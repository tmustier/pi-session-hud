/** Shared subscription usage readers. No timers or UI are started by importing this module. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_SUBSCRIPTION_USAGE_PROVIDERS = new Set(["openai", "openai-codex", "anthropic"]);
const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
// agent-default (not a user rule): 2026-10-26. Preserve the HUD's existing probe timeouts.
const CODEXBAR_TIMEOUT_MS = 15_000;
const ONE_WEEK_MINUTES = 7 * 24 * 60;
const FIVE_HOURS_MINUTES = 5 * 60;

export type UsageWindow = {
	usedPercent: number;
	resetAtMs?: number;
};
/** Weekly quota at the top level (what the border shows), plus the 5-hour window when the provider reports one. */
export type SubscriptionUsage = UsageWindow & {
	provider: string;
	fiveHour?: UsageWindow;
};

type RateLimitWindowUsage = {
	usedPercent: number;
	windowMinutes?: number;
	resetAtSeconds?: number;
};

export function codexAccountIdFromToken(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const accountId = claims?.[CODEX_JWT_AUTH_CLAIM]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function numberFrom(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function usedPercentFrom(value: unknown): number | undefined {
	const parsed = numberFrom(value);
	return parsed !== undefined && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

/** Anthropic response headers report utilization as a 0-1 fraction. */
function utilizationPercentFrom(value: unknown): number | undefined {
	const parsed = numberFrom(value);
	return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed * 100 : undefined;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const direct = headers[name];
	if (direct !== undefined) return direct;
	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
	return undefined;
}

function usageWindow(usedPercent: number, resetAtSeconds?: number): UsageWindow {
	const resetAtMs = resetAtSeconds && resetAtSeconds > 0 ? resetAtSeconds * 1000 : undefined;
	return { usedPercent, ...(resetAtMs ? { resetAtMs } : {}) };
}

function makeSubscriptionUsage(provider: string, weekly: RateLimitWindowUsage, fiveHour: RateLimitWindowUsage | null): SubscriptionUsage {
	return {
		provider,
		...usageWindow(weekly.usedPercent, weekly.resetAtSeconds),
		...(fiveHour ? { fiveHour: usageWindow(fiveHour.usedPercent, fiveHour.resetAtSeconds) } : {}),
	};
}

function selectWindow(windows: Array<RateLimitWindowUsage | null>, lengthMinutes: number): RateLimitWindowUsage | null {
	return windows.find((window) => {
		const minutes = window?.windowMinutes ?? 0;
		return minutes >= lengthMinutes * 0.95 && minutes <= lengthMinutes * 1.05;
	}) ?? null;
}

/** Codex reports its 5-hour and weekly windows in either slot; tell them apart by length. */
function codexSubscriptionUsage(windows: Array<RateLimitWindowUsage | null>): SubscriptionUsage | null {
	const weekly = selectWindow(windows, ONE_WEEK_MINUTES);
	return weekly ? makeSubscriptionUsage("openai-codex", weekly, selectWindow(windows, FIVE_HOURS_MINUTES)) : null;
}

function parseCodexHeaderWindow(headers: Record<string, string>, slot: "primary" | "secondary"): RateLimitWindowUsage | null {
	const usedPercent = usedPercentFrom(getHeader(headers, `x-codex-${slot}-used-percent`));
	if (usedPercent === undefined) return null;
	return {
		usedPercent,
		windowMinutes: numberFrom(getHeader(headers, `x-codex-${slot}-window-minutes`)),
		resetAtSeconds: numberFrom(getHeader(headers, `x-codex-${slot}-reset-at`)),
	};
}

function parseCodexSubscriptionUsageFromHeaders(headers: Record<string, string>): SubscriptionUsage | null {
	return codexSubscriptionUsage([parseCodexHeaderWindow(headers, "primary"), parseCodexHeaderWindow(headers, "secondary")]);
}

function parseAnthropicHeaderWindow(headers: Record<string, string>, slot: "7d" | "5h"): RateLimitWindowUsage | null {
	const usedPercent = utilizationPercentFrom(getHeader(headers, `anthropic-ratelimit-unified-${slot}-utilization`));
	if (usedPercent === undefined) return null;
	return { usedPercent, resetAtSeconds: numberFrom(getHeader(headers, `anthropic-ratelimit-unified-${slot}-reset`)) };
}

function parseAnthropicSubscriptionUsageFromHeaders(headers: Record<string, string>): SubscriptionUsage | null {
	const weekly = parseAnthropicHeaderWindow(headers, "7d");
	return weekly ? makeSubscriptionUsage("anthropic", weekly, parseAnthropicHeaderWindow(headers, "5h")) : null;
}

export function parseSubscriptionUsageFromHeaders(provider: string | undefined, headers: Record<string, string>): SubscriptionUsage | null {
	if (provider === "anthropic") return parseAnthropicSubscriptionUsageFromHeaders(headers);
	if (provider === "openai-codex") return parseCodexSubscriptionUsageFromHeaders(headers);
	return null;
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 5000): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function parseCodexPayloadWindow(window: any): RateLimitWindowUsage | null {
	const usedPercent = usedPercentFrom(window?.used_percent);
	if (usedPercent === undefined) return null;
	const windowSeconds = numberFrom(window.limit_window_seconds);
	return {
		usedPercent,
		windowMinutes: windowSeconds ? Math.ceil(windowSeconds / 60) : undefined,
		resetAtSeconds: numberFrom(window.reset_at),
	};
}

export function parseCodexSubscriptionUsagePayload(payload: any): SubscriptionUsage | null {
	const rateLimit = payload?.rate_limit;
	return codexSubscriptionUsage([parseCodexPayloadWindow(rateLimit?.primary_window), parseCodexPayloadWindow(rateLimit?.secondary_window)]);
}

/** The Anthropic usage endpoint reports utilization in percent, unlike its response headers. */
function parseAnthropicPayloadWindow(window: any): RateLimitWindowUsage | null {
	const usedPercent = usedPercentFrom(window?.utilization);
	if (usedPercent === undefined) return null;
	const resetAtMs = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : undefined;
	return { usedPercent, resetAtSeconds: resetAtMs && Number.isFinite(resetAtMs) ? resetAtMs / 1000 : undefined };
}

export function parseAnthropicSubscriptionUsagePayload(payload: any): SubscriptionUsage | null {
	const weekly = parseAnthropicPayloadWindow(payload?.seven_day ?? payload?.seven_day_oauth_apps);
	return weekly ? makeSubscriptionUsage("anthropic", weekly, parseAnthropicPayloadWindow(payload?.five_hour)) : null;
}

/** Parse CodexBar's account-wide quota, not Pi's app-specific allowance. */
export function parseCodexBarSubscriptionUsagePayload(payload: any): SubscriptionUsage | null {
	if (!Array.isArray(payload)) return null;
	const records = payload.filter((record) => record?.provider === "codex");
	// Do not silently choose between multiple accounts.
	if (records.length !== 1 || records[0].error) return null;
	const windows = [records[0].usage?.primary, records[0].usage?.secondary].map((window) => {
		const usedPercent = usedPercentFrom(window?.usedPercent);
		if (usedPercent === undefined) return null;
		const resetAtMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
		return {
			usedPercent,
			windowMinutes: numberFrom(window.windowMinutes),
			resetAtSeconds: Number.isFinite(resetAtMs) ? resetAtMs / 1000 : undefined,
		};
	});
	const weekly = selectWindow(windows, ONE_WEEK_MINUTES);
	return weekly ? makeSubscriptionUsage("openai", weekly, selectWindow(windows, FIVE_HOURS_MINUTES)) : null;
}

export async function fetchCodexBarSubscriptionUsage(pi: ExtensionAPI): Promise<SubscriptionUsage | null> {
	// HACK: hacky workaround for Pi's new openai ChatGPT OAuth flow: its token
	// cannot query the legacy quota endpoint. Borrow CodexBar's existing Codex
	// connection instead; no new login or credential copying. Requires CodexBar
	// on PATH and reports its selected account's quota, which may differ from
	// Pi's account and does not establish Pi's app-specific remaining allowance.
	const result = await pi.exec("codexbar", ["usage", "--provider", "codex", "--source", "oauth", "--json", "--no-credits"], {
		timeout: CODEXBAR_TIMEOUT_MS,
	});
	if (result.code !== 0 || result.killed) return null;
	return parseCodexBarSubscriptionUsagePayload(JSON.parse(result.stdout));
}

export async function fetchCodexSubscriptionUsage(ctx: ExtensionContext): Promise<SubscriptionUsage | null> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
	if (!token) return null;
	// Pi no longer exposes stored credentials to extensions; the account id lives in the OAuth access token.
	const accountId = codexAccountIdFromToken(token);
	if (!accountId) return null;
	const payload = await fetchJson(`${DEFAULT_CODEX_BASE_URL}/wham/usage`, {
		Authorization: `Bearer ${token}`,
		"chatgpt-account-id": accountId,
		originator: "pi-session-hud",
		"User-Agent": "pi-session-hud",
		accept: "application/json",
	});
	return payload ? parseCodexSubscriptionUsagePayload(payload) : null;
}

export async function fetchAnthropicSubscriptionUsage(ctx: ExtensionContext): Promise<SubscriptionUsage | null> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	if (!token) return null;
	const payload = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
		Authorization: `Bearer ${token}`,
		"anthropic-beta": ANTHROPIC_OAUTH_BETA,
		"User-Agent": "pi-session-hud",
		accept: "application/json",
	});
	return payload ? parseAnthropicSubscriptionUsagePayload(payload) : null;
}
