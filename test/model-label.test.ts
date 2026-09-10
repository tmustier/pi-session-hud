import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fastModeFromExtensionStatuses, formatModelLabel, requestUsesFastMode } from "../pi-session-hud.js";

const reasoningModel = { id: "gpt-5.6-sol", reasoning: true };
const plainModel = { id: "gpt-5.6-sol", reasoning: false };

test("adds a single-column text lightning glyph before the model while fast mode is active", () => {
	const label = formatModelLabel(reasoningModel, "medium", true);
	assert.equal(label, "↯ • gpt-5.6-sol • medium");
	assert.equal(formatModelLabel(plainModel, "off", true), "↯ • gpt-5.6-sol");
	assert.equal(visibleWidth(label), [...label].length);
});

test("keeps the existing model label while fast mode is inactive", () => {
	assert.equal(formatModelLabel(reasoningModel, "medium", false), "gpt-5.6-sol • medium");
});

test("shows thinking off on reasoning models and nothing on models without thinking", () => {
	assert.equal(formatModelLabel(reasoningModel, "off", false), "gpt-5.6-sol • thinking off");
	assert.equal(formatModelLabel(plainModel, "medium", false), "gpt-5.6-sol");
});

test("recognizes fast mode from extension status without depending on request-hook order", () => {
	assert.equal(fastModeFromExtensionStatuses(new Map([["fast-mode", "⚡ fast"]])), true);
	assert.equal(fastModeFromExtensionStatuses(new Map([["fast-mode", "\x1b[33m⚡\x1b[0m\x1b[2m fast\x1b[0m"]])), true);
	assert.equal(fastModeFromExtensionStatuses(new Map([["fast-mode", "⚡ n/a"]])), false);
	assert.equal(fastModeFromExtensionStatuses(new Map()), null);
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
