import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageCollector, UsageCollector } from "../usage-collector.js";

function api(emitter = new EventEmitter()): ExtensionAPI {
	return { events: {
		emit: (name: string, data: unknown) => { emitter.emit(name, data); },
		on: (name: string, callback: (data: unknown) => void) => { emitter.on(name, callback); return () => { emitter.off(name, callback); }; },
	} } as ExtensionAPI;
}
function context(oauth = true): ExtensionContext {
	return { model: { provider: "anthropic" }, sessionManager: {}, modelRegistry: { isUsingOAuth: () => oauth, getApiKeyForProvider: async () => "test-token" } } as unknown as ExtensionContext;
}

test("different extension event-bus wrappers discover one shared collector", () => {
	const bus = new EventEmitter();
	const hud = api(bus), retry = api(bus);
	assert.notEqual(hud.events, retry.events);
	assert.equal(getUsageCollector(hud), getUsageCollector(retry));
	assert.notEqual(getUsageCollector(api()), getUsageCollector(hud));
});

test("shared requests retain source and timestamps, while post-failure refreshes reject earlier readings", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	let resolve!: (value: Response) => void;
	globalThis.fetch = async () => { calls++; return new Promise<Response>(done => { resolve = done; }); };
	const payload = () => Response.json({ seven_day: { utilization: 20, resets_at: "2027-01-01T00:00:00Z" }, five_hour: { utilization: 100, resets_at: "2026-12-01T00:00:00Z" } });
	try {
		const collector = new UsageCollector(api());
		const ctx = context();
		const first = collector.refresh(ctx, "anthropic");
		await new Promise(done => setImmediate(done));
		const second = collector.refresh(ctx, "anthropic");
		assert.equal(calls, 1);
		resolve(payload());
		const [a, b] = await Promise.all([first, second]);
		assert.equal(a, b);
		assert.equal(a?.source, "provider");
		assert(a!.observedAt >= a!.startedAt);
		const earlier = collector.refresh(ctx, "anthropic");
		await new Promise(done => setImmediate(done));
		const fresh = collector.refresh(ctx, "anthropic", Date.now() + 1);
		resolve(payload());
		await earlier;
		await new Promise(done => setImmediate(done));
		assert.equal(calls, 3);
		resolve(payload());
		await fresh;
	} finally { globalThis.fetch = original; }
});

test("API keys and unsupported providers never query subscription endpoints", async () => {
	const collector = new UsageCollector(api());
	assert.equal(await collector.refresh(context(false), "anthropic"), null);
	assert.equal(await collector.refresh(context(), "unknown"), null);
});

test("active waits pause the HUD's background probes until all waiters leave", () => {
	const collector = new UsageCollector(api());
	const first = collector.pauseBackgroundProbes(), second = collector.pauseBackgroundProbes();
	assert(collector.backgroundPaused);
	first();
	assert(collector.backgroundPaused);
	second();
	assert(!collector.backgroundPaused);
});
