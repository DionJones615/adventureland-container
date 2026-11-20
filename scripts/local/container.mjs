#!/usr/bin/env node
// The game container: MongoDB + backend + game server, one image.
//
//   node scripts/local/container.mjs build
//   node scripts/local/container.mjs up [--fixtures containers/fixtures/e2e.json]
//   node scripts/local/container.mjs status
//   node scripts/local/container.mjs logs [-f]
//   node scripts/local/container.mjs down
//
// Docker and Podman are interchangeable here: the engine is auto-detected (podman first, then
// docker) and can be forced with AL_CONTAINER_BIN=docker. There is no bot and no pod: the container
// publishes the api (client + backend) and the game socket, and the host connects to it like any
// other Adventure Land server. Everything that makes a test deterministic - the default account and
// the character fixtures - is seeded inside the container at start, driven by the environment.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL, ROOT } from "./apply_config.mjs";

const NAME = "al-game";
const IMAGE = "localhost/al-game";
const CLONE = LOCAL;
const DEFAULT_FIXTURES = path.join(ROOT, "containers/fixtures/e2e.json");

function detectEngine() {
	if (process.env.AL_CONTAINER_BIN) return process.env.AL_CONTAINER_BIN;
	for (const candidate of ["podman", "docker"]) {
		const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
		if (probe.status === 0) return candidate;
	}
	throw new Error("neither podman nor docker is installed (or set AL_CONTAINER_BIN)");
}

const ENGINE = detectEngine();

const args = process.argv.slice(2);
const command = args.shift() || "help";
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const value = (name, fallback) => {
	const index = args.indexOf("--" + name);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const dryRun = flags.has("--dry-run");

function run(bin, argv, { quiet = false } = {}) {
	const line = bin + " " + argv.join(" ");
	if (dryRun) {
		console.log("[dry-run] " + line);
		return Promise.resolve("");
	}
	if (!quiet) console.log("[" + ENGINE + "] " + line);
	return new Promise((resolve, reject) => {
		const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(line + " -> exit " + code + "\n" + out.trim()))));
	});
}

const engine = (argv, options) => run(ENGINE, argv, options);

async function exists(argv) {
	try {
		await engine(argv, { quiet: true });
		return true;
	} catch {
		return false;
	}
}

async function build() {
	await engine(["build", "-f", "containers/game.Dockerfile", "-t", IMAGE, "."]);
}

async function up() {
	const apiPort = value("api-port", process.env.AL_API_PORT || "8090");
	const gamePort = value("game-port", process.env.AL_GAME_PORT || "7192");
	const clone = path.resolve(value("clone", CLONE));
	const fixturesFile = value("fixtures", process.env.SEED_FIXTURES || DEFAULT_FIXTURES);

	const seed = {
		DEFAULT_EMAIL: value("seed-email", process.env.DEFAULT_EMAIL),
		DEFAULT_PASSWORD: value("seed-password", process.env.DEFAULT_PASSWORD),
		DEFAULT_CHARACTER: value("seed-character", process.env.DEFAULT_CHARACTER),
		DEFAULT_CHARACTER_TYPE: value("seed-character-type", process.env.DEFAULT_CHARACTER_TYPE),
	};
	const envArgs = Object.entries(seed)
		.filter(([, v]) => v)
		.flatMap(([name, v]) => ["-e", name + "=" + v]);

	let fixturesDir = null;
	if (fixturesFile && !flags.has("--no-fixtures")) {
		const absolute = path.resolve(fixturesFile);
		const stat = await fs.stat(absolute).catch(() => null);
		if (!stat) throw new Error("fixture file not found: " + absolute);
		fixturesDir = path.dirname(absolute);
		envArgs.push("-e", "SEED_FIXTURES=/app/fixtures/" + path.basename(absolute));
	}

	await fs.mkdir(clone, { recursive: true });
	await engine(["rm", "-f", NAME], { quiet: true }).catch(() => {});

	// :z is the SELinux relabel option - needed on Fedora-likes, harmless where SELinux is off.
	const mounts = ["-v", clone + ":/app/reference/local:z"];
	if (fixturesDir) mounts.push("-v", fixturesDir + ":/app/fixtures:ro,z");

	await engine([
		"run", "-d", "--name", NAME,
		"--restart", "on-failure:5",
		"-p", apiPort + ":8090",
		"-p", gamePort + ":7192",
		...envArgs,
		...mounts,
		IMAGE,
	]);

	console.log("");
	console.log("[al] engine " + ENGINE);
	console.log("[al] api    http://127.0.0.1:" + apiPort + "   (client page: /?watch=<character>)");
	console.log("[al] game   http://127.0.0.1:" + gamePort + "/socket.io/");
	console.log("[al] clone  " + clone);
	if (fixturesDir) console.log("[al] fixtures " + path.basename(fixturesFile));
	if (!seed.DEFAULT_EMAIL) console.log("[al] no DEFAULT_EMAIL set: only the fixture account is created");
}

async function down() {
	await engine(["rm", "-f", NAME]).catch((error) => console.log("[al] " + error.message));
}

async function status() {
	if (!(await exists(["container", "exists", NAME]))) {
		console.log("[al] not running");
		return;
	}
	console.log(await engine(["ps", "--filter", "name=" + NAME, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"], { quiet: true }));
}

async function logs() {
	const argv = ["logs", NAME];
	if (flags.has("-f") || flags.has("--follow")) argv.push("-f");
	const child = spawn(ENGINE, argv, { stdio: "inherit" });
	await new Promise((resolve) => child.on("close", resolve));
}

const commands = { build, up, down, status, logs };

if (command === "help" || !commands[command]) {
	const header = await fs.readFile(new URL(import.meta.url), "utf8").then((source) => source.split("\n").slice(1, 13).join("\n").replace(/^\/\/ ?/gm, ""));
	console.log(header);
	process.exit(command === "help" ? 0 : 1);
}

commands[command]().catch((error) => {
	console.error("[al] " + error.message);
	process.exit(1);
});
