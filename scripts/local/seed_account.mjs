#!/usr/bin/env node
// Create the default account once the backend answers, so a fresh container has somewhere to log in.
//
//   DEFAULT_EMAIL      account email to create (or log into, if it already exists)
//   DEFAULT_PASSWORD   its password
//   DEFAULT_CHARACTER  optional: also create this character (default class mage)
//   DEFAULT_CHARACTER_TYPE  optional: warrior | paladin | rogue | ranger | mage | priest | merchant
//
// Idempotent: signup_or_login creates the account in Dev mode and otherwise just logs in, so this can
// run on every start. Started in the background by the game container's entrypoint, before the stack
// has finished booting, and it waits for the API itself.

import { AccountApi } from "./account_api.mjs";

const email = process.env.DEFAULT_EMAIL;
const password = process.env.DEFAULT_PASSWORD;
const character = process.env.DEFAULT_CHARACTER;
const characterType = process.env.DEFAULT_CHARACTER_TYPE || "mage";
const baseUrl = process.env.AL_SEED_API || "http://127.0.0.1:" + (process.env.AL_API_PORT || "8090");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!email || !password) {
	console.log("[seed] no DEFAULT_EMAIL/DEFAULT_PASSWORD set, skipping the default account");
	process.exit(0);
}

const api = new AccountApi({ baseUrl });

async function waitForBackend(attempts = 120) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await api.call("signup_or_login", { email, password, only_login: true });
			return true;
		} catch (error) {
			const message = String(error && error.message ? error.message : error);
			// Once the backend answers, "no such account" is an answer, not a connectivity problem.
			if (!/fetch failed|ECONNREFUSED|aborted|socket hang up|network/i.test(message)) return true;
			await sleep(2_000);
		}
	}
	return false;
}

if (!(await waitForBackend())) {
	console.error("[seed] backend never answered, giving up");
	process.exit(0);
}

// Creates the account in Dev mode; an existing account just logs in. Right after the stack boots
// the backend answers before it can read the database, so retry instead of giving up.
let created = false;
for (let attempt = 1; attempt <= 200 && !created; attempt++) {
	try {
		await api.signupOrLogin({ email, password });
		created = true;
		console.log("[seed] account ready: " + email);
	} catch (error) {
		if (attempt === 30) console.error("[seed] could not create " + email + ": " + error.message);
		else await sleep(3_000);
	}
}
if (!created) process.exit(0);

if (character) {
	try {
		const { characters } = await api.serversAndCharacters();
		const names = (characters || []).map((entry) => (entry.name || "").toLowerCase());
		if (names.includes(character.toLowerCase())) {
			console.log("[seed] character already exists: " + character);
		} else {
			await api.createCharacter({ name: character, char: characterType });
			console.log("[seed] character created: " + character + " (" + characterType + ")");
		}
	} catch (error) {
		console.error("[seed] character " + character + " not created: " + error.message);
	}
}

process.exit(0);
