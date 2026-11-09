import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compareLayout, formatLayoutReport, parseMetadata } from "../../plugin/scripts/modules/layout.mjs";

const METADATA = `<frame id="1:1" name="Hero" x="500" y="300" width="400" height="200">
  <text id="1:2" name="Title" x="20" y="10" width="100" height="24" />
  <frame id="1:3" name="Body" x="20" y="50" width="300" height="100">
    <rectangle id="1:4" name="Bg" x="5" y="5" width="50" height="50" />
    <rectangle id="1:5" name="Hidden" hidden="true" x="0" y="0" width="1" height="1" />
  </frame>
  <instance id="1:6" name="Button" x="20" y="160" width="80" height="30" />
</frame>`;
const INSTANCE_METADATA = `<instance id="1:6" name="Button" x="999" y="999" width="80" height="30">
  <text id="1:7" name="Label" x="10" y="5" width="60" height="20" />
</instance>`;
const INSTANCE_WARNING = 'インスタンス "Button"（id="1:6"）の内部が無い。get_metadata をこの id で呼び、その出力も --metadata に渡す';

describe("--metadata の XML", () => {
	test("親相対の座標を、ルートの左上が原点の座標にし、非表示のノードを除く", () => {
		const { nodes } = parseMetadata([METADATA]);
		assert.deepEqual(
			nodes.map(({ id, depth, x, y, width, height }) => [id, depth, x, y, width, height]),
			[
				["1:1", 0, 0, 0, 400, 200],
				["1:2", 1, 20, 10, 100, 24],
				["1:3", 1, 20, 50, 300, 100],
				["1:4", 2, 25, 55, 50, 50],
				["1:6", 1, 20, 160, 80, 30],
			],
		);
	});

	test("内部の無いインスタンスを警告する", () => {
		assert.deepEqual(parseMetadata([METADATA]).warnings, [INSTANCE_WARNING]);
	});

	test("2 つ目以降の XML を同じ id のインスタンスへ差し込み、差し込んだ先の座標を基準にする", () => {
		const { nodes, warnings } = parseMetadata([METADATA, INSTANCE_METADATA]);
		const label = nodes.find((node) => node.id === "1:7");
		assert.deepEqual([label.depth, label.x, label.y], [2, 30, 165]);
		assert.deepEqual(warnings, []);
	});

	test("最初の XML に無い id の XML は使わずに警告する", () => {
		const { warnings } = parseMetadata([METADATA, '<frame id="9:9" name="x" x="0" y="0" width="1" height="1" />']);
		assert.deepEqual(warnings, ['id="9:9" のノードが最初の --metadata に無いので、この XML は使いません', INSTANCE_WARNING]);
	});

	test("ノードの無い XML はエラーにする", () => {
		assert.throws(() => parseMetadata([METADATA, "no tags"]), { message: "2 番目の --metadata にノードが無い" });
	});
});

const summarize = ([result]) => ({ status: result.status, method: result.method, element: result.element, rival: result.rival, reason: result.reason, delta: result.delta });

describe("文字列での対応付け", () => {
	const boxes = [
		{ label: "section", x: 0, y: 0, width: 400, height: 200, text: "Hello Body", textBox: { x: 0, y: 0, width: 400, height: 200 } },
		{ label: "h1", x: 20, y: 10, width: 300, height: 24, text: "Hello", textBox: { x: 20, y: 10, width: 101, height: 24 } },
		{ label: "span", x: 20, y: 10, width: 101, height: 24, text: "Hello", textBox: { x: 20, y: 10, width: 101, height: 24 } },
	];
	const node = { id: "a", x: 20, y: 10, width: 100, height: 24 };

	test("空白を詰めた文字列が一致する要素のうち、面積が最小の要素を選ぶ", () => {
		assert.deepEqual(summarize(compareLayout([node], boxes, { a: " Hello\n" }, 1)), {
			status: "OK",
			method: "text",
			element: "span",
			rival: null,
			reason: null,
			delta: { x: 0, y: 0, width: 1, height: 0 },
		});
	});

	test("文字列が一致する要素が無ければ、対応なしにする", () => {
		const result = summarize(compareLayout([node], boxes, { a: "Bye" }, 1));
		assert.deepEqual([result.status, result.reason, result.delta], ["対応なし", "文字列「Bye」を持つ要素が無い", null]);
	});

	test("要素の箱と文字幅の箱のうち、ノードに近いほうで測る", () => {
		const paragraph = [{ label: "p", x: 20, y: 10, width: 400, height: 24, text: "Hi", textBox: { x: 20, y: 10, width: 30, height: 24 } }];
		const wide = { id: "a", x: 20, y: 10, width: 400, height: 24 };
		const narrow = { id: "a", x: 20, y: 10, width: 30, height: 24 };
		assert.equal(summarize(compareLayout([wide], paragraph, { a: "Hi" }, 1)).element, "p");
		assert.equal(summarize(compareLayout([narrow], paragraph, { a: "Hi" }, 1)).element, "p の文字幅");
	});
});

describe("位置と寸法での対応付け", () => {
	const left = { label: "div.a", x: 10, y: 10, width: 50, height: 50, text: "", textBox: null };
	const right = { label: "div.b", x: 12, y: 10, width: 50, height: 50, text: "", textBox: null };
	const far = { label: "div.c", x: 300, y: 300, width: 5, height: 5, text: "", textBox: null };

	test("最も近い要素との差が許容以内なら OK にする", () => {
		const result = summarize(compareLayout([{ id: "n", x: 10, y: 10, width: 50, height: 50 }], [left, far], {}, 1));
		assert.deepEqual([result.status, result.method, result.element], ["OK", "geometry", "div.a"]);
	});

	test("最も近い要素との差が許容を超えたら、ずれにする", () => {
		const result = summarize(compareLayout([{ id: "n", x: 13, y: 10, width: 50, height: 50 }], [left, far], {}, 1));
		assert.deepEqual([result.status, result.element, result.delta], ["ずれ", "div.a", { x: -3, y: 0, width: 0, height: 0 }]);
	});

	test("箱の違う要素が許容の 2 倍以内の差で並ぶと、候補が拮抗にする", () => {
		const result = summarize(compareLayout([{ id: "n", x: 11, y: 10, width: 50, height: 50 }], [left, right, far], {}, 1));
		assert.deepEqual([result.status, result.element, result.rival], ["候補が拮抗", "div.a", "div.b"]);
	});

	test("近い箱を持つ要素が無ければ、対応なしにする", () => {
		const result = summarize(compareLayout([{ id: "n", x: 100, y: 100, width: 20, height: 20 }], [left], {}, 1));
		assert.deepEqual([result.status, result.reason], ["対応なし", "近い箱を持つ要素が無い"]);
	});
});

describe("報告の行", () => {
	test("[箱] のずれの行に、x・y・w・h のずれを出す", () => {
		const report = formatLayoutReport(
			[
				{
					node: { depth: 1, name: "title", type: "text" },
					status: "ずれ",
					method: "geometry",
					element: "h2.title",
					rival: null,
					reason: null,
					delta: { x: 1.5, y: 0, width: -2, height: 0.04 },
				},
			],
			1,
		);
		assert.match(report, / x \+1\.5 {2}y 0 {2}w -2\.0 {2}h 0 {2}← h2\.title（幾何）/);
	});
});
