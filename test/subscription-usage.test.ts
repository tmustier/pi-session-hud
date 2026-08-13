import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexSubscriptionUsagePayload } from "../pi-session-hud.js";

test("treats Codex used_percent as a percentage at the 1% boundary", () => {
	const usage = parseCodexSubscriptionUsagePayload({
		rate_limit: {
			primary_window: {
				used_percent: 1,
				limit_window_seconds: 7 * 24 * 60 * 60,
			},
		},
	});

	assert.equal(usage?.usedPercent, 1);
});
