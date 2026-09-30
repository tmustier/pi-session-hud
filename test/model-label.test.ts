import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fastModeFromExtensionStatuses, formatModelLabel, requestUsesFastMode, requestSpeedMode, speedModeFromExtensionStatuses } from "../pi-session-hud.js";

const reasoningModel = { id: "gpt-6-astra", reasoning: true };
const plainModel = { id: "gpt-6-astra", reasoning: false };

test("distinguishes Fast and Ultrafast with a single-column text lightning glyph", () => {
	const label = formatModelLabel(reasoningModel, "medium", "fast");
	assert.equal(label, "↯ fast • gpt-6-astra • medium");
	assert.equal(formatModelLabel(plainModel, "off", true), "↯ fast • gpt-6-astra");
	assert.equal(formatModelLabel(reasoningModel, "medium", "ultrafast"), "↯ ultrafast • gpt-6-astra • medium");
	assert.equal(visibleWidth(label), [...label].length);
});

test("keeps the model label when speed is off and retains thinking off", () => {
	assert.equal(formatModelLabel(reasoningModel, "medium", false), "gpt-6-astra • medium");
	assert.equal(formatModelLabel(reasoningModel, "medium", "off"), "gpt-6-astra • medium");
	assert.equal(formatModelLabel(reasoningModel, "off", false), "gpt-6-astra • thinking off");
	assert.equal(formatModelLabel(plainModel, "medium", false), "gpt-6-astra");
});

test("recognizes both tiers from extension status, including reported backend metadata", () => {
	for (const status of ["⚡ fast", "\x1b[33m⚡\x1b[0m\x1b[2m fast\x1b[0m", "⚡ fast (reported: priority)"]) {
		assert.equal(speedModeFromExtensionStatuses(new Map([["fast-mode", status]])), "fast");
	}
	assert.equal(speedModeFromExtensionStatuses(new Map([["fast-mode", "⚡ ultrafast (reported: default)"]])), "ultrafast");
	assert.equal(fastModeFromExtensionStatuses(new Map([["fast-mode", "⚡ ultrafast"]])), true);
	for (const status of ["⚡ n/a", "⚡ ultrafast n/a", "⚡ fast n/a", "unrelated"]) {
		assert.equal(speedModeFromExtensionStatuses(new Map([["fast-mode", status]])), "off");
	}
	assert.equal(fastModeFromExtensionStatuses(new Map([["fast-mode", "⚡ n/a"]])), false);
	assert.equal(speedModeFromExtensionStatuses(new Map()), null);
});

test("recognizes the requested tier without inferring it from unrelated payloads", () => {
	assert.equal(requestSpeedMode({ service_tier: "ultrafast" }), "ultrafast");
	assert.equal(requestSpeedMode({ service_tier: "priority" }), "fast");
	assert.equal(requestSpeedMode({ speed: "fast" }), "fast");
	assert.equal(requestUsesFastMode({ service_tier: "ultrafast" }), true);
	for (const payload of [{ service_tier: "default" }, { speed: "standard" }, { fast: true }, null, []]) {
		assert.equal(requestSpeedMode(payload), "off");
		assert.equal(requestUsesFastMode(payload), false);
	}
});
