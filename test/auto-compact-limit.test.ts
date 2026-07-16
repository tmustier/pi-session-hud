import assert from "node:assert/strict";
import { test } from "node:test";
import {
	effectiveContextPercent,
	effectiveContextWindow,
	isContextWindowCapped,
	parseAutoCompactPolicySnapshot,
	sameModel,
} from "../auto-compact-limit.js";
import { contextBand } from "../pi-session-hud.js";

const model = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	id: "gpt-5.6-sol",
};

test("uses a lower auto-compact threshold as the displayed context window", () => {
	assert.equal(effectiveContextWindow(372_000, 200_000), 200_000);
	assert.equal(effectiveContextPercent(26.88, 100_000, 372_000, 200_000), 50);
});

test("marks only a lower known context window as capped", () => {
	assert.equal(isContextWindowCapped(372_000, 200_000), true);
	assert.equal(isContextWindowCapped(200_000, 200_000), false);
	assert.equal(isContextWindowCapped(200_000, 250_000), false);
	assert.equal(isContextWindowCapped(0, 200_000), false);
});

test("keeps fixed colour bands based on the provider window", () => {
	assert.equal(contextBand(50, 100_000, 372_000), "yellow");
});

test("keeps the provider context window when it is the binding limit", () => {
	assert.equal(effectiveContextWindow(200_000, 250_000), 200_000);
	assert.equal(effectiveContextWindow(200_000, 200_000), 200_000);
	assert.equal(effectiveContextPercent(50, 100_000, 200_000, 200_000), 50);
});

test("uses the auto-compact threshold when the provider window is unknown", () => {
	assert.equal(effectiveContextWindow(0, 200_000), 200_000);
	assert.equal(effectiveContextPercent(null, 50_000, 0, 200_000), 25);
});

test("handles an immediate zero-token policy", () => {
	assert.equal(effectiveContextWindow(372_000, 0), 0);
	assert.equal(effectiveContextPercent(0, 1, 372_000, 0), 100);
	assert.equal(effectiveContextPercent(0, 0, 372_000, 0), 0);
});

test("falls back cleanly when auto-compact does not provide a policy", () => {
	assert.equal(effectiveContextWindow(372_000), 372_000);
	assert.equal(effectiveContextPercent(26.88, 100_000, 372_000, 372_000), 26.88);
});

test("accepts valid policy snapshots and rejects malformed payloads", () => {
	assert.deepEqual(parseAutoCompactPolicySnapshot({
		protocolVersion: 1,
		model,
		thresholdTokens: 200_000,
		source: "default",
		configPath: "/tmp/auto-compact.json",
	}), {
		protocolVersion: 1,
		model,
		thresholdTokens: 200_000,
		source: "default",
		configPath: "/tmp/auto-compact.json",
	});
	assert.equal(parseAutoCompactPolicySnapshot({ protocolVersion: 1, model, thresholdTokens: -1 }), undefined);
	assert.equal(parseAutoCompactPolicySnapshot({ protocolVersion: 2, model, thresholdTokens: 200_000 }), undefined);
});

test("matches policy responses to the full active model identity", () => {
	assert.equal(sameModel(model, { ...model }), true);
	assert.equal(sameModel(model, { ...model, provider: "openai" }), false);
	assert.equal(sameModel(model, { ...model, api: "openai-responses" }), false);
	assert.equal(sameModel(model, { ...model, id: "gpt-5.5" }), false);
});
