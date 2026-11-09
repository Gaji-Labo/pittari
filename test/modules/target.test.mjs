import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { judge, targetLabel } from "../../plugin/scripts/modules/target.mjs";

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

describe("Stop hook の判定", () => {
	const target = { label: "cv-375", registeredAt: "2026-11-01T00:00:00.000Z" };
	const run = (minute, overrides) => ({
		at: `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
		pass: false,
		pixelPass: true,
		diffRatio: 0.01,
		layoutMismatched: null,
		edgeMismatched: null,
		treeHash: "a",
		...overrides,
	});

	test("登録してから一度も実行していなければ止める", () => {
		const before = { ...run(0), at: "2026-10-31T23:59:00.000Z", pass: true };
		assert.deepEqual(judge(target, [before], "a"), { done: false, reason: "差分チェックを一度も実行していない" });
	});

	test("合格したあとに作業ツリーが変わっていなければ終えてよい", () => {
		assert.deepEqual(judge(target, [run(1, { pass: true })], "a"), { done: true });
	});

	test("作業ツリーのハッシュを求められないプロジェクトでは、合否だけで判定する", () => {
		assert.deepEqual(judge(target, [run(1, { pass: true, treeHash: null })], "b"), { done: true });
		assert.deepEqual(judge(target, [run(1, { pass: true })], null), { done: true });
	});

	test("合格したあとに作業ツリーが変わっていれば止める", () => {
		assert.deepEqual(judge(target, [run(1, { pass: true })], "b"), {
			done: false,
			reason: "合格したあとにファイルが変わったが、差分チェックを再実行していない",
		});
	});

	test("不合格なら、落ちた判定の件数と調整の回数を理由に出す", () => {
		const runs = [run(1), run(2, { pixelPass: false, diffRatio: 0.0345, layoutMismatched: 2, edgeMismatched: 3 })];
		assert.deepEqual(judge(target, runs, "a"), {
			done: false,
			reason: "pass: false のまま（箱のずれ・未対応 2 件、辺のずれ 3 件、diffRatio 3.45%（閾値超え）、調整 1/3 回）",
		});
	});

	test("件数の無い以前の実行記録では、diffRatio だけを理由に出す", () => {
		const { reason } = judge(target, [{ ...run(1), pixelPass: undefined, layoutMismatched: undefined, edgeMismatched: undefined }], "a");
		assert.equal(reason, "pass: false のまま（diffRatio 1.00%、調整 0/3 回）");
	});

	test("調整が 3 回に達したら、合否と作業ツリーの変化を問わず終えてよい", () => {
		const adjusted = [run(1), run(2), run(3)];
		assert.deepEqual(judge(target, [...adjusted, run(4)], "a"), { done: true });
		assert.deepEqual(judge(target, [...adjusted, run(4, { pass: true })], "b"), { done: true });
	});
});
