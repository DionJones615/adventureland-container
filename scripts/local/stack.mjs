#!/usr/bin/env node
// 'npm run local:up|down|status|logs' - the local Adventure Land stack.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL, ROOT, applyConfig, dirs, ports } from "./apply_config.mjs";
import { waitForBackend, waitForGameServer, waitForGameServerWebSocket } from "./stacklib.mjs";

const SUPERVISOR = path.join(ROOT, "scripts/local/supervisor.mjs");
const stateFile = path.join(dirs.run, "state.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState() {
	try {
		return JSON.parse(await fs.readFile(stateFile, "utf8"));
	} catch {
		return null;
	}
}

async function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function up() {
	if (!(await fs.access(path.join(LOCAL, "adventureland/.git")).then(() => true, () => false))) {
		console.log("[local] stack not fetched yet, running scripts/local/fetch_stack.sh");
		const fetch = spawn("bash", [path.join(ROOT, "scripts/local/fetch_stack.sh")], { stdio: "inherit" });
		await new Promise((resolve, reject) => fetch.on("close", (code) => (code === 0 ? resolve() : reject(new Error("fetch_stack.sh failed")))));
	}
	await applyConfig();

	const existing = await readState();
	if (existing && (await isAlive(existing.pid))) {
		console.log("[local] already running (pid " + existing.pid + "): " + existing.urls.ws);
		return;
	}
	await fs.mkdir(dirs.run, { recursive: true });
	await fs.mkdir(dirs.logs, { recursive: true });
	const supervisorLog = await fs.open(path.join(dirs.logs, "supervisor.log"), "a");
	const child = spawn(process.execPath, [SUPERVISOR], {
		cwd: ROOT,
		detached: true,
		stdio: ["ignore", supervisorLog.fd, supervisorLog.fd],
		env: process.env,
	});
	child.unref();
	await supervisorLog.close();
	await fs.writeFile(path.join(dirs.run, "supervisor.pid"), String(child.pid));

	const deadline = Date.now() + 300_000;
	let state = null;
	while (Date.now() < deadline) {
		state = await readState();
		if (state) break;
		if (!(await isAlive(child.pid))) break;
		await sleep(500);
	}
	if (!state) {
		const log = await fs.readFile(path.join(dirs.logs, "supervisor.log"), "utf8").catch(() => "");
		throw new Error("[local] supervisor did not publish state. Last log:\n" + log.trim().split("\n").slice(-12).join("\n"));
	}
	await waitForBackend(state.urls.api, { timeoutMs: 60_000 });
	await waitForGameServer(state.urls.game, "/socket.io/", { timeoutMs: 60_000 });
	await waitForGameServerWebSocket(state.urls.game, "/socket.io-msgpack/", { timeoutMs: 30_000 });
	console.log("[local] api      " + state.urls.api);
	console.log("[local] game     " + state.urls.ws);
	console.log("[local] msgpack  " + state.urls.msgpack);
	console.log("[local] mongo    " + state.urls.mongo + " (db " + state.db + ")");
	console.log("[local] logs     " + dirs.logs);
	console.log("[local] stop with: npm run local:down");
}

async function down() {
	const state = await readState();
	if (!state) {
		console.log("[local] not running");
		return;
	}
	if (await isAlive(state.pid)) {
		process.kill(state.pid, "SIGTERM");
		const deadline = Date.now() + 30_000;
		while ((await isAlive(state.pid)) && Date.now() < deadline) await sleep(200);
		if (await isAlive(state.pid)) {
			process.kill(state.pid, "SIGKILL");
			await sleep(500);
		}
	}
	await fs.rm(stateFile, { force: true });
	console.log("[local] stopped");
}

async function status() {
	const state = await readState();
	if (!state) {
		console.log("[local] not running");
		return;
	}
	const alive = await isAlive(state.pid);
	console.log("[local] " + (alive ? "running" : "dead supervisor") + " pid=" + state.pid + " since " + state.startedAt);
	console.log("[local] api " + state.urls.api + " game " + state.urls.ws + " msgpack " + state.urls.msgpack);
	for (const [name, url, pathname] of [
		["backend", state.urls.api, "/"],
		["game", state.urls.game, "/socket.io/"],
		["msgpack", state.urls.game, "/socket.io-msgpack/"],
	]) {
		try {
			if (name === "backend") await waitForBackend(url, { timeoutMs: 2500, intervalMs: 250 });
			else if (name === "msgpack") await waitForGameServerWebSocket(url, pathname, { timeoutMs: 2500, intervalMs: 250 });
			else await waitForGameServer(url, pathname, { timeoutMs: 2500, intervalMs: 250 });
			console.log("[local] " + name + " ok");
		} catch {
			console.log("[local] " + name + " DOWN");
		}
	}
}

async function logs() {
	const name = process.argv[3];
	await fs.mkdir(dirs.logs, { recursive: true });
	const entries = await fs.readdir(dirs.logs).catch(() => []);
	for (const file of entries.filter((candidate) => entry(candidate, name)).sort()) {
		const body = await fs.readFile(path.join(dirs.logs, file), "utf8").catch(() => "");
		console.log("=== " + file + " ===");
		console.log(body.trim().split("\n").slice(-40).join("\n"));
	}
}
const entry = (file, name) => !name || file.startsWith(name);

const command = process.argv[2];
const handlers = { up, down, status, logs };
if (!command || !handlers[command]) {
	console.log("usage: node scripts/local/stack.mjs up|down|status|logs [name]");
	process.exit(command ? 1 : 0);
}
handlers[command]().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
