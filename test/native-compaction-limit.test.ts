import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { effectiveContextPercent, effectiveContextWindow, isContextWindowCapped } from "../auto-compact-limit.js";
import { bindingThreshold, nativeCompactionThreshold } from "../native-compaction-limit.js";

const fable = { provider: "anthropic", id: "claude-fable-5-1" };
const sol = { provider: "openai-codex", id: "gpt-5.6-sol" };

function settingsWithReserves() {
	return SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16_384,
			modelOverrides: { "anthropic/claude-fable-5-1": { reserveTokens: 750_000 } },
		},
	});
}

test("shows Pi's compaction trigger as the window when a model reserve lowers it", () => {
	const threshold = nativeCompactionThreshold(settingsWithReserves(), fable, 1_000_000);
	assert.equal(threshold, 250_000);
	assert.equal(effectiveContextWindow(1_000_000, threshold), 250_000);
	assert.equal(isContextWindowCapped(1_000_000, 250_000), true);
	assert.equal(effectiveContextPercent(12.5, 125_000, 1_000_000, 250_000), 50);
});

test("uses the ordinary reserve for a model without an override", () => {
	assert.equal(nativeCompactionThreshold(settingsWithReserves(), sol, 272_000), 255_616);
});

test("applies the built-in reserve when settings configure none", () => {
	assert.equal(nativeCompactionThreshold(SettingsManager.inMemory(), sol, 272_000), 255_616);
});

test("reports no threshold when compaction cannot lower the window", () => {
	const disabled = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 750_000 } });
	assert.equal(nativeCompactionThreshold(disabled, fable, 1_000_000), undefined);

	const reserveCoversWindow = SettingsManager.inMemory({ compaction: { reserveTokens: 272_000 } });
	assert.equal(nativeCompactionThreshold(reserveCoversWindow, sol, 272_000), undefined);

	assert.equal(nativeCompactionThreshold(settingsWithReserves(), fable, 0), undefined);
	assert.equal(nativeCompactionThreshold(settingsWithReserves(), undefined, 1_000_000), undefined);
	assert.equal(nativeCompactionThreshold(null, fable, 1_000_000), undefined);
});

test("keeps the provider window when compaction settings are invalid", () => {
	const invalid = SettingsManager.inMemory({ compaction: { reserveTokens: -1 } });
	assert.equal(nativeCompactionThreshold(invalid, sol, 272_000), undefined);
	assert.equal(effectiveContextWindow(272_000, nativeCompactionThreshold(invalid, sol, 272_000)), 272_000);
});

test("displays whichever threshold binds first", () => {
	assert.equal(bindingThreshold(undefined, 250_000), 250_000);
	assert.equal(bindingThreshold(200_000, 250_000), 200_000);
	assert.equal(bindingThreshold(250_000, 200_000), 200_000);
	assert.equal(bindingThreshold(0, 250_000), 0);
	assert.equal(bindingThreshold(undefined, undefined), undefined);
});
