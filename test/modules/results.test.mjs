import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendResultsFile,
	readInputFile,
	readResultsFile,
	UnsafeResultsPathError,
	writeResultsFiles,
} from "../../plugin/scripts/modules/results.mjs";

const base = mkdtempSync(join(tmpdir(), "design-results-"));
after(() => rmSync(base, { recursive: true, force: true }));
const caseInsensitive = existsSync(base.toUpperCase());

let project;
let outside;
let secret;
beforeEach(() => {
	const dir = mkdtempSync(join(base, "case-"));
	project = join(dir, "project");
	outside = join(dir, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	secret = join(outside, "secret.txt");
	writeFileSync(secret, "SECRET");
});

function assertOutsideUntouched() {
	assert.deepEqual(readdirSync(outside), ["secret.txt"]);
	assert.equal(readFileSync(secret, "utf8"), "SECRET");
}

function labelDir(label = "a-375") {
	const dir = join(project, ".design-diff", label);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("通常の読み書き", () => {
	test("書き出し、追記し、読み戻せる", () => {
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n");
		appendResultsFile(project, ["a-375"], "runs.jsonl", "2\n");
		assert.equal(readFileSync(join(project, ".design-diff", "a-375", "summary.json"), "utf8"), "{}");
		assert.equal(readResultsFile(project, ["a-375"], "runs.jsonl"), "1\n2\n");
	});

	test("無いファイルは null を返し、ディレクトリを作らない", () => {
		assert.equal(readResultsFile(project, ["a-375"], "runs.jsonl"), null);
		assert.deepEqual(readdirSync(project), []);
	});

	test("読み書きのあとにカレントディレクトリを戻す", () => {
		const before = process.cwd();
		writeResultsFiles(project, ["a-375"], { "x.json": "1" });
		assert.equal(process.cwd(), before);
		symlinkSync(outside, join(project, ".design-diff", "b"));
		assert.throws(() => writeResultsFiles(project, ["b"], { "x.json": "1" }), UnsafeResultsPathError);
		assert.equal(process.cwd(), before);
	});

	test("プロジェクトのディレクトリが無ければ null を返す", () => {
		assert.equal(readResultsFile(join(project, "gone"), ["sessions"], "s1.json"), null);
	});
});

describe("大文字と小文字を区別しないファイルシステム", { skip: !caseInsensitive && "大文字と小文字を区別するファイルシステム" }, () => {
	test("大文字・小文字だけが違うパスで渡されたプロジェクトにも読み書きできる", () => {
		writeResultsFiles(project.toUpperCase(), ["a-375"], { "x.json": "1" });
		assert.equal(readResultsFile(project, ["a-375"], "x.json"), "1");
	});

	test("大文字・小文字だけが違うラベルは、リンクとは別の理由で断る", () => {
		writeResultsFiles(project, ["cv-375"], { "x.json": "1" });
		assert.throws(() => writeResultsFiles(project, ["CV-375"], { "x.json": "2" }), /大文字・小文字だけが違う/);
		assert.equal(readResultsFile(project, ["cv-375"], "x.json"), "1");
	});
});

describe("ディレクトリがリンクや普通のファイルなら、読み書きしない", () => {
	test(".design-diff がシンボリックリンク", () => {
		symlinkSync(outside, join(project, ".design-diff"));
		assert.throws(() => writeResultsFiles(project, ["a-375"], { "x.json": "1" }), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("ラベルのディレクトリがシンボリックリンク", () => {
		mkdirSync(join(project, ".design-diff"));
		symlinkSync(outside, join(project, ".design-diff", "a-375"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test(".design-diff が普通のファイル", () => {
		writeFileSync(join(project, ".design-diff"), "");
		assert.throws(() => writeResultsFiles(project, ["a-375"], { "x.json": "1" }), UnsafeResultsPathError);
	});

	test("ラベルに .. を含む", () => {
		labelDir();
		assert.throws(() => readResultsFile(project, ["../.."], "secret.txt"), UnsafeResultsPathError);
	});
});

describe("ファイルがリンクなら、リンク先を読み書きしない", () => {
	test("書き出し先のシンボリックリンクは、リンクごと置き換わる", () => {
		symlinkSync(secret, join(labelDir(), "summary.json"));
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		assert.equal(lstatSync(join(labelDir(), "summary.json")).isSymbolicLink(), false);
		assertOutsideUntouched();
	});

	test("書き出し先のハードリンクは、リンクごと置き換わる", () => {
		linkSync(secret, join(labelDir(), "summary.json"));
		writeResultsFiles(project, ["a-375"], { "summary.json": "{}" });
		assertOutsideUntouched();
	});

	test("追記先がシンボリックリンク", () => {
		symlinkSync(secret, join(labelDir(), "runs.jsonl"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("追記先がハードリンク", () => {
		linkSync(secret, join(labelDir(), "runs.jsonl"));
		assert.throws(() => appendResultsFile(project, ["a-375"], "runs.jsonl", "1\n"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});

	test("読み込み先がシンボリックリンク", () => {
		symlinkSync(secret, join(labelDir("sessions"), "s1.json"));
		assert.throws(() => readResultsFile(project, ["sessions"], "s1.json"), UnsafeResultsPathError);
		assertOutsideUntouched();
	});
});

describe("--metadata・--texts の入力", () => {
	function inputsDir(session = "s1") {
		const dir = join(project, ".design-diff", "inputs", session);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	function assertRefused(path, error = UnsafeResultsPathError) {
		assert.throws(
			() => readInputFile(project, path),
			(thrown) => thrown instanceof error && !thrown.message.includes("SECRET"),
		);
	}

	test(".design-diff/inputs の下の XML と JSON を読める", () => {
		writeFileSync(join(inputsDir(), "1-2.xml"), "<frame />");
		writeFileSync(join(inputsDir(), "texts.json"), "{}");
		assert.equal(readInputFile(project, ".design-diff/inputs/s1/1-2.xml"), "<frame />");
		assert.equal(readInputFile(project, join(project, ".design-diff", "inputs", "s1", "texts.json")), "{}");
	});

	test(": ; や . 始まりを含む名前のファイルも読める", () => {
		for (const name of ["1:2.xml", "I1:2;3:4.xml", ".hidden"]) {
			writeFileSync(join(inputsDir(), name), name);
			assert.equal(readInputFile(project, `.design-diff/inputs/s1/${name}`), name);
		}
	});

	test("無いファイルは、読めなかったとしてエラーで終わる", () => {
		inputsDir();
		assert.throws(() => readInputFile(project, ".design-diff/inputs/s1/none.xml"), /ファイルがありません/);
	});

	describe("inputs の外のパスは読まない", () => {
		test("/etc/hosts", () => assertRefused("/etc/hosts"));

		test("プロジェクトの外の ../x.json", () => {
			writeFileSync(join(project, "..", "x.json"), "SECRET");
			assertRefused("../x.json");
		});

		test("プロジェクト直下の package.json", () => {
			writeFileSync(join(project, "package.json"), "SECRET");
			assertRefused("package.json");
		});

		test(".design-diff の中の inputs 以外", () => {
			writeFileSync(join(labelDir("sessions"), "s1.json"), "SECRET");
			assertRefused(".design-diff/sessions/s1.json");
			assertRefused(".design-diff/inputs/../sessions/s1.json");
		});

		for (const path of [".design-diff", ".design-diff/inputs"]) {
			test(path, () => {
				inputsDir();
				assertRefused(path);
			});
		}
	});

	describe("リンクなら読まない", () => {
		test("ファイルがシンボリックリンク", () => {
			symlinkSync(secret, join(inputsDir(), "1-2.xml"));
			assertRefused(".design-diff/inputs/s1/1-2.xml");
		});

		test("ファイルがハードリンク", () => {
			linkSync(secret, join(inputsDir(), "1-2.xml"));
			assertRefused(".design-diff/inputs/s1/1-2.xml");
		});

		test("inputs がシンボリックリンク", () => {
			mkdirSync(join(project, ".design-diff"));
			symlinkSync(outside, join(project, ".design-diff", "inputs"));
			assertRefused(".design-diff/inputs/secret.txt");
		});

		test("inputs の下のディレクトリがシンボリックリンク", () => {
			mkdirSync(join(project, ".design-diff", "inputs"), { recursive: true });
			symlinkSync(outside, join(project, ".design-diff", "inputs", "s1"));
			assertRefused(".design-diff/inputs/s1/secret.txt");
		});

		test(".design-diff がシンボリックリンク", () => {
			mkdirSync(join(outside, "inputs"));
			writeFileSync(join(outside, "inputs", "1-2.xml"), "SECRET");
			symlinkSync(outside, join(project, ".design-diff"));
			assertRefused(".design-diff/inputs/1-2.xml");
		});
	});
});
