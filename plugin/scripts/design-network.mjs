import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { isLocalHostname, LOCAL_HOSTNAMES } from "./design-url.mjs";

// design-diff の Chrome はサンドボックスの外で動き、ページの JS は AI が書く。開発サーバーと --allow-domain 以外へ通信させると、
// 承認画面に出ない宛先へ、AI が読んだ内容を送れてしまう。
// Playwright の route はリダイレクトの 2 回目以降の要求を通らず、WebSocket も別扱いなので、Chrome の通信をすべてこのプロキシサーバーに通し、許可していない宛先への通信を遮断する

// ワイルドカードやポートを受け付けると、承認画面に並ぶ文字列から、許可する宛先の範囲を人が読み取りにくくなる
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isValidAllowDomain(value) {
	return DOMAIN_PATTERN.test(value);
}

export function isAllowedHost(hostname, allowDomains) {
	const host = hostname.toLowerCase();
	return isLocalHostname(host) || allowDomains.includes(host);
}

// Chrome が既定でプロキシサーバーを通さずに直接つなぐ宛先には、169.254/16 のようなリンクローカルの宛先も含まれる。
// <-loopback> でこの既定を外し、--url と同じ規則の宛先だけを直接つなぐ
export const PROXY_BYPASS = [...LOCAL_HOSTNAMES, "*.localhost", "<-loopback>"].join(",");

const CONNECT_TARGET = /^(\[[^\]]+\]|[^:]+):(\d+)$/;

export async function startBlockingProxy(allowDomains) {
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
		if (!isAllowedHost(target.hostname, allowDomains)) {
			req.socket.destroy();
			return;
		}
		const upstream = httpRequest(target, { method: req.method, headers: req.headers }, (upstreamRes) => {
			res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
			upstreamRes.pipe(res);
		});
		upstream.on("error", () => req.socket.destroy());
		req.pipe(upstream);
	});

	// https と WebSocket は CONNECT で届く
	server.on("connect", (req, clientSocket, head) => {
		const match = CONNECT_TARGET.exec(req.url);
		if (!match || !isAllowedHost(match[1], allowDomains)) {
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
