import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeHash } from "../../plugin/scripts/modules/tree-hash.mjs";

const base = mkdtempSync(join(tmpdir(), "design-tree-hash-"));
after(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, stdio: "ignore" });

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

	test("ステージしただけの変更も値に入る", () => {
		const clean = workingTreeHash(repo);
		writeFileSync(join(repo, "a.css"), "a { color: red }");
		git(repo, "add", "a.css");
		assert.notEqual(workingTreeHash(repo), clean);
	});

	test(".design-diff の下のファイルは値に入れない", () => {
		const clean = workingTreeHash(repo);
		mkdirSync(join(repo, ".design-diff", "cv-375"), { recursive: true });
		writeFileSync(join(repo, ".design-diff", "cv-375", "runs.jsonl"), "{}\n");
		assert.equal(workingTreeHash(repo), clean);
	});
});
