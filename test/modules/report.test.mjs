import { describe, test } from "node:test";
import assert from "node:assert/strict";
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
