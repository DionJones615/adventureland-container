// Deep link for the local stack: /?watch=<Character>.
//
// Upstream has no URL parameter for watching: the client parses no query string, and the watch view is
// reachable only by clicking a character (js/game.js observe_character). This file is appended to the
// cloned js/game.js by scripts/local/patch_client.mjs so a URL can do the same thing.
//
// It also builds a watch HUD: the observed character is handed to the client as "character", so the
// official inventory (render_inventory) and equipment (render_slots) renderers do the work, the camera
// follows natively, and every other panel is hidden.
(function () {
	var params = new URLSearchParams(window.location.search);
	var wanted = params.get("watch") || params.get("observe") || "";
	// ?relay=1 means the relay on this machine (npm run live:relay); ?relay=<url> is explicit.
	var relayParam = params.get("relay");
	var relayUrl = relayParam === "1" || relayParam === "on" ? "http://127.0.0.1:7899" : /^https?:\/\//.test(relayParam || "") ? String(relayParam).replace(/\/+$/, "") : null;
	window.__watchShim = { wanted: wanted, relayUrl: relayUrl, search: window.location.search };
	if (!wanted && !relayUrl) return;

	var attached = null;
	var lastRefresh = 0;
	var readyAt = 0;
	var timer = setInterval(bootstrap, 500);

	function note(text) {
		console.log("[local_watch] " + text);
		if (window.add_log) {
			try {
				add_log(text, "#83BDCF");
			} catch (e) {}
		}
	}

	function matches(entry) {
		return entry && String(entry.name).toLowerCase() === wanted.toLowerCase();
	}

	/** servers_and_characters keeps the characters, secrets included, inside infs[]. */
	function refreshCharacters() {
		if (Date.now() - lastRefresh < 3000) return;
		lastRefresh = Date.now();
		fetch("/api/servers_and_characters", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
			.then(function (response) {
				return response.json();
			})
			.then(function (body) {
				var entry = ((body && body.infs) || []).filter(function (info) {
					return info && info.type === "servers_and_characters";
				})[0];
				if (!entry) return;
				window.X = window.X || {};
				window.X.characters = entry.characters || [];
				window.X.servers = entry.servers || window.X.servers;
			})
			.catch(function () {});
	}

	/**
	 * Hide every sibling of the canvas' ancestor chain: the landing panels, the tutorial/news column,
	 * the chat and skillbar containers - everything except the canvas and our HUD.
	 */
	function hideEverythingElse(hud) {
		var keep = [hud, document.getElementById("watch-skills"), document.getElementById("watch-buffs"), document.getElementById("gamelog")];
		var canvas = document.querySelector("canvas");
		if (!canvas) return;
		var chain = new Set();
		var node = canvas;
		while (node && node !== document.body) {
			chain.add(node);
			node = node.parentElement;
		}
		var containers = [document.body].concat(Array.prototype.slice.call(chain));
		containers.forEach(function (parent) {
			Array.prototype.slice.call(parent.children).forEach(function (child) {
				if (chain.has(child) || child === hud || hud.contains(child)) return;
				if (keep.some(function (node) { return node && node.contains(child); })) return;
				if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(child.tagName)) return;
				child.style.display = "none";
			});
		});
	}

	function panel(id, style) {
		var existing = document.getElementById(id);
		if (existing) return existing;
		var element = document.createElement("div");
		element.id = id;
		element.style.cssText =
			"position: fixed; z-index: 30; background: rgba(0,0,0,0.85); border: 3px solid #444; padding: 3px; " + style;
		return element;
	}

	/**
	 * Give the client the observed character as "character": the camera reads character.real_x every
	 * frame, and the inventory/equipment renderers read character.items/slots. It is a stable proxy
	 * object refreshed from the live entity, not the entity itself - the entity's real_x is only
	 * maintained while it is being drawn, and copying that (possibly undefined) value once froze the
	 * camera on a null coordinate.
	 */
	function adoptLivingEntity(watched) {
		var live = (typeof entities !== "undefined" && entities && entities[watched.id]) || {};
		var view = window.__watchView || (window.__watchView = {});
		Object.assign(view, watched, live);
		if (!live.items) view.items = (watched.items || []).slice();
		if (!live.slots) view.slots = Object.assign({}, watched.slots || {});
		if (view.isize === undefined) view.isize = watched.isize || 42;
		if (view.gold === undefined) view.gold = watched.gold || 0;
		if (view.cash === undefined) view.cash = watched.cash || 0;
		view.real_x = live.real_x === undefined ? (live.x === undefined ? watched.x : live.x) : live.real_x;
		view.real_y = live.real_y === undefined ? (live.y === undefined ? watched.y : live.y) : live.real_y;
		// draw_entities() culls every entity outside the receiving character's vision box, and a real
		// character gets one at login (js/game.js start: "if (!data.vision) character.vision = [700, 500]").
		// Without it the entities that process_entities() creates are deleted again on the next frame,
		// which is why the watch view rendered nothing but tiles.
		// Keep the client from treating this proxy as "me": process_entities() skips creating an entity
		// for the player whose id matches character.id ("if (character && character.id == player.id)
		// continue"), so claiming the watched id made the character itself invisible. The renderers only
		// need ctype/items/slots, never the id.
		view.id = "__watch__";
		view.vision = view.vision || watched.vision || [700, 500];
		view.map = view.map || watched.map || (typeof current_map !== "undefined" ? current_map : null);
		view.in = view.in || watched.in || (typeof current_in !== "undefined" ? current_in : null);
		// Deliberately NOT installed as window.character. draw() ends with
		// "if (character) update_sprite(character)", and this proxy is a plain object with no PIXI
		// texture: cosmetics_logic() would throw on sprite.texture.width, and because
		// requestAnimationFrame(draw) is the LAST statement of draw(), one throw stops the render loop
		// for good - which is what froze every entity in place. paintHud() installs it only for the
		// duration of the inventory/equipment renderers, which are the ones that need it.
		return view;
	}

	function buildHud() {
		var hud = document.getElementById("watch-hud");
		if (!hud) {
			hud = document.createElement("div");
			hud.id = "watch-hud";
			hud.style.cssText = "position: fixed; inset: 0; pointer-events: none; z-index: 30;";
			hud.appendChild(panel("watch-equipment", "top: 12px; right: 12px; pointer-events: auto;"));
			hud.appendChild(panel("watch-inventory", "bottom: 12px; right: 12px; pointer-events: auto;"));
			document.body.appendChild(hud);
		}
		return hud;
	}

	/** Render with the official renderers, then move their output into the HUD. */
	function paintHud() {
		var view = window.__watchView;
		if (!view) return;
		var hud = buildHud();
		// The renderers read window.character; install the proxy for just this call so the draw loop
		// never hands it to update_sprite (see adoptLivingEntity).
		var previousCharacter = window.character;
		window.character = view;
		try {
			if (typeof render_inventory === "function") {
				if (window.inventory) render_inventory(true);
				else {
					window.inventory = false;
					render_inventory();
				}
				var inventory = document.querySelector(".theinventory");
				if (inventory) document.getElementById("watch-inventory").appendChild(inventory);
			}
			if (typeof render_slots === "function") {
				render_slots(window.character, {});
				var slots = document.querySelector(".slots");
				if (slots) document.getElementById("watch-equipment").appendChild(slots);
			}
		} catch (error) {
			note("hud render failed: " + error.message);
		} finally {
			window.character = previousCharacter;
		}
		hideEverythingElse(hud);
	}

	/**
	 * The client's entity table only fills up once the game surface exists, and an observer never really
	 * gets one - "observing" itself is a frozen snapshot of the welcome packet. So follow the character
	 * from the socket events: entity packets carry position and destination, and new_map (emitted by the
	 * o:home recenter) carries the tile the observer was moved to.
	 */
	function trackWorld(watched) {
		var state = (window.__watchTrack = {
			x: watched.x,
			y: watched.y,
			speed: watched.speed || 100,
			moving: false,
			going_x: watched.x,
			going_y: watched.y,
			stamp: Date.now(),
		});
		function merge(entity) {
			// window.__watchName is the character the page is following right now: clicking another row in
			// the party panel retargets this tracker instead of re-binding every socket handler.
			var followed = (typeof window !== "undefined" && window.__watchName) || watched.name;
			if (!entity || String(entity.id).toLowerCase() !== String(followed).toLowerCase()) return;
			if (entity.x !== undefined) {
				state.x = entity.x;
				state.y = entity.y;
			}
			if (entity.speed) state.speed = entity.speed;
			// Buffs/debuffs: the server sends the status map ("s": {condition: {ms, ...}}) and the
			// condition map ("c") on entity updates. Keep both, plus when we first saw each entry so the
			// remaining time can be ticked down locally between packets.
			state.seenAt = state.seenAt || {};
			if (entity.s || entity.c) {
				var now = Date.now();
				var next = Object.assign({}, entity.c || {}, entity.s || {});
				Object.keys(next).forEach(function (name) {
					var ms = next[name] && next[name].ms;
					var previous = state.seenAt[name];
					if (!previous || previous.ms !== ms) state.seenAt[name] = { ms: ms, at: now };
				});
				Object.keys(state.seenAt).forEach(function (name) {
					if (!(name in next)) delete state.seenAt[name];
				});
				state.s = entity.s || state.s || {};
				state.c = entity.c || state.c || {};
				state.statuses = next;
			}
			if (entity.going_x !== undefined) {
				state.going_x = entity.going_x;
				state.going_y = entity.going_y;
				state.moving = Boolean(entity.moving);
			} else if (entity.moving === false) {
				state.moving = false;
			}
			state.stamp = Date.now();
		}
		// attach() destroys the page's socket before reconnecting, so the handlers must be bound to
		// whichever socket exists *after* the observe connect - hence the late bind() below.
		state.bind = function () {
			if (!socket || !socket.on || state.bound === socket) return;
			state.bound = socket;
			socket.on("entities", function (data) {
				if (!data) return;
				[data.players, data.monsters].forEach(function (list) {
					(list || []).forEach(merge);
				});
			});
			socket.on("u", merge);
			socket.on("player", merge);
			// Skill activations: the server broadcasts "action" for attacks and skills to nearby observers
			// (source carries the skill name), and "skill_timeout" when the character's own socket is told
			// about a cooldown. Both are recorded so the panel can flash and count down.
			window.__watchUses = window.__watchUses || {};
			socket.on("action", function (data) {
				if (!data || !data.attacker) return;
				if (String(data.attacker).toLowerCase() !== String(watched.name).toLowerCase()) return;
				var name = data.source || data.type || "attack";
				window.__watchUses[name] = Date.now();
				window.__watchUses.attack = window.__watchUses.attack || Date.now();
			});
			socket.on("skill_timeout", function (data) {
				if (!data || !data.name) return;
				window.__watchUses[data.name] = Date.now();
			});
			// Log transcript: chat, and the combat the watcher actually cares about.
			var nameOf = String(watched.name).toLowerCase();
			socket.on("chat_log", function (data) {
				if (!data || typeof data.message !== "string") return;
				logLine((data.owner || data.id || "?") + ": " + data.message, "#e8e8e8");
			});
			socket.on("hit", function (data) {
				if (!data) return;
				var hitter = String(data.hid || data.attacker || "").toLowerCase();
				var target = String(data.id || "").toLowerCase();
				var damage = Math.round(data.damage || 0);
				if (hitter === nameOf) logLine(watched.name + " hit " + data.id + " for " + damage, "#f0c674");
				else if (target === nameOf) logLine(data.hid || data.attacker || "?" + " hit " + watched.name + " for " + damage, "#cf6b5b");
			});
			socket.on("action", function (data) {
				if (!data || String(data.attacker || "").toLowerCase() !== nameOf) return;
				var source = data.source || data.type;
				if (source && source !== "attack") logLine(watched.name + " used " + source, "#83BDCF");
			});
			socket.on("new_map", function (data) {
				if (!data) return;
				state.x = data.x;
				// The query carries desktop=1, and the server places such an observer 120px below the
				// player; without this the camera sits a character-height low and the character is drawn
				// near the top of the screen.
				state.y = data.y - 120;
				state.moving = false;
				state.stamp = Date.now();
			});
		};
		return state;
	}

	/** Entity packets carry destinations; interpolate between them like the client does. */
	function advance(state, now) {
		if (!state.moving) return state;
		var dt = Math.min(0.5, Math.max(0, (now - state.stamp) / 1000));
		state.stamp = now;
		var dx = state.going_x - state.x;
		var dy = state.going_y - state.y;
		var distance = Math.sqrt(dx * dx + dy * dy);
		if (distance < 1) {
			state.moving = false;
			return state;
		}
		var step = Math.min(distance, state.speed * dt);
		state.x += (dx / distance) * step;
		state.y += (dy / distance) * step;
		return state;
	}

	/** The skills this character can use: attack plus every class skill in G.skills. */
	function skillsFor(view) {
		var names = ["attack"];
		var skills = (typeof G !== "undefined" && G.skills) || {};
		Object.keys(skills).forEach(function (name) {
			var skill = skills[name];
			if (skill && skill.type === "skill" && (skill.class || []).indexOf(view.ctype) !== -1) names.push(name);
		});
		return names;
	}

	/**
	 * Cooldown of a skill in ms, resolved the way the game does it
	 * (js/functions.js skill_timeout_singular: cooldown, reuse_cooldown, shared cooldown, attack frequency).
	 */
	function skillCooldownMs(name, view) {
		var skills = (typeof G !== "undefined" && G.skills) || {};
		var skill = skills[name];
		if (!skill) return 0;
		if (skill.cooldown) return skill.cooldown;
		if (skill.reuse_cooldown) return skill.reuse_cooldown;
		if (skill.share && skills[skill.share]) return (skills[skill.share].cooldown || 0) * (skill.cooldown_multiplier || 1);
		if (name === "attack" && view && view.frequency) return 1000 / view.frequency;
		return 0;
	}

	function ensureSkillsPanel() {
		var panel = document.getElementById("watch-skills");
		if (panel) return panel;
		panel = document.createElement("div");
		panel.id = "watch-skills";
		panel.style.cssText =
			"position: fixed; left: 12px; bottom: 12px; z-index: 31; background: rgba(0,0,0,0.85); border: 3px solid #444; " +
			"padding: 6px; display: flex; gap: 6px; pointer-events: none; width: max-content; height: auto; " +
			"align-items: flex-start; flex-wrap: nowrap;";
		var style = document.createElement("style");
		// !important throughout: the client re-styles #gamelog as it logs, and plain inline styles lose.
		style.textContent =
			"#watch-skills .wsk.on{border-color:#ffd166!important;box-shadow:0 0 10px #ffd166}" +
			"#watch-skills .wsk{position:relative;width:48px;text-align:center;border:2px solid #555;background:#000}" +
			"#gamelog{position:fixed!important;left:12px!important;top:12px!important;width:360px!important;" +
			"height:200px!important;overflow-y:scroll!important;z-index:31!important;border:3px solid #444!important;" +
			"padding:4px!important;background:rgba(0,0,0,0.85)!important;pointer-events:none!important;display:block!important}";
		document.head.appendChild(style);
		// Mount inside the HUD, creating it first: a body-level panel would be hidden by
		// hideEverythingElse() on its next pass (it only spares the canvas chain and the HUD).
		var hud = buildHud();
		hud.appendChild(panel);
		ensureLogPanel();
		return panel;
	}

	function buildSkills(view) {
		var panel = ensureSkillsPanel();
		var names = skillsFor(view);
		var signature = names.join(",");
		if (panel.dataset.signature === signature) return panel;
		panel.dataset.signature = signature;
		panel.innerHTML = names
			.map(function (name) {
				var skill = (typeof G !== "undefined" && G.skills && G.skills[name]) || {};
				var icon = "";
				try {
					// G.images has no entry for skill skins, so sprite() renders nothing; item_container is
					// what the game's own skillbar uses for these icons.
					// No skid: item_container prints the skid as a keymap label, and we draw our own cooldown.
					icon = item_container({ skin: skill.skin || name, draggable: false, size: 40 });
				} catch (error) {
					icon = "";
				}
				return (
					'<div class="wsk" data-skill="' + name + '">' +
					'<div style="width:48px;height:48px;overflow:hidden;margin:0 auto">' + icon + "</div>" +
					'<div class="cd" style="position:absolute;left:0;top:0;width:48px;background:rgba(0,0,0,0.72);height:0%"></div>' +
					'<div class="left" style="position:absolute;left:0;top:0;width:48px;height:48px;line-height:48px;color:#ffd166;font-size:15px;text-shadow:0 0 4px #000"></div>' +
					'<div style="font-size:10px;color:#bbb;line-height:12px;height:12px;overflow:hidden;white-space:nowrap">' +
					(skill.name || name) +
					"</div></div>"
				);
			})
			.join("");
		return panel;
	}

	/** Cooldown fill, remaining seconds, and a flash for the skill that was just used. */
	function paintSkills(view) {
		var panel = document.getElementById("watch-skills");
		if (!panel) return;
		var now = Date.now();
		var uses = window.__watchUses || {};
		var cells = panel.querySelectorAll(".wsk");
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			var name = cell.getAttribute("data-skill");
			var used = uses[name] || 0;
			var total = skillCooldownMs(name, view);
			var remaining = total ? Math.max(0, total - (now - used)) : 0;
			var overlay = cell.querySelector(".cd");
			var label = cell.querySelector(".left");
			if (overlay) overlay.style.height = Math.round((total ? remaining / total : 0) * 100) + "%";
			if (label) label.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
			cell.classList.toggle("on", now - used < 400);
		}
	}

	/** Active buffs/debuffs, with the remaining time ticked down between packets. */
	function activeStatuses(view) {
		var state = window.__watchTrack || {};
		var merged = Object.assign({}, (view && view.c) || {}, (view && view.s) || {}, state.c || {}, state.s || {}, state.statuses || {});
		var now = Date.now();
		var out = [];
		Object.keys(merged).forEach(function (name) {
			var entry = merged[name] || {};
			var def = (typeof G !== "undefined" && ((G.conditions && G.conditions[name]) || (G.skills && G.skills[name]))) || null;
			var skin = entry.skin || (def && def.skin);
			// The client shows a status when it has a skin, or when the definition is marked as ui
			// (js/html.js render_conditions).
			if (!skin) return;
			// "technical" marks account/plumbing statuses (notverified, authfail) rather than gameplay
			// effects; a watcher wants the buffs, not the account warnings.
			if (def && def.technical) return;
			var total = entry.ms || (def && def.duration) || 0;
			var seen = state.seenAt && state.seenAt[name];
			var remaining = total;
			if (seen && seen.at) remaining = Math.max(0, total - (now - seen.at));
			out.push({
				name: name,
				label: (def && def.name) || name,
				skin: skin,
				remaining: remaining,
				total: total,
				bad: Boolean(def && (def.debuff || def.bad)),
			});
		});
		return out;
	}

	/**
	 * The client's own log panel (#gamelog). It ships with the welcome/update notes and receives whatever
	 * the client logs; we show it and append the events a watcher cares about (chat, hits, skill use).
	 */
	function ensureLogPanel() {
		var log = document.getElementById("gamelog");
		if (!log) return null;
		// Move it into the HUD: its original ancestors are part of the landing layout, which
		// hideEverythingElse() removes, and a hidden ancestor hides the log regardless of its own styles.
		var hud = buildHud();
		if (log.parentElement !== hud) hud.appendChild(log);
		log.scrollTop = log.scrollHeight;
		return log;
	}

	function logLine(text, color) {
		try {
			if (typeof add_log === "function") add_log(text, color || "#e8e8e8");
		} catch (error) {}
		window.__watchLogCount = (window.__watchLogCount || 0) + 1;
		var log = ensureLogPanel();
		if (log) log.scrollTop = log.scrollHeight;
	}

	function ensureBuffsPanel() {
		var panel = document.getElementById("watch-buffs");
		if (panel) return panel;
		panel = document.createElement("div");
		panel.id = "watch-buffs";
		panel.style.cssText =
			"position: fixed; left: 12px; bottom: 104px; z-index: 31; background: rgba(0,0,0,0.85); border: 3px solid #444; " +
			"padding: 6px; display: flex; gap: 6px; pointer-events: none; width: max-content; height: auto; align-items: flex-start;";
		buildHud().appendChild(panel);
		return panel;
	}

	function paintBuffs(view) {
		var panel = ensureBuffsPanel();
		var statuses = activeStatuses(view);
		var signature = statuses.map(function (entry) { return entry.name; }).join(",");
		if (panel.dataset.signature !== signature) {
			panel.dataset.signature = signature;
			panel.innerHTML = statuses
				.map(function (entry) {
					var icon = "";
					try {
						icon = item_container({ skin: entry.skin, draggable: false, size: 34 });
					} catch (error) {
						icon = "";
					}
					return (
						'<div class="wbf" data-status="' + entry.name + '" style="position:relative;width:42px;text-align:center">' +
						'<div style="width:42px;height:42px;overflow:hidden;margin:0 auto">' + icon + "</div>" +
						'<div class="bar" style="height:4px;background:#222;margin-top:2px"><div style="height:4px;width:100%;background:' +
						(entry.bad ? "#c0563f" : "#6fbf73") +
						'"></div></div>' +
						'<div style="font-size:10px;color:#bbb;line-height:12px;height:12px;overflow:hidden;white-space:nowrap">' +
						entry.label +
						"</div></div>"
					);
				})
				.join("");
			panel.style.display = statuses.length ? "flex" : "none";
		}
		var cells = panel.querySelectorAll(".wbf");
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			var current = statuses[i];
			if (!current) continue;
			var ratio = current.total ? Math.max(0, Math.min(1, current.remaining / current.total)) : 0;
			var fill = cell.querySelector(".bar div");
			if (fill) fill.style.width = Math.round(ratio * 100) + "%";
		}
	}

	// ---- relay mode: the party plays elsewhere, the page renders what the relay sends ------------
	//
	// The local client is a renderer; with ?relay=1 its data source is a local SSE stream instead of
	// the local game server. Frames are injected through original_onevent - the very function the
	// socket uses for its own inbound packets (js/game.js keeps a copy before wrapping it) - so the
	// client's own process_entities(), hit/chat handling, camera and HUD panels run unchanged.

	function inject(event, data) {
		try {
			// socket.io buffers onevent() packets while the socket is not connected (receiveBuffer), which
			// is exactly the relay's situation: the page's own socket may never connect. emitEvent() is
			// the dispatcher onevent() calls once connected, so it delivers the packet either way.
			if (socket && typeof socket.emitEvent === "function") {
				socket.emitEvent([event, data]);
			} else {
				var dispatch = typeof original_onevent === "function" ? original_onevent : socket && socket.onevent;
				if (!dispatch) return false;
				dispatch.apply(socket, [{ type: 2, nsp: "/", data: [event, data] }]);
			}
			window.__watchRelay = window.__watchRelay || { frames: 0, events: 0 };
			window.__watchRelay.events++;
			return true;
		} catch (error) {
			note("inject " + event + " failed: " + error.message);
			return false;
		}
	}

	function ensureStaleBanner() {
		var banner = document.getElementById("watch-stale");
		if (banner) return banner;
		banner = document.createElement("div");
		banner.id = "watch-stale";
		banner.style.cssText =
			"position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 40; background: rgba(0,0,0,0.85); " +
			"border: 3px solid #7a4b3a; color: #f2c1a8; padding: 6px 14px; font: 13px monospace; display: none;";
		banner.textContent = "no live data - is the relay running (npm run live:relay)?";
		buildHud().appendChild(banner);
		return banner;
	}

	function setStale(stale) {
		var banner = ensureStaleBanner();
		banner.style.display = stale ? "block" : "none";
	}

	// ---- partywatch: one camera for the whole party ----------------------------------------------
	//
	// The relay sends every publisher's position, so the group can be framed as a whole: centre on the
	// bounding box of the party members on the current map and pull the zoom back until the box fits.
	// The client's camera math (position_map) reads the global `scale` and the map container's scale, so
	// both move together - nothing else in the renderer needs to know.

	function watchName() {
		return window.__watchName || wanted || "";
	}

	/** Party members the relay knows about, on the map the camera is on. */
	function partyMembers(frame) {
		var self = (frame && frame.self) || null;
		if (!self) return [];
		return ((frame && frame.sources) || []).filter(function (entry) {
			return entry && entry.map === self.map && Number.isFinite(entry.x) && Number.isFinite(entry.y);
		});
	}

	/** The party's bounding box, or null when there is nothing to frame (fewer than two members). */
	function partyBox(frame) {
		var members = partyMembers(frame);
		if (members.length < 2) return null;
		var minX = Infinity;
		var maxX = -Infinity;
		var minY = Infinity;
		var maxY = -Infinity;
		members.forEach(function (entry) {
			minX = Math.min(minX, entry.x);
			maxX = Math.max(maxX, entry.x);
			minY = Math.min(minY, entry.y);
			maxY = Math.max(maxY, entry.y);
		});
		return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, count: members.length };
	}

	function baseScale() {
		var value = window.__watchBaseScale;
		if (!Number.isFinite(value) || value <= 0) value = typeof scale === "number" && scale > 0 ? scale : 2;
		return value;
	}

	/** Move the global zoom and the map container together: position_map() reads the global. */
	function setMapScale(value) {
		try {
			if (typeof map === "object" && map && map.scale) {
				if (typeof map.scale.set === "function") map.scale.set(value, value);
				map.scale.x = value;
				map.scale.y = value;
			}
		} catch (error) {
			note("map scale failed: " + error.message);
		}
		scale = value;
	}


	/** Name markers over the canvas: at partywatch zoom the sprites are small, the labels are not. */
	function ensureMarkers() {
		var layer = document.getElementById("watch-markers");
		if (layer) return layer;
		layer = document.createElement("div");
		layer.id = "watch-markers";
		layer.style.cssText =
			"position: fixed; inset: 0; pointer-events: none; z-index: 29; display: none; font: 11px monospace;";
		buildHud().appendChild(layer);
		return layer;
	}

	function paintMarkers() {
		var layer = ensureMarkers();
		var frame = window.__watchPartyFrame;
		var self = (frame && frame.self) || null;
		if (window.__watchMode !== "party" || !self) {
			layer.style.display = "none";
			return;
		}
		layer.style.display = "block";
		var sources = partyMembers(frame);
		var viewW = typeof width === "number" && width > 0 ? width : window.innerWidth;
		var viewH = typeof height === "number" && height > 0 ? height : window.innerHeight;
		var zoom = Number(scale) || 1;
		var cx = viewW / 2;
		var cy = viewH / 2;
		var signature = sources.map(function (entry) { return entry.name; }).join("|");
		if (layer.dataset.signature !== signature) {
			layer.dataset.signature = signature;
			layer.innerHTML = sources
				.map(function (entry) {
					return (
						'<div class="wm" data-name="' + entry.name + '" style="position:absolute;white-space:nowrap;color:#e6edf3;text-shadow:0 0 3px #000,0 0 3px #000">' +
						'<span class="wm-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#6fbf73;margin-right:4px;vertical-align:middle"></span>' +
						'<span class="wm-name"></span></div>'
					);
				})
				.join("");
		}
		var nodes = layer.querySelectorAll(".wm");
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			var entry = null;
			for (var j = 0; j < sources.length; j++) if (sources[j].name === node.dataset.name) entry = sources[j];
			if (!entry) continue;
			// Same projection the renderer uses: screen = viewport centre + (world - camera) * zoom.
			var sx = cx + (entry.x - map.real_x) * zoom;
			var sy = cy + (entry.y - map.real_y) * zoom;
			var margin = 26;
			var inside = sx >= margin && sx <= viewW - margin && sy >= margin && sy <= viewH - margin;
			var distance = Math.round(Math.sqrt(Math.pow(entry.x - map.real_x, 2) + Math.pow(entry.y - map.real_y, 2)));
			node.style.left = Math.round(Math.max(margin, Math.min(viewW - margin, sx))) + "px";
			node.style.top = Math.round(Math.max(margin, Math.min(viewH - margin, sy))) + "px";
			node.style.opacity = inside ? "1" : "0.65";
			node.querySelector(".wm-name").textContent = entry.name + (inside ? "" : "  " + distance + "u");
			node.querySelector(".wm-dot").style.background = self.id && entry.name === self.id ? "#8fbcbb" : "#6fbf73";
		}
	}

	/** Zoom out just enough to fit the box (plus a margin), never past the normal zoom. */
	function fitScale(box) {
		var viewW = (typeof width === "number" && width > 0 ? width : window.innerWidth) || 1200;
		var viewH = (typeof height === "number" && height > 0 ? height : window.innerHeight) || 800;
		var fit = Math.min(viewW / Math.max(1, box.w + 260), viewH / Math.max(1, box.h + 260));
		return Math.max(0.45, Math.min(baseScale(), fit));
	}

	function enterPartyWatch() {
		window.__watchMode = "party";
		window.__watchCam = null;
		// Fit at once: a slow zoom-out from the single-character zoom looks like a bug.
		var box = partyBox(window.__watchPartyFrame);
		setMapScale(box ? fitScale(box) : baseScale());
		document.title = "watching the party (live)";
		note("partywatch on (" + partyMembers(window.__watchPartyFrame).length + " members)");
	}

	function leavePartyWatch() {
		window.__watchMode = "follow";
		window.__watchCam = null;
		setMapScale(baseScale());
		document.title = "watching " + (watchName() || "the party") + " (live)";
		note("partywatch off");
	}

	/** Follow one character from now on: re-open the stream with that name as the camera. */
	function focusOn(name) {
		if (!name) return;
		if (window.__watchMode === "party") window.__watchMode = "follow";
		window.__watchCam = null;
		setMapScale(baseScale());
		window.__watchName = name;
		window.observing = null;
		var entry = null;
		((window.__watchPartyFrame && window.__watchPartyFrame.sources) || []).forEach(function (source) {
			if (source && String(source.name).toLowerCase() === String(name).toLowerCase()) entry = source;
		});
		if (entry && window.__watchTrack) {
			window.__watchTrack.x = entry.x;
			window.__watchTrack.y = entry.y;
			window.__watchTrack.going_x = entry.x;
			window.__watchTrack.going_y = entry.y;
			window.__watchTrack.moving = false;
			window.__watchTrack.stamp = Date.now();
		}
		document.title = "watching " + name + " (live)";
		startRelay(name);
		note("following " + name);
	}

	function ensurePartyPanel() {
		var panel = document.getElementById("watch-party");
		if (panel) return panel;
		panel = document.createElement("div");
		panel.id = "watch-party";
		panel.style.cssText =
			"position: fixed; left: 12px; top: 296px; z-index: 31; background: rgba(8,10,14,0.88); border: 3px solid #444; " +
			"padding: 7px 9px; font: 12px monospace; color: #d8dee9; pointer-events: auto; width: 268px;";
		// One delegated handler for the whole panel: the roster is rebuilt on every roster change, so
		// per-row listeners would have to be re-attached. A click names either the partywatch chip or
		// one of the characters; stopPropagation() keeps it out of the map's click handlers.
		panel.addEventListener("click", function (event) {
			event.stopPropagation();
			var target = event.target;
			var chip = target && target.closest ? target.closest(".wp-mode") : null;
			if (chip) {
				if (window.__watchMode === "party") leavePartyWatch();
				else enterPartyWatch();
				return;
			}
			var row = target && target.closest ? target.closest(".wp-row") : null;
			if (row && row.dataset.name) focusOn(row.dataset.name);
		});
		buildHud().appendChild(panel);
		return panel;
	}

	/** The panel is built once per roster; the numbers are updated in place every frame. */
	function paintParty(frame) {
		var panel = ensurePartyPanel();
		var me = (frame && frame.self) || {};
		// Never draw in arrival order: the relay publishes to a timestamped merge, so a row would jump
		// every frame. The watched character sits first, everyone else alphabetically.
		var sources = ((frame && frame.sources) || []).slice().sort(function (a, b) {
			var aFirst = String(a.name).toLowerCase() === String(me.id || "").toLowerCase() ? 0 : 1;
			var bFirst = String(b.name).toLowerCase() === String(me.id || "").toLowerCase() ? 0 : 1;
			return aFirst - bFirst || String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
		});
		if (sources.length < 2) {
			panel.style.display = "none";
			return;
		}
		panel.style.display = "block";
		var signature = sources.map(function (entry) { return entry.name + ":" + entry.role; }).join("|");
		if (panel.dataset.signature !== signature) {
			panel.dataset.signature = signature;
			var html = [
				'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
					'<span style="color:#8fbcbb;letter-spacing:1px">PARTY</span>' +
					'<span class="wp-mode" style="cursor:pointer;border:1px solid #3c4652;padding:1px 6px;font-size:11px;color:#8fbcbb">partywatch</span>' +
					"</div>",
			];
			sources.forEach(function (entry) {
				html.push(
					'<div class="wp-row" data-name="' + entry.name + '" title="watch ' + entry.name + '" style="cursor:pointer;margin-bottom:7px">' +
						'<div style="display:flex;justify-content:space-between;gap:6px">' +
						'<span class="wp-name" style="color:#e6edf3"></span>' +
						'<span class="wp-role" style="color:#6e7681"></span>' +
						"</div>" +
						'<div class="wp-hp" style="height:5px;background:#262b33;margin-top:2px"><i style="display:block;height:5px;background:#6fbf73"></i></div>' +
						'<div class="wp-mp" style="height:3px;background:#262b33;margin-top:1px"><i style="display:block;height:3px;background:#5a9bd5"></i></div>' +
						'<div class="wp-meta" style="color:#9aa5b1;font-size:11px;margin-top:2px"></div>' +
						'<div class="wp-stats" style="color:#7f8894;font-size:11px"></div>' +
						"</div>",
				);
			});
			panel.innerHTML = html.join("");
		}
		var mode = panel.querySelector(".wp-mode");
		if (mode) {
			var on = window.__watchMode === "party";
			mode.textContent = on ? "partywatch on" : "partywatch";
			mode.style.background = on ? "#8fbcbb" : "transparent";
			mode.style.color = on ? "#0b1014" : "#8fbcbb";
		}
		var rows = panel.querySelectorAll(".wp-row");
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var entry = null;
			for (var j = 0; j < sources.length; j++) if (sources[j].name === row.dataset.name) entry = sources[j];
			if (!entry) continue;
			row.querySelector(".wp-name").textContent = entry.name;
			row.querySelector(".wp-role").textContent = entry.role || "";
			var hp = row.querySelector(".wp-hp i");
			var mp = row.querySelector(".wp-mp i");
			if (hp) hp.style.width = (entry.max_hp ? Math.round((entry.hp / entry.max_hp) * 100) : 0) + "%";
			if (mp) mp.style.width = (entry.max_mp ? Math.round((entry.mp / entry.max_mp) * 100) : 0) + "%";
			var distance = Math.round(Math.sqrt(Math.pow((entry.x || 0) - (me.x || 0), 2) + Math.pow((entry.y || 0) - (me.y || 0), 2)));
			row.querySelector(".wp-meta").textContent =
				Math.round(entry.hp || 0) + "/" + Math.round(entry.max_hp || 0) + " hp   " + Math.round(entry.mp || 0) + " mp   " + distance + "u   " + Math.round(entry.gold || 0) + "g";
			var counters = entry.counters || {};
			row.querySelector(".wp-stats").textContent =
				"atk " + (counters.attacks || 0) + "  kills " + (counters.kills || 0) + "  chests " + (counters.chests || 0) + "  sent " + (counters.sent || 0) + "  sold " + (counters.sold || 0);
			var followed = window.__watchMode !== "party" && entry.name && me.id && String(entry.name).toLowerCase() === String(me.id).toLowerCase();
			row.style.opacity = followed ? "1" : "0.85";
			row.style.borderLeft = followed ? "3px solid #8fbcbb" : "3px solid transparent";
		}
	}


	/** One merged frame from the relay becomes the packets the client already knows how to handle. */
	function applyFrame(frame) {
		if (!frame) return;
		window.__watchLastFrame = Date.now();
		setStale(false);
		window.__watchRelay = window.__watchRelay || { frames: 0, events: 0 };
		window.__watchRelay.frames++;
		// Kept for the party camera and the panel clicks: every publisher's live position.
		window.__watchPartyFrame = frame;
		if (!frame.self) return;
		var self = frame.self;
		if (!window.__watchSeenSelf) {
			window.__watchSeenSelf = true;
			if (!window.__watchTrack) trackWorld({ name: self.id, x: self.x || 0, y: self.y || 0, speed: self.speed || 100 });
			// The client needs a map before it can draw anything, and it only builds one from "welcome".
			inject("welcome", {
				map: self.map || "main",
				in: self.in || self.map || "main",
				x: self.x || 0,
				y: self.y || 0,
				region: "live",
				name: "relay",
				S: {},
				pvp: 0,
				gameplay: "normal",
			});
			window.__watchEventN = 0;
			window.__watchIds = {};
			// The welcome handler builds the game surface; if it could not (no map data yet), try once
			// more now that the character and its map are known.
			if (typeof game_loaded !== "undefined" && !game_loaded && typeof launch_game === "function") {
				try {
					launch_game();
				} catch (error) {
					note("launch_game failed: " + error.message);
				}
			}
		} else if (self.map && typeof current_map !== "undefined" && self.map !== current_map) {
			// The party changed map: rebuild the world view for the new one.
			inject("new_map", { name: self.map, in: self.in || self.map, x: self.x || 0, y: self.y || 0 });
		}
		window.observing = self;
		// The client's handler drops any entity packet whose "in" is not the map it is showing
		// ("Disregarded stale entities response"), so the map travels with the snapshot.
		inject("entities", {
			in: self.in || self.map,
			players: (frame.entities && frame.entities.players) || [],
			monsters: (frame.entities && frame.entities.monsters) || [],
			npcs: (frame.entities && frame.entities.npcs) || [],
		});
		// Anything that was here and is not any more has left the world: tell the client, or it keeps
		// animating a ghost at its last destination.
		var present = {};
		for (var list in { players: 1, monsters: 1, npcs: 1 }) {
			((frame.entities && frame.entities[list]) || []).forEach(function (entity) {
				if (entity && entity.id !== undefined) present[String(entity.id)] = true;
			});
		}
		Object.keys(window.__watchIds || {}).forEach(function (id) {
			if (present[id]) return;
			delete window.__watchIds[id];
			inject("disappear", { id: id });
		});
		Object.keys(present).forEach(function (id) {
			window.__watchIds[id] = true;
		});
		// Events are a replay buffer on the relay: inject only what this page has not seen yet.
		var events = frame.events || [];
		for (var i = 0; i < events.length; i++) {
			var event = events[i];
			if (!event || typeof event.n !== "number" || event.n <= window.__watchEventN) continue;
			window.__watchEventN = event.n;
			if (event.name && event.data) inject(event.name, event.data);
		}
		paintParty(frame);
	}

	function pinCameraToTrack() {
		var originalPositionMap = window.position_map;
		if (window.__watchPinned || typeof originalPositionMap !== "function") return;
		window.__watchPinned = true;
		window.position_map = function () {
			// In partywatch the zoom is settled *before* the client computes the map's screen offset: the
			// offset is width/2 - real_x * scale, so a scale applied afterwards would lag a frame.
			if (window.__watchMode === "party") {
				var box = partyBox(window.__watchPartyFrame);
				if (box && typeof scale === "number") {
					var want = fitScale(box);
					var next = Math.abs(want - scale) < 0.01 ? want : scale + (want - scale) * 0.35;
					setMapScale(next);
				}
			}
			originalPositionMap();
			if (typeof map === "undefined" || !map) return;
			if (window.__watchMode === "party") {
				var party = partyBox(window.__watchPartyFrame);
				if (party) {
					var cam = window.__watchCam || (window.__watchCam = { x: party.x, y: party.y });
					cam.x += (party.x - cam.x) * 0.25;
					cam.y += (party.y - cam.y) * 0.25;
					map.real_x = Math.round(cam.x);
					map.real_y = Math.round(cam.y);
					return;
				}
			}
			var state = window.__watchTrack;
			if (!state) return;
			var live = observing && typeof entities !== "undefined" ? entities[observing.id] : null;
			map.real_x = live && live.real_x !== undefined ? live.real_x : state.x;
			map.real_y = live && live.real_y !== undefined ? live.real_y : state.y;
		};
	}

	function startRelay(focusName) {
		var name = focusName !== undefined ? focusName : watchName();
		window.__watchName = name || "";
		if (window.EventSource) {
			try {
				if (window.__watchSource) window.__watchSource.close();
				var url = relayUrl + "/events" + (name ? "?watch=" + encodeURIComponent(name) : "");
				var source = new EventSource(url);
				window.__watchSource = source;
				source.addEventListener("frame", function (event) {
					var frame = null;
					try {
						frame = JSON.parse(event.data);
					} catch (error) {
						return;
					}
					applyFrame(frame);
				});
				source.onerror = function () {
					setStale(true);
				};
				note("relay " + url);
			} catch (error) {
				note("relay failed: " + error.message);
			}
		}
		if (window.__watchStaleTimer) clearInterval(window.__watchStaleTimer);
		window.__watchStaleTimer = setInterval(function () {
			setStale(!window.__watchLastFrame || Date.now() - window.__watchLastFrame > 5000);
		}, 1000);
	}

	function attachRelay() {
		attached = wanted || "relay";
		// The zoom the page loaded with is the "normal" zoom: partywatch pulls back from it and every
		// switch back to a single character returns to it.
		window.__watchBaseScale = typeof scale === "number" && scale > 0 ? scale : 2;
		window.__watchMode = window.__watchMode || "follow";
		window.__watchName = window.__watchName || wanted || "";
		// The game surface is built by the injected "welcome" (its handler calls launch_game once the
		// map is known); calling it here, before any map exists, only throws.
		try {
			window.inside = "game";
		} catch (error) {
			note("could not enter game mode: " + error.message);
		}
		ensureSkillsPanel();
		ensureLogPanel();
		ensureBuffsPanel();
		ensurePartyPanel();
		pinCameraToTrack();
		document.title = "watching " + (wanted || "the party") + " (live)";
		note("relay mode: " + (watchName() || "newest publisher") + " from " + relayUrl);
		startRelay();
		if (window.__watchLoop) clearInterval(window.__watchLoop);
		var lastPaint = 0;
		window.__watchLoop = setInterval(function () {
			if (typeof observing === "undefined" || !observing) return;
			var state = advance(window.__watchTrack, Date.now());
			var view = adoptLivingEntity(observing);
			view.real_x = state.x;
			view.real_y = state.y;
			if (state.bind) state.bind();
			buildSkills(view);
			paintSkills(view);
			paintBuffs(view);
			paintMarkers();
			if (!lastPaint || Date.now() - lastPaint > 1000) {
				paintHud();
				lastPaint = Date.now();
			}
		}, 50);
		// A watched character that is dead or gone still needs a camera anchor.
		window.localWatch = function () {
			startRelay();
			return true;
		};
		return true;
	}

	function attach(watched) {
		// Upstream flow, unchanged: the connection carries desktop=1, which the server answers with an
		// observer placed 120px below the player ("welcome"/o:home: player.y + 120). That offset is
		// harmless here because "character" is set below: position_map() then re-centres the camera on the
		// character every frame. Faking is_comm to drop the flag made the server stop streaming entities
		// to the observer altogether, so it is not an option.
		// The page's initial observer socket has to go first: reconnecting on top of it leaves the client
		// with an empty entity table (the world renders, the watched character is never drawn). Tearing
		// it down, letting the client settle, then observing is the sequence that reliably works.
		try {
			if (window.socket) {
				window.socket.destroy();
				window.socket = null;
			}
			window.observing = null;
			window.character = null;
			window.socket_welcomed = false;
		} catch (error) {
			note("teardown failed: " + error.message);
		}
		var call = null;
		setTimeout(function () {
			try {
				if (!observe_character(watched.name)) note("observe_character refused " + watched.name);
			} catch (error) {
				note("observe_character failed: " + error.message);
			}
		}, 1200);
		call = true;
		// The selection screen has no game surface: entities are received but never entered into the
		// client's table, so nothing can be followed. Switching to game mode and launching makes the
		// client build it (this is what the hub does when it opens a character's view).
		try {
			window.inside = "game";
			if (typeof launch_game === "function") launch_game();
		} catch (error) {
			note("launch_game failed: " + error.message);
		}
		attached = watched.name;
		ensureSkillsPanel();
		ensureLogPanel();
		document.title = "watching " + watched.name;
		note("watching " + watched.name);
		// An observer has a fixed position, so the watched character eventually leaves its vision and the
		// server stops sending its entity - the camera then freezes on the last known tile. "o:home" is
		// the supported recenter (node/server.js socket.on("o:home") transports the observer to the
		// player), which keeps the entity stream, and therefore the camera, alive.
		if (window.__watchRecenter) clearInterval(window.__watchRecenter);
		window.__watchRecenter = setInterval(function () {
			try {
				if (socket && socket.emit) socket.emit("o:home", {});
			} catch (error) {}
		}, 5000);

		trackWorld(watched);

		// position_map() runs every frame and re-derives the camera from the client's own state, which for
		// an observer is the server's +120 desktop offset. Wrap it and re-centre on the tracked character
		// afterwards, otherwise the two disagree and the character drifts towards the top of the screen.
		var originalPositionMap = window.position_map;
		if (!window.__watchPinned && typeof originalPositionMap === "function") {
			window.__watchPinned = true;
			window.position_map = function () {
				originalPositionMap();
				var state = window.__watchTrack;
				if (!state || typeof map === "undefined" || !map) return;
				// Prefer the drawn entity: it carries the interpolated position the sprite is actually
				// rendered at, so the camera and the sprite cannot disagree.
				var live = (typeof observing !== "undefined" && observing && typeof entities !== "undefined") ? entities[observing.id] : null;
				map.real_x = live && live.real_x !== undefined ? live.real_x : state.x;
				map.real_y = live && live.real_y !== undefined ? live.real_y : state.y;
			};
		}

		var lastPaint = 0;
		var loop = setInterval(function () {
			if (typeof observing === "undefined" || !observing) return;
			var state = advance(window.__watchTrack, Date.now());
			var view = adoptLivingEntity(observing);
			view.real_x = state.x;
			view.real_y = state.y;
			if (state.bind) state.bind();
			buildSkills(view);
			paintSkills(view);
			paintBuffs(view);
			if (!lastPaint || Date.now() - lastPaint > 1000) {
				paintHud();
				lastPaint = Date.now();
			}
		}, 50);
		window.__watchLoop = loop;
		window.localWatch = function () {
			attach(watched);
			return true;
		};
		return true;
	}

	function bootstrap() {
		if (relayUrl && (typeof socket === "undefined" || !socket)) {
			// The landing page never creates a socket (only a login does), and relay mode does not need a
			// connection at all: init_socket() is what registers the client's packet handlers on a socket
			// object, and the frames are injected through original_onevent. Point it at this origin so the
			// attempt fails immediately, and stop it retrying.
			try {
				if (typeof init_socket === "function") {
					if (typeof server_address === "undefined" || !server_address) window.server_address = window.location.origin;
					if (typeof server_path === "undefined" || !server_path) window.server_path = "/socket.io/";
					init_socket();
					if (socket && socket.io && socket.io.opts) socket.io.opts.reconnection = false;
				}
			} catch (error) {
				note("init_socket for relay mode failed: " + error.message);
			}
			return;
		}
		if (typeof socket === "undefined" || !socket) return;
		// Relay mode needs no session and no secret: the page is a renderer, the relay is the source.
		if (relayUrl) {
			// Relay mode does not care whether the page's own socket ever connects: the socket object is
			// only needed because init_socket() registers the client's packet handlers on it, and the
			// frames are injected through original_onevent. Only the assets have to be in, because the
			// sprites and map tiles come from them.
			if (typeof resources_loaded !== "undefined" && !resources_loaded) return;
			if (attached) {
				clearInterval(timer);
				return;
			}
			clearInterval(timer);
			if (!attachRelay()) note("could not attach the relay stream");
			return;
		}
		if (typeof observe_character !== "function") return;
		// init_socket refuses to reconnect while the page's first connection is still in flight
		// ("!socket_welcomed"), and attaching then leaves an observer that never receives entities.
		if (typeof socket_welcomed !== "undefined" && !socket_welcomed) return;
		// If the follow-up welcome arrives while assets are still loading, the client only sets
		// socket_ready and never calls launch_game(), which is what emits "loaded" - without that the
		// server never registers the observer and no entities arrive.
		if (typeof resources_loaded !== "undefined" && !resources_loaded) return;
		if (typeof user_id === "undefined" || !user_id) {
			note("log in first, then reload ?watch=" + wanted);
			clearInterval(timer);
			return;
		}
		if (attached) {
			clearInterval(timer);
			return;
		}
		var characters = (window.X && window.X.characters) || [];
		var watched = characters.filter(matches)[0];
		if (!watched) {
			refreshCharacters();
			return;
		}
		if (!watched.secret) {
			refreshCharacters();
			return;
		}
		// Let the page's own connection finish settling before reconnecting: attaching in the same tick as
		// the first welcome leaves the client with no sprite pipeline (empty entity table, nothing drawn),
		// while a couple of seconds of settling gives the same result as observing by hand from the hub.
		if (!readyAt) {
			readyAt = Date.now();
			return;
		}
		if (Date.now() - readyAt < 4000) return;
		clearInterval(timer);
		if (!attach(watched)) note("could not attach to " + watched.name);
	}
})();
