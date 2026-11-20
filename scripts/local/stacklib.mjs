// Lifecycle for the local Adventure Land stack: MongoDB, the Express backend and the game server.
// Shared by the CLI (scripts/local/stack.mjs), the detached supervisor and the integration tests,
// so all three start and stop things the same way.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { GAME, LOCAL, applyConfig, dirs, ports } from "./apply_config.mjs";
import { startMongo } from "./mongo.mjs";
import { precomputeBfs, seedDatabase } from "./seed.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};

export function socketIoPollUrl(base, pathname) {
	return base + pathname + "?EIO=4&transport=polling";
}

export function urls({ apiPort, gamePort } = ports()) {
	const game = "http://127.0.0.1:" + gamePort;
	const api = "http://127.0.0.1:" + apiPort;
	return {
		api,
		game,
		ws: game + "/socket.io/",
		msgpack: game + "/socket.io-msgpack/",
		mongo: "mongodb://127.0.0.1:" + ports().mongo + "/adventureland",
	};
}

export function portFree(port, host = "127.0.0.1") {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host });
		const done = (free) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(free);
		};
		socket.once("connect", () => done(false));
		socket.once("error", () => done(true));
		socket.setTimeout(750, () => done(true));
	});
}

function httpGet(url, timeoutMs = 1000) {
	return new Promise((resolve) => {
		const request = http.get(url, { timeout: timeoutMs }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				if (body.length < 4096) body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode, body }));
		});
		request.on("timeout", () => {
			request.destroy();
			resolve(null);
		});
		request.on("error", () => resolve(null));
	});
}

export async function waitFor(name, probe, { timeoutMs = 90_000, intervalMs = 400, log = noop } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			last = await probe();
			if (last) return last;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(
		"[stack] " + name + " did not become ready within " + timeoutMs + "ms" + (lastError ? " (last error: " + lastError.message + ")" : " (probe returned nothing)"),
	);
}

export async function waitForBackend(url, options = {}) {
	return waitFor("backend " + url, async () => {
		const response = await httpGet(url + "/");
		return response ? response : null;
	}, options);
}

export async function waitForGameServer(url, pathname = "/socket.io/", options = {}) {
	return waitFor("game server " + url, async () => {
		const response = await httpGet(socketIoPollUrl(url, pathname));
		return response && response.status === 200 && response.body.startsWith("0") ? response : null;
	}, options);
}

/**
 * The MessagePack endpoint only accepts the websocket transport, so the polling handshake above
 * answers 400 "Transport unknown" there. Do a real Engine.IO websocket handshake instead.
 */
export async function waitForGameServerWebSocket(url, pathname = "/socket.io-msgpack/", options = {}) {
	const wsUrl = url.replace(/^http/, "ws") + pathname + "?EIO=4&transport=websocket";
	return waitFor("game server websocket " + wsUrl, async () => {
		return await new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					socket.close();
				} catch {}
				resolve(value);
			};
			const timer = setTimeout(() => finish(null), 3000);
			let socket;
			try {
				socket = new WebSocket(wsUrl);
			} catch {
				finish(null);
				return;
			}
			socket.onmessage = (event) => {
				if (typeof event.data === "string" && event.data.startsWith("0")) finish(true);
			};
			socket.onerror = () => finish(null);
			socket.onclose = () => finish(null);
		});
	}, options);
}

async function tail(file, lines = 15) {
	try {
		const body = await fs.readFile(file, "utf8");
		return body.trim().split("\n").slice(-lines).join("\n");
	} catch {
		return "(no log)";
	}
}

async function logFiles(name) {
	await fs.mkdir(dirs.logs, { recursive: true });
	return path.join(dirs.logs, name + ".log");
}

async function spawnServer(name, args, env, logFile) {
	const handle = await fs.open(logFile, "a");
	await handle.write("\n=== " + new Date().toISOString() + " " + process.execPath + " " + args.join(" ") + " ===\n");
	const child = spawn(process.execPath, args, {
		cwd: GAME,
		env,
		stdio: ["ignore", handle.fd, handle.fd],
	});
	await handle.close();
	let exited = null;
	child.on("exit", (code, signal) => (exited = { code, signal }));
	return {
		name,
		child,
		logFile,
		get exited() {
			return exited;
		},
		async stop(signal = "SIGTERM", graceMs = 8000) {
			if (exited) return exited;
			child.kill(signal);
			const deadline = Date.now() + graceMs;
			while (!exited && Date.now() < deadline) await sleep(100);
			if (!exited) {
				child.kill("SIGKILL");
				while (!exited) await sleep(50);
			}
			return exited;
		},
	};
}

/**
 * Bring up MongoDB (fresh or reused), seed it, then start the backend and the game server.
 * Returns a handle with the URLs, child handles, log paths and a stop() that unwinds in reverse.
 */
export async function startStack({
	apiPort = ports().api,
	gamePort = ports().game,
	mongoPort = ports().mongo,
	db = "adventureland",
	fresh = true,
	seed = true,
	bfs = true,
	forceBfs = false,
	log = noop,
} = {}) {
	await applyConfig({ quiet: true });
	for (const [label, port] of [["api", apiPort], ["game", gamePort], ["mongo", mongoPort]]) {
		if (!(await portFree(port))) {
			throw new Error(
				"[stack] port " + port + " (" + label + ") is already in use; stop the other stack or set AL_" + label.toUpperCase() + "_PORT",
			);
		}
	}

	log("starting mongodb on " + mongoPort);
	const mongo = await startMongo({ port: mongoPort, dbName: db, reuseData: !fresh });
	const env = Object.assign({}, process.env, {
		NODE_ENV: "development",
		PORT: String(apiPort),
		AL_MONGODB_URI: mongo.uri,
		AL_MONGODB_NAME: db,
		AL_API_PORT: String(apiPort),
		AL_GAME_PORT: String(gamePort),
	});

	let backend = null;
	let game = null;
	try {
		if (seed) await seedDatabase({ uri: mongo.uri, name: db, log });
		if (bfs) await precomputeBfs({ uri: mongo.uri, name: db, force: forceBfs, log });

		log("starting backend");
		backend = await spawnServer("backend", ["main.js"], env, await logFiles("backend"));
		await waitForBackend("http://127.0.0.1:" + apiPort, { log });

		log("starting game server (local)");
		game = await spawnServer("gameserver", ["node/server.js", "local"], env, await logFiles("gameserver"));
		const gameUrl = "http://127.0.0.1:" + gamePort;
		try {
			await waitForGameServer(gameUrl, "/socket.io/", { log, timeoutMs: 120_000 });
			await waitForGameServerWebSocket(gameUrl, "/socket.io-msgpack/", { log, timeoutMs: 60_000 });
		} catch (error) {
			if (game.exited) throw new Error(error.message + "\n[stack] game server exited: " + JSON.stringify(game.exited) + "\n" + (await tail(game.logFile)));
			throw error;
		}

		return {
			urls: urls({ apiPort, gamePort }),
			ports: { api: apiPort, game: gamePort, mongo: mongoPort },
			db,
			backend,
			game,
			mongo,
			logs: { backend: backend.logFile, gameserver: game.logFile },
			async stop() {
				if (game) await game.stop();
				if (backend) await backend.stop();
				await mongo.stop();
			},
		};
	} catch (error) {
		if (game) await game.stop();
		if (backend) await backend.stop();
		await mongo.stop();
		throw error;
	}
}
