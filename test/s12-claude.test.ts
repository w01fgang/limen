// S12 · Claude Code engine. A claude job runs headless Claude Code (the plant's fake plays it) with the wrapper on its
// stdin: the task, then the note check once, then a steer that waits; the last message is the result. Its transcript
// has Pi's shape, so usage and the proof of shell commands read it. `continue` forks the parent's Claude Code session.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { sessionRuns } from "../src/job/session-commands.ts";
import * as plant from "./plant.ts";

const { jobDir, jobFile, limen, spawnJob, until, waitJob } = plant;
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const [, FRAME = "", CUE = ""] = readFileSync(`${PACKAGE}templates/capability.md`, "utf8").split(/\s*## \w+\s*|\s+$/);
const FLAGS = ["--engine", "claude"];
// The Claude Code session that runs `limen` hands these to every child; a job is a session of its own.
const CALLER = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "caller", ANTHROPIC_BASE_URL: "https://gateway.test" };
const p = await plant.plant();
after(p.cleanup);

const argv = (id: string): string[] => JSON.parse(jobFile(p, id, "fake-argv.json"));
const after_ = (id: string, flag: string) => argv(id)[argv(id).indexOf(flag) + 1];
const inputs = (id: string): Array<{ text: string; joined: boolean; closed: boolean }> =>
	JSON.parse(`[${jobFile(p, id, "fake-inputs.jsonl").split("\n").join(",")}]`);
const sessions = (id: string) => readdirSync(join(jobDir(p, id), "session")).sort();
let first = "";

test("a claude job gets its task, then its note check once, and its last message is the result", () => {
	first = spawnJob(p, "fake: tool npm test\nfake: tool false\nfake: say first answer", FLAGS, { env: CALLER });
	assert.equal(waitJob(p, first), "done");
	const [task, check, ...more] = inputs(first);
	assert.ok(task?.text.includes(CUE) && task.text.endsWith("fake: say first answer"), "cue, then the task");
	assert.ok(task?.text.includes(`/jobs/${first}/note.md, or write it`), "the first prompt names the task note");
	assert.match(check?.text ?? "", /^\[limen\] No note exists[\s\S]*whole handoff of this job/);
	assert.deepEqual(more, [], "one note check, then stdin closes");
	assert.match(jobFile(p, first, "result"), /^reply: \[limen\] No note exists in /);
	assert.equal(jobFile(p, first, "log").split("] note check sent\n").length - 1, 1);
	assert.deepEqual([jobFile(p, first, "tool-calls"), jobFile(p, first, "last-tool")], ["2", "bash"]);
});

test("a claude job runs without the user's settings, asks no permission, and takes no Pi model or caller session", () => {
	const args = argv(first);
	assert.deepEqual(
		[after_(first, "--setting-sources"), after_(first, "--permission-mode"), args.includes("--strict-mcp-config")],
		["project", "bypassPermissions", true],
	);
	assert.equal(args.includes("--model"), false, "the package's default Pi model never reaches Claude Code");
	const system = readFileSync(after_(first, "--append-system-prompt-file") ?? "", "utf8");
	assert.ok(system.includes(FRAME), "the capability frame rides the system prompt");
	const seen: string[] = JSON.parse(jobFile(p, first, "fake-env.json"));
	assert.deepEqual(
		seen.filter((name) => name.startsWith("CLAUDE")),
		[],
	);
	assert.ok(seen.includes("LIMEN_JOB_ID"));
});

test("a claude transcript counts each API message once and proves only the shell call that exited 0", () => {
	const run = limen(p, ["jobs", first]).stdout;
	assert.match(run, /tokens 3 turns · input 6 · output 302 · cache read 200 · cache write 100/);
	assert.match(run, /model anthropic\/claude-fake-1/);
	assert.deepEqual(sessionRuns(jobDir(p, first)), [
		{ words: "npm test", why: "" },
		{ words: "false", why: "its shell call did not end with exit 0" },
	]);
});

test("a steer joins the running turn of a claude job once, before its note check; an ended job refuses one", async () => {
	const id = spawnJob(p, "fake: block\nfake: say held", FLAGS);
	const dir = jobDir(p, id);
	await until(dir, () => existsSync(join(dir, "fake-blocked-1")));
	assert.equal(limen(p, ["steer", id, "turn left"]).status, 0);
	await until(dir, () => inputs(id).length === 2);
	await plant.release(dir);
	assert.equal(waitJob(p, id), "done");
	const [, steer, check, ...more] = inputs(id);
	assert.ok(steer?.joined && steer.text.startsWith("turn left\n\n[limen] If this steer changes "), steer?.text);
	assert.ok(check && !check.joined && check.text.startsWith("[limen] No note exists in "), check?.text);
	assert.deepEqual(more, []);
	assert.equal(limen(p, ["steer", id, "late"]).status, 1);
});

test("a steer that arrives while a claude job writes text gets its own turn, and input stays open for the note check", async () => {
	const id = spawnJob(p, "fake: write\nfake: say held", FLAGS);
	const dir = jobDir(p, id);
	await until(dir, () => existsSync(join(dir, "fake-blocked-1")));
	assert.equal(limen(p, ["steer", id, "turn left"]).status, 0);
	await until(dir, () => readdirSync(join(dir, "steer/delivered")).length === 1);
	await plant.release(dir);
	assert.equal(waitJob(p, id), "done");
	const [, steer, check] = inputs(id);
	assert.deepEqual([steer?.text.startsWith("turn left"), steer?.joined, check?.closed], [true, false, false]);
	assert.match(jobFile(p, id, "result"), /^reply: \[limen\] No note exists in /);
});

test("continue forks the parent's Claude Code session and keeps both transcripts", () => {
	const run = limen(p, ["continue", first, "more work", "--detached"]);
	const id = run.stdout.trim().split("\n").at(-1) ?? "";
	assert.equal(waitJob(p, id), "done", run.stderr);
	const parentSession = sessions(first)[0]?.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
	assert.deepEqual([after_(id, "--resume"), argv(id).includes("--fork-session")], [parentSession, true]);
	assert.ok(inputs(id)[0]?.text.endsWith("more work"));
	assert.deepEqual([sessions(id).length, sessions(id)[0]], [2, sessions(first)[0]]);
});

test("a claude turn that ends in an error fails the job and sends no note check", () => {
	const id = spawnJob(p, "fake: error", FLAGS);
	assert.equal(waitJob(p, id), "failed");
	assert.equal(jobFile(p, id, "stop-reason"), "error: error_during_execution");
	assert.equal(inputs(id).length, 1);
});

test("limen context prints the coordinator guidance, and --cue answers a prompt hook with the turn cue", () => {
	const system = limen(p, ["context"]).stdout;
	assert.ok(system.includes(FRAME) && system.includes("Shop manual") && !system.includes(CUE), system.slice(0, 200));
	const { hookSpecificOutput: hook } = JSON.parse(limen(p, ["context", "--cue"]).stdout);
	assert.equal(hook.hookEventName, "UserPromptSubmit");
	assert.ok(hook.additionalContext.includes(CUE) && !hook.additionalContext.includes(FRAME));
	assert.equal(limen(p, ["context", "--all"]).status, 1);
});
