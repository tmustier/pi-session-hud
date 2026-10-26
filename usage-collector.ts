import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchAnthropicSubscriptionUsage, fetchCodexBarSubscriptionUsage, fetchCodexSubscriptionUsage, SUPPORTED_SUBSCRIPTION_USAGE_PROVIDERS, type SubscriptionUsage } from "./subscription-usage.js";

export interface UsageObservation {
	usage: SubscriptionUsage;
	startedAt: number;
	observedAt: number;
	source: "provider" | "codexbar";
}

/** Consumers share requests, not a stale quota cache. No background work unless a consumer asks. */
export class UsageCollector {
	private sessions = new WeakMap<ExtensionContext["sessionManager"], Map<string, Promise<UsageObservation | null>>>();
	constructor(private pi: ExtensionAPI) {}
	private waiters = 0;
	get backgroundPaused(): boolean { return this.waiters > 0; }
	pauseBackgroundProbes(): () => void {
		this.waiters++;
		return () => { this.waiters--; };
	}

	async refresh(ctx: ExtensionContext, provider: string, after = 0): Promise<UsageObservation | null> {
		if (!SUPPORTED_SUBSCRIPTION_USAGE_PROVIDERS.has(provider)) return null;
		const model = ctx.model?.provider === provider ? ctx.model : ctx.modelRegistry.getAll().find(model => model.provider === provider);
		if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return null;
		let inFlight = this.sessions.get(ctx.sessionManager);
		if (!inFlight) { inFlight = new Map(); this.sessions.set(ctx.sessionManager, inFlight); }
		const existing = inFlight.get(provider);
		if (existing) {
			const observation = await existing;
			// A retry needs a reading started after its failure, not a pre-failure background probe.
			if (observation && observation.startedAt >= after) return observation;
		}
		// Another consumer may already have started the requested fresh reading.
		const pending = inFlight.get(provider);
		if (pending) return pending;
		const startedAt = Date.now();
		const request = (async (): Promise<UsageObservation | null> => {
			const usage = await (provider === "anthropic" ? fetchAnthropicSubscriptionUsage(ctx)
				: provider === "openai" ? fetchCodexBarSubscriptionUsage(this.pi) : fetchCodexSubscriptionUsage(ctx)).catch(() => null);
			if (!usage) return null;
			return { usage, startedAt, observedAt: Date.now(), source: provider === "openai" ? "codexbar" : "provider" };
		})();
		inFlight.set(provider, request);
		try { return await request; }
		finally { if (inFlight.get(provider) === request) inFlight.delete(provider); }
	}
}

// Each extension receives a different wrapper around the same bus. Discover the service over
// that bus, rather than keying module state by wrapper identity (or relying on Jiti's module cache).
const COLLECTOR_REQUEST = "pi-session-hud:usage-collector-request:v1";
export function getUsageCollector(pi: ExtensionAPI): UsageCollector {
	let shared: UsageCollector | undefined;
	pi.events.emit(COLLECTOR_REQUEST, { provide: (collector: UsageCollector) => { shared = collector; } });
	if (shared) return shared;
	const collector = new UsageCollector(pi);
	pi.events.on(COLLECTOR_REQUEST, data => {
		const request = data as { provide?: (collector: UsageCollector) => void } | undefined;
		if (typeof request?.provide === "function") request.provide(collector);
	});
	return collector;
}
