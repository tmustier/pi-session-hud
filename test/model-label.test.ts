import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModelLabel, isFastModeActiveStatus } from "../pi-session-hud.js";

test("adds a text lightning glyph before the model while fast mode is active", () => {
	assert.equal(formatModelLabel("gpt-5.6-sol", "medium", true), "⚡︎ • gpt-5.6-sol • medium");
	assert.equal(formatModelLabel("gpt-5.6-sol", "off", true), "⚡︎ • gpt-5.6-sol");
});

test("keeps the existing model label while fast mode is inactive", () => {
	assert.equal(formatModelLabel("gpt-5.6-sol", "medium", false), "gpt-5.6-sol • medium");
});

test("recognizes only pi-fast-mode's active status", () => {
	assert.equal(isFastModeActiveStatus("⚡ fast"), true);
	assert.equal(isFastModeActiveStatus("\u001b[38;5;4m⚡\u001b[0m\u001b[2m fast\u001b[0m"), true);
	assert.equal(isFastModeActiveStatus("⚡ n/a"), false);
	assert.equal(isFastModeActiveStatus(undefined), false);
});
