import { INPUTS_DIR, isValidResultsDirName, readResultsFile } from "./results.mjs";

// 比較対象（target）は、design-target register で登録し、design-diff が測る、セレクタと幅の組

export const SESSIONS_DIR = "sessions";

export const RUN_LOG_FILE = "runs.jsonl";

// #10 で設定できるようにするまでは、SKILL.md Step 5 項目 7 の「調整は最大 3 回」と同じ値を持つ
const MAX_ADJUSTMENTS = 3;

export function targetLabel({ selector, width, designWidth, out }) {
	if (out) {
		// 書き出すときに results.mjs も同じ規則で断るが、そのエラーは --out の名前を挙げないので、ここで先に断る
		if (!isValidResultsDirName(out)) {
			throw new Error(`--out には英数字・-・_ だけの名前を指定してください（渡された値: "${out}"）`);
		}
		// ファイル名は重ならないので動作に支障はないが、計測の結果と登録や入力のファイルが同じディレクトリに混ざって見分けにくくなるので弾く
		if (out === SESSIONS_DIR) throw new Error(`--out に "${SESSIONS_DIR}" は使えません。Stop hook の登録の置き場所と重なります`);
		if (out === INPUTS_DIR) throw new Error(`--out に "${INPUTS_DIR}" は使えません。--metadata・--texts のファイルの置き場所と重なります`);
		return out;
	}
	// 同じセレクタ・同じビューポートで書き出し幅だけ変えた実行が上書きし合わないよう、指定時は幅を重ねる
	const designWidthLabel = designWidth === undefined ? "" : `-${Number(designWidth)}`;
	return `${selector.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}-${Number(width)}${designWidthLabel}`;
}

export function readRuns(projectDir, label) {
	return (readResultsFile(projectDir, [label], RUN_LOG_FILE) ?? "")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function judge(target, runs, treeHash) {
	const runsSinceRegistered = runs.filter((run) => run.at >= target.registeredAt);
	const latest = runsSinceRegistered.at(-1);
	if (!latest) return { done: false, reason: "差分チェックを一度も実行していない" };
	// 作業ツリーのハッシュを求められない（git 管理外の）プロジェクトでは、変更の有無を問わずに合否だけで判定する
	const fresh = latest.treeHash === null || treeHash === null || latest.treeHash === treeHash;
	if (latest.pass && fresh) return { done: true };
	const adjustments = runsSinceRegistered.length - 1;
	if (adjustments >= MAX_ADJUSTMENTS) return { done: true };
	if (latest.pass) return { done: false, reason: "合格したあとにファイルが変わったが、差分チェックを再実行していない" };
	// 件数を記録していない以前の実行記録では、どの判定で落ちたかが分からないので diffRatio だけを出す
	const failures = [
		latest.layoutMismatched > 0 && `箱のずれ・未対応 ${latest.layoutMismatched} 件`,
		latest.edgeMismatched > 0 && `辺のずれ ${latest.edgeMismatched} 件`,
		`diffRatio ${(latest.diffRatio * 100).toFixed(2)}%${latest.pixelPass === false ? "（閾値超え）" : ""}`,
	].filter(Boolean);
	return {
		done: false,
		reason: `pass: false のまま（${failures.join("、")}、調整 ${adjustments}/${MAX_ADJUSTMENTS} 回）`,
	};
}
