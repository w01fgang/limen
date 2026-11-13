#!/usr/bin/env node
// The fake headless Claude Code. It reads one JSON user line per turn on stdin and prints the stream-json lines
// Claude Code 2.1 prints: `system` init, `assistant` (one line per content block; blocks of one API message share its
// id and usage, and report only the output tokens streamed so far), `user` tool results, and one `result` per turn
// with the turn's token totals. It stays open after a turn and exits 0 when stdin closes.
// The first prompt is a script; a line that starts with `fake: ` is one step:
//   tool <command> (a Bash call; consecutive tools are one message; `false` ends in an error) · say <text> ·
//   block (waits for one write to the FIFO fake-gate; a user line that arrives meanwhile joins this turn, as during a
//   tool call) · write (the same wait; a user line that arrives meanwhile gets a turn of its own, as during text) ·
//   error (the turn ends with an error result) · fail <code> (exits at once)
// A later turn replies `reply: <first line of its prompt>`. Records, in the job folder: fake-argv.json,
// fake-env.json (variable names), fake-inputs.jsonl (each user line's text, whether it joined a running turn, and whether stdin had closed when its turn
// started). Each prompt is printed back as a `user` line with `isReplay` when a turn takes it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
	process.exit(console.log("0.0.0-test (Claude Code)") ?? 0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dir = dirname(flag("--append-system-prompt-file") ?? join(process.cwd(), "claude-system.md"));
writeFileSync(join(dir, "fake-argv.json"), JSON.stringify(args));
const names = Object.keys(process.env).filter((name) => /^(LIMEN|HERDR|PI|CLAUDE)/.test(name));
writeFileSync(join(dir, "fake-env.json"), JSON.stringify(names.sort()));

const session = randomUUID();
const model = flag("--model") ?? "claude-fake-1";
const emit = (line) => console.log(JSON.stringify({ ...line, session_id: session }));
let messages = 0;
const message = (content, usage) => ({
	id: `msg_${messages}`,
	role: "assistant",
	model,
	stop_reason: null,
	content,
	usage,
});
const usage = (output, read, written) => ({
	input_tokens: 2,
	output_tokens: output,
	cache_read_input_tokens: read,
	cache_creation_input_tokens: written,
});
let blocks = 0;
async function block() {
	const gate = join(dir, "fake-gate");
	if (!existsSync(gate)) {
		execFileSync("mkfifo", [gate]);
	}
	blocks += 1;
	const released = new Promise((resolve) => createReadStream(gate).once("data", resolve));
	writeFileSync(join(dir, `fake-blocked-${blocks}`), "");
	await released;
}
function callTools(commands) {
	if (!commands.length) {
		return;
	}
	messages += 1;
	const calls = commands.map((command, index) => ({ id: `toolu_${messages}_${index}`, command }));
	for (const call of calls) {
		const part = { type: "tool_use", id: call.id, name: "Bash", input: { command: call.command } };
		emit({ type: "assistant", message: message([part], usage(16, 0, 100)) });
	}
	for (const call of calls) {
		const part = { type: "tool_result", tool_use_id: call.id, content: "out", is_error: call.command === "false" };
		emit({ type: "user", message: { role: "user", content: [part] } });
	}
}
async function turn(prompt, first) {
	emit({ type: "system", subtype: "init", model, permissionMode: flag("--permission-mode") });
	replay(prompt);
	let reply = first ? "fake claude done" : `reply: ${prompt.split("\n")[0]}`;
	let failed = false;
	let pending = [];
	const steps = first ? prompt.split("\n").filter((line) => line.startsWith("fake: ")) : [];
	for (const step of steps) {
		const [word = "", ...rest] = step.slice(6).trim().split(" ");
		const value = rest.join(" ");
		if (word === "tool") {
			pending.push(value);
			continue;
		}
		callTools(pending);
		pending = [];
		if (word === "say") {
			reply = value;
		} else if (word === "block" || word === "write") {
			joining = word === "block";
			await block();
			joining = false;
		} else if (word === "error") {
			failed = true;
		} else if (word === "fail") {
			process.exit(Number(value) || 1);
		}
	}
	callTools(pending);
	if (!failed) {
		messages += 1;
		emit({ type: "assistant", message: message([{ type: "text", text: reply }], usage(5, 100, 0)) });
	}
	emit({
		type: "result",
		subtype: failed ? "error_during_execution" : "success",
		is_error: failed,
		result: failed ? "" : reply,
		usage: { input_tokens: 4, output_tokens: 151 },
	});
}

let busy = false;
let joining = false;
let closed = false;
let turns = 0;
const queue = [];
const replay = (text) => emit({ type: "user", isReplay: true, message: { role: "user", content: text } });
const crash = (error) => process.exit(console.error(error) ?? 1);
async function pump() {
	if (busy) {
		return;
	}
	busy = true;
	while (queue.length) {
		const text = queue.shift();
		turns += 1;
		// A real turn starts with a model call; the wrapper reacts to the last result first.
		await new Promise((resolve) => setTimeout(resolve, 100));
		appendFileSync(join(dir, "fake-inputs.jsonl"), `${JSON.stringify({ text, joined: false, closed })}\n`);
		await turn(text, turns === 1);
	}
	busy = false;
	if (closed) {
		process.stdout.write("", () => process.exit(0));
	}
}
createInterface({ input: process.stdin }).on("line", (line) => {
	const text = JSON.parse(line).message.content;
	if (joining) {
		appendFileSync(join(dir, "fake-inputs.jsonl"), `${JSON.stringify({ text, joined: true, closed })}\n`);
		replay(text);
		return;
	}
	queue.push(text);
	pump().catch(crash);
});
process.stdin.on("end", () => {
	closed = true;
	pump().catch(crash);
});
