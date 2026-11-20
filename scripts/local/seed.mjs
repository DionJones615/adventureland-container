// Prepare the local game database: seed the 49 map geometry records, then precompute the BFS
// movement grid the game server validates movement against.
//
// Both steps run the upstream scripts unchanged (scripts/seed_mongodb.js, node/precompute_bfs.js),
// with the connection taken from the generated secretsandconfig/keys.js.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GAME, dirs } from "./apply_config.mjs";

const BFS_OUTPUT = path.join(GAME, "node/precomputed_map_data.js");

export function runProcess(command, args, { cwd = GAME, env = process.env, timeoutMs = 300_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

/**
 * Seed the map collection. The upstream seeder insists on an empty database and on the exact
 * database name, so this is deliberately a one-shot step per fresh database.
 */
export async function seedDatabase({ uri, name, log = () => {} }) {
	const env = Object.assign({}, process.env, { AL_MONGODB_URI: uri, AL_MONGODB_NAME: name, NODE_ENV: "development" });
	log("seed: " + name + " (dry run)");
	const dry = await runProcess(process.execPath, ["scripts/seed_mongodb.js", "--dry-run"], { env });
	if (dry.code !== 0) {
		throw new Error("seed dry run failed (" + dry.code + "):\n" + (dry.stdout + dry.stderr).trim());
	}
	log("seed: inserting map geometry");
	const run = await runProcess(process.execPath, ["scripts/seed_mongodb.js", "--confirm", name], { env });
	if (run.code !== 0) {
		throw new Error("seed failed (" + run.code + "):\n" + (run.stdout + run.stderr).trim());
	}
	return (run.stdout + run.stderr).trim();
}

/** Movement enforcement needs node/precomputed_map_data.js; without it smap_data is disabled. */
export async function precomputeBfs({ uri, name, force = false, log = () => {} }) {
	if (!force) {
		try {
			const stat = await fs.stat(BFS_OUTPUT);
			if (stat.size > 1024) {
				log("bfs: reusing node/precomputed_map_data.js (" + Math.round(stat.size / 1024) + " KiB)");
				return { skipped: true, bytes: stat.size };
			}
		} catch {}
	}
	const env = Object.assign({}, process.env, { AL_MONGODB_URI: uri, AL_MONGODB_NAME: name, NODE_ENV: "development" });
	log("bfs: precomputing movement grid (this takes tens of seconds)");
	const started = Date.now();
	const run = await runProcess(process.execPath, ["node/precompute_bfs.js"], { env, timeoutMs: 600_000 });
	if (run.code !== 0) {
		throw new Error("bfs precompute failed (" + run.code + "):\n" + (run.stdout + run.stderr).trim());
	}
	const stat = await fs.stat(BFS_OUTPUT);
	await fs.mkdir(dirs.logs, { recursive: true });
	await fs.writeFile(path.join(dirs.logs, "precompute_bfs.log"), run.stdout + run.stderr);
	log("bfs: wrote " + Math.round(stat.size / 1024) + " KiB in " + Math.round((Date.now() - started) / 1000) + "s");
	return { skipped: false, bytes: stat.size };
}

if (process.argv[1] && process.argv[1].endsWith("seed.mjs")) {
	const { applyConfig, ports } = await import("./apply_config.mjs");
	const { startMongo } = await import("./mongo.mjs");
	await applyConfig({ quiet: true });
	const mongo = await startMongo({ port: ports().mongo });
	try {
		await seedDatabase({ uri: mongo.uri, name: mongo.name, log: console.log });
		await precomputeBfs({ uri: mongo.uri, name: mongo.name, force: process.argv.includes("--force-bfs"), log: console.log });
		console.log("database ready");
	} finally {
		await mongo.stop();
	}
}
