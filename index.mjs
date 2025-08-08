import child from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import util from "node:util";
import { Worker } from "node:worker_threads";

const ENVS = ["release", "staging"];
const config = await fs.readFile("config.json", "utf8").then(JSON.parse);
const ghKey = crypto.createSecretKey(config.key);

const execFile = util.promisify(child.execFile);

// TODO: look into worktrees if they don't cause any issues
async function updateRepository(env) {
	try {
		await execFile("git", ["clone", config.repository, env]);
		console.log(`git/${env}: repository cloned`);
	} catch {
		await execFile("git", ["-C", env, "fetch"]);
		console.log(`git/${env}: repository fetched`);
	}

	let rev;
	if (env === "staging") {
		rev = await execFile("git", ["-C", env, "rev-parse", "main"])
			.then((r) => r.stdout.trim());
	} else {
		rev = await execFile("git", ["-C", env, "rev-list", "-1", "main", "--", "CHANGELOG.md"])
			.then((r) => r.stdout.trim());
	}
	await execFile("git", ["-C", env, "checkout", rev]);
	console.log(`git/${env}: checked out ${rev}`);

	await execFile("pnpm", ["install", "--frozen"], { cwd: env });
	console.log(`git/${env}: node modules updated`);
}
const updateAllRepositories = () => Promise.all(ENVS.map(updateRepository));

const state = {};
for (const env of ENVS) {
	state[env] = {
		previous: null,
		current: null,
	};
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

function spawnWorker(env) {
	const workerData = {
		env,
		mod: path.resolve(env, "src", "index.js"),
		config: {
			...config.environments[env],
			...config.common,
		},
	};

	const worker = new Worker(new URL("./worker.js", import.meta.url), {
		workerData,
		stdout: true,
		stderr: true,
	});
	console.log(`worker/${env}: starting worker`);

	let ready = false;
	const { promise: readyPromise, resolve: markReady, reject: markFailure } = Promise.withResolvers();
	worker.ready = readyPromise;

	worker.stdout.pipe(new PrefixTransform(`log/${env}: `)).pipe(process.stdout);
	worker.stderr.pipe(new PrefixTransform(`log/${env}: `)).pipe(process.stderr);

	worker.on("message", (msg) => {
		if (msg.action === "markTemp") {
			worker.on("exit", () => {
				fs.rm(msg.dir, { force: true, recursive: true });
			});
		} else if (msg.action === "ready") {
			markReady();
			ready = true;
			console.log(`worker/${env}: worker is ready`);
		} else if (msg.action === "reportStat") {
			for (const target of ENVS) {
				if (env === target) continue;
				state[target].current.postMessage(msg);
			}
		}
	});

	worker.on("exit", () => {
		if (!ready) markFailure();
	});

	return worker;
}

async function spawnInitialWorkers() {
	let p = [];
	for (const env of ENVS) {
		const worker = spawnWorker(env);
		p.push((state[env].current = worker).ready);
	}
	await Promise.all(p);
}

const stopWorker = (worker, env) =>
	new Promise((res) => {
		if (!worker) return res();

		worker.postMessage({ action: "shutdown" });
		const term = setTimeout(() => worker.terminate(), 5000);

		worker.on("exit", (code) => {
			clearTimeout(term);
			if (code === 0) {
				console.log(`worker/${env}: gracefully shut down`);
			} else {
				console.log(`worker/${env}: forcefully terminated`);
			}
			res();
		});
	});

async function rolloverRestart(env) {
	const s = state[env];
	await updateRepository(env);
	s.previous = s.current;
	s.current = spawnWorker(env);
	await s.current.ready;
	await stopWorker(s.previous, env);
	s.previous = null;
}
const rolloverRestartAll = () => Promise.all(ENVS.map(rolloverRestart));

// truly the nodejs code of all time
let superServer;
function supervisorListen() {
	superServer = http.createServer(async (req, res) => {
		if (req.url === "/_internal/webhook") {
			let sig;
			try {
				const hexSig = req.headers["x-hub-signature-256"].split("=")[1];
				if (!hexSig) {
					res.writeHead(400);
					res.end();
					return;
				}
				sig = Buffer.from(hexSig, "hex");
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}

			let chunks = [];
			const hmac = crypto.createHmac("sha256", ghKey);
			try {
				for await (const chunk of req) {
					hmac.update(chunk);
					chunks.push(chunk);
				}
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}

			if (!crypto.timingSafeEqual(sig, hmac.digest())) {
				res.writeHead(400);
				res.end();
				return;
			}

			const event = req.headers["x-github-event"];
			if (event !== "push") return res.end();
			const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));

			console.log("supervisor: head moved to", json.head_commit.id);

			await updateAllRepositories();
			await rolloverRestartAll();

			res.end();
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	superServer.listen(config.port, () => {
		console.log("supervisor: listening on", config.port);
	});
}

function registerSignalHandlers() {
	async function terminate(signal) {
		superServer.close();
		superServer.closeAllConnections();

		await Promise.all(ENVS.flatMap((env) => [
			stopWorker(state[env].previous, env),
			stopWorker(state[env].current, env),
		]));

		process.kill(process.pid, signal);
	}

	process.once("SIGINT", terminate);
	process.once("SIGTERM", terminate);
}

async function main() {
	registerSignalHandlers();
	await updateAllRepositories();
	await spawnInitialWorkers();
	supervisorListen();
}

await main();
