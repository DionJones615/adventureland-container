// Detached supervisor for the local stack: starts Mongo + backend + game server, publishes state,
// and unwinds everything on SIGTERM. Started by 'npm run local:up', stopped by 'npm run local:down'.

import fs from "node:fs/promises";
import path from "node:path";
import { dirs } from "./apply_config.mjs";
import { startStack } from "./stacklib.mjs";

const stateFile = path.join(dirs.run, "state.json");
const log = (message) => console.log(new Date().toISOString() + " " + message);

await fs.mkdir(dirs.run, { recursive: true });
await fs.rm(stateFile, { force: true });

let stack = null;
let stopping = false;

async function shutdown(code) {
	if (stopping) return;
	stopping = true;
	log("stopping stack");
	try {
		await stack?.stop();
	} catch (error) {
		log("stop error: " + error.message);
	}
	await fs.rm(stateFile, { force: true });
	log("stopped");
	process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

try {
	stack = await startStack({
		fresh: process.env.AL_FRESH !== "0",
		forceBfs: process.env.AL_FORCE_BFS === "1",
		log,
	});
	await fs.writeFile(
		stateFile,
		JSON.stringify(
			{
				pid: process.pid,
				startedAt: new Date().toISOString(),
				urls: stack.urls,
				ports: stack.ports,
				db: stack.db,
				logs: stack.logs,
			},
			null,
			2,
		) + "\n",
	);
	log("ready: " + stack.urls.ws + " (api " + stack.urls.api + ")");
	const monitor = setInterval(async () => {
		if (stack.backend.exited) {
			log("backend exited: " + JSON.stringify(stack.backend.exited));
			await shutdown(1);
		}
		if (stack.game.exited) {
			log("game server exited: " + JSON.stringify(stack.game.exited));
			await shutdown(1);
		}
	}, 2000);
	process.on("beforeExit", () => clearInterval(monitor));
} catch (error) {
	log("failed to start: " + (error && error.message));
	await shutdown(1);
}
