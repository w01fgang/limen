import { readFileSync } from "node:fs";
import { sessionContext } from "../../hook/communication.ts";
import { limenRoot } from "../project/git.ts";

/**
 * The coordinator guidance for an agent that loads no Limen extension, such as Claude Code. Without a flag it prints
 * the stable guidance (capability frame, shop manual, register, vision, styleguide, board digest) for a system prompt.
 * With `--cue` it answers a Claude Code `UserPromptSubmit` hook: it reads the hook's JSON on stdin and prints the
 * per-turn cue as the hook's additional context.
 */
export async function contextCommand(args: readonly string[], cwd: string): Promise<void> {
	const cue = args[0] === "--cue";
	if (args.length > (cue ? 1 : 0)) {
		throw new Error("context takes no arguments, or only --cue");
	}
	const root = limenRoot(cwd);
	if (!cue) {
		console.log(sessionContext(root, false).system);
		return;
	}
	const additionalContext = sessionContext(root, false, hookPrompt()).cue;
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }));
}

/** The prompt in the hook's JSON on stdin; empty when a person runs the command in a terminal. */
function hookPrompt(): string {
	if (process.stdin.isTTY) {
		return "";
	}
	try {
		const { prompt } = JSON.parse(readFileSync(0, "utf8")) as { prompt?: unknown };
		return typeof prompt === "string" ? prompt : "";
	} catch {
		return "";
	}
}
