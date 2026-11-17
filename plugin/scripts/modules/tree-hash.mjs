import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
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

// 試行の途中でコミットしても値が変わらないよう、ファイルの中身だけから木のハッシュを求める。
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
			// git は、インデックスを書いた時刻以降に更新されたファイルを、stat が一致していても中身を読み直して確かめる。
			// 複製の更新時刻が今になると git がこの読み直しをしなくなり、インデックスを書いた直後の書き換えを見逃す
			const { atime, mtime } = statSync(index);
			utimesSync(tempIndex, atime, mtime);
		} catch {
			// まだ一度も git add していないリポジトリにはインデックスがないので、空のインデックスから作る
		}
		const env = { GIT_INDEX_FILE: tempIndex };
		// .design-diff/ を .gitignore に入れ忘れたプロジェクトでも、実行記録を書き足すたびや、
		// 実行記録をステージ・コミットしたときに値が変わらないよう、インデックスにある分も外す
		const designDiff = "**/.design-diff/**";
		git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", `:(top,glob)${designDiff}`], env);
		// 読めないファイルが 1 つあるだけで design-diff が起動できなくならないよう、そのファイルを飛ばして続ける。
		// --ignore-errors でも飛ばしたファイルがあると 1 で終わるので、1 も成功として扱う
		const add = spawnSync("git", ["add", "-A", "--ignore-errors", "--", `:(top,exclude,glob)${designDiff}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, ...env },
		});
		if (add.error) throw add.error;
		// clean フィルタのコマンドが見つからないなどで git add が失敗したときに例外にすると、design-diff は計測できず、
		// Stop hook は異常終了して Claude Code の終了を止められなくなる。ハッシュを求められない扱いにして、判定を緩めたことは警告で知らせる
		if (add.status !== 0 && add.status !== 1) {
			console.warn(
				[
					`警告: git add が ${add.status} で終了したため、作業ツリーのハッシュを求められませんでした。`,
					"合格したあとにファイルが変わったかは確かめず、合否と調整回数だけで差分チェックの完走を判定します。",
					add.stderr.trim(),
				].join("\n"),
			);
			return null;
		}
		return git(root, ["write-tree"], env).trim();
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
