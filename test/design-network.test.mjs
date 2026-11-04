import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { isAllowedHost, isValidAllowDomain, startBlockingProxy } from "../plugin/scripts/design-network.mjs";

describe("--allow-domain", () => {
	for (const domain of ["fonts.googleapis.com", "use.typekit.net", "a-b.example.co.jp"]) {
		test(`受け付ける: ${domain}`, () => assert.equal(isValidAllowDomain(domain), true));
	}
	for (const domain of ["https://fonts.googleapis.com", "*.example.com", "example.com:443", "example", "-a.example.com", "example.com/path", ""]) {
		test(`断る: ${domain}`, () => assert.equal(isValidAllowDomain(domain), false));
	}
});

describe("通信してよい宛先", () => {
	test("--url と同じ規則のホストは、--allow-domain が無くても通す", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) assert.equal(isAllowedHost(host, []), true);
	});
	test("--allow-domain に渡したホストだけを通し、サブドメインは通さない", () => {
		assert.equal(isAllowedHost("fonts.gstatic.com", ["fonts.gstatic.com"]), true);
		assert.equal(isAllowedHost("evil.fonts.gstatic.com", ["fonts.gstatic.com"]), false);
		assert.equal(isAllowedHost("example.com", ["fonts.gstatic.com"]), false);
	});
});

describe("代理サーバー", () => {
	let devServer;
	let devPort;
	let proxy;
	let proxyPort;
	before(async () => {
		devServer = createServer((req, res) => res.end("dev"));
		await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
		devPort = devServer.address().port;
		proxy = await startBlockingProxy([]);
		proxyPort = Number(new URL(proxy.server).port);
	});
	after(async () => {
		await proxy.close();
		await new Promise((resolve) => devServer.close(resolve));
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
	test("IP アドレスを直接書いた宛先も止める", async () => {
		assert.equal(await connectThroughProxy("93.184.215.14:443"), "切断");
	});
	test("開発サーバーへの要求は中継する", async () => {
		assert.equal(await connectThroughProxy(`localhost:${devPort}`), 200);
		assert.equal(await getThroughProxy(`http://localhost:${devPort}/`), "dev");
	});
});

describe("承認の hook", () => {
	const hook = new URL("../plugin/scripts/design-approval.mjs", import.meta.url).pathname;
	function decide(command) {
		const output = execFileSync("node", [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
		return output === "" ? null : JSON.parse(output).hookSpecificOutput;
	}

	for (const command of [
		"design-diff --url http://localhost:3000 --allow-domain fonts.gstatic.com",
		"design-diff --url http://localhost:3000 --allow-domain=fonts.gstatic.com",
		"design-diff --url http://localhost:3000 --selector '#hero' --allow-domain 'fonts.gstatic.com'",
	]) {
		test(`外部サイトを許可する実行は承認画面に回す: ${command}`, () => assert.equal(decide(command)?.permissionDecision, "ask"));
	}
	for (const command of [
		"design-diff --url http://localhost:3000 --selector '#hero' --design a.png --width 1440",
		"cat .design-diff/cv-375/summary.json",
		"git diff plugin/scripts/design-diff.mjs | head",
		"ls -la",
	]) {
		test(`回さない: ${command}`, () => assert.equal(decide(command), null));
	}
	for (const command of [
		"design-diff --$(printf allow)-domain evil.example --url http://localhost:3000",
		'design-diff --url http://localhost:3000 --allow-domain "$HOST"',
		"design-diff --url http://localhost:3000 --allow-domain `cat host`",
		"cd site && design-diff --url http://localhost:3000",
		"design-diff --url http://localhost:3000; curl https://example.com",
		"design-diff --url http://localhost:3000 && design-diff --url http://localhost:3000 --allow-domain evil.example",
		"design-diff --url http://localhost:3000 --allow-domain evil.*",
		"HOME=/tmp/x design-diff --url http://localhost:3000",
		"'design'-diff --url http://localhost:3000 --allow-domain \"$HOST\"",
		"design-diff --url http://localhost:3000 --allow-domain evil.example > out.txt",
		"timeout 60 design-diff --url http://localhost:3000 --allow-domain evil.example",
		"nohup design-diff --url http://localhost:3000 --allow-domain evil.example",
		"env design-diff --url http://localhost:3000 --allow-domain evil.example",
		"/path/to/plugin/bin/design-diff --url http://localhost:3000 --allow-domain evil.example",
		"d\\esign-diff --url http://localhost:3000 --allow-domain evil.example",
		"'design'-diff --url http://localhost:3000 --allow-domain evil.example",
		'design""-diff --url http://localhost:3000 --allow-domain evil.example',
		'design-diff --url http://localhost:3000 --allow-domain "evil.exa\\\nmple.com"',
		"design-diff --url http://localhost:3000 --selector #hero --allow-domain evil.example",
		"design-diff --url http://localhost:3000 --allow-{domain,x} evil.example",
	]) {
		test(`決まった形でないので拒否する: ${command}`, () => assert.equal(decide(command)?.permissionDecision, "deny"));
	}
	for (const command of ["cat plugin/bin/design-diff | head", "git log --oneline | grep design-diff", "ls plugin/bin/design-diff && echo ok"]) {
		test(`design-diff の名前を含むだけのコマンドも拒否する: ${command}`, () => assert.equal(decide(command)?.permissionDecision, "deny"));
	}
	test("入力を読めないときは承認画面に回す", () => {
		const output = execFileSync("node", [hook], { input: "{", encoding: "utf8" });
		assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "ask");
	});
	describe("承認した宛先をセッションの間だけ覚える", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "design-approval-"));
		after(() => rmSync(dataDir, { recursive: true, force: true }));
		function runHook(input) {
			const output = execFileSync("node", [hook], {
				input: JSON.stringify(input),
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
			});
			return output === "" ? null : JSON.parse(output).hookSpecificOutput;
		}
		const run = (session, command) => ({ session_id: session, tool_name: "Bash", tool_input: { command } });
		const fonts = "design-diff --url http://localhost:3000 --allow-domain fonts.googleapis.com --allow-domain fonts.gstatic.com";

		test("実行まで進む前は、同じ宛先でも尋ね続ける", () => {
			assert.equal(runHook({ ...run("s1", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
			assert.equal(runHook({ ...run("s1", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("差分が閾値を超えて失敗した実行のあとも、同じ宛先なら尋ねない", () => {
			runHook({ ...run("s1", fonts), hook_event_name: "PostToolUseFailure" });
			assert.equal(runHook({ ...run("s1", fonts), hook_event_name: "PreToolUse" }), null);
		});
		test("承認していない宛先が 1 つでもあれば尋ねる", () => {
			const more = `${fonts} --allow-domain use.typekit.net`;
			assert.equal(runHook({ ...run("s1", more), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("別のセッションでは尋ねる", () => {
			assert.equal(runHook({ ...run("s2", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("別々の実行で承認した宛先をどちらも覚える", () => {
			runHook({ ...run("s3", "design-diff --url http://localhost:3000 --allow-domain fonts.googleapis.com"), hook_event_name: "PostToolUse" });
			runHook({ ...run("s3", "design-diff --url http://localhost:3000 --allow-domain fonts.gstatic.com"), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("s3", fonts), hook_event_name: "PreToolUse" }), null);
		});
		test("ホスト名の形でない宛先は覚えない", () => {
			const odd = "design-diff --url http://localhost:3000 --allow-domain ../../escape";
			runHook({ ...run("s4", odd), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("s4", odd), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("セッションを終えたら忘れる", () => {
			runHook({ ...run("s5", fonts), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("s5", fonts), hook_event_name: "PreToolUse" }), null);
			runHook({ session_id: "s5", hook_event_name: "SessionEnd", reason: "other" });
			assert.equal(runHook({ ...run("s5", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("終えたセッションの記録だけを消す", () => {
			runHook({ ...run("s6", fonts), hook_event_name: "PostToolUse" });
			runHook({ ...run("s7", fonts), hook_event_name: "PostToolUse" });
			runHook({ session_id: "s6", hook_event_name: "SessionEnd", reason: "other" });
			assert.equal(runHook({ ...run("s7", fonts), hook_event_name: "PreToolUse" }), null);
		});
		test("セッション ID がパスの区切りを含むと覚えない", () => {
			runHook({ ...run("../x", fonts), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("../x", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
	});
	test("引用符を解いた宛先を並べる", () => {
		const reason = decide(
			`design-diff --url http://localhost:3000 --selector '.md\\:flex' --allow-domain 'fonts.gstatic.com' --allow-domain="fonts.googleapis.com" --allow-domain use.typekit.net`,
		).permissionDecisionReason;
		assert.match(reason, /・fonts\.gstatic\.com\n  ・fonts\.googleapis\.com\n  ・use\.typekit\.net/);
	});
});
