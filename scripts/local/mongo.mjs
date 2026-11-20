// Start a throwaway MongoDB for the local Adventure Land stack.
//
// There is no system mongod on this host and the container runtime is unusable inside the
// sandbox, so the binary is downloaded once into reference/local/.cache by mongodb-memory-server
// and reused afterwards. The data directory is fresh per boot: the seeder refuses to run against a
// database that already has collections, and a 5 MB geometry seed is cheap enough to redo.

import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL, dirs, ports } from "./apply_config.mjs";

const MONGODB_VERSION = process.env.AL_MONGODB_VERSION || "7.0.14";
const REPLICA_SET = process.env.AL_MONGODB_REPLSET || "al";

export function mongoEnv() {
	return Object.assign({}, process.env, {
		MONGOMS_DOWNLOAD_DIR: process.env.MONGOMS_DOWNLOAD_DIR || path.join(dirs.cache, "mongodb"),
		MONGOMS_VERSION: process.env.MONGOMS_VERSION || MONGODB_VERSION,
		MONGOMS_DISABLE_POSTINSTALL: "1",
	});
}

export async function startMongo({ port = ports().mongo, dbName = "adventureland", reuseData = false } = {}) {
	Object.assign(process.env, mongoEnv());
	await fs.mkdir(path.join(dirs.cache, "mongodb"), { recursive: true });
	const dbPath = path.join(dirs.mongoData, String(port));
	if (!reuseData) {
		await fs.rm(dbPath, { recursive: true, force: true });
	}
	await fs.mkdir(dbPath, { recursive: true });

	// The backend writes accounts and characters inside MongoDB transactions (common/mongodb_functions.js
	// tx()), and transactions need a replica set: a standalone answers
	// "Transaction numbers are only allowed on a replica set member or mongos". One member is enough.
	const { MongoMemoryReplSet } = await import("mongodb-memory-server");
	const server = await MongoMemoryReplSet.create({
		binary: { version: MONGODB_VERSION },
		replSet: { count: 1, name: REPLICA_SET, storageEngine: "wiredTiger", dbName },
		instanceOpts: [{ port, dbPath, ip: "127.0.0.1" }],
	});
	const uri = server.getUri(dbName);
	return {
		server,
		uri,
		name: dbName,
		port,
		async stop() {
			await server.stop({ doCleanup: true, force: true });
		},
	};
}

export { LOCAL };
