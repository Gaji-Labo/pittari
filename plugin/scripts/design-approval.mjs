import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAllowDomain, isValidAllowOrigin } from "./modules/network.mjs";
import { isValidSessionId } from "./modules/session.mjs";

// シェルの規則を再現して design-diff を実行するかを見分ける方法では、timeout などを前に付けた形のように、サンドボックスの除外ルールに一致する形を
// hook が 1 つ見落とすたびに、AI は承認画面を通さずに外部の宛先を許可できる。そこで、シェルが何も書き換えない決まった形だけを通す
const WORD = String.raw`(?:[A-Za-z0-9_./:=@%+,-]|'[^']*'|"[^"$\x60\\]*")+`;
const RUNNABLE_DESIGN_DIFF = new RegExp(String.raw`^design-diff((?:[ \t]+${WORD})*)[ \t]*$`);

// シェルは引用符とバックスラッシュを取り除いてから実行するので、'design'-diff や d\esign-diff も design-diff の名前として拾う
function mentionsDesignDiff(command) {
	const words = command.replace(/[\\'"]/g, "").split(/[\s;&|()`<>${}]+/);
	return words.some((word) => word === "design-diff" || word.endsWith("/design-diff"));
}

function optionValuesIn(args, option) {
	const values = [];
	args.forEach((arg, index) => {
		if (arg === option && index + 1 < args.length) values.push(args[index + 1]);
		else if (arg.startsWith(`${option}=`)) values.push(arg.slice(option.length + 1));
	});
	return values;
}

const DENY_REASON = [
	"design-diff は、design-diff で始まる単独のコマンドとして実行してください。cd・環境変数・timeout などを前に付けた形、&& などでほかのコマンドとつないだ形、変数、リダイレクトは使えません。",
	"英数字と . / : = @ % + , - _ 以外の文字を含む引数は引用符で囲み、$・バッククォート・バックスラッシュを含む引数は単一引用符で囲みます。",
	"design-diff のコードや出力を探す・読むときは、Bash ではなく Grep・Read ツールを使ってください。",
].join("\n");

function parseDesignDiff(command) {
	if (!mentionsDesignDiff(command)) return null;
	const match = RUNNABLE_DESIGN_DIFF.exec(command);
	if (match === null) return { denyReason: DENY_REASON };
	const args = (match[1].match(new RegExp(WORD, "g")) ?? []).map((arg) => arg.replace(/'([^']*)'|"([^"]*)"/g, (_, single, double) => single ?? double));
	return {
		domains: optionValuesIn(args, "--allow-domain").map((domain) => domain.toLowerCase()),
		origins: optionValuesIn(args, "--allow-origin"),
	};
}

// 承認の記録は、サンドボックスの中から書けないプラグインのデータ用ディレクトリに置き、AI が承認を偽れないようにする。
// 並行して終えた実行どうしが記録を消し合わないよう、宛先ごとに空のファイルを作る
function approvalDir(sessionId) {
	const dataDir = process.env.CLAUDE_PLUGIN_DATA;
	if (!dataDir || !isValidSessionId(sessionId)) return null;
	return join(dataDir, "approved-domains", sessionId);
}

function readApproved(sessionId) {
	const dir = approvalDir(sessionId);
	if (dir === null) return [];
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

// オリジンは / を含むのでそのままではファイル名にできない。符号化した名前は % を含み、ホスト名の記録と重ならない
const originRecordName = (origin) => encodeURIComponent(origin);

function rememberApproved(sessionId, { domains, origins }) {
	const dir = approvalDir(sessionId);
	if (dir === null) return;
	mkdirSync(dir, { recursive: true });
	const names = [...domains.filter(isValidAllowDomain), ...origins.filter(isValidAllowOrigin).map(originRecordName)];
	for (const name of names) writeFileSync(join(dir, name), "");
}

function decide(permissionDecision, permissionDecisionReason) {
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));
	process.exit(0);
}

let input = null;
try {
	input = JSON.parse(readFileSync(0, "utf8"));
} catch {}
const command = typeof input?.tool_input?.command === "string" ? input.tool_input.command : null;

if (input?.hook_event_name === "SessionEnd") {
	const dir = approvalDir(input.session_id);
	if (dir !== null) rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}

// PostToolUseFailure でも記録するのは、差分が閾値を超えて終了コード 1 で終えた実行も、人が承認して実行まで進んでいるため
if (input?.hook_event_name === "PostToolUse" || input?.hook_event_name === "PostToolUseFailure") {
	const parsed = command === null ? null : parseDesignDiff(command);
	if (parsed?.domains?.length > 0 || parsed?.origins?.length > 0) rememberApproved(input.session_id, parsed);
	process.exit(0);
}

if (command === null) {
	decide("ask", "design-to-code の hook が Bash のコマンドを読み取れませんでした。外部サイトとの通信を見逃さないよう、すべての Bash の実行を承認画面に回しています。");
}
const parsed = parseDesignDiff(command);
if (parsed === null) process.exit(0);
if (parsed.denyReason) decide("deny", parsed.denyReason);

const approved = readApproved(input.session_id);
const { domains, origins } = parsed;
if (domains.every((domain) => approved.includes(domain)) && origins.every((origin) => approved.includes(originRecordName(origin)))) {
	process.exit(0);
}

const sections = [];
if (domains.length > 0) {
	sections.push(
		"次の外部サイト:",
		...domains.map((domain) => `  ・${domain}`),
		"許可すると、開発中のページのプログラムがこれらのサイトへデータを送れるようになります。フォントや画像の配信元として知っているサイトだけを許可してください。",
		"",
	);
}
if (origins.length > 0) {
	sections.push(
		"このマシンで動いている次のサーバー:",
		...origins.map((origin) => `  ・${origin}`),
		"許可すると、開発中のページのプログラムがこれらのサーバーへ要求を送り、返ってきた内容を撮影結果に写せるようになります。このプロジェクトの API サーバーなど、何が動いているか知っているものだけを許可してください。",
		"",
	);
}
decide(
	"ask",
	[
		"デザインとの比較のため、開発中のページが次の宛先と通信することを許可しますか？",
		"",
		...sections,
		"一度許可した宛先は、このセッションの間は再び尋ねません。",
	].join("\n"),
);
