import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compareEdges, formatEdgeReport } from "../../plugin/scripts/modules/edges.mjs";

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

// 単体テストは plugin の依存を入れる前に走り、pngjs を使えないので、compareEdges が読む width・height・data だけを持つ画像を作る
function image(width, height, rects) {
	const data = new Uint8Array(width * height * 4).fill(255);
	for (const { x, y, w, h, color } of rects) {
		for (let row = y; row < y + h; row++) {
			for (let column = x; column < x + w; column++) data.set([...color, 255], (row * width + column) * 4);
		}
	}
	return { width, height, data };
}

const ALL_SIDES = { top: true, bottom: true, left: true, right: true };
const NO_SIDES = { top: false, bottom: false, left: false, right: false };

function element(overrides) {
	return {
		label: "div.card",
		left: 20,
		top: 20,
		right: 60,
		bottom: 50,
		painted: ALL_SIDES,
		radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
		text: null,
		textBox: null,
		...overrides,
	};
}

const OPTIONS = { scale: 1, offset: { x: 0, y: 0 }, tolerance: 1, isExcluded: () => false };

// 箱の辺のずれは、一致した位置の符号を反転して求めるので、ずれの無い辺は -0 になる。edges.json にも報告にも 0 と出るので、0 として比べる
const withoutNegativeZero = (result) => ({ ...result, delta: Object.is(result.delta, -0) ? 0 : result.delta });

const bySide = (results, kind) =>
	Object.fromEntries(results.filter((result) => result.kind === kind).map((result) => [result.side, withoutNegativeZero(result)]));

describe("背景のある箱の辺", () => {
	const actual = image(100, 80, [{ x: 20, y: 20, w: 40, h: 30, color: RED }]);

	test("見本と同じ位置の辺は、ずれ 0 で OK になる", () => {
		const results = compareEdges(actual, actual, [element()], OPTIONS).map(withoutNegativeZero);
		assert.deepEqual(
			results.map((result) => [result.side, result.status, result.delta]),
			[
				["top", "OK", 0],
				["bottom", "OK", 0],
				["left", "OK", 0],
				["right", "OK", 0],
			],
		);
	});

	test("見本の箱が右へ 3px 寄ると、左辺と右辺が -3 のずれになる", () => {
		const design = image(100, 80, [{ x: 23, y: 20, w: 40, h: 30, color: RED }]);
		const sides = bySide(compareEdges(design, actual, [element()], OPTIONS), "box");
		assert.deepEqual([sides.left.status, sides.left.delta], ["ずれ", -3]);
		assert.deepEqual([sides.right.status, sides.right.delta], ["ずれ", -3]);
		assert.deepEqual([sides.top.status, sides.bottom.status], ["OK", "OK"]);
	});

	test("見本の箱が右へ 2px 広いと、右辺だけが -2 のずれになる", () => {
		const design = image(100, 80, [{ x: 20, y: 20, w: 42, h: 30, color: RED }]);
		const sides = bySide(compareEdges(design, actual, [element()], OPTIONS), "box");
		assert.deepEqual([sides.right.status, sides.right.delta], ["ずれ", -2]);
		assert.deepEqual([sides.top.status, sides.bottom.status, sides.left.status], ["OK", "OK", "OK"]);
	});

	test("見本の探す範囲に境界が無ければ、ずれの値を出さずに理由を出す", () => {
		const results = compareEdges(image(100, 80, []), actual, [element()], OPTIONS);
		for (const result of results) {
			assert.deepEqual([result.status, result.delta, result.reason], ["ずれ", null, "デザイン画像の ±8px 以内に同じ境界が無い"]);
		}
	});

	test("倍率 2 の画像では、ずれを CSS px で出す", () => {
		const actual2x = image(200, 160, [{ x: 40, y: 40, w: 80, h: 60, color: RED }]);
		const design2x = image(200, 160, [{ x: 42, y: 40, w: 80, h: 60, color: RED }]);
		const sides = bySide(compareEdges(design2x, actual2x, [element()], { ...OPTIONS, scale: 2 }), "box");
		assert.deepEqual([sides.left.delta, sides.right.delta], [-1, -1]);
	});
});

describe("判定不能の辺", () => {
	const actual = image(100, 80, [{ x: 20, y: 20, w: 40, h: 30, color: RED }]);

	test("要素自身が描かない辺は判定しない", () => {
		const results = compareEdges(actual, actual, [element({ painted: NO_SIDES })], OPTIONS);
		for (const result of results) assert.deepEqual([result.status, result.delta], ["判定不能", null]);
	});

	test("辺をまたぐ帯が比較から外した範囲にかかる辺は判定しない", () => {
		const sides = bySide(compareEdges(actual, actual, [element()], { ...OPTIONS, isExcluded: (x) => x < 40 }), "box");
		assert.equal(sides.left.status, "判定不能");
		assert.deepEqual([sides.top.status, sides.bottom.status, sides.right.status], ["OK", "OK", "OK"]);
	});
});

describe("入れ子の要素の辺", () => {
	// collectElementBoxes は親を子より先に集めるので、渡す順は外側の要素が先になる
	test("位置も範囲も同じ辺は 1 つにまとめ、要素の名前を渡された順に並べる", () => {
		const actual = image(100, 80, [{ x: 20, y: 20, w: 40, h: 30, color: RED }]);
		const results = compareEdges(actual, actual, [element(), element({ label: "div.inner" })], OPTIONS);
		assert.equal(results.length, 4);
		for (const result of results) assert.deepEqual(result.elements, ["div.card", "div.inner"]);
	});
});

describe("文字の辺", () => {
	// 字の代わりに、背景と色の違う棒を置く
	const actual = image(100, 60, [{ x: 20, y: 20, w: 30, h: 8, color: BLUE }]);
	const textElement = element({
		left: 10,
		top: 10,
		right: 80,
		bottom: 40,
		painted: NO_SIDES,
		text: "hello",
		textBox: { left: 15, top: 15, right: 60, bottom: 35 },
	});

	test("字の外接矩形の辺を、要素の名前と文字を添えて照合する", () => {
		const sides = bySide(compareEdges(actual, actual, [textElement], OPTIONS), "text");
		for (const side of ["top", "bottom", "left", "right"]) {
			assert.deepEqual([sides[side].status, sides[side].delta], ["OK", 0]);
			assert.deepEqual(sides[side].elements, ["div.card の文字「hello」"]);
		}
	});

	test("見本の字が右へ 3px 長いと、右辺が -3 のずれになる", () => {
		const design = image(100, 60, [{ x: 20, y: 20, w: 33, h: 8, color: BLUE }]);
		const sides = bySide(compareEdges(design, actual, [textElement], OPTIONS), "text");
		assert.deepEqual([sides.right.status, sides.right.delta], ["ずれ", -3]);
		assert.deepEqual([sides.top.status, sides.bottom.status, sides.left.status], ["OK", "OK", "OK"]);
	});

	test("見本の字が探す範囲の外まで続くと、ずれの値を出さずに理由を出す", () => {
		const design = image(100, 60, [{ x: 20, y: 20, w: 60, h: 8, color: BLUE }]);
		const sides = bySide(compareEdges(design, actual, [textElement], OPTIONS), "text");
		assert.deepEqual([sides.right.status, sides.right.delta, sides.right.reason], ["ずれ", null, "デザイン画像では ±8px より外まで字が続く"]);
	});
});

describe("報告の行", () => {
	test("[辺] のずれの行に、辺の位置とずれを出す", () => {
		const report = formatEdgeReport(
			[{ side: "top", kind: "box", positionCssPx: 10, rangeCssPx: [0, 100], elements: ["div.card"], status: "ずれ", delta: -2, reason: null }],
			1,
		);
		assert.match(report, /上辺 y=10（x=0〜100） {2}-2\.0 {2}← div\.card/);
	});
});
