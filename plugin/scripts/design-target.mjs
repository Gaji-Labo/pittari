import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { readResultsFile, UnsafeResultsPathError, writeResultsFiles } from "./modules/results.mjs";
import { isValidSessionId } from "./modules/session.mjs";
import { judge, readRuns, SESSIONS_DIR, targetLabel } from "./modules/target.mjs";
import { workingTreeHash } from "./modules/tree-hash.mjs";

function readSession(projectDir, sessionId) {
	const text = readResultsFile(projectDir, [SESSIONS_DIR], `${sessionId}.json`);
	return text === null ? null : JSON.parse(text);
}

function writeSession(projectDir, sessionId, session) {
	writeResultsFiles(projectDir, [SESSIONS_DIR], { [`${sessionId}.json`]: JSON.stringify(session, null, 2) });
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function register(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			session: { type: "string" },
			selector: { type: "string" },
			width: { type: "string" },
			"design-width": { type: "string" },
			out: { type: "string" },
		},
	});
	const missing = ["session", "selector", "width"].filter((key) => !values[key]);
	if (missing.length > 0) fail(`必須引数が不足しています: ${missing.map((k) => `--${k}`).join(", ")}`);
	// SKILL.md の ${CLAUDE_SESSION_ID} が置き換えられない環境では、どのセッションの Stop hook からも見つからない登録になる
	if (!isValidSessionId(values.session)) {
		fail(`--session がセッション ID になっていません（渡された値: "${values.session}"）。差分チェックの完走は Stop hook で確かめられません。`);
	}
	const projectDir = process.cwd();
	const session = readSession(projectDir, values.session) ?? { targets: [] };
	let label;
	try {
		label = targetLabel({ selector: values.selector, width: values.width, designWidth: values["design-width"], out: values.out });
	} catch (error) {
		fail(error.message);
	}
	// 登録し直して登録時刻を進めると、それまでの試行が数えられなくなるので、最初の登録を残す
	if (!session.targets.some((target) => target.label === label)) {
		session.targets.push({ label, selector: values.selector, width: Number(values.width), registeredAt: new Date().toISOString() });
	}
	writeSession(projectDir, values.session, session);
	console.log(`登録済み: ${label}`);
}

function stopHook() {
	const input = JSON.parse(readFileSync(0, "utf8"));
	let projectDir;
	let session;
	let unsafeError;
	for (const dir of [input.cwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean)) {
		// 片方の .design-diff がリンクでも、もう片方に登録があれば完走を確かめられるので、どちらでも読めないときだけ失敗にする
		try {
			session = readSession(dir, input.session_id);
		} catch (error) {
			if (!(error instanceof UnsafeResultsPathError)) throw error;
			unsafeError ??= error;
			continue;
		}
		if (session) {
			projectDir = dir;
			break;
		}
	}
	if (!projectDir) {
		if (unsafeError) throw unsafeError;
		return;
	}
	const treeHash = workingTreeHash(projectDir);
	const pending = session.targets
		.map((target) => ({ target, ...judge(target, readRuns(projectDir, target.label), treeHash) }))
		.filter((result) => !result.done);
	if (pending.length === 0) return;

	// 開発サーバーが止まっているなどで差分チェックを実行できないと、止め続けても状態が変わらず終われなくなる。
	// 前回止めたときから実行記録も作業ツリーも変わっていなければ、同じ理由では止めない
	const state = JSON.stringify([treeHash, ...session.targets.map((target) => readRuns(projectDir, target.label).length)]);
	if (session.lastBlockedState === state) return;
	writeSession(projectDir, input.session_id, { ...session, lastBlockedState: state });

	const lines = pending.map(({ target, reason }) => `- ${target.label}: ${reason}`);
	const reason = [
		"design-to-code の差分チェックが終わっていません。",
		...lines,
		"SKILL.md の Step 5 に沿って design-diff を実行し、合格するか調整が上限に達するまで続けてください。",
		"開発サーバーが止まっているなど差分チェックを実行できない場合は、その理由をユーザーに報告して終えてください。",
	].join("\n");
	console.log(JSON.stringify({ decision: "block", reason }));
}

const [command, ...argv] = process.argv.slice(2);
try {
	if (command === "register") register(argv);
	else if (command === "stop-hook") stopHook();
	else fail("使い方: design-target register --session <ID> --selector <セレクタ> --width <幅> [--design-width <幅>] [--out <名前>]");
} catch (error) {
	if (!(error instanceof UnsafeResultsPathError)) throw error;
	// Stop hook で止めると、登録を書き戻せずに同じ理由で止め続けるので、ユーザーに見える失敗として終える
	fail(`.design-diff の中を読み書きせずに終えました: ${error.message}`);
}
