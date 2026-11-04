// design-diff を子プロセスで実際に動かす。plugin の依存と Chrome が要り、サンドボックスの中では Chrome が起動しないので、
// test/*.test.mjs とは分けて実行する
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { PNG } = createRequire(new URL("../../plugin/package.json", import.meta.url))("pngjs");
const script = fileURLToPath(new URL("../../plugin/scripts/design-diff.mjs", import.meta.url));

// 文字を背景と同じ色で描くので、書体の違う環境でも画素は見本と揃い、文字は対応表で照合される
const PAGE = `<!doctype html>
<body style="margin:0">
	<div id="t" style="width:100px;height:50px;background:#f00">
		<p id="x" style="margin:0;width:40px;height:20px;background:#00f;color:#00f;font-size:10px">ok</p>
	</div>
</body>`;
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
	server = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		response.end(PAGE);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${server.address().port}/`;
});
after(() => {
	server?.close();
	rmSync(base, { recursive: true, force: true });
});

// 撮影するページのサーバーがこのプロセスで動いているので、子プロセスの終了を同期で待たない
function designDiff(args) {
	return new Promise((resolve) => {
		execFile(process.execPath, [script, "--url", url, "--selector", "#t", "--width", "100", ...args], { cwd: project }, (error, stdout, stderr) => {
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
});
