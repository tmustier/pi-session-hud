import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatModelLabel, requestUsesFastMode } from "../pi-session-hud.js";

test("adds a single-column text lightning glyph before the model while fast mode is active", () => {
	const label = formatModelLabel("gpt-5.6-sol", "medium", true);
	assert.equal(label, "↯ • gpt-5.6-sol • medium");
	assert.equal(formatModelLabel("gpt-5.6-sol", "off", true), "↯ • gpt-5.6-sol");
	assert.equal(visibleWidth(label), [...label].length);
});

test("keeps the existing model label while fast mode is inactive", () => {
	assert.equal(formatModelLabel("gpt-5.6-sol", "medium", false), "gpt-5.6-sol • medium");
});

test("recognizes fast mode from the serialized provider request", () => {
	assert.equal(requestUsesFastMode({ service_tier: "priority" }), true);
	assert.equal(requestUsesFastMode({ speed: "fast" }), true);
});

test("does not infer fast mode from unrelated or malformed payloads", () => {
	assert.equal(requestUsesFastMode({ service_tier: "default" }), false);
	assert.equal(requestUsesFastMode({ speed: "standard" }), false);
	assert.equal(requestUsesFastMode({ fast: true }), false);
	assert.equal(requestUsesFastMode(null), false);
	assert.equal(requestUsesFastMode([]), false);
});
