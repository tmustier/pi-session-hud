import assert from "node:assert/strict";
import test from "node:test";
import {
	formatShortCountdown,
	InfoPopup,
	infoPopupWidth,
	parseAnthropicSubscriptionUsagePayload,
	parseCodexSubscriptionUsagePayload,
	usagePace,
	usagePopupLines,
} from "../pi-session-hud.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const tagged = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const plain = { fg: (_color: string, text: string) => text };

test("pace compares usage with the elapsed share of the window", () => {
	// Half the week gone, 38% used: 12 points in hand.
	assert.equal(usagePace({ usedPercent: 38, resetAtMs: NOW + 3.5 * DAY }, 7 * DAY, NOW), 12);
	// 80% of the 5-hour window gone, 90% used: 10 points over.
	assert.equal(usagePace({ usedPercent: 90, resetAtMs: NOW + HOUR }, 5 * HOUR, NOW), -10);
	assert.equal(usagePace({ usedPercent: 50, resetAtMs: NOW + 3.5 * DAY }, 7 * DAY, NOW), 0);
	// No reset time means no pace; skewed reset times clamp to the window.
	assert.equal(usagePace({ usedPercent: 38 }, 7 * DAY, NOW), undefined);
	assert.equal(usagePace({ usedPercent: 10, resetAtMs: NOW + 8 * DAY }, 7 * DAY, NOW), -10);
	assert.equal(usagePace({ usedPercent: 10, resetAtMs: NOW - HOUR }, 7 * DAY, NOW), 90);
});

test("short countdowns round up to the minute and drop an empty hour", () => {
	assert.equal(formatShortCountdown(NOW + 3 * HOUR + 12 * 60 * 1000, NOW), "3h12m");
	assert.equal(formatShortCountdown(NOW + HOUR - 1000, NOW), "1h00m");
	assert.equal(formatShortCountdown(NOW + 42 * 60 * 1000 + 1, NOW), "43m");
	assert.equal(formatShortCountdown(NOW - 1, NOW), "0m");
});

test("usage popup lines align columns and colour the pace by direction", () => {
	const usage = {
		provider: "openai-codex",
		usedPercent: 38,
		resetAtMs: NOW + 3.5 * DAY,
		fiveHour: { usedPercent: 90, resetAtMs: NOW + HOUR },
	};
	assert.deepEqual(usagePopupLines(usage, NOW, tagged), [
		"Weekly:  38% used (<success>12% ahead</success>)  <muted>| resets in 3d12h</muted>",
		"5h:      90% used (<error>10% behind</error>) <muted>| resets in 1h00m</muted>",
	]);
	assert.deepEqual(usagePopupLines({ provider: "anthropic", usedPercent: 50, resetAtMs: NOW + 3.5 * DAY }, NOW, tagged), [
		"Weekly:  50% used (<muted>on pace</muted>) <muted>| resets in 3d12h</muted>",
	]);
	// Without a reset time there is neither pace nor countdown; a 5-hour window without one still lists.
	assert.deepEqual(usagePopupLines({ provider: "anthropic", usedPercent: 5, fiveHour: { usedPercent: 100 } }, NOW, plain), [
		"Weekly:   5% used",
		"5h:     100% used",
	]);
});

test("Codex payloads carry both windows whichever slot they arrive in", () => {
	const usage = parseCodexSubscriptionUsagePayload({
		rate_limit: {
			primary_window: { used_percent: 90, limit_window_seconds: 5 * 3600, reset_at: 1_800_000_000 },
			secondary_window: { used_percent: 37, limit_window_seconds: 7 * 24 * 3600, reset_at: 1_800_500_000 },
		},
	});
	assert.deepEqual(usage, {
		provider: "openai-codex",
		usedPercent: 37,
		resetAtMs: 1_800_500_000_000,
		fiveHour: { usedPercent: 90, resetAtMs: 1_800_000_000_000 },
	});
	// Weekly alone is enough; a 5-hour window alone is not a quota.
	assert.deepEqual(parseCodexSubscriptionUsagePayload({ rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 7 * 24 * 3600 } } }), {
		provider: "openai-codex",
		usedPercent: 37,
	});
	assert.equal(parseCodexSubscriptionUsagePayload({ rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 5 * 3600 } } }), null);
});

test("Anthropic payloads report utilization in percent and carry the five-hour window when present", () => {
	// Shape and units as served by api.anthropic.com/api/oauth/usage.
	const usage = parseAnthropicSubscriptionUsagePayload({
		five_hour: { utilization: 28, resets_at: "2026-09-10T12:09:59.984212+00:00", limit_dollars: null, locked_reason: null },
		seven_day: { utilization: 20, resets_at: "2026-09-15T02:59:59.984237+00:00", limit_dollars: null, locked_reason: null },
		seven_day_oauth_apps: null,
	});
	assert.deepEqual(usage, {
		provider: "anthropic",
		usedPercent: 20,
		resetAtMs: Date.parse("2026-09-15T02:59:59.984237+00:00"),
		fiveHour: { usedPercent: 28, resetAtMs: Date.parse("2026-09-10T12:09:59.984212+00:00") },
	});
	assert.deepEqual(parseAnthropicSubscriptionUsagePayload({ seven_day: { utilization: 100 }, five_hour: { utilization: null, resets_at: null } }), {
		provider: "anthropic",
		usedPercent: 100,
	});
	assert.equal(parseAnthropicSubscriptionUsagePayload({ seven_day: { utilization: 101 } }), null);
});

test("an info popup renders once per width, closes on Escape, and reports pointer edges", () => {
	const lines = ["Weekly:  38% used", "5h:      90% used"];
	let closed = 0;
	const popup = new InfoPopup("Usage", lines, (text) => text, plain as never, () => { closed++; });
	const width = infoPopupWidth(lines, 120);
	assert.equal(width, 17 + 2 + 2);
	const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const first = popup.render(width);
	assert.deepEqual(first.map(strip), [
		"╭ Usage ────────────╮",
		"│ Weekly:  38% used │",
		"│ 5h:      90% used │",
		"╰───────────────────╯",
	]);
	assert.equal(popup.render(width), first, "same array instance: no re-render at the same width");
	assert.notEqual(popup.render(width + 1), first);

	const seen: string[] = [];
	popup.onPointer = (at) => { seen.push(at); };
	popup.handleMouse({ type: "move", button: "none", x: 0, y: 1, width, height: 4, screenX: 0, screenY: 0 } as never);
	popup.handleMouse({ type: "move", button: "none", x: 3, y: 1, width, height: 4, screenX: 0, screenY: 0 } as never);
	popup.handleMouse({ type: "move", button: "none", x: 3, y: 3, width, height: 4, screenX: 0, screenY: 0 } as never);
	assert.deepEqual(seen, ["edge", "inside", "inside"]);

	popup.handleInput("x");
	assert.equal(closed, 0);
	popup.handleInput("\x1b");
	popup.handleInput("\x1b");
	assert.equal(closed, 1);
	assert.equal(popup.isClosed, true);
});
