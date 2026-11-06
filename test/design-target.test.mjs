import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { targetLabel } from "../plugin/scripts/design-target.mjs";

describe("--out", () => {
	test("英数字・-・_ の名前はそのままラベルになる", () => {
		assert.equal(targetLabel({ selector: "#cv", width: "375", out: "score-375_a" }), "score-375_a");
	});
	for (const out of ["../x", "a/b", "../../x", ".", "a b"]) {
		test(`断る: ${out}`, () => assert.throws(() => targetLabel({ selector: "#cv", width: "375", out })));
	}
	test("Stop hook の登録の置き場所と同じ sessions を断る", () => {
		assert.throws(() => targetLabel({ selector: "#cv", width: "375", out: "sessions" }));
	});
	test("--metadata・--texts のファイルの置き場所と同じ inputs を断る", () => {
		assert.throws(() => targetLabel({ selector: "#cv", width: "375", out: "inputs" }));
	});
	test("--out が無ければセレクタと幅から作る", () => {
		assert.equal(targetLabel({ selector: "#cv", width: "375" }), "cv-375");
	});
});
