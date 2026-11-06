import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionId } from "../../plugin/scripts/modules/session.mjs";

describe("セッション ID", () => {
	test("受け付ける: UUID", () => assert.equal(isValidSessionId("0b9c3f6e-1a2b-4c3d-8e9f-0123456789ab"), true));
	for (const value of ["../x", "a/b", "..", "", "${CLAUDE_SESSION_ID}", undefined]) {
		test(`断る: ${JSON.stringify(value)}`, () => assert.equal(isValidSessionId(value), false));
	}
});
