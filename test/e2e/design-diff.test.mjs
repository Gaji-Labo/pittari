// design-diff を子プロセスで実際に動かす。plugin の依存と Chrome が要り、サンドボックスの中では Chrome が起動しないので、
// test/*.test.mjs とは分けて実行する
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const requirePlugin = createRequire(new URL("../../plugin/package.json", import.meta.url));
const { PNG } = requirePlugin("pngjs");
const { chromium } = requirePlugin("playwright-core");
const script = fileURLToPath(new URL("../../plugin/scripts/design-diff.mjs", import.meta.url));

// Chrome の WebRTC は既定でループバックのインターフェースを使わないので、UDP の受け手の宛先には外向きのアドレスを使う
const externalAddress = Object.values(networkInterfaces())
	.flat()
	.find((address) => address.family === "IPv4" && !address.internal)?.address;

// 文字を背景と同じ色で描くので、書体の違う環境でも画素は見本と揃い、文字は対応表で照合される
const PAGE = `<!doctype html>
<body style="margin:0">
	<div id="t" style="width:100px;height:50px;background:#f00">
		<p id="x" style="margin:0;width:40px;height:20px;background:#00f;color:#00f;font-size:10px">ok</p>
	</div>
</body>`;
// STUN サーバーとして指定した宛先へ、Chrome は候補を集める段階で UDP を送る
const webrtcPage = (stunPort) => `${PAGE}
<script>
	window.pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${externalAddress}:${stunPort}" }] });
	pc.createDataChannel("leak");
	pc.createOffer().then((offer) => pc.setLocalDescription(offer));
</script>`;
const STUN_MAGIC_COOKIE = 0x2112a442;
const METADATA = '<frame id="1:1" name="t" x="0" y="0" width="100" height="50"><text id="1:2" name="x" x="0" y="0" width="40" height="20" /></frame>';

function designPng() {
	const png = new PNG({ width: 100, height: 50 });
	for (let y = 0; y < 50; y++) {
		for (let x = 0; x < 100; x++) {
			png.data.set(x < 40 && y < 20 ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * 100 + x) * 4);
		}
	}
	return PNG.sync.write(png);
}

let base;
let project;
let design;
let secret;
let server;
let url;
let udpReceiver;
let datagrams = 0;
before(async () => {
	base = mkdtempSync(join(tmpdir(), "design-diff-e2e-"));
	project = join(base, "project");
	mkdirSync(join(project, ".design-diff", "inputs", "s1"), { recursive: true });
	writeFileSync(join(project, ".design-diff", "inputs", "s1", "1-1.xml"), METADATA);
	writeFileSync(join(project, ".design-diff", "inputs", "s1", "texts.json"), JSON.stringify({ "1:2": "ok" }));
	// --design はプロジェクトの外の PNG も読むことを確かめるため、見本はプロジェクトの外に置く
	design = join(base, "design.png");
	writeFileSync(design, designPng());
	secret = join(base, "secret.env");
	writeFileSync(secret, "SECRET=1\n");
	udpReceiver = createSocket("udp4");
	// 受け手は全インターフェースで待つので、Chrome 以外から届いた UDP を数えないよう、STUN の固定値を持つものだけを数える
	udpReceiver.on("message", (message) => {
		if (message.length >= 8 && message.readUInt32BE(4) === STUN_MAGIC_COOKIE) datagrams++;
	});
	await new Promise((resolve) => udpReceiver.bind(0, "0.0.0.0", resolve));
	const stunPort = udpReceiver.address().port;
	server = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		response.end(request.url === "/webrtc" ? webrtcPage(stunPort) : PAGE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => {
	server?.close();
	udpReceiver?.close();
	rmSync(base, { recursive: true, force: true });
});

// 撮影するページのサーバーがこのプロセスで動いているので、子プロセスの終了を同期で待たない
function designDiff(args, pageUrl = url) {
	return new Promise((resolve) => {
		execFile(process.execPath, [script, "--url", pageUrl, "--selector", "#t", "--width", "100", ...args], { cwd: project }, (error, stdout, stderr) => {
			resolve({ code: error ? error.code : 0, stdout, stderr });
		});
	});
}

describe("design-diff", { timeout: 60_000 }, () => {
	test(".design-diff/inputs の XML と文字の対応表で、箱を比べる", async () => {
		const { code, stdout, stderr } = await designDiff([
			"--design",
			design,
			"--metadata",
			".design-diff/inputs/s1/1-1.xml",
			"--texts",
			".design-diff/inputs/s1/texts.json",
		]);
		assert.equal(code, 0, `${stdout}\n${stderr}`);
		assert.match(stdout, /\[箱\] PASS 全 2 ノード/);
		assert.match(stdout, /（文字）/);
		assert.match(stdout, /\[画素\] PASS/);
		assert.ok(existsSync(join(project, ".design-diff", "t-100", "layout.json")));
	});

	for (const [option, path] of [
		["--metadata", "/etc/hosts"],
		["--metadata", "../secret.env"],
		["--texts", "../secret.env"],
	]) {
		test(`${option} ${path} は読まずにエラーで終わる`, async () => {
			const { code, stdout, stderr } = await designDiff(["--design", design, option, path]);
			assert.equal(code, 1);
			assert.match(stderr, /\.design-diff\/inputs\/ の下のファイルではないので読みません/);
			assert.doesNotMatch(`${stdout}${stderr}`, /SECRET|localhost/);
		});
	}

	test("--design に PNG でないファイルを渡すと、中身を出さずにエラーで終わる", async () => {
		const { code, stdout, stderr } = await designDiff(["--design", secret]);
		assert.equal(code, 1);
		assert.match(stderr, /PNG として読めませんでした/);
		assert.doesNotMatch(`${stdout}${stderr}`, /SECRET/);
	});

	test("--out inputs はエラーで終わる", async () => {
		const { code, stderr } = await designDiff(["--design", design, "--out", "inputs"]);
		assert.equal(code, 1);
		assert.match(stderr, /--out に "inputs" は使えません/);
	});

	// WebRTC の UDP を止めている起動引数は、Chrome が本来は IP アドレスの漏洩を防ぐために用意したもので、
	// 通信先を絞る用途での動作は Chrome の更新で変わっても知らされない
	test("ページが WebRTC で送る UDP は、外部の受け手に届かない", async () => {
		// 飛ばすと、Chrome の更新で UDP が届くようになっても CI が通ってしまうので、アドレスが無ければ失敗させる
		assert.ok(externalAddress, "外向きの IPv4 アドレスが無く、UDP の受け手の宛先を用意できない");
		const webrtcUrl = new URL("/webrtc", url).href;

		// 起動引数を付けない Chrome で着信を数え、このページが UDP を送ることと、受け手が着信を数えられることを先に確かめる
		datagrams = 0;
		const browser = await chromium.launch({ channel: "chrome", chromiumSandbox: true });
		try {
			const page = await browser.newPage();
			await page.goto(webrtcUrl);
			for (let waited = 0; datagrams === 0 && waited < 5_000; waited += 100) await sleep(100);
		} finally {
			await browser.close();
		}
		assert.ok(datagrams > 0, "起動引数を付けない Chrome からも着信が無く、この確かめ方では UDP が止まったかを判断できない");

		datagrams = 0;
		const { code, stdout, stderr } = await designDiff(["--design", design], webrtcUrl);
		assert.equal(code, 0, `${stdout}\n${stderr}`);
		assert.equal(datagrams, 0);
	});
});
