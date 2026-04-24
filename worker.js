import crypto from "node:crypto";
import { _load, createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const ghKey = crypto.createSecretKey(workerData.config.supervisor.key);
let server, honoListener;

async function listener(req, res) {
	if (!req.url.startsWith("/_internal/")) return honoListener(req, res);

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

		if (json.ref !== `refs/heads/${workerData.config.branch || "main"}`) return res.end();

		parentPort.postMessage({ action: "update", commit: json.head_commit.id });
		res.end();
	} else {
		res.writeHead(404);
		res.end();
	}
}

parentPort.on("message", (msg) => {
	if (msg.action === "shutdown") {
		if (!server) process.exit(0);
		server.on("close", () => {
			process.exit(0);
		});
		server.close();
	}
});

const require = createRequire(import.meta.url);

const fs = require("node:fs");
const _readFileSync = fs.readFileSync;
fs.readFileSync = function(...args) {
	const url = args[0];
	if (typeof url === "string" && url.endsWith("/config.json")) {
		fs.readFileSync = _readFileSync;
		return JSON.stringify(workerData.config);
	}
	return _readFileSync.apply(this, args);
};

const _mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function(...args) {
	const res = _mkdtempSync.apply(this, args);
	if (args[0].endsWith("sheltupdate-cache-")) {
		fs.mkdtempSync = _mkdtempSync;
		parentPort.postMessage({ action: "markTemp", dir: res });
	}
	return res;
};

const http = require("node:http");
const _listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(port, host, callback) {
	server = this;

	// I could also patch createServer, but this seems more robust.
	honoListener = server.listeners("request")[0];
	server.removeListener("request", honoListener);
	server.on("request", listener);

	_listen.call(this, {
		port,
		host,
		reusePort: true,
	}, callback);

	parentPort.postMessage({ action: "ready" });
	return this;
};

_load(workerData.mod, null, true);
