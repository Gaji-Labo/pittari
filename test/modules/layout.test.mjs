import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatLayoutReport } from "../../plugin/scripts/modules/layout.mjs";

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
