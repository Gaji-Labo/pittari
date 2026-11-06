import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createDestinationPolicy, isValidAllowDomain, isValidAllowOrigin, startBlockingProxy } from "../../plugin/scripts/modules/network.mjs";

describe("--allow-domain", () => {
	for (const domain of ["fonts.googleapis.com", "use.typekit.net", "a-b.example.co.jp"]) {
		test(`受け付ける: ${domain}`, () => assert.equal(isValidAllowDomain(domain), true));
	}
	for (const domain of ["https://fonts.googleapis.com", "*.example.com", "example.com:443", "example", "-a.example.com", "example.com/path", ""]) {
		test(`断る: ${domain}`, () => assert.equal(isValidAllowDomain(domain), false));
	}
});

describe("--allow-origin", () => {
	for (const origin of ["http://localhost:8080", "https://127.0.0.1:8443", "http://[::1]:3001", "http://api.localhost:8080", "http://localhost"]) {
		test(`受け付ける: ${origin}`, () => assert.equal(isValidAllowOrigin(origin), true));
	}
	for (const origin of [
		"http://localhost:8080/",
		"http://localhost:8080/api",
		"http://LOCALHOST:8080",
		"http://localhost:80",
		"localhost:8080",
		"https://example.com",
		"file:///etc/hosts",
		"",
	]) {
		test(`断る: ${origin}`, () => assert.equal(isValidAllowOrigin(origin), false));
	}
});

describe("通信してよい宛先", () => {
	test("ローカルの宛先は、--url と同じホスト名とポートだけを通す", () => {
		const policy = createDestinationPolicy("http://localhost:5173/page", []);
		assert.equal(policy.isAllowed("localhost", "5173"), true);
		assert.equal(policy.isAllowed("LOCALHOST", 5173), true);
		for (const [host, port] of [
			["localhost", "8080"],
			["127.0.0.1", "5173"],
			["[::1]", "5173"],
			["app.localhost", "5173"],
		]) {
			assert.equal(policy.isAllowed(host, port), false, `${host}:${port}`);
		}
	});
	test("ポートを書かない --url は、スキームの既定のポートと比べる", () => {
		assert.equal(createDestinationPolicy("http://app.localhost/", []).isAllowed("app.localhost", "80"), true);
		assert.equal(createDestinationPolicy("https://[::1]/", []).isAllowed("[::1]", "443"), true);
		assert.equal(createDestinationPolicy("https://[::1]/", []).isAllowed("[::1]", "80"), false);
	});
	test("--allow-domain に渡したホストだけを通し、サブドメインは通さない", () => {
		const policy = createDestinationPolicy("http://localhost:5173/", ["fonts.gstatic.com"]);
		assert.equal(policy.isAllowed("fonts.gstatic.com", "443"), true);
		assert.equal(policy.isAllowed("evil.fonts.gstatic.com", "443"), false);
		assert.equal(policy.isAllowed("example.com", "443"), false);
	});
	test("--allow-origin に渡したローカルのオリジンだけを、ポートまで比べて通す", () => {
		const policy = createDestinationPolicy("http://localhost:5173/", [], ["http://localhost:8080", "http://127.0.0.1"]);
		assert.equal(policy.isAllowed("localhost", "8080"), true);
		assert.equal(policy.isAllowed("127.0.0.1", "80"), true);
		assert.equal(policy.isAllowed("localhost", "8081"), false);
		assert.equal(policy.isAllowed("127.0.0.1", "8080"), false);
	});
	test("--allow-domain にローカルのホスト名を渡しても、--url と別のオリジンは通さない", () => {
		assert.equal(createDestinationPolicy("http://localhost:5173/", ["app.localhost"]).isAllowed("app.localhost", "5173"), false);
	});
	test("Chrome には開発サーバーだけを直接つながせ、ほかのループバックの宛先はプロキシサーバーに通させる", () => {
		assert.equal(createDestinationPolicy("http://localhost:5173/", []).proxyBypass, "localhost:5173,<-loopback>");
		assert.equal(createDestinationPolicy("http://[::1]/", []).proxyBypass, "[::1]:80,<-loopback>");
	});
});

describe("プロキシサーバー", () => {
	let devServer;
	let devPort;
	let otherServer;
	let otherPort;
	let otherHits = 0;
	let proxy;
	let proxyPort;
	before(async () => {
		devServer = createServer((req, res) => {
			if (req.url === "/reset") {
				res.writeHead(200, { "content-length": "100" });
				res.write("partial");
				setTimeout(() => res.socket.destroy(), 20);
				return;
			}
			res.end("dev");
		});
		await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
		devPort = devServer.address().port;
		otherServer = createServer((req, res) => {
			otherHits++;
			res.end("other");
		});
		otherServer.on("connection", () => otherHits++);
		await new Promise((resolve) => otherServer.listen(0, "127.0.0.1", resolve));
		otherPort = otherServer.address().port;
		proxy = await startBlockingProxy(createDestinationPolicy(`http://localhost:${devPort}/`, []));
		proxyPort = Number(new URL(proxy.server).port);
	});
	after(async () => {
		await proxy.close();
		await new Promise((resolve) => devServer.close(resolve));
		await new Promise((resolve) => otherServer.close(resolve));
	});

	function connectThroughProxy(target) {
		return new Promise((resolve) => {
			const req = request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: target });
			req.on("connect", (res, socket) => {
				socket.destroy();
				resolve(res.statusCode);
			});
			req.on("error", () => resolve("切断"));
			req.end();
		});
	}

	function getThroughProxy(url) {
		return new Promise((resolve) => {
			const req = request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve(body));
				res.on("error", () => resolve("切断"));
			});
			req.on("error", () => resolve("切断"));
			req.end();
		});
	}

	test("許可していないホストへの CONNECT は、つながずに切る", async () => {
		assert.equal(await connectThroughProxy("example.com:443"), "切断");
	});
	test("許可していないホストへの http の要求は、応答を返さずに切る", async () => {
		assert.equal(await getThroughProxy("http://example.com/?d=secret"), "切断");
	});
	test("IP アドレスを直接書いた宛先も遮断する", async () => {
		assert.equal(await connectThroughProxy("93.184.215.14:443"), "切断");
	});
	test("開発サーバーへの要求は中継する", async () => {
		assert.equal(await connectThroughProxy(`localhost:${devPort}`), 200);
		assert.equal(await getThroughProxy(`http://localhost:${devPort}/`), "dev");
	});
	test("開発サーバーと別のポートのローカルのサーバーには、要求も接続も届かない", async () => {
		otherHits = 0;
		assert.equal(await connectThroughProxy(`localhost:${otherPort}`), "切断");
		assert.equal(await connectThroughProxy(`127.0.0.1:${otherPort}`), "切断");
		assert.equal(await getThroughProxy(`http://localhost:${otherPort}/.env`), "切断");
		assert.equal(otherHits, 0);

		// 同じ受け手への通信を許可したプロキシサーバーを通すと、受け手が数えた要求の数が増えることを確かめる。上で 0 のままだったのが、数え方の誤りのせいではないことを示すため
		const control = await startBlockingProxy(createDestinationPolicy(`http://localhost:${otherPort}/`, []));
		try {
			const status = await new Promise((resolve) => {
				const req = request({ host: "127.0.0.1", port: Number(new URL(control.server).port), path: `http://localhost:${otherPort}/` }, (res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode));
				});
				req.on("error", () => resolve("切断"));
				req.end();
			});
			assert.equal(status, 200);
		} finally {
			await control.close();
		}
		assert.ok(otherHits > 0);
	});
	test("中継先が応答の途中で接続を切っても、プロキシサーバーは動き続ける", async () => {
		assert.equal(await getThroughProxy(`http://localhost:${devPort}/reset`), "切断");
		assert.equal(await getThroughProxy(`http://localhost:${devPort}/`), "dev");
	});
});
