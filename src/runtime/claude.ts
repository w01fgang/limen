import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { sessionContext } from "../../hook/communication.ts";
import { watchSteerInbox } from "../job/steer-inbox.ts";
import { noteCheck, noteStart, recordNote } from "../job/task-note.ts";
import { readOptional } from "../project/inherit.ts";
import { type StreamEvent, type StreamInterpreter, toolDetail } from "./stream.ts";

// Claude Code runs headless: the wrapper writes each user turn as one JSON line to its stdin and reads its
// stream-json stdout. The process stays open after a turn until stdin closes, so the wrapper owns the note check,
// the steers and the end of the job. Claude Code loads no Limen extension.

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/;
const RESULT_TEXT_CHARS = 20_000;
// The job result is the last message, and the note check asks for one more message after the handoff.
const HANDOFF = 'That final message is the whole handoff of this job: give your handoff again, then the "Note check".';
/** Variables of the Claude Code session that ran `limen`; a job is a session of its own and must not inherit them. */
export const CLAUDE_SESSION_ENVIRONMENT =
	"CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_SESSION_ID CLAUDE_CODE_VERSION";

type Fields = Record<string, unknown>;
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Pending = { readonly id: string; readonly model: string; readonly usage: Usage; readonly content: Fields[] };
export type ClaudeJob = {
	readonly args: string[];
	readonly read: StreamInterpreter;
	/** Sends the first prompt and starts the steer watch. */
	start(stdin: Writable): void;
	stop(): void;
};

/** What `--engine claude` cannot do, said before any job exists. */
export function preflightClaude(
	options: {
		readonly tab: boolean;
		readonly provider?: string | undefined;
		readonly thinking?: string | undefined;
		readonly extensions?: readonly string[];
	},
	grouped: boolean,
): void {
	if (options.tab) {
		throw new Error("--engine claude runs detached only; omit --tab");
	}
	if (grouped) {
		throw new Error("--engine claude cannot join a group; spawn it outside the group");
	}
	if (options.provider) {
		throw new Error("--engine claude has no provider; omit --provider (--model names a Claude model or alias)");
	}
	if (options.extensions?.length) {
		throw new Error("--engine claude loads no Pi or OMP extension; omit --extension");
	}
	if (options.thinking && !EFFORTS.includes(options.thinking)) {
		throw new Error(`--thinking for --engine claude is its effort: ${EFFORTS.join(", ")}`);
	}
}

/** The launch of one detached Claude Code job: its command line, and the driver of its stdin and stdout. */
export function claudeJob(input: {
	readonly jobDir: string;
	readonly root: string;
	readonly preamble: string;
	readonly task: string;
	readonly continued: boolean;
	readonly model?: string;
	readonly thinking?: string;
}): ClaudeJob {
	const { jobDir } = input;
	const context = sessionContext(input.root, true);
	const systemFile = join(jobDir, "claude-system.md");
	writeFileSync(systemFile, [input.preamble, context.system].filter(Boolean).join("\n\n"));
	const resume = input.continued ? parentSession(jobDir) : undefined;
	if (input.continued && !resume) {
		throw new Error("the parent job has no Claude Code session to resume");
	}
	const session = claudeSession(jobDir, [context.cue, noteStart(jobDir), input.task].filter(Boolean).join("\n\n"));
	return {
		args: claudeArgv({
			systemFile,
			...(input.model ? { model: input.model } : {}),
			...(input.thinking ? { thinking: input.thinking } : {}),
			...(resume ? { resume } : {}),
		}),
		...session,
	};
}

/**
 * User settings, user hooks, plugins and MCP servers stay off; the project's own `.claude/settings.json` and
 * `CLAUDE.md` in the worktree still load. A job runs unattended, so no tool call waits for a permission.
 */
export function claudeArgv(slots: {
	readonly systemFile: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly resume?: string;
}): string[] {
	// Claude Code prints each prompt back when a turn takes it, so the wrapper knows which prompts still wait.
	const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
	args.push("--replay-user-messages");
	args.push("--setting-sources", "project", "--strict-mcp-config", "--permission-mode", "bypassPermissions");
	args.push("--append-system-prompt-file", slots.systemFile);
	if (slots.model) {
		args.push("--model", slots.model);
	}
	if (slots.thinking) {
		args.push("--effort", slots.thinking);
	}
	if (slots.resume) {
		// A fork keeps the parent's conversation and writes this job's turns under a session id of its own.
		args.push("--resume", slots.resume, "--fork-session");
	}
	return args;
}

/** The Claude Code session id in the newest transcript name; a continuation holds a copy of its parent's transcript. */
function parentSession(jobDir: string): string | undefined {
	let names: string[] = [];
	try {
		names = readdirSync(join(jobDir, "session"));
	} catch {
		// No transcript, no session.
	}
	return names
		.filter((name) => SESSION_FILE.test(name))
		.sort()
		.at(-1)
		?.match(SESSION_FILE)?.[1];
}

/**
 * Drives one job. After the first clean turn the worker gets its task note to check, once; the turn after that is
 * the handoff. A prompt that still waits for its turn, or a steer that waits when a turn ends, keeps the input open.
 * Then stdin closes and Claude Code exits.
 */
function claudeSession(jobDir: string, firstPrompt: string): Omit<ClaudeJob, "args"> {
	const transcript = claudeTranscript(jobDir);
	let stdin: Writable | undefined;
	let steers: ReturnType<typeof watchSteerInbox>;
	let checked = false;
	let sent = 0;
	let taken = 0;
	let noteSeen = readOptional(join(jobDir, "note.md"));
	const send = (text: string) => {
		if (!stdin?.writable) {
			throw new Error("the Claude Code session takes no more input");
		}
		stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
		sent += 1;
	};
	const end = () => {
		steers?.stop();
		// `limen steer` waits for this file; without it a late steer is refused, and none waits unread in the inbox.
		rmSync(join(jobDir, "steer", "ready"), { force: true });
		stdin?.end();
	};
	const turnEnded = (failed: boolean) => {
		try {
			if (failed) {
				return end();
			}
			if (!checked) {
				checked = true;
				appendFileSync(join(jobDir, "log"), `[limen ${new Date().toISOString()}] note check sent\n`);
				return send(`${noteCheck(jobDir, false)}\n${HANDOFF}`);
			}
			// A steer that arrives while the agent writes text waits for a turn of its own; that turn ends later.
			if (sent > taken) {
				return;
			}
			const before = sent;
			steers?.sweep();
			if (sent === before) {
				end();
			}
		} catch {
			end();
		}
	};
	return {
		read(event) {
			const line = fields(event);
			if (line.type === "system" && line.subtype === "init") {
				transcript.open(text(line.session_id), text(line.model));
				return { kind: "activity", name: "think" };
			}
			if (line.type === "assistant") {
				return transcript.assistant(fields(line.message));
			}
			if (line.type === "user") {
				if (line.isReplay === true) {
					taken += 1;
					return;
				}
				const results = transcript.toolResults(fields(line.message));
				if (!results) {
					return;
				}
				noteSeen = recordNote(jobDir, noteSeen);
				return { kind: "activity", name: "wait" };
			}
			if (line.type !== "result") {
				return;
			}
			transcript.result(fields(line.usage));
			const failure = resultFailure(line);
			turnEnded(Boolean(failure));
			return failure
				? { kind: "assistant", text: text(line.result), stopReason: failure }
				: { kind: "activity", name: "wait" };
		},
		start(input) {
			stdin = input;
			// The wrapper learns of a closed pipe from the process exit.
			input.on("error", () => {});
			send(firstPrompt);
			steers = watchSteerInbox(jobDir, send);
		},
		stop: end,
	};
}

/** Empty for a clean turn; else a stop reason the job record reads as failed. */
function resultFailure(line: Fields): string {
	if (line.is_error !== true && line.subtype === "success") {
		return "";
	}
	const detail = text(line.result).replace(/\s+/g, " ").trim().slice(0, 200);
	const subtype = text(line.subtype) || "error";
	return `error: ${detail && subtype === "success" ? detail : [subtype, detail].filter(Boolean).join(": ")}`;
}

/**
 * Writes the job's turns to `<jobDir>/session/` in the shape Pi's transcript has, so usage, the note check's proof of
 * shell commands, `continue` and the picture read a Claude Code job as any other. Names sort by start time and end in
 * the Claude Code session id. Claude Code prints one API message as several lines, one per content block, each with
 * the same usage: they become one transcript message. A line reports the output tokens streamed so far; the turn's
 * `result` line has the total, so the last message of a turn takes the rest.
 */
function claudeTranscript(jobDir: string) {
	let file: string | undefined;
	let pending: Pending | undefined;
	let turnOutput = 0;
	let flushed = "";
	const tools = new Map<string, string>();
	const background = new Set<string>();
	const write = (entry: Fields) => {
		if (!file) {
			return;
		}
		try {
			appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
		} catch {
			// The transcript is a record; a line that cannot be written must not hold the turn.
		}
	};
	const flush = (total?: number) => {
		if (!pending) {
			return;
		}
		const { id, model, usage, content } = pending;
		pending = undefined;
		flushed = id;
		if (total !== undefined) {
			usage.output = Math.max(usage.output, total - turnOutput);
		}
		turnOutput += usage.output;
		write({ type: "message", message: { role: "assistant", provider: "anthropic", model, usage, content } });
	};
	return {
		open(session: string, model: string): void {
			if (file || !session) {
				return;
			}
			mkdirSync(join(jobDir, "session"), { recursive: true });
			file = join(jobDir, "session", `${new Date().toISOString().replace(/[:.]/g, "-")}_${session}.jsonl`);
			write({ type: "model_change", provider: "anthropic", modelId: model });
		},
		assistant(message: Fields): StreamEvent[] {
			const id = text(message.id);
			if (pending && pending.id !== id) {
				flush();
			}
			// A tool result can arrive between two blocks of one API message; the later blocks add no usage.
			pending ??= {
				id,
				model: text(message.model),
				usage: usageOf(id === flushed ? {} : fields(message.usage)),
				content: [],
			};
			const events: StreamEvent[] = [];
			for (const part of parts(message.content)) {
				if (part.type === "text" && text(part.text).trim()) {
					pending.content.push({ type: "text", text: text(part.text) });
					events.push({ kind: "assistant", text: text(part.text).trim() });
				} else if (part.type === "tool_use") {
					const name = text(part.name).toLowerCase() || "tool";
					tools.set(text(part.id), name);
					if (fields(part.input).run_in_background === true) {
						background.add(text(part.id));
					}
					pending.content.push({ type: "toolCall", id: text(part.id), name, arguments: fields(part.input) });
					const detail = toolDetail(part.input);
					events.push({ kind: "tool", name, ...(detail ? { detail } : {}) });
				}
			}
			return events.length ? events : [{ kind: "activity", name: "think" }];
		},
		/** True when the line answers tool calls; a plain user line is a prompt the wrapper wrote. */
		toolResults(message: Fields): boolean {
			const results = parts(message.content).filter((part) => part.type === "tool_result");
			if (results.length) {
				flush();
			}
			for (const part of results) {
				const id = text(part.tool_use_id);
				const body = resultText(part.content).slice(0, RESULT_TEXT_CHARS);
				write({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: id,
						toolName: tools.get(id) ?? "",
						// A background call answers at once, before its command ends: it proves no exit 0.
						isError: part.is_error === true || background.has(id),
						content: [{ type: "text", text: body }],
					},
				});
			}
			return results.length > 0;
		},
		result(usage: Fields): void {
			flush(count(usage.output_tokens));
			turnOutput = 0;
		},
	};
}

function usageOf(usage: Fields): Usage {
	return {
		input: count(usage.input_tokens),
		output: count(usage.output_tokens),
		cacheRead: count(usage.cache_read_input_tokens),
		cacheWrite: count(usage.cache_creation_input_tokens),
	};
}

function resultText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	return parts(content)
		.map((part) => text(part.text))
		.join("\n");
}

const fields = (value: unknown): Fields => (value && typeof value === "object" ? (value as Fields) : {});
const parts = (value: unknown): Fields[] => (Array.isArray(value) ? value.map(fields) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);
