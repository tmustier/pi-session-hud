/** Optional subscription-limit waiting. It never changes Pi's settings or parking behaviour. */
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getUsageCollector, type UsageObservation } from "./usage-collector.js";

export interface ProviderPolicy {
	behavior: "normal-retry" | "wait-until-reset";
	allowCodexBarInference?: boolean;
}
export interface RetryConfig { enabled: boolean; providers: Record<string, ProviderPolicy> }
export const CONFIG_NAME = "pi-rate-limit-retry.json";
const WIDGET = "subscription-limit-wait";

export function parseRetryConfig(value: unknown): RetryConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
	const input = value as Record<string, unknown>;
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
	if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers)) throw new Error("providers must be an object");
	const providers: Record<string, ProviderPolicy> = {};
	for (const [provider, raw] of Object.entries(input.providers)) {
		const policy = raw as ProviderPolicy | undefined;
		if (!policy || !["normal-retry", "wait-until-reset"].includes(policy.behavior)) throw new Error(`Invalid behavior for ${provider}`);
		if (policy.allowCodexBarInference !== undefined && typeof policy.allowCodexBarInference !== "boolean") throw new Error(`Invalid allowCodexBarInference for ${provider}`);
		providers[provider] = { behavior: policy.behavior, allowCodexBarInference: policy.allowCodexBarInference };
	}
	return { enabled: input.enabled !== false, providers };
}

export function isRateLimitFailure(message: AssistantMessage): boolean {
	if (/insufficient_quota|billing|out of budget|workplace_individual_usage_limit_exceeded/i.test(message.errorMessage ?? "")) return false;
	return message.stopReason === "error" && /rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])|subscription_sharing_usage_limit_exceeded|usage limit (?:reached|exceeded)/i.test(message.errorMessage ?? "");
}

export interface BlockingWindow { label: "5-hour" | "weekly"; resetAtMs: number }
export function nextBlockingReset(observation: UsageObservation, now: number): BlockingWindow | undefined {
	const usage = observation.usage;
	const exhausted = [
		{ label: "5-hour" as const, window: usage.fiveHour },
		{ label: "weekly" as const, window: usage },
	].filter(({ window }) => window && window.usedPercent >= 100);
	// Missing reset information cannot justify a scheduled retry.
	if (exhausted.some(({ window }) => !window?.resetAtMs || !Number.isFinite(window.resetAtMs))) return undefined;
	return exhausted.map(({ label, window }) => ({ label, resetAtMs: window!.resetAtMs! }))
		.filter(window => window.resetAtMs > now).sort((a, b) => a.resetAtMs - b.resetAtMs)[0];
}

export function formatResetTime(resetAtMs: number, now: number): string {
	const reset = new Date(resetAtMs);
	const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(reset);
	const today = new Date(now);
	const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
	const day = reset.toDateString() === today.toDateString() ? "today"
		: reset.toDateString() === tomorrow.toDateString() ? "tomorrow"
		: `on ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(reset)}`;
	return `${time} ${day}`;
}

export function waitNotice(provider: string, window: BlockingWindow, source: UsageObservation["source"], now: number, theme: Pick<Theme, "fg" | "bold">): string[] {
	const name = provider === "anthropic" ? "Anthropic" : provider === "openai" || provider === "openai-codex" ? "OpenAI" : provider;
	const minutes = Math.max(0, Math.ceil((window.resetAtMs - now) / 60_000));
	return [
		theme.fg("warning", source === "codexbar" ? `CodexBar reports that the ${name} subscription has reached its ${window.label} usage limit.` : `Your ${name} subscription has reached its ${window.label} usage limit.`),
		`Pi will retry after usage resets at ${theme.bold(formatResetTime(window.resetAtMs, now))}.`,
		...(source === "codexbar" ? [theme.fg("muted", "Reset inferred from CodexBar; its account may differ from Pi's.")] : []),
		theme.fg("muted", `Resets in ${minutes} minute${minutes === 1 ? "" : "s"}. Esc to cancel waiting.`),
	];
}

/** Cancel waiting without leaving a timer or abort listener behind. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) { resolve(); return; }
		const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return undefined;
	let stop: () => void = () => {};
	const aborted = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop, { once: true }); });
	try { return await Promise.race([promise, aborted]); }
	finally { signal.removeEventListener("abort", stop); }
}

export default function rateLimitRetry(pi: ExtensionAPI) {
	const collector = getUsageCollector(pi);
	let config: RetryConfig = { enabled: false, providers: {} };
	let failures = 0;
	let settlementRetries = 0;
	let generation = 0;
	let pending: { message: AssistantMessage; entryId: string } | undefined;
	let active: { controller: AbortController; ctx: ExtensionContext; generation: number } | undefined;
	let unsubscribeInput: (() => void) | undefined;

	const cancel = () => {
		if (!active) return;
		active.controller.abort();
		active.ctx.abort();
	};
	const clearUI = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, undefined);
		ctx.ui.setWorkingVisible(true);
	};

	async function wait(message: AssistantMessage, ctx: ExtensionContext): Promise<boolean> {
		const policy = config.providers[message.provider];
		if (!config.enabled || policy?.behavior !== "wait-until-reset") return false;
		const controller = new AbortController();
		const state = { controller, ctx, generation };
		active = state;
		const signal = ctx.signal;
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) controller.abort();
		let waited = false;
		let resumeBackgroundProbes: (() => void) | undefined;
		try {
			let observation = await untilAborted(collector.refresh(ctx, message.provider, Date.now()), controller.signal);
			while (!controller.signal.aborted && observation) {
				if (observation.source === "codexbar" && !policy.allowCodexBarInference) break;
				const window = nextBlockingReset(observation, Date.now());
				if (!window) break;
				waited = true;
				resumeBackgroundProbes ??= collector.pauseBackgroundProbes();
				if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
				while (!controller.signal.aborted && Date.now() < window.resetAtMs) {
					if (ctx.mode === "tui") {
						const source = observation.source;
						ctx.ui.setWidget(WIDGET, (_tui, theme) => ({ render: width => waitNotice(message.provider, window, source, Date.now(), theme).flatMap(line => wrapTextWithAnsi(line, width)), invalidate() {} }));
					}
					// One timer wakes at the next displayed minute or at reset. No animation or quota polling.
					const remaining = window.resetAtMs - Date.now();
					await abortableDelay(Math.min(remaining, remaining % 60_000 || 60_000), controller.signal);
				}
				if (controller.signal.aborted) break;
				observation = await untilAborted(collector.refresh(ctx, message.provider, Date.now()), controller.signal);
			}
			return waited && !controller.signal.aborted;
		} finally {
			signal?.removeEventListener("abort", abort);
			resumeBackgroundProbes?.();
			if (active === state) {
				active = undefined;
				if (waited && generation === state.generation) clearUI(ctx);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		generation++;
		failures = 0; settlementRetries = 0; pending = undefined;
		try { config = parseRetryConfig(JSON.parse(readFileSync(join(getAgentDir(), CONFIG_NAME), "utf8"))); }
		catch (error) {
			config = { enabled: false, providers: {} };
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") ctx.ui.notify(`${CONFIG_NAME}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		unsubscribeInput?.();
		if (ctx.mode === "tui") unsubscribeInput = ctx.ui.onTerminalInput(data => {
			if (active && matchesKey(data, "escape")) { cancel(); return { consume: true }; }
			return undefined;
		});
	});
	pi.on("session_shutdown", () => { cancel(); generation++; active = undefined; pending = undefined; unsubscribeInput?.(); unsubscribeInput = undefined; });
	pi.on("model_select", () => { cancel(); pending = undefined; });
	pi.on("cache_warming_decision", () => active ? { action: "stop" } : undefined);
	pi.on("before_agent_start", () => { failures = 0; settlementRetries = 0; pending = undefined; });
	pi.on("agent_settled", () => { failures = 0; settlementRetries = 0; pending = undefined; });

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") { failures = 0; settlementRetries = 0; pending = undefined; return; }
		const failedModel = ctx.modelRegistry.find(message.provider, message.model) ?? ctx.model;
		// Overflow has its own compact-and-retry path, outside the transient retry budget.
		if (isContextOverflow(message, failedModel?.contextWindow ?? 0)) return;
		failures++;
		const retry = pi.getSettings().retry;
		const maxRetries = retry?.maxRetries ?? 3; // Pi's default, not a separate extension budget.
		if (settlementRetries > 0 && failures > maxRetries && isRetryableAssistantError(message)) {
			// Pi cannot count our settlement continuations. Stop its next retry once the combined
			// budget is spent, keeping the final failed response in the transcript.
			ctx.abort();
			return;
		}
		if (retry?.enabled === false || failures > maxRetries || !isRateLimitFailure(message)) return;
		if (!config.enabled || config.providers[message.provider]?.behavior !== "wait-until-reset") return;
		// Always wait while the low-level run still has an abort signal. Settlement itself
		// has no signal, so holding an asynchronous wait there would break SDK/RPC aborts.
		const waited = await wait(message, ctx);
		if (waited && !isRetryableAssistantError(message)) pending = { message, entryId: event.messageEntryId };
	});
	pi.on("agent_before_settle", event => {
		const failure = pending;
		pending = undefined;
		if (!failure || event.outcome !== "error" || !config.enabled || config.providers[failure.message.provider]?.behavior !== "wait-until-reset") return;
		settlementRetries++;
		return { entries: [...event.entries, { type: "context_edit", targetId: failure.entryId, replacement: null }], continue: true };
	});

	pi.registerCommand("rate-limit-retry", {
		description: "Show subscription retry policies, or turn waiting on/off for this session",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "off") { config.enabled = false; pending = undefined; cancel(); }
			else if (action === "on") config.enabled = true;
			else if (action && action !== "status") { ctx.ui.notify("Use /rate-limit-retry [on|off|status]", "warning"); return; }
			const providers = Object.entries(config.providers).filter(([, policy]) => policy.behavior === "wait-until-reset").map(([provider]) => provider);
			ctx.ui.notify(`Subscription waiting ${config.enabled ? "on" : "off"}. Configured providers: ${providers.join(", ") || "none"}. Configure ${CONFIG_NAME} and /reload to apply file changes.`, "info");
		},
	});
}
