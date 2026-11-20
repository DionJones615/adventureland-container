import assert from "node:assert/strict";
import test from "node:test";

import { buildFixturePatch, parseFixture } from "../../scripts/local/fixtures.mjs";

// Just enough game data for validation.
const G = {
	items: {
		hpot1: { name: "Health Potion I", type: "pot" },
		goo: { name: "Goo", type: "material" },
		blade: { name: "Blade", type: "weapon", wtype: "sword" },
		helmet: { name: "Helmet", type: "helmet" },
		staff: { name: "Staff", type: "weapon", wtype: "staff" },
	},
	skills: { fireball: { name: "Fireball" }, blink: { name: "Blink" } },
	maps: { main: {}, cave: {} },
};

const base = {
	name: "E2EMage",
	type: "mage",
	level: 40,
	map: "main",
	x: -100.5,
	y: 800,
	gold: 5000,
	hp: null,
	mp: null,
	skills: { fireball: { level: 30 } },
	inventory: [
		{ slot: 2, name: "hpot1", q: 100 },
		{ name: "goo", q: 10 },
	],
	equipment: { mainhand: { name: "blade", level: 5 } },
};

test("parses characters and applies defaults", () => {
	const parsed = parseFixture({ characters: [{ name: "A" }, { name: "B", class: "priest", level: 7 }] });
	assert.equal(parsed.characters[0].type, "mage");
	assert.equal(parsed.characters[0].map, "main");
	assert.equal(parsed.characters[1].type, "priest");
	assert.equal(parsed.characters[1].level, 7);
});

test("rejects duplicate names, unknown classes and empty fixtures", () => {
	assert.throws(() => parseFixture({ characters: [] }), /no characters/);
	assert.throws(() => parseFixture({ characters: [{ name: "A" }, { name: "a" }] }), /twice/);
	assert.throws(() => parseFixture({ characters: [{ name: "A", type: "bard" }] }), /unknown class/);
});

test("writes level, position, gold, items, equipment and skills", () => {
	const { patch, warnings } = buildFixturePatch(base, { info: { items: [] } }, G);
	assert.deepEqual(warnings, []);
	assert.equal(patch.level, 40);
	assert.equal(patch["info.map"], "main");
	assert.equal(patch["info.x"], -100.5);
	assert.equal(patch["info.gold"], 5000);
	assert.equal(patch["info.items"].length, 42);
	assert.deepEqual(patch["info.items"][2], { name: "hpot1", q: 100 });
	assert.deepEqual(patch["info.items"][0], { name: "goo", q: 10 }, "no slot given -> first free slot");
	assert.equal(patch["info.items"][1], null);
	assert.deepEqual(patch["info.slots"], { mainhand: { name: "blade", level: 5 } });
	assert.deepEqual(patch["info.skills"], { fireball: { level: 30 } });
});

test("keeps the existing bag length when it is larger", () => {
	const { patch } = buildFixturePatch(base, { info: { items: new Array(60).fill(null) } }, G);
	assert.equal(patch["info.items"].length, 60);
});

test("warns about unknown items, skills and maps instead of writing them", () => {
	const fixture = {
		...base,
		map: "nowhere",
		skills: { fireball: { level: 30 }, not_a_skill: { level: 3 } },
		inventory: [{ slot: 0, name: "mystery_box" }, { slot: 1, name: "goo" }],
		equipment: { mainhand: { name: "unicorn_horn" } },
	};
	const { patch, warnings } = buildFixturePatch(fixture, { info: {} }, G);
	assert.equal(warnings.length, 4);
	assert.match(warnings.join(" "), /unknown map nowhere/);
	assert.match(warnings.join(" "), /unknown skill not_a_skill/);
	assert.match(warnings.join(" "), /unknown item mystery_box/);
	assert.match(warnings.join(" "), /unknown equipment item unicorn_horn/);
	assert.equal(patch["info.items"][0], null);
	assert.deepEqual(patch["info.slots"], {});
	assert.deepEqual(Object.keys(patch["info.skills"]), ["fireball"]);
});

test("auto slot follows the item type", () => {
	const { patch } = buildFixturePatch({ ...base, equipment: { auto: { name: "helmet" }, other: { name: "staff" } } }, { info: {} }, G);
	assert.deepEqual(Object.keys(patch["info.slots"]).sort(), ["helmet", "other"]);
});

test("hp and mp are only written when given", () => {
	const without = buildFixturePatch(base, { info: {} }, G).patch;
	assert.equal("info.hp" in without, false);
	const withStats = buildFixturePatch({ ...base, hp: 321, mp: 123 }, { info: {} }, G).patch;
	assert.equal(withStats["info.hp"], 321);
	assert.equal(withStats["info.mp"], 123);
});
