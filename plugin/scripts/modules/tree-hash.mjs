import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// 試行中はコミットしないので、HEAD とコミットしていないファイルの中身から求める。
// 全ファイルではなくコミットしていないファイルだけを読むので、大きいリポジトリでも計測のたびに求められる
export function workingTreeHash(cwd) {
	let root;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		return null;
	}
	// 親のリポジトリが除外しているディレクトリでは、ファイルを変えても一覧に出ず、変更を見逃す
	try {
		git(cwd, ["check-ignore", "-q", "."]);
		return null;
	} catch {}
	let head;
	try {
		head = git(root, ["rev-parse", "HEAD"]).trim();
	} catch {
		head = "";
	}
	// git diff はリポジトリのルートからのパスを返すので、一覧もファイルの読み込みもルートを基準にする。
	// ステージしただけのファイルも拾うよう、作業ツリーをインデックスではなく HEAD と比べる
	const changed = head ? git(root, ["diff", "--name-only", "-z", "HEAD"]) : git(root, ["ls-files", "-z", "--cached"]);
	const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
	// .design-diff/ を .gitignore に入れ忘れたプロジェクトでも、実行記録を書き足すたびに値が変わらないようにする
	const files = [...new Set(`${changed}${untracked}`.split("\0"))]
		.filter((file) => file && !/(^|\/)\.design-diff\//.test(file))
		.sort();
	const hash = createHash("sha256");
	hash.update(head);
	for (const file of files) {
		hash.update(`\0${file}\0`);
		try {
			hash.update(readFileSync(join(root, file)));
		} catch {
			hash.update("<deleted>");
		}
	}
	return hash.digest("hex");
}
