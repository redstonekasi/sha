import { _load, createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
const req = createRequire(import.meta.url);

const fs = req("node:fs");
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

let server;
// this supports other signatures but i don't care
const net = req("node:net");
const _listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(port, host, callback) {
	server = this;
	_listen.call(this, {
		port,
		host,
		reusePort: true,
	}, callback);
	parentPort.postMessage({ action: "ready" });
	return this;
};

parentPort.on("message", (msg) => {
	if (msg.action === "shutdown") {
		if (!server) process.exit(0);
		server.on("close", () => {
			process.exit(0);
		});
		server.close();
	}
});

_load(workerData.mod, null, true);
