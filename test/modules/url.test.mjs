import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isLocalDevServerUrl } from "../../plugin/scripts/modules/url.mjs";

describe("--url", () => {
	for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000", "http://[::1]:3000", "https://app.localhost:3000/page"]) {
		test(`受け付ける: ${url}`, () => assert.equal(isLocalDevServerUrl(url), true));
	}
	for (const url of [
		"file:///etc/hosts",
		"https://example.com",
		"http://192.168.0.1:3000",
		"http://localhost@example.com",
		"http://localhost.example.com",
		"http://mysite.local",
		"localhost:3000",
	]) {
		test(`断る: ${url}`, () => assert.equal(isLocalDevServerUrl(url), false));
	}
});
