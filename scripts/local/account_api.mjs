// Account API for the container's seeders: POST /api/<method> with a JSON body.
//
// This is the only HTTP the game container needs (signup, login, character list/creation); the
// fixture state itself is written straight into the character document, because inventory,
// equipment and position have no API. Extracted from the protocol client so the container repo does
// not have to ship a socket client it never uses.
//
// Endpoint: POST /api/<method> (common/handlers.js in the local stack). The response is the method's
// JSON object plus an "infs" array carrying UI-shaped side information - servers_and_characters
// returns its payload only inside infs, which is easy to miss.

export class ClientError extends Error {
	constructor(message, details) {
		super(message);
		this.name = "ClientError";
		Object.assign(this, details || {});
	}
}

export class ResponseError extends Error {
	constructor(reason, details) {
		super(reason);
		this.name = "ResponseError";
		this.reason = reason;
		Object.assign(this, details || {});
	}
}

export class AccountApi {
	constructor({ baseUrl = "http://127.0.0.1:8090", cookieName = "auth", timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.cookieName = cookieName;
		this.timeoutMs = timeoutMs;
		this.fetch = fetchImpl;
		this.cookies = new Map();
		this.session = null;
	}

	get cookieHeader() {
		if (!this.cookies.size) return "";
		return Array.from(this.cookies, ([name, value]) => name + "=" + value).join("; ");
	}

	_storeCookies(response) {
		const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
		for (const cookie of list) {
			const [pair] = cookie.split(";");
			const index = pair.indexOf("=");
			if (index <= 0) continue;
			const name = pair.slice(0, index).trim();
			const value = pair.slice(index + 1).trim();
			if (value === "" || value === "deleted") this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	async call(method, args = {}) {
		const url = this.baseUrl + "/api/" + method;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response;
		try {
			response = await this.fetch(url, {
				method: "POST",
				headers: Object.assign({ "content-type": "application/json" }, this.cookieHeader ? { cookie: this.cookieHeader } : {}),
				body: JSON.stringify(args),
				signal: controller.signal,
			});
		} catch (error) {
			throw new ClientError("POST /api/" + method + " failed: " + (error?.message || error), { cause: error });
		} finally {
			clearTimeout(timer);
		}
		this._storeCookies(response);
		let body;
		try {
			body = await response.json();
		} catch {
			throw new ClientError("POST /api/" + method + " did not return JSON (HTTP " + response.status + ")", { status: response.status });
		}
		if (!response.ok) throw new ClientError("POST /api/" + method + " returned HTTP " + response.status, { status: response.status, body });
		if (method !== "signup_or_login" && body && body.failed) throw new ResponseError(body.reason || "unknown", { method, body });
		return body;
	}

	async signupOrLogin({ email, password, onlyLogin = false, onlySignup = false } = {}) {
		if (!email || !password) throw new ClientError("email and password are required");
		// The API validates its argument names strictly: an unknown field is rejected with
		// { failed: true, reason: "invalid_field", field } before the handler ever runs.
		const body = await this.call("signup_or_login", { email, password, only_login: onlyLogin, only_signup: onlySignup });
		if (body && body.failed) throw new ResponseError(body.reason || "login_failed", { body });
		if (!body || !body.user || !body.auth) throw new ClientError("login response had no user/auth: " + JSON.stringify(body));
		this.session = { user: body.user, auth: body.auth, language: body.language || "en" };
		return this.session;
	}

	async logout() {
		const body = await this.call("logout", {});
		this.session = null;
		return body;
	}

	/** servers_and_characters keeps its payload inside infs[], not at the top level. */
	async serversAndCharacters() {
		const body = await this.call("servers_and_characters", {});
		const entry = findInfo(body, "servers_and_characters");
		if (!entry) throw new ClientError("servers_and_characters response carried no servers entry");
		return entry;
	}

	async createCharacter({ name, char: charType = "mage", look = 0 } = {}) {
		if (!name) throw new ClientError("a character name is required");
		const body = await this.call("create_character", { name, char: charType, look });
		if (body && body.failed) throw new ResponseError(body.reason || "character_creation_failed", { body });
		return body;
	}

	async characterList() {
		const entry = await this.serversAndCharacters();
		return entry.characters || [];
	}
}

export function findInfo(body, type) {
	const infs = (body && body.infs) || [];
	return infs.find((info) => info && info.type === type);
}
