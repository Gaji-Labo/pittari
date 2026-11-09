import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		test(`承認画面に回さない: ${command}`, () => assert.equal(decide(command), null));
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
		const api = "design-diff --url http://localhost:3000 --allow-origin http://localhost:8080";

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
		test("承認したローカルのオリジンも覚え、別のポートは尋ねる", () => {
			assert.equal(runHook({ ...run("s8", api), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
			runHook({ ...run("s8", api), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("s8", api), hook_event_name: "PreToolUse" }), null);
			const otherPort = "design-diff --url http://localhost:3000 --allow-origin http://localhost:9000";
			assert.equal(runHook({ ...run("s8", otherPort), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("オリジンの形でない --allow-origin の値は覚えない", () => {
			const odd = "design-diff --url http://localhost:3000 --allow-origin http://localhost:8080/../..";
			runHook({ ...run("s9", odd), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("s9", odd), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("同じ文字列のホスト名とオリジンの記録を取り違えない", () => {
			runHook({ ...run("s10", "design-diff --url http://localhost:3000 --allow-domain fonts.gstatic.com"), hook_event_name: "PostToolUse" });
			const origin = "design-diff --url http://localhost:3000 --allow-origin http://fonts.gstatic.com";
			assert.equal(runHook({ ...run("s10", origin), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
		test("セッション ID がパスの区切りを含むと覚えない", () => {
			runHook({ ...run("../x", fonts), hook_event_name: "PostToolUse" });
			assert.equal(runHook({ ...run("../x", fonts), hook_event_name: "PreToolUse" })?.permissionDecision, "ask");
		});
	});
	for (const command of [
		"design-diff --url http://localhost:3000 --allow-origin http://localhost:8080",
		"design-diff --url http://localhost:3000 --allow-origin=http://localhost:8080",
	]) {
		test(`ローカルのオリジンを許可する実行も承認画面に回す: ${command}`, () => {
			const output = decide(command);
			assert.equal(output?.permissionDecision, "ask");
			assert.match(output.permissionDecisionReason, /このマシンで動いている次のサーバー:\n  ・http:\/\/localhost:8080/);
		});
	}
	test("引用符を解いた宛先を並べる", () => {
		const reason = decide(
			`design-diff --url http://localhost:3000 --selector '.md\\:flex' --allow-domain 'fonts.gstatic.com' --allow-domain="fonts.googleapis.com" --allow-domain use.typekit.net`,
		).permissionDecisionReason;
		assert.match(reason, /・fonts\.gstatic\.com\n  ・fonts\.googleapis\.com\n  ・use\.typekit\.net/);
	});
});
