// Fixture parsing for e2e state: who exists, what they carry, where they stand.
//
// Pure on purpose (no IO): seed_fixtures.mjs does the talking, this decides what goes into a
// character document. The shape it writes is the one the server actually uses - character.info holds
// items, slots, map/x/y, gold, hp, mp and skills, while level lives on the document itself.

import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SLOT_COUNT = 42;
export const CLASSES = ["warrior", "paladin", "rogue", "ranger", "mage", "priest", "merchant"];

/** Validate and normalise the fixture file. Throws on anything that cannot be seeded. */
export function parseFixture(raw) {
	if (!raw || typeof raw !== "object") throw new Error("the fixture must be a JSON object");
	const account = raw.account || {};
	if (account.email && typeof account.email !== "string") throw new Error("account.email must be a string");
	const characters = Array.isArray(raw.characters) ? raw.characters : [];
	if (!characters.length) throw new Error("the fixture defines no characters");
	const seen = new Set();
	const parsed = characters.map((entry, index) => {
		if (!entry || typeof entry.name !== "string" || !entry.name.trim()) throw new Error("characters[" + index + "] needs a name");
		const name = entry.name.trim();
		if (seen.has(name.toLowerCase())) throw new Error("character " + name + " is defined twice");
		seen.add(name.toLowerCase());
		const type = entry.type || entry.class || "mage";
		if (!CLASSES.includes(type)) throw new Error(name + ": unknown class " + type + " (one of " + CLASSES.join(", ") + ")");
		const map = entry.map || "main";
		const position = { x: numberOr(entry.x, 0), y: numberOr(entry.y, 0) };
		return {
			name,
			type,
			level: Math.max(1, Math.trunc(numberOr(entry.level, 1))),
			map,
			...position,
			gold: numberOr(entry.gold, 0),
			hp: optionalNumber(entry.hp),
			mp: optionalNumber(entry.mp),
			skills: entry.skills && typeof entry.skills === "object" ? entry.skills : null,
			inventory: Array.isArray(entry.inventory) ? entry.inventory : [],
			equipment: entry.equipment && typeof entry.equipment === "object" ? entry.equipment : null,
		};
	});
	return { account, characters: parsed };
}

function numberOr(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the game data that validation needs. The container has only the section files (they are
 * tracked in git, unlike raw/data.js), so this reads them directly instead of the client loader.
 */
export async function loadGameData(sectionsDir, { fallbackRoot } = {}) {
	const roots = [sectionsDir, fallbackRoot].filter(Boolean);
	let root = null;
	for (const candidate of roots) {
		const exists = await fs.stat(path.join(candidate, "items.json")).catch(() => null);
		if (exists) {
			root = candidate;
			break;
		}
	}
	if (!root) throw new Error("game data sections not found (looked in " + roots.join(", ") + ")");
	const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name + ".json"), "utf8"));
	return { items: await read("items"), skills: await read("skills"), maps: await read("maps") };
}

/** item object the way the game stores it: name, optional stack and upgrade level. */
export function normaliseItem(entry, warning) {
	if (typeof entry === "string") return { name: entry };
	if (!entry || typeof entry.name !== "string") {
		warning("an item entry has no name, skipped");
		return null;
	}
	const item = { name: entry.name };
	if (entry.q !== undefined) item.q = Math.max(1, Math.trunc(numberOr(entry.q, 1)));
	if (entry.level !== undefined) item.level = Math.max(0, Math.trunc(numberOr(entry.level, 0)));
	return item;
}

/**
 * Build the Mongo $set for one character.
 *
 * Returns { patch, warnings }. The patch uses dotted paths (level, info.items, ...) so a single
 * updateOne can apply it; warnings are non-fatal (unknown item or skill) unless --strict.
 */
export function buildFixturePatch(fixture, doc, G) {
	const warnings = [];
	const warn = (message) => warnings.push(message);
	const info = (doc && doc.info) || {};

	if (!G.maps[fixture.map]) warn("unknown map " + fixture.map + ", position left as is");

	const skillLevels = {};
	for (const [name, value] of Object.entries(fixture.skills || {})) {
		if (!G.skills[name]) {
			warn("unknown skill " + name + ", skipped");
			continue;
		}
		const level = Math.max(1, Math.trunc(numberOr(value && value.level !== undefined ? value.level : value, 1)));
		skillLevels[name] = { level };
	}

	// The bag is a fixed-length array with nulls, exactly like the game keeps it.
	const slotsUsed = [];
	const slotCount = Math.max(DEFAULT_SLOT_COUNT, Array.isArray(info.items) ? info.items.length : 0);
	const bag = new Array(slotCount).fill(null);
	for (const entry of fixture.inventory) {
		const item = normaliseItem(entry, warn);
		if (!item) continue;
		if (!G.items[item.name]) {
			warn("unknown item " + item.name + ", skipped");
			continue;
		}
		let slot = Number.isInteger(entry && entry.slot) ? entry.slot : bag.findIndex((cell, index) => cell === null && !slotsUsed.includes(index));
		if (slot < 0 || slot >= slotCount) {
			warn("slot " + slot + " for " + item.name + " is out of range, skipped");
			continue;
		}
		bag[slot] = item;
		slotsUsed.push(slot);
	}

	const equipment = {};
	for (const [slot, entry] of Object.entries(fixture.equipment || {})) {
		const item = normaliseItem(entry, warn);
		if (!item) continue;
		const def = G.items[item.name];
		if (!def) {
			warn("unknown equipment item " + item.name + ", skipped");
			continue;
		}
		// "auto" asks for the slot the item's type implies (a weapon goes to mainhand, a helmet to
		// helmet); anything else is taken verbatim because test fixtures often want ring2, offhand...
		const key = slot === "auto" ? (def.type === "weapon" ? "mainhand" : def.type) : slot;
		equipment[key] = item.level === undefined ? { name: item.name, level: 0 } : { name: item.name, level: item.level };
	}

	const patch = {
		level: fixture.level,
		"info.map": fixture.map,
		"info.in": fixture.map,
		"info.x": fixture.x,
		"info.y": fixture.y,
		"info.gold": fixture.gold,
		"info.items": bag,
	};
	if (fixture.hp !== null) patch["info.hp"] = fixture.hp;
	if (fixture.mp !== null) patch["info.mp"] = fixture.mp;
	if (fixture.skills) patch["info.skills"] = { ...(info.skills || {}), ...skillLevels };
	if (fixture.equipment) patch["info.slots"] = equipment;

	return { patch, warnings };
}
