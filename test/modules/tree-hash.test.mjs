import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeHash } from "../../plugin/scripts/modules/tree-hash.mjs";

const base = mkdtempSync(join(tmpdir(), "design-tree-hash-"));
after(() => rmSync(base, { recursive: true, force: true }));

// コミットに署名する設定の人の手元でも、準備のコミットで落ちないよう署名を切る
const gitOptions = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => execFileSync("git", [...gitOptions, ...args], { cwd, stdio: "ignore" });
const status = (cwd) => execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });

let repo;
beforeEach(() => {
	repo = mkdtempSync(join(base, "repo-"));
	git(repo, "init", "-q");
	writeFileSync(join(repo, "a.css"), "a {}");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
});

describe("作業ツリーのハッシュ", () => {
	test("git で管理していないディレクトリでは null を返す", () => {
		const plain = mkdtempSync(join(base, "plain-"));
		assert.equal(workingTreeHash(plain), null);
	});

	test("親のリポジトリが除外しているディレクトリでは null を返す", () => {
		writeFileSync(join(repo, ".gitignore"), "ignored/\n");
		mkdirSync(join(repo, "ignored"));
		assert.equal(workingTreeHash(join(repo, "ignored")), null);
	});

	test("コミットしていないファイルの中身が変わると値が変わる", () => {
		const clean = workingTreeHash(repo);
		writeFileSync(join(repo, "a.css"), "a { color: red }");
		const modified = workingTreeHash(repo);
		writeFileSync(join(repo, "b.css"), "b {}");
		const untracked = workingTreeHash(repo);
		assert.equal(new Set([clean, modified, untracked]).size, 3);
	});

	test("中身を変えずにコミットしても値が変わらない", () => {
		writeFileSync(join(repo, "a.css"), "a { color: red }");
		writeFileSync(join(repo, "b.css"), "b {}");
		const before = workingTreeHash(repo);
		git(repo, "add", ".");
		assert.equal(workingTreeHash(repo), before);
		git(repo, "commit", "-q", "-m", "change");
		assert.equal(workingTreeHash(repo), before);
	});

	test("呼んだ後も利用者のステージの状態を変えない", () => {
		writeFileSync(join(repo, "a.css"), "a { color: red }");
		writeFileSync(join(repo, "b.css"), "b {}");
		writeFileSync(join(repo, "c.css"), "c {}");
		git(repo, "add", "c.css");
		const before = status(repo);
		workingTreeHash(repo);
		assert.equal(status(repo), before);
	});

	test("まだ何もコミットしていないリポジトリでも値を返す", () => {
		const fresh = mkdtempSync(join(base, "fresh-"));
		git(fresh, "init", "-q");
		const empty = workingTreeHash(fresh);
		writeFileSync(join(fresh, "a.css"), "a {}");
		assert.notEqual(workingTreeHash(fresh), empty);
	});

	test(".design-diff の下のファイルは値に入れない", () => {
		const clean = workingTreeHash(repo);
		mkdirSync(join(repo, ".design-diff", "cv-375"), { recursive: true });
		writeFileSync(join(repo, ".design-diff", "cv-375", "runs.jsonl"), "{}\n");
		mkdirSync(join(repo, "app", ".design-diff"), { recursive: true });
		writeFileSync(join(repo, "app", ".design-diff", "runs.jsonl"), "{}\n");
		assert.equal(workingTreeHash(repo), clean);
	});
});
