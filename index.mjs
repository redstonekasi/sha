import child from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import util from "node:util";
import { Worker } from "node:worker_threads";

import { defu } from "./defu.mjs";

const node = process.argv[2];
if (!node) {
	console.error("usage: sha <node>");
	process.exit(1);
}

const config = await fs.readFile("config.json", "utf8").then(JSON.parse);
const nodeConfig = defu(config[node], config["_"]);

const execFile = util.promisify(child.execFile);

// TODO: look into worktrees if they don't cause any issues
async function updateRepository(force) {
	try {
		await execFile("git", ["clone", config.repository, node]);
		console.log(`git: repository cloned`);
	} catch {
		await execFile("git", ["-C", node, "fetch"]);
		console.log(`git: repository fetched`);
	}

	const previous = await execFile("git", ["-C", node, "rev-parse", "HEAD"])
		.then((r) => r.stdout.trim());

	let rev;
	if (!nodeConfig.branch) {
		rev = await execFile("git", ["-C", node, "rev-list", "-1", "main", "--", "CHANGELOG.md"])
			.then((r) => r.stdout.trim());
	} else {
		rev = await execFile("git", ["-C", node, "rev-parse", nodeConfig.branch])
			.then((r) => r.stdout.trim());
	}

	if (force || previous !== rev) {
		await execFile("git", ["-C", node, "checkout", rev]);
		console.log(`git: checked out ${rev}`);

		await execFile("pnpm", ["install", "--frozen"], { cwd: node });
		console.log(`git: node modules updated`);
	}

	return previous !== rev;
}

class PrefixTransform extends Transform {
	constructor(prefix, options) {
		super(options);
		this._prefix = Buffer.from(prefix);
		this._buf = Buffer.alloc(0);
	}

	_transform(chunk, _encoding, callback) {
		this._buf = Buffer.concat([this._buf, chunk]);
		let i;
		while ((i = this._buf.indexOf("\n")) !== -1) {
			const line = this._buf.subarray(0, ++i);
			this._buf = this._buf.subarray(i);
			this.push(Buffer.concat([this._prefix, line]));
		}
		callback();
	}

	_flush(callback) {
		if (this._buf.length) {
			callback(null, Buffer.concat([this._prefix, this._buf]));
		}
	}
}

function spawnWorker() {
	const workerData = {
		mod: path.resolve(node, "src", "index.js"),
		config: nodeConfig,
	};

	const worker = new Worker(new URL("./worker.js", import.meta.url), {
		workerData,
		stdout: true,
		stderr: true,
	});
	console.log(`worker: starting worker`);

	let resolved = false;
	const ready = Promise.withResolvers();

	worker.stdout.pipe(new PrefixTransform(`log: `)).pipe(process.stdout);
	worker.stderr.pipe(new PrefixTransform(`log: `)).pipe(process.stderr);

	let directories = new Set();

	worker.on("message", async (msg) => {
		if (msg.action === "markTemp") {
			directories.add(msg.dir);
		} else if (msg.action === "ready") {
			ready.resolve(worker);
			resolved = true;
			console.log(`worker: worker is ready`);
		} else if (msg.action === "update") {
			console.log("webhook: head moved to", msg.commit);
			const updated = await updateRepository();
			if (updated) {
				await rolloverRestart();
			}
		}
	});

	worker.on("exit", async (status) => {
		for (const directory of directories) {
			fs.rm(directory, { force: true, recursive: true });
			console.log(`worker: trying to delete ${directory}`);
		}

		if (status === 0) {
			console.log("worker: gracefully shut down");
		} else {
			console.log(`worker: worker crashed`, status);
			process.exit(status);
		}

		if (!resolved) return ready.reject();
	});

	return ready.promise;
}

let previousWorker;
let currentWorker;

const stopWorker = (worker) =>
	new Promise((res) => {
		if (!worker) return res();

		worker.postMessage({ action: "shutdown" });
		const term = setTimeout(() => worker.terminate(), 5000);

		worker.on("exit", () => {
			clearTimeout(term);
			res();
		});
	});

async function rolloverRestart() {
	previousWorker = currentWorker;
	currentWorker = await spawnWorker();
	await stopWorker(previousWorker);
	previousWorker = null;
}

function registerSignalHandlers() {
	async function terminate(signal) {
		await stopWorker(previousWorker);
		await stopWorker(currentWorker);

		process.kill(process.pid, signal);
	}

	process.once("SIGINT", terminate);
	process.once("SIGTERM", terminate);

	process.on("SIGHUP", rolloverRestart);
}

async function main() {
	registerSignalHandlers();
	await updateRepository(true);
	currentWorker = await spawnWorker();
}

await main();
