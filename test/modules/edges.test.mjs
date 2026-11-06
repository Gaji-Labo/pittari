import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatEdgeReport } from "../../plugin/scripts/modules/edges.mjs";

describe("報告の行", () => {
	test("[辺] のずれの行に、辺の位置とずれを出す", () => {
		const report = formatEdgeReport(
			[{ side: "top", kind: "box", positionCssPx: 10, rangeCssPx: [0, 100], elements: ["div.card"], status: "ずれ", delta: -2, reason: null }],
			1,
		);
		assert.match(report, /上辺 y=10（x=0〜100） {2}-2\.0 {2}← div\.card/);
	});
});
