import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import sessionHud, {
	type ChromeLayout,
	ChromePopup,
	chromeTargetAt,
	codexAccountIdFromToken,
	labelHotspots,
	modelLabelSegments,
	modelPopupItems,
	OTHER_MODELS_VALUE,
	popupPosition,
	popupWidth,
	thinkingPopupItems,
	translateChromeMouseEvent,
} from "../pi-session-hud.js";

const fakeTui = {
	requestRender() {},
	terminal: { columns: 120, rows: 40 },
	focused: null as unknown,
	getFocusedComponent() { return this.focused; },
};

function mouse(overrides: Partial<TuiMouseEvent>): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 60,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

function layout(overrides: Partial<ChromeLayout> = {}): ChromeLayout {
	return { width: 60, innerWidth: 58, bottomIndex: 2, lineCount: 3, hotspots: [], ...overrides };
}

const reasoningModel = { id: "gpt-5.6-sol", reasoning: true };
const plainModel = { id: "gpt-5.6-sol", reasoning: false };

test("label segments mark only the model id and thinking level as clickable", () => {
	assert.deepEqual(modelLabelSegments(reasoningModel, "medium", true), [
		{ text: "↯ • " },
		{ text: "gpt-5.6-sol", target: "model" },
		{ text: " • " },
		{ text: "medium", target: "thinking" },
	]);
});

test("thinking off stays visible and clickable on reasoning models, like Pi's footer", () => {
	assert.deepEqual(modelLabelSegments(reasoningModel, "off", false), [
		{ text: "gpt-5.6-sol", target: "model" },
		{ text: " • " },
		{ text: "thinking off", target: "thinking" },
	]);
	assert.deepEqual(modelLabelSegments(plainModel, "off", false), [{ text: "gpt-5.6-sol", target: "model" }]);
	assert.deepEqual(modelLabelSegments(plainModel, "medium", false), [{ text: "gpt-5.6-sol", target: "model" }]);
});

test("hotspots follow segment widths from the label start and clip at the visible limit", () => {
	const segments = modelLabelSegments(reasoningModel, "medium", false);
	assert.deepEqual(labelHotspots(segments, 38, 59), [
		{ start: 38, end: 49, target: "model" },
		{ start: 52, end: 58, target: "thinking" },
	]);
	// A truncated label exposes only the columns that were actually drawn.
	assert.deepEqual(labelHotspots(segments, 38, 54), [
		{ start: 38, end: 49, target: "model" },
		{ start: 52, end: 54, target: "thinking" },
	]);
	assert.deepEqual(labelHotspots(segments, 38, 45), [{ start: 38, end: 45, target: "model" }]);
});

test("chrome targets resolve only on the top border row", () => {
	const hotspots = labelHotspots(modelLabelSegments(reasoningModel, "medium", false), 38, 59);
	const chrome = layout({ hotspots });
	assert.equal(chromeTargetAt(chrome, 38, 0), "model");
	assert.equal(chromeTargetAt(chrome, 48, 0), "model");
	assert.equal(chromeTargetAt(chrome, 49, 0), undefined);
	assert.equal(chromeTargetAt(chrome, 55, 0), "thinking");
	assert.equal(chromeTargetAt(chrome, 58, 0), undefined);
	assert.equal(chromeTargetAt(chrome, 40, 1), undefined);
});

test("mouse events shift one column inside the frame and stay put on autocomplete rows", () => {
	const chrome = layout({ bottomIndex: 2, lineCount: 6 });
	const framed = translateChromeMouseEvent(mouse({ x: 10, y: 1, height: 6 }), chrome);
	assert.equal(framed.x, 9);
	assert.equal(framed.y, 1);
	assert.equal(framed.width, 58);
	assert.equal(framed.height, 6);

	const autocomplete = translateChromeMouseEvent(mouse({ x: 10, y: 4, height: 6 }), chrome);
	assert.equal(autocomplete.x, 10);
	assert.equal(autocomplete.y, 4);

	const wrapped = translateChromeMouseEvent(mouse({ x: 10, y: 3, height: 5 }), layout({ bottomIndex: undefined, lineCount: 5 }));
	assert.equal(wrapped.x, 9);
	assert.equal(wrapped.y, 2);
	assert.equal(wrapped.height, 3);
});

test("reads the Codex account id from the OAuth access token claims", () => {
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } };
	const token = `hdr.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
	assert.equal(codexAccountIdFromToken(token), "acct_123");
	assert.equal(codexAccountIdFromToken("sk-not-a-jwt"), undefined);
	assert.equal(codexAccountIdFromToken("a.!!!.c"), undefined);
});

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

type FakeModel = { id: string; provider: string; api: string; contextWindow: number; reasoning: boolean; thinkingLevelMap?: Record<string, string> };
type FakePopup = { component: ChromePopup; options: unknown };

function installHud(
	thinking: string,
	options: { oauth?: boolean; capturePress?: boolean; reasoning?: boolean; scoped?: Array<{ model: FakeModel; thinkingLevel?: string }> } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const actions: string[] = [];
	const forwarded: TuiMouseEvent[] = [];
	const popups: FakePopup[] = [];
	const changes: string[] = [];
	const notices: string[] = [];
	const fakeEditor = {
		actionHandlers: new Map<string, () => void>([
			["app.model.select", () => actions.push("model")],
			["app.thinking.cycle", () => actions.push("thinking")],
		]),
		render: (_width: number) => ["────", " text ", "────"],
		handleMouse: (event: TuiMouseEvent) => {
			forwarded.push(event);
			return event.type === "press" ? (options.capturePress ? { handled: true, capture: true } : undefined) : { handled: true, focus: true };
		},
		handleInput() {},
		invalidate() {},
		getText: () => "",
		setText() {},
	};
	let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => typeof fakeEditor) | undefined;
	const pi = {
		on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		events: { on: () => () => {}, emit() {} },
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		registerCommand() {},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; changes.push(`thinking:${level}`); },
		setModel: async (next: FakeModel) => { model = next; changes.push(`model:${next.provider}/${next.id}`); return next.provider !== "unauthenticated"; },
		getSessionName: () => "",
	};
	let model: FakeModel = { id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272_000, reasoning: options.reasoning ?? true };
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } };
	const token = `hdr.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
	// Pi creates a fresh ExtensionContext object for every event it emits.
	const createCtx = () => ({
		hasUI: true,
		cwd: "/tmp",
		model,
		getContextUsage: () => null,
		sessionManager: { getBranch: () => [] },
		modelRegistry: {
			isUsingOAuth: () => options.oauth === true,
			getApiKeyForProvider: async () => token,
		},
		scopedModels: options.scoped ?? [],
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setFooter() {},
			notify: (message: string) => { notices.push(message); },
			getEditorComponent: () => () => fakeEditor,
			setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => ChromePopup, opts: unknown) =>
				new Promise<string | undefined>((resolve) => {
					const component = factory(fakeTui, {}, {}, (value) => { component.focused = false; resolve(value); });
					component.focused = true;
					popups.push({ component, options: opts });
				}),
		},
	});

	sessionHud(pi as any);
	const fire = async (event: string) => {
		const ctx = createCtx();
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	const selectModel = async (next: typeof model) => {
		model = next;
		await fire("model_select");
	};
	return { fire, selectModel, editorFactory: () => editorFactory!, fakeEditor, actions, forwarded, popups, changes, notices };
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("clicking the model id without a scope opens Pi's selector; other clicks reach the editor", async () => {
	const hud = installHud("medium");
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		const lines = editor.render(60);
		assert.equal(lines.length, 3);
		assert.match(lines[0]!, /─ gpt-5\.6-sol • medium ╮\x1b\[0m$/);

		// " gpt-5.6-sol • medium " is 22 columns wide, so the label starts at column 38.
		assert.equal(editor.handleMouse(mouse({ x: 40, y: 0 }))?.handled, true);
		assert.deepEqual(hud.actions, ["model"]);
		assert.equal(hud.popups.length, 0);
		assert.equal(hud.forwarded.length, 0);

		// Anything else reaches the wrapped editor in its own coordinate space.
		editor.handleMouse(mouse({ x: 5, y: 1 }));
		editor.handleMouse(mouse({ x: 20, y: 0 }));
		editor.handleMouse(mouse({ x: 55, y: 0, button: "right" }));
		assert.deepEqual(hud.forwarded.map((event) => [event.x, event.y, event.width]), [[4, 1, 58], [19, 0, 58], [54, 0, 58]]);
		assert.deepEqual(hud.actions, ["model"]);
	} finally {
		await hud.fire("session_shutdown");
	}
});

const scopedFable: FakeModel = { id: "claude-fable-5", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, reasoning: true };
const scopedAstra: FakeModel = { id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 400_000, reasoning: true };

test("clicking the model id with a scope pops up the scoped models above the frame, plus Other", async () => {
	const hud = installHud("medium", { scoped: [{ model: scopedFable, thinkingLevel: "high" }, { model: scopedAstra }] });
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);
		// The editor frame starts at screen column 3, row 30.
		editor.handleMouse(mouse({ x: 40, y: 0, screenX: 43, screenY: 30 }));
		await settle();
		assert.deepEqual(hud.actions, []);
		assert.equal(hud.popups.length, 1);

		const { component, options } = hud.popups[0]!;
		const width = popupWidth(modelPopupItems([{ model: scopedFable, thinkingLevel: "high" as never }, { model: scopedAstra }] as never, undefined), 120);
		assert.deepEqual(options, { overlay: true, overlayOptions: { row: 30 - 5, col: 3 + 60 - width, width } });
		const rows = component.render(width).map(strip);
		assert.equal(rows.length, 5);
		assert.match(rows[0]!, /^╭ Model ─+╮$/);
		assert.match(rows[1]!, /^│ →   claude-fable-5\s+anthropic · high\s+│$/);
		assert.match(rows[2]!, /^│     gpt-6-astra\s+openai-codex\s+│$/);
		assert.match(rows[3]!, /^│     Other…\s+all models\s+│$/);
		assert.match(rows[4]!, /^╰─+╯$/);

		// Clicking the second row selects it: the model switches and inherits no scoped level.
		component.handleMouse(mouse({ type: "press", x: 4, y: 2, width, height: 5 }));
		component.handleMouse(mouse({ type: "click", x: 4, y: 2, width, height: 5 }));
		await settle();
		assert.deepEqual(hud.changes, ["model:openai-codex/gpt-6-astra"]);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("a scoped model with its own level applies that level after switching", async () => {
	const hud = installHud("medium", { scoped: [{ model: scopedFable, thinkingLevel: "high" }] });
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);
		editor.handleMouse(mouse({ x: 40, y: 0 }));
		await settle();
		hud.popups[0]!.component.handleInput("\r");
		await settle();
		assert.deepEqual(hud.changes, ["model:anthropic/claude-fable-5", "thinking:high"]);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("Other opens Pi's model selector and switches it to the all scope", async () => {
	const hud = installHud("medium", { scoped: [{ model: scopedFable }] });
	await hud.fire("session_start");
	const scopes: string[] = [];
	fakeTui.focused = { setScope: (scope: string) => scopes.push(scope) };
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);
		editor.handleMouse(mouse({ x: 40, y: 0 }));
		await settle();
		const popup = hud.popups[0]!.component;
		popup.handleInput("\x1b[B"); // down to Other…
		popup.handleInput("\r");
		await settle();
		assert.deepEqual(hud.actions, ["model"]);
		assert.deepEqual(scopes, ["all"]);
		assert.deepEqual(hud.changes, []);
	} finally {
		fakeTui.focused = null;
		await hud.fire("session_shutdown");
	}
});

test("clicking the thinking level pops up the model's supported levels with the current one checked", async () => {
	const hud = installHud("medium");
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);
		editor.handleMouse(mouse({ x: 55, y: 0 }));
		await settle();
		assert.equal(hud.popups.length, 1);
		const width = popupWidth(thinkingPopupItems(["off", "minimal", "low", "medium", "high"], "medium"), 120);
		assert.equal((hud.popups[0]!.options as { overlayOptions: { width: number } }).overlayOptions.width, width);
		const rows = hud.popups[0]!.component.render(width).map(strip);
		assert.match(rows[0]!, /^╭ Thinking ─+╮$/);
		assert.deepEqual(rows.slice(1, -1).map((row) => row.replace(/\s+/g, " ").trim()), [
			"│ off No reasoning │",
			"│ minimal Very brief reasoning (~1k tokens) │",
			"│ low Light reasoning (~2k tokens) │",
			"│ → ✓ medium Moderate reasoning (~8k tokens) │",
			"│ high Deep reasoning (~16k tokens) │",
		]);

		hud.popups[0]!.component.handleInput("\x1b[B");
		hud.popups[0]!.component.handleInput("\r");
		await settle();
		assert.deepEqual(hud.changes, ["thinking:high"]);
		assert.deepEqual(hud.actions, []);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("clicking the open popup's label closes it and the other label swaps popups", async () => {
	const hud = installHud("medium", { scoped: [{ model: scopedFable }] });
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);
		editor.handleMouse(mouse({ x: 40, y: 0 }));
		await settle();
		assert.equal(hud.popups.length, 1);
		assert.equal(hud.popups[0]!.component.focused, true);

		editor.handleMouse(mouse({ x: 40, y: 0 }));
		await settle();
		assert.equal(hud.popups[0]!.component.focused, false);
		assert.equal(hud.popups.length, 1);

		editor.handleMouse(mouse({ x: 40, y: 0 }));
		await settle();
		editor.handleMouse(mouse({ x: 55, y: 0 }));
		await settle();
		assert.equal(hud.popups.length, 3);
		assert.equal(hud.popups[1]!.component.focused, false);
		assert.equal(hud.popups[2]!.component.focused, true);
		assert.match(strip(hud.popups[2]!.component.render(50)[0]!), /Thinking/);
		assert.deepEqual(hud.changes, []);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("a popup closes itself when something else takes focus", async () => {
	let result: string | undefined | "open" = "open";
	const popup = new ChromePopup("Model", [{ value: "a", label: "a" }], "a", (t) => t, { fg: (_c, t) => t }, (value) => { result = value; });
	popup.focused = true;
	popup.focused = false;
	assert.equal(result, "open");
	await Promise.resolve();
	assert.equal(result, undefined);
});

test("popup items and geometry", () => {
	const items = thinkingPopupItems(["off", "low", "xhigh"], "low");
	assert.deepEqual(items.map((item) => [item.value, item.label]), [["off", "  off"], ["low", "✓ low"], ["xhigh", "  xhigh"]]);

	const models = modelPopupItems([{ model: scopedFable as never }, { model: scopedAstra as never, thinkingLevel: "low" as never }], scopedAstra);
	assert.deepEqual(models.map((item) => [item.value, item.label, item.description]), [
		["anthropic/claude-fable-5", "  claude-fable-5", "anthropic"],
		["openai-codex/gpt-6-astra", "✓ gpt-6-astra", "openai-codex · low"],
		[OTHER_MODELS_VALUE, "  Other…", "all models"],
	]);

	// Wide enough for the longest label and description without truncation (SelectList only
	// draws descriptions above 40 columns), but never wider than the terminal.
	assert.equal(popupWidth(models, 120), Math.max(41, 2 + 16 + 2 + 18 + 2) + 2 + 2);
	assert.equal(popupWidth(models, 30), 30);
	assert.equal(popupWidth([{ value: "a", label: "a" }], 120), 2 + 1 + 2 + 0 + 2 + 2 + 2);

	// Right edge on the frame's right edge, bottom edge on the row above the frame; clamped to the terminal.
	assert.deepEqual(popupPosition({ screenX: 43, screenY: 30, x: 40, y: 0 }, 60, { width: 20, height: 5 }, { columns: 120, rows: 40 }), { row: 25, col: 43 });
	assert.deepEqual(popupPosition({ screenX: 43, screenY: 3, x: 40, y: 0 }, 60, { width: 80, height: 5 }, { columns: 70, rows: 40 }), { row: 0, col: 0 });
});

test("keeps a subscription usage probe result even when other events fire while it is in flight", async () => {
	const originalFetch = globalThis.fetch;
	let releaseProbe!: () => void;
	const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
	const requests: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push(String(url));
		assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "acct_123");
		await probeReleased;
		return Response.json({
			rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 7 * 24 * 60 * 60, reset_at: 4_102_444_800 } },
		});
	}) as typeof fetch;

	const hud = installHud("medium", { oauth: true });
	try {
		await hud.fire("session_start");
		const editor = hud.editorFactory()(fakeTui, {}, {});
		assert.doesNotMatch(editor.render(60).at(-1)!, /% left/);

		// A new prompt starts before the probe answers; the answer must still land.
		await hud.fire("agent_start");
		releaseProbe();
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepEqual(requests, ["https://chatgpt.com/backend-api/wham/usage"]);
		assert.match(editor.render(60).at(-1)!, /63% left ╯/);
	} finally {
		globalThis.fetch = originalFetch;
		await hud.fire("session_shutdown");
	}
});

test("discards a probe from the previous provider that finishes after a model switch", async () => {
	const originalFetch = globalThis.fetch;
	const codexProbe = deferred<void>();
	const anthropicProbe = deferred<void>();
	globalThis.fetch = (async (url: string | URL | Request) => {
		if (String(url).includes("chatgpt.com")) {
			await codexProbe.promise;
			return Response.json({ rate_limit: { primary_window: { used_percent: 37, limit_window_seconds: 604_800 } } });
		}
		await anthropicProbe.promise;
		return Response.json({ seven_day: { utilization: 0.2, resets_at: "2100-01-01T00:00:00Z" } });
	}) as typeof fetch;

	const hud = installHud("medium", { oauth: true });
	try {
		await hud.fire("session_start");
		const editor = hud.editorFactory()(fakeTui, {}, {});
		await hud.selectModel({ id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000, reasoning: true });

		anthropicProbe.resolve();
		await settle();
		assert.match(editor.render(60).at(-1)!, /80% left ╯/);

		// The older Codex probe answers last; it belongs to a provider no longer selected.
		codexProbe.resolve();
		await settle();
		assert.match(editor.render(60).at(-1)!, /80% left ╯/);
	} finally {
		globalThis.fetch = originalFetch;
		await hud.fire("session_shutdown");
	}
});

test("owns the press on a hotspot so a wrapped editor that captures presses cannot take the click", async () => {
	const hud = installHud("medium", { capturePress: true });
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);

		assert.equal(editor.handleMouse(mouse({ type: "press", x: 40, y: 0 }))?.handled, true);
		assert.equal(editor.handleMouse(mouse({ type: "release", x: 40, y: 0 }))?.handled, true);
		assert.equal(editor.handleMouse(mouse({ type: "click", x: 40, y: 0 }))?.handled, true);
		assert.deepEqual(hud.actions, ["model"]);
		assert.equal(hud.forwarded.length, 0);

		// Presses elsewhere still reach the wrapped editor so it can capture its own gestures.
		assert.equal(editor.handleMouse(mouse({ type: "press", x: 5, y: 1 }))?.capture, true);
		assert.deepEqual(hud.forwarded.map((event) => [event.type, event.x, event.y]), [["press", 4, 1]]);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("clicking thinking off on a reasoning model still opens the thinking popup", async () => {
	const hud = installHud("off");
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		const top = editor.render(60)[0]!;
		assert.match(top, /gpt-5\.6-sol • thinking off ╮/);

		// " gpt-5.6-sol • thinking off " is 28 columns wide, so the label starts at column 32.
		editor.handleMouse(mouse({ x: 50, y: 0 }));
		await settle();
		assert.deepEqual(hud.actions, []);
		assert.match(strip(hud.popups[0]!.component.render(50)[1]!), /→ ✓ off/);
	} finally {
		await hud.fire("session_shutdown");
	}
});

test("a model without thinking support only exposes the model hotspot", async () => {
	const hud = installHud("medium", { reasoning: false });
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);

		// " gpt-5.6-sol " is 13 columns wide, so the label starts at column 47.
		editor.handleMouse(mouse({ x: 50, y: 0 }));
		editor.handleMouse(mouse({ x: 58, y: 0 }));
		await settle();
		assert.deepEqual(hud.actions, ["model"]);
		assert.equal(hud.popups.length, 0);
		assert.equal(hud.forwarded.length, 1);
	} finally {
		await hud.fire("session_shutdown");
	}
});
