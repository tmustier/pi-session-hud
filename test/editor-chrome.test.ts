import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import sessionHud, {
	type ChromeLayout,
	chromeTargetAt,
	codexAccountIdFromToken,
	labelHotspots,
	modelLabelSegments,
	translateChromeMouseEvent,
} from "../pi-session-hud.js";

const fakeTui = { requestRender() {} };

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

test("label segments mark only the model id and thinking level as clickable", () => {
	assert.deepEqual(modelLabelSegments("gpt-5.6-sol", "medium", true), [
		{ text: "↯ • " },
		{ text: "gpt-5.6-sol", target: "model" },
		{ text: " • " },
		{ text: "medium", target: "thinking" },
	]);
	assert.deepEqual(modelLabelSegments("gpt-5.6-sol", "off", false), [{ text: "gpt-5.6-sol", target: "model" }]);
});

test("hotspots follow segment widths from the label start and clip at the visible limit", () => {
	const segments = modelLabelSegments("gpt-5.6-sol", "medium", false);
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
	const hotspots = labelHotspots(modelLabelSegments("gpt-5.6-sol", "medium", false), 38, 59);
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

function installHud(thinking: string, options: { oauth?: boolean; capturePress?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const actions: string[] = [];
	const forwarded: TuiMouseEvent[] = [];
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
		getSessionName: () => "",
	};
	let model = { id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 272_000 };
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
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setFooter() {},
			getEditorComponent: () => () => fakeEditor,
			setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
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
	return { fire, selectModel, editorFactory: () => editorFactory!, fakeEditor, actions, forwarded };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("clicking the rendered model id or thinking level runs the app action instead of the editor", async () => {
	const hud = installHud("medium");
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		const lines = editor.render(60);
		assert.equal(lines.length, 3);
		assert.match(lines[0]!, /─ gpt-5\.6-sol • medium ╮\x1b\[0m$/);

		// " gpt-5.6-sol • medium " is 22 columns wide, so the label starts at column 38.
		assert.equal(editor.handleMouse(mouse({ x: 40, y: 0 }))?.handled, true);
		assert.equal(editor.handleMouse(mouse({ x: 55, y: 0 }))?.handled, true);
		assert.deepEqual(hud.actions, ["model", "thinking"]);
		assert.equal(hud.forwarded.length, 0);

		// Anything else reaches the wrapped editor in its own coordinate space.
		editor.handleMouse(mouse({ x: 5, y: 1 }));
		editor.handleMouse(mouse({ x: 20, y: 0 }));
		editor.handleMouse(mouse({ x: 55, y: 0, button: "right" }));
		assert.deepEqual(hud.forwarded.map((event) => [event.x, event.y, event.width]), [[4, 1, 58], [19, 0, 58], [54, 0, 58]]);
		assert.deepEqual(hud.actions, ["model", "thinking"]);
	} finally {
		await hud.fire("session_shutdown");
	}
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
		await hud.selectModel({ id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages", contextWindow: 200_000 });

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

test("a model without a thinking segment only exposes the model hotspot", async () => {
	const hud = installHud("off");
	await hud.fire("session_start");
	try {
		const editor = hud.editorFactory()(fakeTui, {}, {});
		editor.render(60);

		// " gpt-5.6-sol " is 13 columns wide, so the label starts at column 47.
		editor.handleMouse(mouse({ x: 50, y: 0 }));
		editor.handleMouse(mouse({ x: 58, y: 0 }));
		assert.deepEqual(hud.actions, ["model"]);
		assert.equal(hud.forwarded.length, 1);
	} finally {
		await hud.fire("session_shutdown");
	}
});
