import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAllowDomain } from "./design-network.mjs";

// design-diff は --allow-domain で渡した外部の宛先へ、撮影中の Chrome を通信させる。auto mode では承認を判定役のモデルが代わりに行うので、
// 外部の宛先を許可する実行は、PreToolUse の ask でどのモードでも人の承認画面に回す。
// 調整のたびの再実行で同じ宛先を尋ね続けないよう、実行まで進んだ（人が承認した）宛先をセッションの間だけ覚える。
// 日をおいて再開したセッションで、承認した経緯を人が覚えていない宛先や、その後に持ち主が変わった宛先を尋ねずに使わないよう、セッションを終えたら忘れる

// 承認画面に並べる宛先と実際に渡る引数が食い違わないよう、design-diff の名前を含むコマンドは、シェルが何も書き換えない決まった形のときだけ通す。
// シェルの規則を再現して design-diff を実行するかを見分ける方法では、timeout などを前に付けた形のように、サンドボックスの除外ルールに一致する形を
// hook が 1 つ見落とすたびに、AI は承認画面を通さずに外部の宛先を許可できる。
// 代わりに、名前を含むだけで design-diff を実行しないコマンドも拒否する
const WORD = String.raw`(?:[A-Za-z0-9_./:=@%+,-]|'[^']*'|"[^"$\x60\\]*")+`;
const RUNNABLE_DESIGN_DIFF = new RegExp(String.raw`^design-diff((?:[ \t]+${WORD})*)[ \t]*$`);

// シェルは引用符とバックスラッシュを取り除いてから実行するので、'design'-diff や d\esign-diff も design-diff の名前として拾う。
// 出力先の .design-diff/ を読むコマンドまで拒否しないよう、部分一致では拾わない
function mentionsDesignDiff(command) {
	const words = command.replace(/[\\'"]/g, "").split(/[\s;&|()`<>${}]+/);
	return words.some((word) => word === "design-diff" || word.endsWith("/design-diff"));
}

function allowDomainsIn(args) {
	const domains = [];
	args.forEach((arg, index) => {
		if (arg === "--allow-domain" && index + 1 < args.length) domains.push(args[index + 1]);
		else if (arg.startsWith("--allow-domain=")) domains.push(arg.slice("--allow-domain=".length));
	});
	return domains;
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
	return { domains: allowDomainsIn(args).map((domain) => domain.toLowerCase()) };
}

// 承認の記録は、サンドボックスの中から書けないプラグインのデータ用ディレクトリに置き、AI が承認を偽れないようにする。
// 並行して終えた実行どうしが同じファイルを読んで書き戻すと、片方の記録が消えるので、宛先ごとに空のファイルを作って記録する
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
function approvalDir(sessionId) {
	const dataDir = process.env.CLAUDE_PLUGIN_DATA;
	if (!dataDir || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
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

function rememberApproved(sessionId, domains) {
	const dir = approvalDir(sessionId);
	if (dir === null) return;
	mkdirSync(dir, { recursive: true });
	// 宛先をファイル名に使うので、パスの区切りを含みうる値は記録しない。design-diff もホスト名の形でない値を受け付けない
	for (const domain of domains.filter(isValidAllowDomain)) writeFileSync(join(dir, domain), "");
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

// 強制終了などで SessionEnd が動かなかったセッションの記録は消えずに残る。記録は空のファイルで、別のセッションの承認には使われないので、残っても消さない
if (input?.hook_event_name === "SessionEnd") {
	const dir = approvalDir(input.session_id);
	if (dir !== null) rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}

// 失敗した（差分が閾値を超えて終了コード 1 で終えた）実行も、人が承認して実行まで進んだことに変わりはない。
// 承認画面で拒否された呼び出しでは、PostToolUseFailure は動かない（Claude Code の hooks の文書による）
if (input?.hook_event_name === "PostToolUse" || input?.hook_event_name === "PostToolUseFailure") {
	const parsed = command === null ? null : parseDesignDiff(command);
	if (parsed?.domains?.length > 0) rememberApproved(input.session_id, parsed.domains);
	process.exit(0);
}

// Claude Code の入力の形が変わって hook がコマンドを読めなくなったときに、外部の宛先を許可する実行が承認画面を通らずに実行されないようにする
if (command === null) {
	decide("ask", "design-to-code の hook が Bash のコマンドを読み取れませんでした。外部サイトとの通信を見逃さないよう、すべての Bash の実行を承認画面に回しています。");
}
const parsed = parseDesignDiff(command);
if (parsed === null) process.exit(0);
if (parsed.denyReason) decide("deny", parsed.denyReason);

const approved = readApproved(input.session_id);
const domains = parsed.domains;
if (domains.every((domain) => approved.includes(domain))) process.exit(0);

decide(
	"ask",
	[
		"デザインとの比較のため、開発中のページが次の外部サイトと通信することを許可しますか？",
		"",
		...domains.map((domain) => `  ・${domain}`),
		"",
		"許可すると、開発中のページのプログラムがこれらのサイトへデータを送れるようになります。フォントや画像の配信元として知っているサイトだけを許可してください。",
		"このセッションの間は、許可したサイトだけを使う実行では再び尋ねません。",
	].join("\n"),
);
