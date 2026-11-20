import assert from "node:assert/strict";
import test from "node:test";

import { AccountApi, ClientError, ResponseError, findInfo } from "../../scripts/local/account_api.mjs";

/** A fetch stand-in: records requests, replays responses, and keeps Set-Cookie headers. */
function fakeFetch(responses) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url, body: JSON.parse(options.body), cookie: options.headers.cookie });
		const next = responses.shift();
		if (!next) throw new Error("no more fake responses");
		if (next instanceof Error) throw next;
		return {
			ok: next.status === undefined || next.status < 400,
			status: next.status || 200,
			headers: { getSetCookie: () => next.cookies || [] },
			json: async () => next.body,
		};
	};
	impl.calls = calls;
	return impl;
}

test("posts JSON to /api/<method> and keeps the login session", async () => {
	const fetchImpl = fakeFetch([
		{ body: { success: true, user: "US_1", auth: "abc", language: "en" }, cookies: ["auth=abc; Path=/"] },
	]);
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl });
	const session = await api.signupOrLogin({ email: "a@b.c", password: "pw" });
	assert.deepEqual(session, { user: "US_1", auth: "abc", language: "en" });
	assert.equal(fetchImpl.calls[0].url, "http://example.test/api/signup_or_login");
	assert.deepEqual(fetchImpl.calls[0].body, { email: "a@b.c", password: "pw", only_login: false, only_signup: false });
	assert.equal(api.cookieHeader, "auth=abc");
});

test("sends the cookie on later calls", async () => {
	const fetchImpl = fakeFetch([
		{ body: { success: true, user: "US_1", auth: "abc" }, cookies: ["auth=abc"] },
		{ body: { infs: [{ type: "servers_and_characters", servers: [], characters: [{ name: "E2EMage" }] }] } },
	]);
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl });
	await api.signupOrLogin({ email: "a@b.c", password: "pw" });
	const entry = await api.serversAndCharacters();
	assert.equal(entry.characters[0].name, "E2EMage");
	assert.equal(fetchImpl.calls[1].cookie, "auth=abc");
});

test("a failed body becomes a ResponseError", async () => {
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl: fakeFetch([{ body: { failed: true, reason: "not_logged_in" } }]) });
	await assert.rejects(api.serversAndCharacters(), (error) => error instanceof ResponseError && /not_logged_in/.test(error.message));
});

test("a network failure becomes a ClientError", async () => {
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl: fakeFetch([new Error("fetch failed")]) });
	await assert.rejects(api.signupOrLogin({ email: "a@b.c", password: "pw" }), (error) => error instanceof ClientError && /fetch failed/.test(error.message));
});

test("a login without user/auth is rejected", async () => {
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl: fakeFetch([{ body: { success: true } }]) });
	await assert.rejects(api.signupOrLogin({ email: "a@b.c", password: "pw" }), /no user\/auth/);
});

test("character creation posts the class and surfaces refusals", async () => {
	const fetchImpl = fakeFetch([{ body: { success: true } }, { body: { failed: true, reason: "name_taken" } }]);
	const api = new AccountApi({ baseUrl: "http://example.test", fetchImpl });
	await api.createCharacter({ name: "E2EMage", char: "mage" });
	assert.deepEqual(fetchImpl.calls[0].body, { name: "E2EMage", char: "mage", look: 0 });
	await assert.rejects(api.createCharacter({ name: "E2EMage", char: "mage" }), /name_taken/);
});

test("findInfo digs the payload out of infs", () => {
	assert.deepEqual(findInfo({ infs: [{ type: "a" }, { type: "b", value: 1 }] }, "b"), { type: "b", value: 1 });
	assert.equal(findInfo({}, "b"), undefined);
});
