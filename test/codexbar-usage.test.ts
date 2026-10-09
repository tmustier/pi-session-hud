import assert from "node:assert/strict";
import test from "node:test";
import sessionHud, * as hudModule from "../pi-session-hud.js";
import { ansiFallbackTheme } from "./theme-fixture.js";

const { parseCodexBarSubscriptionUsagePayload } = hudModule;

const weekly = { usedPercent: 2, windowMinutes: 10080, resetsAt: "2026-10-07T09:06:18Z" };
const fiveHour = { usedPercent: 45, windowMinutes: 300, resetsAt: "2026-09-30T14:00:00Z" };
const payload = [{ provider: "codex", source: "oauth", usage: { primary: null, secondary: weekly } }];

test("CodexBar quota is labelled for openai and windows are selected by duration", () => {
	assert.deepEqual(parseCodexBarSubscriptionUsagePayload(payload), {
		provider: "openai", usedPercent: 2, resetAtMs: Date.parse(weekly.resetsAt),
	});
	assert.deepEqual(parseCodexBarSubscriptionUsagePayload([
		{ provider: "codex", usage: { primary: weekly, secondary: fiveHour } },
	]), {
		provider: "openai", usedPercent: 2, resetAtMs: Date.parse(weekly.resetsAt),
		fiveHour: { usedPercent: 45, resetAtMs: Date.parse(fiveHour.resetsAt) },
	});
});

test("missing, erroneous, ambiguous or invalid CodexBar quota is not displayed", () => {
	for (const invalid of [null, {}, [], [...payload, ...payload],
		[{ ...payload[0], error: { message: "Login required" } }],
		[{ provider: "openai", usage: payload[0].usage }],
		[{ provider: "codex", usage: { primary: fiveHour } }],
		[{ provider: "codex", usage: { secondary: { ...weekly, usedPercent: 101 } } }],
	]) assert.equal(parseCodexBarSubscriptionUsagePayload(invalid), null);
});

function harness(oauth = true) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const calls: Array<{ command: string; args: string[]; options: any }> = [];
	let output: () => Promise<any> = async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: "", killed: false });
	const theme = ansiFallbackTheme();
	const tui = { requestRender() {} };
	let footer: any;
	let editor: any;
	const ctx: any = {
		hasUI: true, cwd: "/tmp", isProjectTrusted: () => false,
		model: { provider: "openai", id: "gpt-6.1-sol", api: "openai-responses", reasoning: true, contextWindow: 272000 },
		getContextUsage: () => null, sessionManager: { getBranch: () => [] },
		modelRegistry: { isUsingOAuth: () => oauth },
		ui: {
			theme,
			setFooter(factory: any) { footer = factory(tui, theme, { getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} }); },
			getEditorComponent: () => () => ({ render: () => ["────", " prompt ", "────"], handleInput() {} }),
			setEditorComponent(factory: any) { editor = factory(tui, theme, {}); },
		},
	};
	sessionHud({
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: { on: () => () => {}, emit() {} }, registerCommand() {},
		getThinkingLevel: () => "medium", getSessionName: () => "",
		exec: async (command: string, args: string[], options: any) => {
			if (command !== "codexbar") return { code: 1, stdout: "", stderr: "" };
			calls.push({ command, args, options });
			return output();
		},
	} as any);
	return {
		ctx, calls, output: (fn: typeof output) => { output = fn; },
		fire: async (name: string) => { await handlers.get(name)?.({}, ctx); await new Promise((resolve) => setImmediate(resolve)); },
		editorText: () => editor.render(100).join("\n"),
		footerText: () => footer.render(180).join("\n"),
	};
}

test("openai OAuth fetches CodexBar and renders quota; failure clears it", async () => {
	const hud = harness();
	try {
		await hud.fire("session_start");
		assert.deepEqual(hud.calls[0]?.args, ["usage", "--provider", "codex", "--source", "oauth", "--json", "--no-credits"]);
		assert.ok(hud.calls[0]?.options.timeout > 0);
		assert.match(hud.editorText(), /98% left/);
		assert.match(hud.footerText(), /openai weekly reset/);
		for (const failure of [
			async () => { throw new Error("ENOENT"); },
			async () => ({ code: 1, stdout: "", killed: false }),
			async () => ({ code: 0, stdout: "not JSON", killed: false }),
			async () => ({ code: 0, stdout: JSON.stringify(payload), killed: true }),
		]) {
			hud.output(failure);
			await hud.fire("model_select");
			assert.doesNotMatch(hud.editorText(), /% left/);
		}
	} finally { await hud.fire("session_shutdown"); }
});

test("openai API-key billing never invokes CodexBar", async () => {
	const hud = harness(false);
	try {
		await hud.fire("session_start");
		assert.equal(hud.calls.length, 0);
		assert.match(hud.editorText(), /\$0\.000/);
	} finally { await hud.fire("session_shutdown"); }
});

test("a CodexBar result finishing after a provider switch is discarded", async () => {
	const hud = harness();
	let resolve!: (result: any) => void;
	hud.output(() => new Promise((r) => { resolve = r; }));
	try {
		await hud.fire("session_start");
		hud.ctx.model = { ...hud.ctx.model, provider: "other" };
		await hud.fire("model_select");
		resolve({ code: 0, stdout: JSON.stringify(payload), killed: false });
		await new Promise((r) => setImmediate(r));
		assert.doesNotMatch(hud.editorText(), /% left/);
	} finally { await hud.fire("session_shutdown"); }
});
