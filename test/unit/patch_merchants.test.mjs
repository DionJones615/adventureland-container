import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SPEC, MARKER, merchantBlock, main, parseSpec, patchSource } from "../../scripts/local/patch_merchants.mjs";

/** Write a script to a temp file, run it with node, return its stdout. */
async function runScript(source) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-merchant-run-"));
	const file = path.join(dir, "script.mjs");
	await fs.writeFile(file, source);
	try {
		return execFileSync(process.execPath, [file], { encoding: "utf8" }).trim();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("the default spec is the standmerchant on main, where the fixtures farm", () => {
	assert.deepEqual(parseSpec(), { map: "main", x: -193, y: 680, id: "standmerchant" });
	assert.deepEqual(parseSpec(DEFAULT_SPEC), parseSpec("main:-193,680"));
});

test("off means leave the stack as upstream ships it", () => {
	for (const value of ["off", "OFF", "none", "", "0", "false"]) {
		assert.equal(parseSpec(value), null, JSON.stringify(value) + " disables the patch");
	}
	// Unset means "use the default", which is the patched stack the fixtures expect.
	assert.deepEqual(parseSpec(undefined), parseSpec(DEFAULT_SPEC));
});

test("a malformed spec fails loudly instead of silently not selling", () => {
	assert.throws(() => parseSpec("main"), /off.*map:x,y/);
	assert.throws(() => parseSpec("main:left,right"), /off.*map:x,y/);
});

test("custom coordinates and maps round-trip", () => {
	const spec = parseSpec("desertland:12.5,-3");
	assert.deepEqual(spec, { map: "desertland", x: 12.5, y: -3, id: "standmerchant" });
	const source = patchSource("var maps = {};\n", spec).source;
	assert.match(source, /maps\["desertland"\]\.merchants = \[\{ id: "standmerchant", x: 12\.5, y: -3 \}\];/);
});

test("patching is idempotent: the marker is the guard", () => {
	const spec = parseSpec();
	const once = patchSource("var maps = {};\n", spec);
	assert.equal(once.changed, true);
	assert.equal(once.source.split(MARKER).length - 1, 1);
	const twice = patchSource(once.source, spec);
	assert.equal(twice.changed, false);
	assert.equal(twice.source, once.source);
	// A second run with different coordinates must not stack a second block either.
	assert.equal(patchSource(once.source, parseSpec("main:1,2")).changed, false);
});

test("the appended block is valid javascript, guards a missing map and lands where the spec says", async () => {
	const block = merchantBlock(parseSpec());
	const missing = await runScript("var maps = {};\n" + block + "\nconsole.log(JSON.stringify(maps));\n");
	assert.equal(missing, "{}", "a map that does not exist is left alone");
	const present = await runScript("var maps = { main: {} };\n" + block + "\nconsole.log(JSON.stringify(maps.main.merchants));\n");
	assert.deepEqual(JSON.parse(present), [{ id: "standmerchant", x: -193, y: 680 }]);
});

test("main() patches a file once, and off leaves it untouched", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-merchants-"));
	const file = path.join(dir, "maps.js");
	const original = "var maps = { main: {} };\n";
	await fs.writeFile(file, original);

	await main(["--file", file, "--spec", "off"]);
	assert.equal(await fs.readFile(file, "utf8"), original, "off writes nothing");

	await main(["--file", file, "--spec", "main:-193,680"]);
	const patched = await fs.readFile(file, "utf8");
	assert.equal(patched.split(MARKER).length - 1, 1);
	assert.match(patched, /maps\["main"\]\.merchants/);

	await main(["--file", file, "--spec", "main:-193,680"]);
	assert.equal(await fs.readFile(file, "utf8"), patched, "a restart does not stack a second block");

	// The patched clone must still be valid javascript for the server's eval().
	execFileSync(process.execPath, ["--check", file]);
	await fs.rm(dir, { recursive: true, force: true });
});

test("a missing clone is not an error", async () => {
	const result = await main(["--file", path.join(os.tmpdir(), "definitely-not-there-" + Date.now(), "maps.js")]);
	assert.equal(result.skipped, true);
});
