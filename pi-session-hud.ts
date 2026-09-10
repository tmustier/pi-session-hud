/** Compact context footer and editor chrome for Pi. */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type AppKeybinding,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type ScopedModel,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	AUTO_COMPACT_POLICY_EVENT,
	AUTO_COMPACT_POLICY_REQUEST_EVENT,
	effectiveContextPercent,
	effectiveContextWindow,
	isContextWindowCapped,
	parseAutoCompactPolicySnapshot,
	sameModel,
	type AutoCompactPolicySnapshot,
	type ModelIdentity,
} from "./auto-compact-limit.js";
import {
	CHROME_MENU_EVENT,
	CHROME_MENU_REQUEST_EVENT,
	type ChromeMenu,
	type ChromeMenuExtend,
	type ChromeMenuItem,
	parseChromeMenu,
	resolveChromeMenu,
} from "./chrome-menu.js";

const FAST_MODE_STATUS_KEY = "fast-mode";
const CONTEXT_BAR_WIDTH = 6;
const SESSION_FALLBACK_WORDS = 8;
const EDITOR_GUTTER_WIDTH = 1;
const FOOTER_GUTTER_WIDTH = EDITOR_GUTTER_WIDTH;
const SUPPORTED_SUBSCRIPTION_USAGE_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const ONE_WEEK_MINUTES = 7 * 24 * 60;
const FIVE_HOURS_MINUTES = 5 * 60;
const ONE_WEEK_MS = ONE_WEEK_MINUTES * 60 * 1000;
const FIVE_HOURS_MS = FIVE_HOURS_MINUTES * 60 * 1000;
const SUBSCRIPTION_USAGE_PROBE_INTERVAL_MS = 5 * 60 * 1000;
const SUBSCRIPTION_USAGE_PROBE_MIN_INTERVAL_MS = 60 * 1000;
const GIT_COMMAND_TIMEOUT_MS = 2000;
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MODEL_SELECT_ACTION: AppKeybinding = "app.model.select";
/** Model popup entry that opens Pi's full model selector; model values always contain "/". */
export const OTHER_MODELS_VALUE = "other";
const POPUP_MAX_ROWS = 12;
const POPUP_PADDING_X = 1;
/** Hover waits this long so a pointer crossing the label does not flash a popup. */
export const HOVER_OPEN_DELAY_MS = 120;
/** Grace after the pointer reaches a popup edge; the cells beyond it send no events. */
export const HOVER_LEAVE_DELAY_MS = 250;
const MENU_TARGET_PREFIX = "menu:";
const MENU_VALUE_SEPARATOR = "\u0000";
/** Mirrors the descriptions in Pi's thinking selector. */
const THINKING_LEVEL_DESCRIPTIONS: Record<string, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const RESET = "\x1b[0m";
const FG_DIM = "\x1b[38;2;90;90;90m";
const FG_MUTED = "\x1b[38;2;128;128;128m";
const FG_TEXT = "\x1b[38;2;255;255;255m";
const DIFF_GREEN = "\x1b[38;2;100;200;120m";
const DIFF_RED = "\x1b[38;2;240;100;100m";
const CONTEXT_GREEN = "\x1b[38;2;100;200;120m";
const CONTEXT_YELLOW_GREEN = "\x1b[38;2;180;210;100m";
const CONTEXT_AMBER = "\x1b[38;2;220;180;60m";
const CONTEXT_RED = "\x1b[38;2;240;80;80m";

const CONTEXT_COLOR_REFERENCE_WINDOW = 272_000;
const CONTEXT_WARNING_LEVELS = {
	yellow: CONTEXT_COLOR_REFERENCE_WINDOW * 0.25,
	amber: CONTEXT_COLOR_REFERENCE_WINDOW * 0.40,
	red: CONTEXT_COLOR_REFERENCE_WINDOW * 0.60,
};

export type ContextBand = "healthy" | "yellow" | "amber" | "red";
/** Built-in popups, or `menu:<id>` for one registered by another extension. */
export type ChromeTarget = "model" | "thinking" | "usage" | `menu:${string}`;
export type LabelSegment = { text: string; target?: ChromeTarget };
export type ChromeHotspot = { row: number; start: number; end: number; target: ChromeTarget };
/** Geometry of the last rendered editor chrome, used to route mouse input. */
export type ChromeLayout = {
	width: number;
	innerWidth: number;
	/** Row of the editor's bottom border, or undefined when the HUD wrapped every editor row. */
	bottomIndex: number | undefined;
	lineCount: number;
	hotspots: ChromeHotspot[];
};
type HudTheme = {
	fg?: (color: ThemeColor, text: string) => string;
};
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type InstalledEditor = {
	factory: EditorFactory;
	previousFactory: EditorFactory | undefined;
	disable: () => void;
};
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

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return `${n}`;
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max);
}

function effectiveWarningLevels(contextWindow: number) {
	if (contextWindow <= 0 || contextWindow >= CONTEXT_COLOR_REFERENCE_WINDOW) {
		return CONTEXT_WARNING_LEVELS;
	}

	const scale = contextWindow / CONTEXT_COLOR_REFERENCE_WINDOW;
	return {
		yellow: CONTEXT_WARNING_LEVELS.yellow * scale,
		amber: CONTEXT_WARNING_LEVELS.amber * scale,
		red: CONTEXT_WARNING_LEVELS.red * scale,
	};
}

export function contextBand(percent: number | null, tokens: number | null, contextWindow: number): ContextBand {
	if (percent === null) return "healthy";

	const value = tokens !== null
		? Math.max(0, tokens)
		: contextWindow > 0
			? (clamp(percent, 0, 100) / 100) * contextWindow
			: clamp(percent, 0, 100);
	const levels = tokens !== null || contextWindow > 0
		? effectiveWarningLevels(contextWindow)
		: { yellow: 25, amber: 40, red: 60 };

	if (value >= levels.red) return "red";
	if (value >= levels.amber) return "amber";
	if (value >= levels.yellow) return "yellow";
	return "healthy";
}

function contextColor(band: ContextBand): string {
	if (band === "yellow") return CONTEXT_YELLOW_GREEN;
	if (band === "amber") return CONTEXT_AMBER;
	if (band === "red") return CONTEXT_RED;
	return CONTEXT_GREEN;
}

function contextBar(percent: number | null, band: ContextBand): string {
	if (percent === null) return `${FG_DIM}${"░".repeat(CONTEXT_BAR_WIDTH)}${RESET}`;

	const clampedPercent = clamp(percent, 0, 100);
	const filled = clamp(Math.round((clampedPercent / 100) * CONTEXT_BAR_WIDTH), 0, CONTEXT_BAR_WIDTH);
	const empty = CONTEXT_BAR_WIDTH - filled;
	return `${contextColor(band)}${"█".repeat(filled)}${FG_DIM}${"░".repeat(empty)}${RESET}`;
}

function displayPath(cwd: string): string {
	const home = process.env.HOME || "";
	if (home && cwd.startsWith(home)) {
		const rel = cwd.slice(home.length);
		return rel ? `~${rel}` : "~";
	}
	return cwd;
}

function normalizeText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

function firstWords(text: string, maxWords = SESSION_FALLBACK_WORDS): string {
	const words = normalizeText(text).split(" ").filter(Boolean);
	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}…`;
}

function textFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "")
		.join(" ");
}

function extractFirstUserText(ctx: ExtensionContext): string | null {
	try {
		const sessionManager = ctx.sessionManager as any;
		const entries: any[] = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
		for (const entry of entries) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = normalizeText(textFromMessageContent(entry.message.content));
			if (text) return text;
		}
	} catch {
		// Best-effort fallback only.
	}
	return null;
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(line, width, "…", false);
	return `${truncated}${RESET}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function fitLeftRight(left: string, right: string, width: number): string {
	if (!right) return fitLine(left, width);
	if (width <= 0) return "";

	const rightWidth = visibleWidth(right);
	if (rightWidth + 1 >= width) return fitLine(`${left} ${right}`, width);

	const leftWidth = width - rightWidth - 1;
	const leftFit = truncateToWidth(left, leftWidth, "…", false);
	const padding = " ".repeat(Math.max(1, width - visibleWidth(leftFit) - rightWidth));
	return `${leftFit}${padding}${right}${RESET}`;
}

function visibleFits(line: string, width: number): boolean {
	return visibleWidth(line) <= width;
}

function fitsLeftRight(left: string, right: string, width: number): boolean {
	if (!right) return visibleFits(left, width);
	return visibleWidth(left) + visibleWidth(right) + 1 <= width;
}

function padAnsiLine(line: string, width: number): string {
	if (width <= 0) return "";
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, "…", false) : line;
	return `${fitted}${RESET}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

type BorderLayout = { line: string; rightStart: number; rightWidth: number };

function layoutHorizontalBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	leftCorner: string,
	rightCorner: string,
	fill: (text: string) => string = border,
): BorderLayout {
	if (width <= 0) return { line: "", rightStart: 0, rightWidth: 0 };
	if (width === 1) return { line: border(leftCorner), rightStart: 1, rightWidth: 0 };

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = leftText && rightText ? 3 : 0;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const rightWidth = visibleWidth(rightText);
	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - rightWidth);
	return {
		line: `${border(leftCorner)}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border(rightCorner)}${RESET}`,
		rightStart: width - 1 - rightWidth,
		rightWidth,
	};
}

function fitHorizontalBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	leftCorner: string,
	rightCorner: string,
	fill: (text: string) => string = border,
): string {
	return layoutHorizontalBorder(left, right, width, border, leftCorner, rightCorner, fill).line;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "");
}

export function fastModeFromExtensionStatuses(statuses: ReadonlyMap<string, string>): boolean | null {
	const status = statuses.get(FAST_MODE_STATUS_KEY);
	if (status === undefined) return null;
	return stripAnsi(status).trim().toLowerCase() === "⚡ fast";
}

export function requestUsesFastMode(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
	const request = payload as Record<string, unknown>;
	return request.service_tier === "priority" || request.speed === "fast";
}

export interface LabelModel {
	id: string;
	reasoning: boolean;
}

export type MenuLabel = { id: string; label: string; clickable: boolean };

export function menuTarget(id: string): ChromeTarget {
	return `${MENU_TARGET_PREFIX}${id}`;
}

export function menuIdFromTarget(target: ChromeTarget): string | undefined {
	return target.startsWith(MENU_TARGET_PREFIX) ? target.slice(MENU_TARGET_PREFIX.length) : undefined;
}

export function modelLabelSegments(
	model: LabelModel,
	thinking: string,
	fastModeActive: boolean,
	menus: readonly MenuLabel[] = [],
): LabelSegment[] {
	const segments: LabelSegment[] = [];
	// Use a single-column text glyph so the TUI and terminal agree on border width.
	if (fastModeActive) segments.push({ text: "↯ • " });
	segments.push({ text: model.id, target: "model" });
	// Match Pi's footer: only reasoning models get a thinking segment, and "off" stays
	// visible so a click can turn thinking back on.
	if (model.reasoning) segments.push({ text: " • " }, { text: thinking === "off" ? "thinking off" : thinking, target: "thinking" });
	for (const menu of menus) {
		segments.push({ text: " • " }, { text: menu.label, ...(menu.clickable ? { target: menuTarget(menu.id) } : {}) });
	}
	return segments;
}

export function formatModelLabel(model: LabelModel, thinking: string, fastModeActive: boolean, menus: readonly MenuLabel[] = []): string {
	return modelLabelSegments(model, thinking, fastModeActive, menus).map((segment) => segment.text).join("");
}

/**
 * Column ranges (end exclusive) of clickable label segments laid out from `start`,
 * clipped to `limit` so truncated labels only expose their visible columns.
 */
export function labelHotspots(segments: LabelSegment[], row: number, start: number, limit: number): ChromeHotspot[] {
	const hotspots: ChromeHotspot[] = [];
	let column = start;
	for (const segment of segments) {
		const segmentStart = column;
		column += visibleWidth(segment.text);
		const end = Math.min(column, limit);
		if (segment.target && end > segmentStart) hotspots.push({ row, start: segmentStart, end, target: segment.target });
	}
	return hotspots;
}

export function chromeTargetAt(layout: ChromeLayout, x: number, y: number): ChromeTarget | undefined {
	return layout.hotspots.find((hotspot) => hotspot.row === y && x >= hotspot.start && x < hotspot.end)?.target;
}

// ---- Editor chrome popups ----

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function modelPopupItems(scoped: readonly ScopedModel[], current: ModelIdentity | undefined): SelectItem[] {
	const items: SelectItem[] = scoped.map(({ model, thinkingLevel }) => ({
		value: modelKey(model),
		label: `${current && sameModel(model, current) ? "✓ " : "  "}${model.id}`,
		description: thinkingLevel ? `${model.provider} · ${thinkingLevel}` : model.provider,
	}));
	items.push({ value: OTHER_MODELS_VALUE, label: "  Other…", description: "all models" });
	return items;
}

export function thinkingPopupItems(levels: readonly string[], current: string): SelectItem[] {
	return levels.map((level) => ({
		value: level,
		label: `${level === current ? "✓ " : "  "}${level}`,
		description: THINKING_LEVEL_DESCRIPTIONS[level],
	}));
}

/** Rows contributed by another extension, namespaced so they cannot collide with built-in values. */
export function menuPopupItems(menuId: string, items: readonly ChromeMenuItem[], current: string | undefined): SelectItem[] {
	return items.map((item) => ({
		value: menuItemValue(menuId, item.value),
		label: `${item.value === current ? "✓ " : "  "}${item.label}`,
		...(item.description !== undefined ? { description: item.description } : {}),
	}));
}

export function menuItemValue(menuId: string, value: string): string {
	return `${MENU_TARGET_PREFIX}${menuId}${MENU_VALUE_SEPARATOR}${value}`;
}

export function parseMenuItemValue(value: string): { menuId: string; value: string } | undefined {
	if (!value.startsWith(MENU_TARGET_PREFIX)) return undefined;
	const separator = value.indexOf(MENU_VALUE_SEPARATOR);
	if (separator === -1) return undefined;
	return { menuId: value.slice(MENU_TARGET_PREFIX.length, separator), value: value.slice(separator + 1) };
}

function widestLabel(items: readonly SelectItem[]): number {
	return Math.max(0, ...items.map((item) => visibleWidth(item.label)));
}

/** Total popup width including frame and padding, sized so no label or description truncates. */
export function popupWidth(items: readonly SelectItem[], maxWidth: number): number {
	const descriptions = Math.max(0, ...items.map((item) => visibleWidth(item.description ?? "")));
	// SelectList: two-column prefix, primary column with a two-column gap, description, two columns of slack.
	// It only renders descriptions when wider than 40 columns.
	const list = 2 + widestLabel(items) + 2 + descriptions + 2;
	const inner = descriptions > 0 ? Math.max(41, list) : list;
	return Math.min(maxWidth, inner + 2 + 2 * POPUP_PADDING_X);
}

export function popupRows(itemCount: number): number {
	return Math.min(itemCount, POPUP_MAX_ROWS) + (itemCount > POPUP_MAX_ROWS ? 1 : 0);
}

/** Place a popup above the editor frame with its right edge on the frame's right edge. */
export function popupPosition(
	anchor: { screenX: number; screenY: number; x: number; y: number },
	editorWidth: number,
	size: { width: number; height: number },
	terminal: { columns: number; rows: number },
	aboveScreenRow?: number,
): { row: number; col: number } {
	const editorLeft = anchor.screenX - anchor.x;
	const editorTop = anchor.screenY - anchor.y;
	return {
		row: Math.max(0, (aboveScreenRow ?? editorTop) - size.height),
		col: Math.max(0, Math.min(editorLeft + editorWidth - size.width, terminal.columns - size.width)),
	};
}

type PopupTheme = { fg(color: ThemeColor, text: string): string };

/** Same mapping as Pi's own selectors, but from the theme Pi hands extensions. */
function selectListTheme(theme: PopupTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

/** Where a pointer move landed on a popup. Cells beyond the top, left and right edges send no events. */
export type PopupPointer = "inside" | "edge";

/** What the editor chrome needs from any popup it opens. */
export interface ChromeOverlay extends Component {
	onPointer: ((at: PopupPointer) => void) | undefined;
	close(value?: string): void;
}

function popupPointerAt(event: TuiMouseEvent): PopupPointer {
	return event.x === 0 || event.y === 0 || event.x === event.width - 1 ? "edge" : "inside";
}

function framePopup(title: string, body: readonly string[], width: number, border: (text: string) => string, theme: PopupTheme): string[] {
	const inner = Math.max(1, width - 2 - 2 * POPUP_PADDING_X);
	const pad = " ".repeat(POPUP_PADDING_X);
	const lines = [fitHorizontalBorder(theme.fg("accent", ` ${title} `), "", width, border, "╭", "╮")];
	for (const line of body) lines.push(`${border("│")}${pad}${padAnsiLine(line, inner)}${pad}${border("│")}`);
	lines.push(fitHorizontalBorder("", "", width, border, "╰", "╯"));
	return lines;
}

/** Total width of a framed popup showing `lines` without truncation. */
export function infoPopupWidth(lines: readonly string[], maxWidth: number): number {
	return Math.min(maxWidth, Math.max(0, ...lines.map(visibleWidth)) + 2 + 2 * POPUP_PADDING_X);
}

/** Framed read-only lines rendered as a TUI overlay; rendered once per width, closes itself on blur or Escape. */
export class InfoPopup implements ChromeOverlay {
	private closed = false;
	private _focused = false;
	private rendered: { width: number; lines: string[] } | undefined;
	onPointer: ((at: PopupPointer) => void) | undefined;

	constructor(
		private readonly title: string,
		private readonly lines: readonly string[],
		private readonly border: (text: string) => string,
		private readonly theme: PopupTheme,
		private readonly done: () => void,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (!value) queueMicrotask(() => { if (!this._focused) this.close(); });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}

	render(width: number): string[] {
		if (this.rendered?.width !== width) this.rendered = { width, lines: framePopup(this.title, this.lines, width, this.border, this.theme) };
		return this.rendered.lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "move") this.onPointer?.(popupPointerAt(event));
		return { handled: true, render: false };
	}

	invalidate(): void {
		this.rendered = undefined;
	}
}

/** Framed single-column list rendered as a TUI overlay; closes itself on blur. */
export class ChromePopup implements ChromeOverlay {
	private readonly list: SelectList;
	private readonly rows: number;
	private closed = false;
	private _focused = false;
	/** Set by the owner to watch hover; the bottom edge borders the editor, which reports its own moves. */
	onPointer: ((at: PopupPointer) => void) | undefined;

	constructor(
		private readonly title: string,
		items: SelectItem[],
		preselect: string | undefined,
		private readonly border: (text: string) => string,
		private readonly theme: PopupTheme,
		private readonly done: (value: string | undefined) => void,
	) {
		const primary = widestLabel(items) + 2;
		this.list = new SelectList(items, Math.min(items.length, POPUP_MAX_ROWS), selectListTheme(theme), {
			minPrimaryColumnWidth: primary,
			maxPrimaryColumnWidth: primary,
		});
		this.rows = popupRows(items.length);
		const index = items.findIndex((item) => item.value === preselect);
		if (index !== -1) this.list.setSelectedIndex(index);
		this.list.onSelect = (item) => this.close(item.value);
		this.list.onCancel = () => this.close(undefined);
	}

	get focused(): boolean {
		return this._focused;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	set focused(value: boolean) {
		this._focused = value;
		// Clicking anywhere that takes focus dismisses the popup. Defer past the TUI's
		// focus bookkeeping, which is still running when this setter fires.
		if (!value) queueMicrotask(() => { if (!this._focused) this.close(undefined); });
	}

	close(value: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(value);
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2 - 2 * POPUP_PADDING_X);
		return framePopup(this.title, this.list.render(inner).slice(0, this.rows), width, this.border, this.theme);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "move") {
			this.onPointer?.(popupPointerAt(event));
			return { handled: true, render: false };
		}
		const inner = event.width - 2 - 2 * POPUP_PADDING_X;
		const x = event.x - 1 - POPUP_PADDING_X;
		const y = event.y - 1;
		if (x < 0 || x >= inner || y < 0 || y >= this.rows) return { handled: true, render: false };
		return this.list.handleMouse({ ...event, x, y, width: inner, height: this.rows }) ?? { handled: true, render: false };
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

/**
 * Map a mouse event on the HUD chrome back onto the editor it wraps: framed rows
 * sit one column right of the editor's own render, autocomplete rows below the
 * bottom border are not indented, and a fully wrapped editor is one row lower.
 */
export function translateChromeMouseEvent(event: TuiMouseEvent, layout: ChromeLayout): TuiMouseEvent {
	if (layout.bottomIndex === undefined) {
		return { ...event, x: event.x - EDITOR_GUTTER_WIDTH, y: event.y - 1, width: layout.innerWidth, height: layout.lineCount - 2 };
	}
	const framed = event.y <= layout.bottomIndex;
	return { ...event, x: framed ? event.x - EDITOR_GUTTER_WIDTH : event.x, width: layout.innerWidth, height: layout.lineCount };
}

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

function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return plain.includes("─") && /^[─ ↑↓0-9more]+$/.test(plain);
}

function findBottomBorderIndex(lines: string[]): number | undefined {
	for (let i = lines.length - 1; i > 0; i--) {
		if (isEditorBorderLine(lines[i] ?? "")) return i;
	}
	return undefined;
}

function scrollIndicator(line: string): string {
	return stripAnsi(line).match(/[↑↓] \d+ more/)?.[0] ?? "";
}

function parseGitShortstat(stdout: string): { added: number; removed: number } {
	const added = Number(stdout.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0);
	const removed = Number(stdout.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0);
	return { added, removed };
}

function formatDiffStats(added: number, removed: number, dirty: boolean): string {
	const parts: string[] = [];
	if (added > 0) parts.push(`${DIFF_GREEN}+${added}${RESET}`);
	if (removed > 0) parts.push(`${DIFF_RED}-${removed}${RESET}`);
	if (parts.length > 0) return ` ${parts.join(" ")}`;
	return dirty ? ` ${FG_DIM}~${RESET}` : "";
}

function muted(text: string, theme?: HudTheme): string {
	return theme?.fg ? theme.fg("muted", text) : `${FG_MUTED}${text}${RESET}`;
}

function textColor(text: string, theme?: HudTheme): string {
	return theme?.fg ? theme.fg("text", text) : `${FG_TEXT}${text}${RESET}`;
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

function parseSubscriptionUsageFromHeaders(provider: string | undefined, headers: Record<string, string>): SubscriptionUsage | null {
	if (provider === "anthropic") return parseAnthropicSubscriptionUsageFromHeaders(headers);
	if (provider === "openai-codex") return parseCodexSubscriptionUsageFromHeaders(headers);
	return null;
}

function formatResetCountdown(resetAtMs: number, now = Date.now()): string {
	const remainingMs = Math.max(0, resetAtMs - now);
	const totalHours = remainingMs === 0 ? 0 : Math.ceil(remainingMs / (60 * 60 * 1000));
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}d${String(hours).padStart(2, "0")}h`;
}

/** Countdown in hours and minutes for the 5-hour window, where days would be meaningless. */
export function formatShortCountdown(resetAtMs: number, now: number): string {
	const totalMinutes = Math.max(0, Math.ceil((resetAtMs - now) / (60 * 1000)));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * How far usage sits from a straight line through the window, in percentage points:
 * positive when more has been used than the elapsed share of the window (ahead), negative when less (behind).
 */
export function usagePace(window: UsageWindow, windowMs: number, now: number): number | undefined {
	if (!window.resetAtMs) return undefined;
	const elapsed = clamp(1 - (window.resetAtMs - now) / windowMs, 0, 1);
	return Math.round(window.usedPercent - elapsed * 100);
}

type UsagePopupTheme = { fg(color: ThemeColor, text: string): string };

/** One line per window: `Weekly: 38% used (12% ahead) | resets in 4d18h`, columns aligned across lines. */
export function usagePopupLines(usage: SubscriptionUsage, now: number, theme: UsagePopupTheme): string[] {
	const rows = [
		{ label: "Weekly:", window: usage, windowMs: ONE_WEEK_MS, countdown: formatResetCountdown },
		...(usage.fiveHour ? [{ label: "5h:", window: usage.fiveHour, windowMs: FIVE_HOURS_MS, countdown: formatShortCountdown }] : []),
	].map(({ label, window, windowMs, countdown }) => {
		const pace = usagePace(window, windowMs, now);
		const paceText = pace === undefined ? "" : pace === 0 ? "on pace" : `${Math.abs(pace)}% ${pace > 0 ? "ahead" : "behind"}`;
		const paceColor: ThemeColor = pace === undefined || pace === 0 ? "muted" : pace > 0 ? "error" : "success";
		return {
			label,
			used: `${String(Math.round(clamp(window.usedPercent, 0, 100))).padStart(3)}% used`,
			pace: paceText,
			paceColor,
			reset: window.resetAtMs ? `resets in ${countdown(window.resetAtMs, now)}` : "",
		};
	});
	const labelWidth = Math.max(...rows.map((row) => row.label.length));
	const paceWidth = Math.max(...rows.map((row) => row.pace.length + 2));
	return rows.map((row) => {
		let line = `${row.label.padEnd(labelWidth)} ${row.used}`;
		if (row.pace) line += ` (${theme.fg(row.paceColor, row.pace)})${" ".repeat(paceWidth - row.pace.length - 2)}`;
		if (row.reset) line += ` ${theme.fg("muted", `| ${row.reset}`)}`;
		return line;
	});
}

function formatUsageMetric(usage: SubscriptionUsage, theme?: HudTheme): string {
	const percentLeft = Math.round(clamp(100 - usage.usedPercent, 0, 100));
	return muted(`${percentLeft}% left`, theme);
}

function formatProviderDetail(provider: string, usage: SubscriptionUsage | null, theme?: HudTheme): string {
	if (!provider) return "";
	if (usage?.resetAtMs) {
		return muted(`${provider} weekly reset in ${formatResetCountdown(usage.resetAtMs)}  `, theme);
	}
	return muted(provider, theme);
}

function formatProviderDetailCompact(usage: SubscriptionUsage | null, theme?: HudTheme): string {
	return usage?.resetAtMs ? muted(`${formatResetCountdown(usage.resetAtMs)}  `, theme) : "";
}

function formatSessionCost(cost: number, theme?: HudTheme): string {
	const amount = Math.max(0, cost);
	const digits = amount < 1 ? 3 : 2;
	return muted(`$${amount.toFixed(digits)}`, theme);
}

function sessionCost(ctx: ExtensionContext | null): number {
	if (!ctx) return 0;
	try {
		const sessionManager = ctx.sessionManager as any;
		const entries: any[] = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
		return entries.reduce((total, entry) => {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") return total;
			return total + (numberFrom(entry.message.usage?.cost?.total) ?? 0);
		}, 0);
	} catch {
		return 0;
	}
}

function isUsingSubscriptionAuth(ctx: ExtensionContext | null): boolean {
	return Boolean(ctx?.model && ctx.modelRegistry.isUsingOAuth(ctx.model));
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

async function fetchCodexSubscriptionUsage(ctx: ExtensionContext): Promise<SubscriptionUsage | null> {
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

async function fetchAnthropicSubscriptionUsage(ctx: ExtensionContext): Promise<SubscriptionUsage | null> {
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

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let contextPercent: number | null = null;
	let contextTokens: number | null = null;
	let contextWindow = 0;
	let providerContextWindow = 0;
	let gitAdded = 0;
	let gitRemoved = 0;
	let gitDirty = false;
	let gitRefreshInFlight = false;
	let gitRefreshPending = false;
	let subscriptionProbeTimer: ReturnType<typeof setInterval> | null = null;
	let currentCtx: ExtensionContext | null = null;
	let firstUserText: string | null = null;
	let footerTui: TUI | null = null;
	let editorTui: TUI | null = null;
	let installedEditor: InstalledEditor | null = null;
	let latestSubscriptionUsage: SubscriptionUsage | null = null;
	let lastSubscriptionProbeAt = 0;
	let disposed = false;
	// Pi builds a fresh ExtensionContext per event, so async work compares this
	// generation instead of ctx identity to detect a replaced session.
	let sessionGeneration = 0;
	let autoCompactPolicy: AutoCompactPolicySnapshot | null = null;
	let lastRequestUsedFastMode = false;
	let extensionFastModeActive: boolean | null = null;

	function selectedModelIdentity(ctx: ExtensionContext | null): ModelIdentity | undefined {
		const model = ctx?.model;
		return model ? { api: model.api, provider: model.provider, id: model.id } : undefined;
	}

	const unregisterAutoCompactPolicy = pi.events.on(AUTO_COMPACT_POLICY_EVENT, (data) => {
		const snapshot = parseAutoCompactPolicySnapshot(data);
		const currentModel = selectedModelIdentity(currentCtx);
		if (!snapshot || !currentModel || !sameModel(snapshot.model, currentModel)) return;
		autoCompactPolicy = snapshot;
		refreshContext();
		requestChromeRender();
	});

	function requestAutoCompactPolicy(ctx: ExtensionContext) {
		autoCompactPolicy = null;
		const model = selectedModelIdentity(ctx);
		if (!model) return;
		pi.events.emit(AUTO_COMPACT_POLICY_REQUEST_EVENT, { protocolVersion: 1, model });
	}

	// Menus other extensions add to the input border; see chrome-menu.ts for the protocol.
	const chromeMenus = new Map<string, ChromeMenu>();
	const unregisterChromeMenus = pi.events.on(CHROME_MENU_EVENT, (data) => {
		const menu = parseChromeMenu(data);
		if (!menu) return;
		if ("remove" in menu) chromeMenus.delete(menu.id);
		else chromeMenus.set(menu.id, menu);
		requestChromeRender();
	});

	function chromeMenuLabels(): MenuLabel[] {
		const labels: MenuLabel[] = [];
		for (const menu of chromeMenus.values()) {
			if (menu.label) labels.push({ id: menu.id, label: menu.label, clickable: typeof menu.items === "function" || (menu.items?.length ?? 0) > 0 });
		}
		return labels;
	}

	function chromeMenuExtensions(extend: ChromeMenuExtend): SelectItem[] {
		const items: SelectItem[] = [];
		for (const menu of chromeMenus.values()) {
			if (menu.extend !== extend) continue;
			const resolved = resolveChromeMenu(menu);
			items.push(...menuPopupItems(menu.id, resolved.items, resolved.current));
		}
		return items;
	}

	function isStaleExtensionError(err: unknown): boolean {
		const message = err instanceof Error ? err.message : String(err ?? "");
		return message.includes("stale after session replacement");
	}

	function refreshContext(ctx: ExtensionContext | null = currentCtx) {
		if (!ctx) return;

		if (!firstUserText) firstUserText = extractFirstUserText(ctx);

		const usage = ctx.getContextUsage();
		providerContextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		contextTokens = usage?.tokens ?? null;
		contextWindow = effectiveContextWindow(providerContextWindow, autoCompactPolicy?.thresholdTokens);
		contextPercent = effectiveContextPercent(
			usage?.percent ?? null,
			contextTokens,
			providerContextWindow,
			contextWindow,
		);
	}

	function clearSubscriptionProbe() {
		if (!subscriptionProbeTimer) return;
		clearInterval(subscriptionProbeTimer);
		subscriptionProbeTimer = null;
	}

	function updateSubscriptionUsage(usage: SubscriptionUsage | null | undefined) {
		if (!usage) return;
		latestSubscriptionUsage = usage;
		requestChromeRender();
	}

	async function refreshSubscriptionUsage(ctx: ExtensionContext | null = currentCtx, force = false) {
		const provider = ctx?.model?.provider;
		if (
			!ctx ||
			disposed ||
			!SUPPORTED_SUBSCRIPTION_USAGE_PROVIDERS.has(provider ?? "") ||
			!isUsingSubscriptionAuth(ctx) ||
			(!force && Date.now() - lastSubscriptionProbeAt < SUBSCRIPTION_USAGE_PROBE_MIN_INTERVAL_MS)
		) return;

		lastSubscriptionProbeAt = Date.now();
		const generation = sessionGeneration;
		const usage = await (provider === "anthropic"
			? fetchAnthropicSubscriptionUsage(ctx)
			: fetchCodexSubscriptionUsage(ctx)
		).catch(() => null);
		// A probe started before a model switch must not overwrite the new provider's quota.
		if (disposed || generation !== sessionGeneration || provider !== currentCtx?.model?.provider) return;
		updateSubscriptionUsage(usage);
	}

	async function refreshGit(ctx: ExtensionContext | null = currentCtx) {
		if (!ctx || disposed) return;
		if (gitRefreshInFlight) {
			gitRefreshPending = true;
			return;
		}

		gitRefreshInFlight = true;
		const generation = sessionGeneration;
		try {
			const cwd = ctx.cwd;
			const configResult = await pi.exec(
				"git",
				["config", "--local", "--get", "filter.git-crypt.clean"],
				{ cwd, timeout: GIT_COMMAND_TIMEOUT_MS },
			).catch(() => undefined);
			if (disposed || generation !== sessionGeneration) return;
			const dirtyOnly = configResult?.code === 0 && Boolean(configResult.stdout.trim());

			const statusPromise = pi.exec(
				"git",
				["status", "--porcelain"],
				{ cwd, timeout: GIT_COMMAND_TIMEOUT_MS },
			).catch(() => undefined);
			const diffPromise = dirtyOnly
				? Promise.resolve(undefined)
				: pi.exec(
					"git",
					["diff", "--shortstat", "HEAD"],
					{ cwd, timeout: GIT_COMMAND_TIMEOUT_MS },
				).catch(() => undefined);
			const [statusResult, diffResult] = await Promise.all([statusPromise, diffPromise]);

			if (disposed || generation !== sessionGeneration) return;
			const valid = statusResult?.code === 0 && (dirtyOnly || diffResult?.code === 0);
			const parsed = valid ? parseGitShortstat(diffResult?.stdout ?? "") : { added: 0, removed: 0 };
			gitAdded = parsed.added;
			gitRemoved = parsed.removed;
			gitDirty = valid && Boolean(statusResult?.stdout.trim());
			footerTui?.requestRender();
		} finally {
			gitRefreshInFlight = false;
			const refreshAgain = gitRefreshPending;
			gitRefreshPending = false;
			if (refreshAgain && !disposed) void refreshGit();
		}
	}

	function currentModelLabelSegments(): LabelSegment[] {
		const model = currentCtx?.model;
		if (!model) return [];
		const fastModeActive = extensionFastModeActive ?? lastRequestUsedFastMode;
		return modelLabelSegments(model, pi.getThinkingLevel(), fastModeActive, chromeMenuLabels());
	}

	function syncExtensionStatuses(footerData: ReadonlyFooterDataProvider): string[] {
		const statuses = footerData.getExtensionStatuses();
		const observedFastMode = fastModeFromExtensionStatuses(statuses);
		const previousFastMode = extensionFastModeActive;
		if (observedFastMode !== null) extensionFastModeActive = observedFastMode;
		else if (extensionFastModeActive !== null) extensionFastModeActive = false;
		if (extensionFastModeActive !== previousFastMode) editorTui?.requestRender();

		return [...statuses.entries()]
			.filter(([key, value]) => value && (key !== FAST_MODE_STATUS_KEY || observedFastMode !== true))
			.map(([, value]) => normalizeText(value));
	}

	function updateFastModeObservation(next: boolean) {
		if (next === lastRequestUsedFastMode) return;
		lastRequestUsedFastMode = next;
		if (!disposed) editorTui?.requestRender();
	}

	function currentSubscriptionUsage(): SubscriptionUsage | null {
		if (!currentCtx || !isUsingSubscriptionAuth(currentCtx) || !latestSubscriptionUsage) return null;
		return currentCtx.model?.provider === latestSubscriptionUsage.provider ? latestSubscriptionUsage : null;
	}

	/** Bottom-right label: subscription quota (clickable, it has a popup) or session cost on API-key billing. */
	function inputUsageSegments(theme: HudTheme): LabelSegment[] {
		const subscriptionUsage = currentSubscriptionUsage();
		if (subscriptionUsage) return [{ text: formatUsageMetric(subscriptionUsage, theme), target: "usage" }];
		if (!isUsingSubscriptionAuth(currentCtx)) return [{ text: formatSessionCost(sessionCost(currentCtx), theme) }];
		return [];
	}

	function joinFooterDetails(parts: string[], theme?: HudTheme): string {
		return parts.filter(Boolean).join(` ${muted("•", theme)} `);
	}

	/**
	 * Right side of the footer: the HUD's own provider detail, preceded by the extension statuses
	 * that fit beside it, in order. Statuses are ancillary and must not push the detail out.
	 */
	function footerRight(statuses: string[], detail: string, left: string, width: number, theme?: HudTheme): string {
		const room = width - visibleWidth(left) - 1;
		const kept: string[] = [];
		for (const status of statuses) {
			if (visibleWidth(joinFooterDetails([...kept, status, detail], theme)) <= room) kept.push(status);
		}
		return joinFooterDetails([...kept, detail], theme);
	}

	function requestChromeRender() {
		footerTui?.requestRender();
		editorTui?.requestRender();
	}

	function renderFooter(
		width: number,
		footerData: ReadonlyFooterDataProvider,
		theme?: HudTheme,
	): string[] {
		if (disposed) return [""];
		try {
			refreshContext();
			const extensionStatuses = syncExtensionStatuses(footerData);

			const band = contextBand(contextPercent, contextTokens, providerContextWindow);
			const color = contextColor(band);
			const pct = contextPercent === null ? "?" : `${Math.round(contextPercent)}%`;
			const tokUsed = contextTokens === null ? "?" : fmtTokens(contextTokens);
			const capIndicator = isContextWindowCapped(providerContextWindow, contextWindow) ? muted("↓", theme) : "";
			const tokWindow = `${fmtTokens(contextWindow)}${capIndicator}`;
			const contextFull = `${contextBar(contextPercent, band)} ${color}${pct} ${tokUsed}/${tokWindow}${RESET}`;
			const contextCompact = `${contextBar(contextPercent, band)} ${color}${pct} ${tokUsed}${RESET}`;

			const cwd = currentCtx?.cwd ?? process.cwd();
			const branch = footerData.getGitBranch();
			const diffStats = formatDiffStats(gitAdded, gitRemoved, gitDirty);
			const location = `${displayPath(cwd)}${branch ? ` (${branch})` : ""}${diffStats}`;
			const locationCompact = branch ? `(${branch})${diffStats}` : (diffStats.trim() || displayPath(cwd));
			const sessionName = normalizeText(pi.getSessionName() ?? "");
			const isFallbackSessionLabel = !sessionName && Boolean(firstUserText);
			const sessionLabelRaw = sessionName || (firstUserText ? firstWords(firstUserText) : "");
			const sessionLabel = sessionLabelRaw
				? isFallbackSessionLabel ? muted(sessionLabelRaw, theme) : textColor(sessionLabelRaw, theme)
				: "";
			const divider = muted("│", theme);
			const sessionDivider = muted("|", theme);
			const gutter = " ".repeat(FOOTER_GUTTER_WIDTH);
			const fullLeftBase = `${gutter}${contextFull} ${divider} ${location}`;
			const compactLeftBase = `${gutter}${contextCompact} ${divider} ${location}`;
			const fullLeft = sessionLabel ? `${fullLeftBase} ${sessionDivider} ${sessionLabel}` : fullLeftBase;
			const compactLeft = sessionLabel ? `${compactLeftBase} ${sessionDivider} ${sessionLabel}` : compactLeftBase;
			const subscriptionUsage = currentSubscriptionUsage();
			const detailFull = formatProviderDetail(currentCtx?.model?.provider ?? "", subscriptionUsage, theme);
			const detailCompact = formatProviderDetailCompact(subscriptionUsage, theme);
			const line = (left: string, detail: string) =>
				fitLeftRight(left, footerRight(extensionStatuses, detail, left, width, theme), width);

			if (fitsLeftRight(fullLeft, detailFull, width)) return [line(fullLeft, detailFull)];
			if (fitsLeftRight(compactLeft, detailCompact, width)) return [line(compactLeft, detailCompact)];
			if (fitsLeftRight(compactLeftBase, detailCompact, width)) return [line(compactLeftBase, detailCompact)];
			if (visibleFits(compactLeft, width)) return [fitLine(compactLeft, width)];
			if (visibleFits(compactLeftBase, width)) {
				return sessionLabel
					? [fitLine(compactLeftBase, width), fitLine(`${gutter}${sessionLabel}`, width)]
					: [fitLine(compactLeftBase, width)];
			}

			const lines = [fitLine(`${gutter}${contextCompact}`, width), fitLine(`${gutter}${locationCompact}`, width)];
			if (sessionLabel) lines.push(fitLine(`${gutter}${sessionLabel}`, width));
			return lines;
		} catch (err) {
			if (isStaleExtensionError(err)) return [""];
			throw err;
		}
	}

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		sessionGeneration++;
		currentCtx = ctx;
		firstUserText = null;
		lastRequestUsedFastMode = false;
		extensionFastModeActive = null;
		refreshContext(ctx);
		requestAutoCompactPolicy(ctx);
		pi.events.emit(CHROME_MENU_REQUEST_EVENT, { protocolVersion: 1 });

		disposed = false;
		gitRefreshPending = false;
		void refreshGit(ctx);
		clearSubscriptionProbe();
		latestSubscriptionUsage = null;
		void refreshSubscriptionUsage(ctx, true);
		subscriptionProbeTimer = setInterval(() => {
			void refreshSubscriptionUsage();
		}, SUBSCRIPTION_USAGE_PROBE_INTERVAL_MS);
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				render: (width: number) => renderFooter(width, footerData, theme),
				invalidate() {},
				dispose() {
					disposed = true;
					footerTui = null;
					clearSubscriptionProbe();
					unsubscribeBranch();
				},
			};
		});

		const previousFactory = ctx.ui.getEditorComponent();
		let editorActive = true;
		// Set by the editor factory so disabling the chrome also takes its popup down.
		let dismissPopup: (() => void) | null = null;
		const editorFactory: EditorFactory = (tui, theme, keybindings) => {
			editorTui = tui;
			const hudTheme = ctx.ui.theme;
			const editor = previousFactory?.(tui, theme, keybindings)
				?? new CustomEditor(tui, theme, keybindings, { paddingX: EDITOR_GUTTER_WIDTH });
			const renderEditor = editor.render.bind(editor);
			const handleEditorMouse = editor.handleMouse?.bind(editor);
			const actionHandlers = "actionHandlers" in editor && editor.actionHandlers instanceof Map
				? editor.actionHandlers as Map<AppKeybinding, () => void>
				: undefined;
			const setPaddingX = editor.setPaddingX?.bind(editor);
			if (setPaddingX) {
				editor.setPaddingX = (padding) => setPaddingX(Math.max(EDITOR_GUTTER_WIDTH, padding));
				editor.setPaddingX(EDITOR_GUTTER_WIDTH);
			}
			let chromeLayout: ChromeLayout | null = null;
			let hotspotPressed = false;
			// A hover popup shows without focus and follows the pointer; a click on its label
			// pins it (focus, keyboard navigation) until it is dismissed.
			let activePopup: { target: ChromeTarget; pinned: boolean; close: () => void; pin: () => void } | null = null;
			let hoverOpen: { target: ChromeTarget; timer: ReturnType<typeof setTimeout> } | undefined;
			let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined;

			function chromeTargetForEvent(layout: ChromeLayout, event: TuiMouseEvent): ChromeTarget | undefined {
				return event.button === "left" ? chromeTargetAt(layout, event.x, event.y) : undefined;
			}

			function cancelHoverOpen() {
				if (hoverOpen) clearTimeout(hoverOpen.timer);
				hoverOpen = undefined;
			}

			function cancelHoverLeave() {
				if (hoverLeaveTimer !== undefined) clearTimeout(hoverLeaveTimer);
				hoverLeaveTimer = undefined;
			}

			function closeHoverPopup() {
				cancelHoverLeave();
				if (activePopup && !activePopup.pinned) activePopup.close();
			}

			function launchPopup(target: ChromeTarget, event: TuiMouseEvent, layout: ChromeLayout, pinned: boolean) {
				// Nothing awaits a mouse handler, so report failures instead of leaking a rejection.
				openChromePopup(target, event, layout, pinned).catch((err: unknown) => {
					if (!isStaleExtensionError(err)) currentCtx?.ui.notify(err instanceof Error ? err.message : String(err), "error");
				});
			}

			/** Pointer moved over the editor: open, swap or dismiss hover popups. */
			function handleChromeHover(target: ChromeTarget | undefined, event: TuiMouseEvent, layout: ChromeLayout) {
				if (!target) {
					cancelHoverOpen();
					closeHoverPopup();
					return;
				}
				cancelHoverLeave();
				if (activePopup?.pinned) return;
				if (activePopup?.target === target) {
					cancelHoverOpen();
					return;
				}
				if (hoverOpen?.target === target) return;
				cancelHoverOpen();
				// Another extension's dialog may be up; hovering must not stack a popup on it.
				if (!activePopup && tui.hasOverlay()) return;
				const timer = setTimeout(() => {
					hoverOpen = undefined;
					if (!editorActive || !chromeLayout || activePopup?.pinned) return;
					activePopup?.close();
					launchPopup(target, event, layout, false);
				}, HOVER_OPEN_DELAY_MS);
				hoverOpen = { target, timer };
			}

			/** Pointer moved over the popup itself; only its top, left and right edges lead off-screen for us. */
			function handlePopupPointer(at: PopupPointer) {
				cancelHoverOpen();
				cancelHoverLeave();
				if (at === "edge" && activePopup && !activePopup.pinned) {
					hoverLeaveTimer = setTimeout(() => {
						hoverLeaveTimer = undefined;
						closeHoverPopup();
					}, HOVER_LEAVE_DELAY_MS);
				}
			}

			function openAllModelsSelector() {
				actionHandlers?.get(MODEL_SELECT_ACTION)?.();
				// Pi opens its selector on the scoped list when a scope is configured; the
				// popup already covered that list, so switch to "all" as its Tab key does.
				// getFocusedComponent is on Pi's TUI class but not the TUI interface; setScope is
				// the selector's own method. Either missing simply leaves the scoped list open.
				const focused = (tui as { getFocusedComponent?: () => unknown }).getFocusedComponent?.();
				const selector = focused as { setScope?: (scope: "all" | "scoped") => void } | null | undefined;
				selector?.setScope?.("all");
			}

			type PopupSpec = { title: string; items: SelectItem[]; preselect: string | undefined };

			function popupSpec(target: ChromeTarget, ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): PopupSpec | undefined {
				const menuId = menuIdFromTarget(target);
				if (menuId !== undefined) {
					const menu = chromeMenus.get(menuId);
					if (!menu) return undefined;
					const resolved = resolveChromeMenu(menu);
					if (resolved.items.length === 0) return undefined;
					return {
						title: menu.title ?? menu.label ?? menu.id,
						items: menuPopupItems(menu.id, resolved.items, resolved.current),
						preselect: resolved.current === undefined ? undefined : menuItemValue(menu.id, resolved.current),
					};
				}
				const thinking = pi.getThinkingLevel();
				const builtIn: ChromeMenuExtend = target === "model" ? "model" : "thinking";
				const items = builtIn === "model"
					? modelPopupItems(ctx.scopedModels, model)
					: thinkingPopupItems(getSupportedThinkingLevels(model), thinking);
				items.push(...chromeMenuExtensions(builtIn));
				return { title: builtIn === "model" ? "Model" : "Thinking", items, preselect: builtIn === "model" ? modelKey(model) : thinking };
			}

			async function applyPopupChoice(target: ChromeTarget, value: string, ctx: ExtensionContext): Promise<void> {
				const contributed = parseMenuItemValue(value);
				if (contributed) {
					await chromeMenus.get(contributed.menuId)?.onSelect?.(contributed.value);
					return;
				}
				if (target === "thinking") {
					pi.setThinkingLevel(value as ThinkingLevel);
					return;
				}
				if (value === OTHER_MODELS_VALUE) {
					openAllModelsSelector();
					return;
				}
				const picked = ctx.scopedModels.find((entry) => modelKey(entry.model) === value);
				if (!picked) return;
				if (!(await pi.setModel(picked.model))) {
					ctx.ui.notify(`No credentials configured for ${picked.model.provider}`, "error");
					return;
				}
				// A scope entry like provider/id:high carries its own level, as Pi's model cycling applies it.
				if (picked.thinkingLevel) pi.setThinkingLevel(picked.thinkingLevel);
			}

			async function openChromePopup(target: ChromeTarget, event: TuiMouseEvent, layout: ChromeLayout, pinned: boolean): Promise<void> {
				const ctx = currentCtx;
				const model = ctx?.model;
				if (!ctx || !model) return;
				if (target === "model" && ctx.scopedModels.length === 0) {
					// No scope configured: Pi's selector already opens on all models. Only a click goes there.
					if (pinned) actionHandlers?.get(MODEL_SELECT_ACTION)?.();
					return;
				}
				const border = editor.borderColor?.bind(editor) ?? ((text: string) => hudTheme.fg("accent", text));
				let width: number;
				let height: number;
				let create: (done: (value: string | undefined) => void) => ChromeOverlay;
				if (target === "usage") {
					const usage = currentSubscriptionUsage();
					if (!usage) return;
					const lines = usagePopupLines(usage, Date.now(), hudTheme);
					width = infoPopupWidth(lines, tui.terminal.columns);
					height = lines.length + 2;
					create = (done) => new InfoPopup("Usage", lines, border, hudTheme, () => done(undefined));
				} else {
					const spec = popupSpec(target, ctx, model);
					if (!spec) return;
					width = popupWidth(spec.items, tui.terminal.columns);
					height = popupRows(spec.items.length) + 2;
					create = (done) => new ChromePopup(spec.title, spec.items, spec.preselect, border, hudTheme, done);
				}
				// Model and thinking popups sit above the frame. Usage is targeted from the
				// bottom border, so keep its popup adjacent even when a narrow editor wraps.
				const { row, col } = popupPosition(
					event,
					layout.width,
					{ width, height },
					tui.terminal,
					target === "usage" ? event.screenY : undefined,
				);

				let popup: ChromeOverlay | undefined;
				const choice = ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
					popup = create(done);
					popup.onPointer = handlePopupPointer;
					return popup;
				}, { overlay: true, overlayOptions: { row, col, width, nonCapturing: !pinned } });
				const opened = {
					target,
					pinned,
					close: () => popup?.close(),
					pin: () => {
						opened.pinned = true;
						cancelHoverLeave();
						if (popup) tui.setFocus(popup);
					},
				};
				activePopup = opened;
				let value: string | undefined;
				try {
					value = await choice;
				} finally {
					if (activePopup === opened) activePopup = null;
				}
				if (value !== undefined) await applyPopupChoice(target, value, ctx);
			}

			editor.handleMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
				const layout = chromeLayout;
				if (!editorActive || !layout || layout.width !== event.width) return handleEditorMouse?.(event);

				// Own the whole gesture from a hotspot press so the wrapped editor cannot
				// capture it first; Pi synthesizes the click on release at the same cell.
				if (event.type === "press" && chromeTargetForEvent(layout, event)) {
					hotspotPressed = true;
					return { handled: true };
				}
				if (hotspotPressed && (event.type === "drag" || event.type === "release")) {
					hotspotPressed = event.type === "drag";
					return { handled: true, render: false };
				}
				if (event.type === "move") {
					const target = chromeTargetAt(layout, event.x, event.y);
					handleChromeHover(target, event, layout);
					if (target) return { handled: true, render: false };
				} else if (event.type === "click") {
					const target = chromeTargetForEvent(layout, event);
					if (target) {
						cancelHoverOpen();
						// A hotspot press does not move focus, so an open popup survives until here:
						// a hover popup pins, a pinned one toggles closed, the other label swaps.
						const open = activePopup;
						if (open?.target === target && !open.pinned) {
							open.pin();
							return { handled: true };
						}
						open?.close();
						if (open?.target !== target) launchPopup(target, event, layout, true);
						return { handled: true };
					}
				}
				return handleEditorMouse?.(translateChromeMouseEvent(event, layout));
			};

			dismissPopup = () => {
				cancelHoverOpen();
				cancelHoverLeave();
				activePopup?.close();
			};

			// Typing while a hover popup is up means the pointer merely rests there; get out of the way.
			const handleEditorInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				cancelHoverOpen();
				closeHoverPopup();
				return handleEditorInput(data);
			};


			editor.render = (width: number): string[] => {
				if (!editorActive || width < 4) {
					chromeLayout = null;
					return renderEditor(width);
				}

				try {
					const innerWidth = Math.max(1, width - 2);
					const lines = renderEditor(innerWidth);
					const border = editor.borderColor?.bind(editor) ?? ((text: string) => hudTheme.fg("accent", text));
					const bottomIndex = isEditorBorderLine(lines[0] ?? "")
						? findBottomBorderIndex(lines)
						: undefined;
					const topIndicator = bottomIndex === undefined ? "" : scrollIndicator(lines[0] ?? "");
					const bottomIndicator = bottomIndex === undefined ? "" : scrollIndicator(lines[bottomIndex] ?? "");
					const labelSegments = currentModelLabelSegments();
					const modelLabel = labelSegments.map((segment) => segment.text).join("");
					const usageSegments = inputUsageSegments(hudTheme);
					const usageMetric = usageSegments.map((segment) => segment.text).join("");
					const topLeft = topIndicator ? hudTheme.fg("dim", ` ${topIndicator} `) : "";
					const bottomLeft = bottomIndicator ? hudTheme.fg("dim", ` ${bottomIndicator} `) : "";
					const topRight = modelLabel ? hudTheme.fg("accent", ` ${modelLabel} `) : "";
					const bottomRight = usageMetric ? ` ${usageMetric} ` : "";
					const top = layoutHorizontalBorder(topLeft, topRight, width, border, "╭", "╮");
					const bottom = layoutHorizontalBorder(bottomLeft, bottomRight, width, border, "╰", "╯");
					const rendered = [top.line];

					for (let i = bottomIndex === undefined ? 0 : 1; i < lines.length; i++) {
						const line = lines[i] ?? "";
						if (i === bottomIndex) {
							rendered.push(bottom.line);
						} else if (bottomIndex !== undefined && i > bottomIndex) {
							rendered.push(fitLine(line, width));
						} else {
							rendered.push(`${border("│")}${padAnsiLine(line, innerWidth)}${border("│")}`);
						}
					}
					const bottomRow = bottomIndex ?? rendered.length;
					if (bottomIndex === undefined) rendered.push(bottom.line);

					// Each label sits one column after rightStart (its leading pad) and ends before the corner.
					chromeLayout = {
						width,
						innerWidth,
						bottomIndex,
						lineCount: rendered.length,
						hotspots: [
							...labelHotspots(labelSegments, 0, top.rightStart + 1, top.rightStart + top.rightWidth),
							...labelHotspots(usageSegments, bottomRow, bottom.rightStart + 1, bottom.rightStart + bottom.rightWidth),
						],
					};
					return rendered;
				} catch (err) {
					chromeLayout = null;
					if (isStaleExtensionError(err)) return renderEditor(width);
					throw err;
				}
			};
			return editor;
		};
		installedEditor = {
			factory: editorFactory,
			previousFactory,
			disable: () => {
				editorActive = false;
				dismissPopup?.();
			},
		};
		ctx.ui.setEditorComponent(editorFactory);
	}

	function refreshAndRender(ctx: ExtensionContext) {
		currentCtx = ctx;
		refreshContext(ctx);
		requestChromeRender();
	}

	pi.on("session_start", async (_event, ctx) => { install(ctx); });
	pi.on("session_shutdown", async () => {
		unregisterAutoCompactPolicy();
		unregisterChromeMenus();
		sessionGeneration++;
		disposed = true;
		clearSubscriptionProbe();
		installedEditor?.disable();
		installedEditor = null;
		footerTui = null;
		editorTui = null;
	});
	pi.on("agent_start", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("before_provider_request", (event, ctx) => {
		currentCtx = ctx;
		updateFastModeObservation(requestUsesFastMode(event.payload));
	});
	pi.on("agent_end", async (_event, ctx) => {
		refreshAndRender(ctx);
		void refreshGit(ctx);
		void refreshSubscriptionUsage(ctx);
	});
	pi.on("after_provider_response", async (event, ctx) => {
		currentCtx = ctx;
		const usage = parseSubscriptionUsageFromHeaders(ctx.model?.provider, event.headers);
		updateSubscriptionUsage(usage);
	});
	pi.on("tool_call", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("tool_result", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("turn_end", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("thinking_level_select", async () => { requestChromeRender(); });
	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		lastRequestUsedFastMode = false;
		refreshContext(ctx);
		requestAutoCompactPolicy(ctx);
		if (latestSubscriptionUsage?.provider !== ctx.model?.provider) latestSubscriptionUsage = null;
		void refreshSubscriptionUsage(ctx, true);
		requestChromeRender();
	});

	async function toggleSessionHud(ctx: ExtensionContext) {
		enabled = !enabled;
		if (enabled) {
			install(ctx);
			ctx.ui.notify("Session HUD enabled", "info");
		} else {
			sessionGeneration++;
			disposed = true;
			clearSubscriptionProbe();
			footerTui = null;
			editorTui = null;
			ctx.ui.setFooter(undefined);
			installedEditor?.disable();
			if (installedEditor && ctx.ui.getEditorComponent() === installedEditor.factory) {
				ctx.ui.setEditorComponent(installedEditor.previousFactory);
			}
			installedEditor = null;
			ctx.ui.notify("Session HUD disabled", "info");
		}
	}

	pi.registerCommand("hud", {
		description: "Toggle the session HUD",
		handler: async (_args, ctx) => {
			await toggleSessionHud(ctx);
		},
	});

	pi.registerCommand("status", {
		description: "Toggle the session HUD (alias for /hud)",
		handler: async (_args, ctx) => {
			await toggleSessionHud(ctx);
		},
	});

	pi.registerCommand("header", {
		description: "Toggle the session HUD (alias for /hud)",
		handler: async (_args, ctx) => {
			await toggleSessionHud(ctx);
		},
	});
}
