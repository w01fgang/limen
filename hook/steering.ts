import { existsSync } from "node:fs";
import { join } from "node:path";
import { watchSteerInbox } from "../src/job/steer-inbox.ts";

type PiApi = {
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: unknown) => void): void;
	sendUserMessage(content: string, options?: { readonly deliverAs: "steer" }): void;
};

export default function limenSteering(pi: PiApi): void {
	let watching: { stop(): void } | undefined;
	const stop = () => {
		watching?.stop();
		watching = undefined;
	};
	pi.on("session_start", () => {
		if (process.env.LIMEN_JOB !== "1") {
			return;
		}
		stop();
		const root = process.env.LIMEN_CONTEXT_ROOT;
		const id = process.env.LIMEN_JOB_ID;
		if (!root || !id) {
			return;
		}
		const job = join(root, ".limen", "jobs", id);
		if (!existsSync(job)) {
			return;
		}
		watching = watchSteerInbox(job, (text) => pi.sendUserMessage(text, { deliverAs: "steer" }));
	});
	pi.on("session_shutdown", stop);
}
