import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { isLocalDevServerUrl, isLocalHostname } from "./url.mjs";

// Playwright の route はリダイレクトの 2 回目以降の要求も WebSocket の接続も通らないので、route ではなくプロキシサーバーで宛先を絞る

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isValidAllowDomain(value) {
	return DOMAIN_PATTERN.test(value);
}

const DEFAULT_PORTS = { "http:": "80", "https:": "443" };

export function portOf(url) {
	return url.port || DEFAULT_PORTS[url.protocol];
}

// ローカルの宛先をホスト名だけで許可すると、そのホストのすべてのポートが通るので、ポートまで含めたオリジンで許可させる。
// 承認画面に並ぶ文字列と、承認の記録と照らす文字列が揃うよう、URL が書き直さない形（末尾の / やパスの無い形）だけを受け付ける
export function isValidAllowOrigin(value) {
	return isLocalDevServerUrl(value) && new URL(value).origin === value;
}

const localOriginKey = (hostname, port) => `${hostname.toLowerCase()}:${port}`;

// ローカルの宛先をホスト名だけで通すと、ページのコードが、同じマシンで動く開発サーバー以外のサービスにも要求を送れるので、ポートまで比べる。
// CONNECT の要求にはスキームが無いので、ローカルの宛先はスキームを除いたホスト名とポートで比べる
export function createDestinationPolicy(devServerUrl, allowDomains, allowOrigins = []) {
	const devServer = new URL(devServerUrl);
	const devPort = portOf(devServer);
	const localOrigins = new Set(
		[devServer, ...allowOrigins.map((origin) => new URL(origin))].map((origin) => localOriginKey(origin.hostname, portOf(origin))),
	);
	return {
		devOrigin: devServer.origin,
		isAllowed(hostname, port) {
			const host = hostname.toLowerCase();
			if (isLocalHostname(host)) return localOrigins.has(localOriginKey(host, port));
			return allowDomains.includes(host);
		},
		// Chrome が既定でプロキシサーバーを通さずに直接つなぐ宛先には、ほかのポートのループバックや 169.254/16 のようなリンクローカルの宛先も含まれる。
		// <-loopback> でこの既定を外し、開発サーバーだけを直接つなぐ
		proxyBypass: `${devServer.hostname}:${devPort},<-loopback>`,
	};
}

const CONNECT_TARGET = /^(\[[^\]]+\]|[^:]+):(\d+)$/;

export async function startBlockingProxy(policy) {
	const sockets = new Set();

	const server = createServer((req, res) => {
		let target;
		try {
			target = new URL(req.url);
		} catch {
			req.socket.destroy();
			return;
		}
		// 403 などの応答を返すと、Chrome はそれを外部の宛先の応答として描画を続けるので、接続を切って読み込みの失敗にする
		if (!policy.isAllowed(target.hostname, portOf(target))) {
			req.socket.destroy();
			return;
		}
		const upstream = httpRequest(target, { method: req.method, headers: req.headers }, (upstreamRes) => {
			res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
			// pipe は中継先の接続が途中で切れても Chrome との接続を閉じないので、Chrome は本文の残りを待ち続け、撮影が進まない
			upstreamRes.on("error", () => req.socket.destroy());
			upstreamRes.pipe(res);
		});
		upstream.on("error", () => req.socket.destroy());
		req.on("error", () => upstream.destroy());
		req.pipe(upstream);
	});

	server.on("connect", (req, clientSocket, head) => {
		const match = CONNECT_TARGET.exec(req.url);
		if (!match || !policy.isAllowed(match[1], match[2])) {
			clientSocket.destroy();
			return;
		}
		const upstream = connect(Number(match[2]), match[1].replace(/^\[|\]$/g, ""), () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => upstream.destroy());
	});

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	return {
		server: `http://127.0.0.1:${server.address().port}`,
		close() {
			for (const socket of sockets) socket.destroy();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
