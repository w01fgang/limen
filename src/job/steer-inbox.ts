import {
	appendFileSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { noteSteer } from "./task-note.ts";

const CLAIM_STALE_MS = 30_000;

/** Queue one steer for the worker's steering hook; numbers continue past every inbox, claim and delivered name. */
export async function enqueueSteer(jobDir: string, message: string): Promise<string> {
	const inbox = `${jobDir}/steer/inbox`;
	await mkdir(inbox, { recursive: true });
	for (let next = (await highest(jobDir)) + 1; next <= 9_999; next += 1) {
		const seq = String(next).padStart(4, "0");
		try {
			await writeFile(`${inbox}/${seq}`, `${message}\n`, { flag: "wx", flush: true });
			return seq;
		} catch (error: unknown) {
			if (!isExist(error)) {
				throw error;
			}
		}
	}
	throw new Error(`steer inbox is full for ${jobDir}`);
}

/**
 * Marks the job ready for `limen steer` and hands each inbox file to `send` once, in order, with the task note
 * reminder. A `send` that throws leaves the file for a later sweep. Undefined when the steer folder cannot be made.
 */
export function watchSteerInbox(
	job: string,
	send: (text: string) => void,
): { sweep(): void; stop(): void } | undefined {
	try {
		mkdirSync(join(job, "steer", "inbox"), { recursive: true });
		mkdirSync(join(job, "steer", "delivered"), { recursive: true });
		writeFileSync(join(job, "steer", "ready"), "1\n", { flag: "wx" });
	} catch {
		if (!existsSync(join(job, "steer", "ready"))) {
			return;
		}
	}
	let watcher: FSWatcher | undefined;
	let changeTimer: NodeJS.Timeout | undefined;
	const sweep = () => {
		try {
			for (const name of pendingNames(job)) {
				if (!deliver(send, job, name)) {
					break;
				}
			}
		} catch {
			// Delivery is advisory; inbox files remain until a later sweep.
		}
	};
	const scheduleSweep = () => {
		if (changeTimer) {
			return;
		}
		changeTimer = setTimeout(() => {
			changeTimer = undefined;
			sweep();
		}, 50);
		changeTimer.unref();
	};
	try {
		watcher = watch(join(job, "steer"), { recursive: true }, scheduleSweep);
		watcher.unref();
		watcher.on("error", () => {
			watcher?.close();
			watcher = undefined;
		});
	} catch {
		// Polling still delivers.
	}
	const sweepTimer = setInterval(sweep, 500);
	sweepTimer.unref();
	sweep();
	return {
		sweep,
		stop() {
			watcher?.close();
			watcher = undefined;
			clearInterval(sweepTimer);
			if (changeTimer) {
				clearTimeout(changeTimer);
			}
			changeTimer = undefined;
		},
	};
}

function deliver(send: (text: string) => void, job: string, name: string): boolean {
	const inbox = join(job, "steer", "inbox", name);
	const claim = join(job, "steer", "claims", name);
	const delivered = join(job, "steer", "delivered", name);
	mkdirSync(join(job, "steer", "claims"), { recursive: true });
	mkdirSync(join(job, "steer", "delivered"), { recursive: true });
	recoverClaim(claim, delivered);
	if (existsSync(delivered)) {
		rmSync(inbox, { force: true });
		return true;
	}
	const text = readText(inbox);
	if (!text) {
		return false;
	}
	try {
		mkdirSync(claim);
		writeFileSync(join(claim, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
		writeFileSync(join(claim, "text"), `${text}\n`);
	} catch {
		return false;
	}
	try {
		send(`${text}\n\n${noteSteer(job)}`);
		writeFileSync(join(claim, "accepted"), "1\n");
		renameSync(claim, delivered);
		rmSync(inbox, { force: true });
		appendFileSync(join(job, "log"), `[limen ${new Date().toISOString()}] steered: ${preview(text)}\n`);
		return true;
	} catch {
		rmSync(claim, { recursive: true, force: true });
		return false;
	}
}

function pendingNames(job: string): string[] {
	try {
		return readdirSync(join(job, "steer", "inbox"))
			.filter((name) => /^\d+$/.test(name))
			.sort((left, right) => Number(left) - Number(right));
	} catch {
		return [];
	}
}

function recoverClaim(claim: string, delivered: string): void {
	try {
		if (!existsSync(claim)) {
			return;
		}
		const age = Date.now() - statSync(claim).mtimeMs;
		if (age < CLAIM_STALE_MS) {
			return;
		}
		if (existsSync(join(claim, "accepted"))) {
			if (!existsSync(delivered)) {
				renameSync(claim, delivered);
			} else {
				rmSync(claim, { recursive: true, force: true });
			}
			return;
		}
		rmSync(claim, { recursive: true, force: true });
	} catch {
		// Another sweep recovered it first.
	}
}

function readText(path: string): string {
	if (!existsSync(path)) {
		return "";
	}
	return readFileSync(path, "utf8").trim();
}

function preview(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

async function highest(jobDir: string): Promise<number> {
	const names = await Promise.all(
		["inbox", "claims", "delivered"].map((part) => readdir(`${jobDir}/steer/${part}`).catch(() => [])),
	);
	return names.flat().reduce((max, name) => {
		const value = Number(name);
		return /^\d+$/.test(name) && value > max ? value : max;
	}, 0);
}

function isExist(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
