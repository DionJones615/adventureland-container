#!/usr/bin/env node
// Seed characters with a known inventory, equipment, skills and location - for end-to-end tests that
// need a specific starting state instead of whatever the last bot run left behind.
//
//   SEED_FIXTURES=/app/fixtures/e2e.json   (game container, applied at start)
//   node scripts/local/seed_fixtures.mjs --file fixtures/e2e.json --api http://127.0.0.1:8090
//
// Fixture file:
//
//   {
//     "account": { "email": "dev@example.test", "password": "dev-password-123" },
//     "characters": [
//       {
//         "name": "E2EMage", "type": "mage", "level": 40,
//         "map": "main", "x": -100, "y": 800, "gold": 5000, "hp": 400, "mp": 400,
//         "skills": { "fireball": { "level": 30 } },
//         "inventory": [ { "slot": 2, "name": "hpot1", "q": 100 } ],
//         "equipment": { "mainhand": { "name": "blade", "level": 5 } }
//       }
//     ]
//   }
//
// Accounts are created through the account API (Dev mode allows signup), characters through
// create_character, and the state is then written to the character document, because inventory,
// equipment and position have no API - they live in character.info.

import fs from "node:fs/promises";
import path from "node:path";
import { AccountApi } from "./account_api.mjs";
import { LOCAL, ROOT } from "./apply_config.mjs";
import { buildFixturePatch, loadGameData, parseFixture } from "./fixtures.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf("--" + name);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
};
const has = (name) => args.includes("--" + name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const api = flag("api", process.env.AL_SEED_API || "http://127.0.0.1:" + (process.env.AL_API_PORT || "8090"));
const mongoUri = flag("mongo", process.env.AL_SEED_MONGO || "mongodb://127.0.0.1:" + (process.env.AL_MONGODB_PORT || "27017") + "/adventureland");
const file = flag("file", process.env.SEED_FIXTURES);
const inline = process.env.SEED_FIXTURES_JSON;
const strict = has("strict");
const dryRun = has("dry-run");
const markerFile = path.join(LOCAL, ".state", "fixtures.ready");

if (!file && !inline) {
	console.log("[fixtures] no SEED_FIXTURES / --file given, nothing to seed");
	process.exit(0);
}

const source = inline || (await fs.readFile(file, "utf8"));
const fixtures = parseFixture(JSON.parse(source));
const G = await loadGameData(path.join(ROOT, "reference/game-data/sections"), { fallbackRoot: "/app/reference/game-data/sections" });

/**
 * Wait for a usable account session. signup_or_login is the probe on purpose: it is the one method
 * that both proves the backend can read the database and leaves the cookie jar logged in, which
 * create_character and servers_and_characters need. Failures here are expected at container start
 * (the backend answers before Mongo is up), so retry rather than report them.
 */
async function accountApi(email, password) {
	const client = new AccountApi({ baseUrl: api });
	for (let attempt = 1; attempt <= 200; attempt++) {
		try {
			if (email && password) await client.signupOrLogin({ email, password });
			return client;
		} catch (error) {
			if (attempt === 60) throw new Error("the account API never became usable on " + api + ": " + error.message);
			await sleep(3_000);
		}
	}
}

const { MongoClient } = await import(process.env.AL_MONGODB_MODULE || "mongodb");
await fs.mkdir(path.dirname(markerFile), { recursive: true });
await fs.rm(markerFile, { force: true });

const account = fixtures.account;
const email = account.email || process.env.DEFAULT_EMAIL;
const password = account.password || process.env.DEFAULT_PASSWORD;
const accounts = await accountApi(email, password);

let mongo;
let failures = 0;
try {
	if (email && password) {
		await accounts.signupOrLogin({ email, password });
		console.log("[fixtures] account ready: " + email);
	} else if (fixtures.characters.length) {
		throw new Error("the fixture needs an account: set account.email/account.password or DEFAULT_EMAIL/DEFAULT_PASSWORD");
	}

	mongo = await MongoClient.connect(mongoUri);
	const db = mongo.db();
	const collection = db.collection("character");

	for (const wanted of fixtures.characters) {
		try {
			const existing = await accounts.serversAndCharacters().catch(() => ({ characters: [] }));
			const names = (existing.characters || []).map((entry) => String(entry.name).toLowerCase());
			if (!names.includes(wanted.name.toLowerCase())) {
				await accounts.createCharacter({ name: wanted.name, char: wanted.type });
				console.log("[fixtures] created character " + wanted.name + " (" + wanted.type + ")");
				await sleep(500);
			}

			const doc = await collection.findOne({ name: wanted.name.toLowerCase() });
			if (!doc) throw new Error("character document not found for " + wanted.name);
			if (doc.online) console.log("[fixtures] warning: " + wanted.name + " looks online, the change may not reach a live session");

			const { patch, warnings } = buildFixturePatch(wanted, doc, G);
			warnings.forEach((warning) => console.log("[fixtures] " + wanted.name + ": " + warning));
			if ((strict && warnings.length) || !patch) {
				if (warnings.length) throw new Error(wanted.name + ": " + warnings.join("; "));
				throw new Error(wanted.name + ": nothing to apply");
			}

			const label = dryRun ? "[dry-run] " : "";
			console.log(label + "[fixtures] " + wanted.name + ": " + JSON.stringify(patch).slice(0, 180));
			if (!dryRun) await collection.updateOne({ _id: doc._id }, { $set: patch });
		} catch (error) {
			failures++;
			console.error("[fixtures] " + wanted.name + " failed: " + error.message);
		}
	}

	console.log("[fixtures] " + fixtures.characters.length + " character(s) seeded, " + failures + " failure(s)");
} finally {
	// The bot waits for this file; it is written even when seeding failed, so a broken fixture cannot
	// leave the pod with a bot that waits forever.
	if (!dryRun) await fs.writeFile(markerFile, JSON.stringify({ at: new Date().toISOString(), failures }) + "\n").catch(() => {});
	await mongo?.close().catch(() => {});
}

process.exit(failures ? 1 : 0);
