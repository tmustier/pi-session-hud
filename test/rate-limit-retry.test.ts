import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import retryExtension, { abortableDelay, CONFIG_NAME, formatResetTime, isRateLimitFailure, nextBlockingReset, parseRetryConfig, waitNotice } from "../rate-limit-retry.js";
import { getUsageCollector, type UsageObservation } from "../usage-collector.js";

function observation(fiveHour: number, weekly = 0, resetAtMs = Date.now() + 120): UsageObservation {
	return { usage: { provider: "anthropic", usedPercent: weekly, resetAtMs: resetAtMs + 120, fiveHour: { usedPercent: fiveHour, resetAtMs } }, source: "provider", startedAt: Date.now(), observedAt: Date.now() };
}

test("configuration only waits for explicitly configured providers", () => {
	assert.deepEqual(parseRetryConfig({ providers: {} }), { enabled: true, providers: {} });
	assert.equal(parseRetryConfig({ enabled: false, providers: { anthropic: { behavior: "wait-until-reset" } } }).enabled, false);
	for (const value of [null, [], {}, { providers: [] }, { providers: { anthropic: { behavior: "switch" } } }, { enabled: "yes", providers: {} }]) assert.throws(() => parseRetryConfig(value));
});

test("recognises actual rate-limit failures, not successful quoted errors or ordinary outages", () => {
	for (const errorMessage of ["429 rate_limit_error", "Too many requests", "subscription_sharing_usage_limit_exceeded"]) assert(isRateLimitFailure(fauxAssistantMessage("", { stopReason: "error", errorMessage })));
	for (const errorMessage of ["503 overloaded", "insufficient_quota billing", "request req429123", "subscription_sharing_workplace_individual_usage_limit_exceeded"]) assert(!isRateLimitFailure(fauxAssistantMessage("", { stopReason: "error", errorMessage })));
	assert(!isRateLimitFailure(fauxAssistantMessage("429 rate_limit_error")));
});

test("uses unrounded exhaustion and wakes at the first blocking reset without assuming windows are coupled", () => {
	const o = observation(99.99, 0, 1000);
	assert.equal(nextBlockingReset(o, 0), undefined);
	o.usage.fiveHour!.usedPercent = 100;
	assert.deepEqual(nextBlockingReset(o, 0), { label: "5-hour", resetAtMs: 1000 });
	o.usage.usedPercent = 100;
	o.usage.resetAtMs = 500;
	assert.deepEqual(nextBlockingReset(o, 0), { label: "weekly", resetAtMs: 500 });
	assert.deepEqual(nextBlockingReset(o, 600), { label: "5-hour", resetAtMs: 1000 });
	o.usage.resetAtMs = undefined;
	assert.equal(nextBlockingReset(o, 0), undefined);
	assert.equal(nextBlockingReset(observation(100, 0, 100), 1000), undefined);
});

test("uses the local timezone and daylight saving time, with no weekday guessing", () => {
	const previous = process.env.TZ;
	process.env.TZ = "Europe/London";
	try {
		assert.equal(formatResetTime(Date.parse("2026-01-04T19:21Z"), Date.parse("2026-01-04T12:00Z")), "19:21 GMT today");
		assert.equal(formatResetTime(Date.parse("2026-07-04T18:21Z"), Date.parse("2026-07-03T12:00Z")), "19:21 BST tomorrow");
	} finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("the notice qualifies CodexBar inference and cancellation clears its timer", async () => {
	const lines = waitNotice("openai", { label: "weekly", resetAtMs: Date.now() + 60_000 }, "codexbar", Date.now(), { fg: (_color, text) => text, bold: text => text });
	assert(lines.some(line => line.includes("account may differ")));
	const controller = new AbortController();
	const waiting = abortableDelay(86_400_000, controller.signal);
	controller.abort();
	await waiting;
});

interface Scenario {
	error?: string; mode?: "abort" | "switch" | "escape" | "off" | "off-after-wait" | "queue";
	enabled?: boolean; maxRetries?: number; configured?: boolean;
	readings?: (number: number) => UsageObservation | null;
	repeatedErrors?: number; errors?: string[]; priorBoundaryEntry?: boolean; checkCompaction?: boolean; recoverCompaction?: boolean;
}

async function scenario(options: Scenario = {}) {
	const dir = await mkdtemp(join(tmpdir(), "hud-retry-test-"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const faux = fauxProvider({ provider: "anthropic", models: [{ id: "first" }, { id: "second" }] });
	const errorMessage = options.error ?? "429 rate_limit_error";
	faux.setResponses([...(options.errors ?? Array.from({ length: options.repeatedErrors ?? 1 }, () => errorMessage)).map(errorMessage => fauxAssistantMessage("", { stopReason: "error", errorMessage })), fauxAssistantMessage("Resumed"), fauxAssistantMessage("Queued follow-up handled")]);
	await writeFile(join(dir, CONFIG_NAME), JSON.stringify({ providers: options.configured === false ? {} : { anthropic: { behavior: "wait-until-reset" } } }));
	let probes = 0;
	let widgets = 0;
	let compactions = 0;
	let afterWait!: () => void, releaseLater!: () => void;
	const laterEntered = new Promise<void>(resolve => { afterWait = resolve; });
	const laterReleased = new Promise<void>(resolve => { releaseLater = resolve; });
	let input: ((data: string) => unknown) | undefined;
	let waiting!: () => void;
	const waitingStarted = new Promise<void>(resolve => { waiting = resolve; });
	const ui = {
		onTerminalInput: (handler: typeof input) => { input = handler; return () => { input = undefined; }; },
		setWidget: (_key: string, value: unknown) => { if (value) { widgets++; waiting(); } },
		setWorkingVisible() {}, notify() {},
	} as unknown as ExtensionUIContext;
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: options.enabled !== false, maxRetries: options.maxRetries ?? 3, baseDelayMs: 1 }, compaction: { enabled: options.checkCompaction === true, keepRecentTokens: 1 } });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: [pi => {
		pi.registerProvider(faux.provider);
		if (options.priorBoundaryEntry) pi.on("agent_before_settle", event => ({ entries: [...event.entries, { type: "custom", customType: "other-extension", data: "preserve me" }] }));
		getUsageCollector(pi).refresh = async () => { probes++; return options.readings ? options.readings(probes) : observation(probes === 1 ? 100 : 0); };
		retryExtension(pi);
		if (options.checkCompaction) pi.on("session_before_compact", event => {
			compactions++;
			return options.recoverCompaction ? { compaction: { summary: "Previous work completed.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } } : { cancel: true };
		});
		if (options.mode === "off-after-wait") pi.on("turn_end", async event => {
			if (event.message.role === "assistant" && event.message.stopReason === "error") { afterWait(); await laterReleased; }
		});
	}] });
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		const sessionManager = SessionManager.inMemory(dir);
		if (options.checkCompaction) {
			sessionManager.appendMessage({ role: "user", content: "Previous request", timestamp: Date.now() });
			sessionManager.appendMessage(fauxAssistantMessage("Previously completed work."));
		}
		({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager, model: faux.getModel(), sessionManager }));
		const errors: string[] = [];
		await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error.error) });
		const running = session.prompt("Lifecycle probe");
		if (options.mode) {
			if (options.mode === "off-after-wait") await laterEntered; else await waitingStarted;
			if (options.mode === "abort") await session.abort();
			if (options.mode === "escape") input?.("\x1b");
			if (options.mode === "switch") await session.setModel(faux.getModel("second")!);
			if (options.mode === "off" || options.mode === "off-after-wait") { await session.prompt("/rate-limit-retry off"); releaseLater(); }
			if (options.mode === "queue") await session.prompt("New request", { streamingBehavior: "steer" });
		}
		await running;
		await sleep(5);
		assert.deepEqual(errors, []);
		assert.equal(session.isIdle, true);
		return { calls: faux.state.callCount, probes, widgets, compactions, messages: session.messages, entries: session.sessionManager.getEntries() };
	} finally {
		session?.dispose();
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("Pi waits, refreshes and retries without adding a user message", async () => {
	const result = await scenario();
	assert.equal(result.calls, 2);
	assert.equal(result.probes, 2);
	assert(result.widgets > 0);
	assert.equal(result.messages.filter(message => message.role === "user").length, 1);
});

test("subscription errors excluded by native retries resume and preserve earlier boundary entries", async () => {
	const result = await scenario({ error: "subscription_sharing_usage_limit_exceeded", priorBoundaryEntry: true });
	assert(result.entries.some(entry => entry.type === "custom" && entry.customType === "other-extension"));
	assert.equal(result.calls, 2);
	assert.equal(result.probes, 2);
	assert(result.entries.some(entry => entry.type === "context_edit" && entry.replacement === null));
	assert.equal(result.messages.filter(message => message.role === "user").length, 1);
});

for (const mode of ["abort", "escape", "switch", "off"] as const) {
	test(`${mode} cancels waiting without a delayed retry`, async () => {
		const result = await scenario({ mode });
		assert.equal(result.calls, 1);
		assert.equal(result.probes, 1);
	});
}

test("follow-up input keeps Pi's normal queue and is not lost while waiting", async () => {
	const result = await scenario({ mode: "queue" });
	assert.equal(result.probes, 2);
	assert.equal(result.messages.filter(message => message.role === "user").length, 2);
	assert(result.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("New request")));
});

test("SDK abort also cancels subscription errors excluded by native retries", async () => {
	const result = await scenario({ error: "subscription_sharing_usage_limit_exceeded", mode: "abort" });
	assert.equal(result.calls, 1);
	assert.equal(result.probes, 1);
});

test("mixed settlement and native retries share one total retry budget", async () => {
	const result = await scenario({ maxRetries: 1, errors: ["subscription_sharing_usage_limit_exceeded", "429 rate_limit_error"] });
	assert.equal(result.calls, 2);
});

test("turning off after waiting also clears a pending settlement continuation", async () => {
	const result = await scenario({ error: "subscription_sharing_usage_limit_exceeded", mode: "off-after-wait" });
	assert.equal(result.calls, 1);
});

test("a spent transient retry budget does not suppress context-overflow compaction", async () => {
	const result = await scenario({ maxRetries: 1, errors: ["subscription_sharing_usage_limit_exceeded", "prompt is too long: 250000 tokens > 200000 maximum"], checkCompaction: true });
	assert.equal(result.compactions, 1);
	assert.equal(result.calls, 2);
});

test("successful overflow recovery does not spend a transient retry", async () => {
	const result = await scenario({ maxRetries: 2, errors: ["subscription_sharing_usage_limit_exceeded", "prompt is too long: 250000 tokens > 200000 maximum", "503 overloaded"], checkCompaction: true, recoverCompaction: true });
	assert.equal(result.compactions, 1);
	assert.equal(result.calls, 4);
});

test("disabled retries, zero retries and unconfigured providers never probe or wait", async () => {
	for (const options of [{ enabled: false }, { maxRetries: 0 }, { configured: false }]) {
		const result = await scenario(options);
		assert.equal(result.probes, 0);
		assert.equal(result.widgets, 0);
	}
});

test("unknown usage keeps native retries and repeated errors obey the retry budget", async () => {
	const unavailable = await scenario({ readings: () => null });
	assert.equal(unavailable.calls, 2);
	assert.equal(unavailable.widgets, 0);
	const repeated = await scenario({ maxRetries: 1, repeatedErrors: 2 });
	assert.equal(repeated.calls, 2);
	assert.equal(repeated.probes, 2);
});

test("an unavailable reset refresh releases native retry rather than polling indefinitely", async () => {
	const result = await scenario({ readings: number => number === 1 ? observation(100) : null });
	assert.equal(result.calls, 2);
	assert.equal(result.probes, 2);
});

test("both exhausted windows are rechecked at the earliest reset", async () => {
	const result = await scenario({ readings: number => number === 1 ? observation(100, 100) : number === 2 ? observation(0, 100, Date.now() - 100) : observation(0, 0) });
	assert.equal(result.calls, 2);
	assert.equal(result.probes, 3);
});
