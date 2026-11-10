import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function git(cwd, args, env) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: env ? { ...process.env, ...env } : undefined,
	});
}

// 試行の途中でコミットしても値が変わらないよう、HEAD を含めず、ファイルの中身だけから木のハッシュを求める。
// 利用者のステージの状態を変えないよう、実際のインデックスではなく、その複製に作業ツリーを丸ごと加える。
// 空のインデックスから作ると stat のキャッシュが効かず、大きいリポジトリでは計測のたびに全ファイルを読み直すことになる
export function workingTreeHash(cwd) {
	let root;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		return null;
	}
	// 親のリポジトリが除外しているディレクトリでは、ファイルを変えても値に入らず、変更を見逃す
	try {
		git(cwd, ["check-ignore", "-q", "."]);
		return null;
	} catch {}
	const index = resolve(root, git(root, ["rev-parse", "--git-path", "index"]).trim());
	const tempDir = mkdtempSync(join(tmpdir(), "design-tree-hash-"));
	const tempIndex = join(tempDir, "index");
	try {
		try {
			copyFileSync(index, tempIndex);
		} catch {
			// まだ一度も git add していないリポジトリにはインデックスがないので、空のインデックスから作る
		}
		const env = { GIT_INDEX_FILE: tempIndex };
		// .design-diff/ を .gitignore に入れ忘れたプロジェクトでも、実行記録を書き足すたびに値が変わらないようにする
		git(root, ["add", "-A", "--", ":(top,exclude,glob)**/.design-diff/**"], env);
		return git(root, ["write-tree"], env).trim();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
