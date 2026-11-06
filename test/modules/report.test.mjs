import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatEdgeReport } from "../../plugin/scripts/modules/edges.mjs";
import { formatLayoutReport } from "../../plugin/scripts/modules/layout.mjs";
import { formatDelta } from "../../plugin/scripts/modules/report.mjs";

describe("ずれの値", () => {
	for (const [value, expected] of [
		[0, "0"],
		[0.04, "0"],
		[-0.04, "0"],
		[1.5, "+1.5"],
		[-2, "-2.0"],
	]) {
		test(`${value} は ${expected}`, () => assert.equal(formatDelta(value), expected));
	}
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

	test("[辺] のずれの行に、辺の位置とずれを出す", () => {
		const report = formatEdgeReport(
			[{ side: "top", kind: "box", positionCssPx: 10, rangeCssPx: [0, 100], elements: ["div.card"], status: "ずれ", delta: -2, reason: null }],
			1,
		);
		assert.match(report, /上辺 y=10（x=0〜100） {2}-2\.0 {2}← div\.card/);
	});
});
