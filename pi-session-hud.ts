/**
 * Pi Session HUD — a compact context footer plus Amp-style editor chrome.
 *
 * Shows:
 *   ╭──────────────────────────────────────── gpt-5.5 • xhigh ╮
 *   │ prompt text wraps inside a one-column gutter              │
 *   ╰───────────────────────────────────────── (openai-codex) ╯
 *    ██░░░░ 36% 98k/272k │ ~/projects/pi-session-hud (main) +12 -3 | Simplify HUD…
 *
 * Minimal footer output: context usage, cwd/branch, git diff stats, and session.
 * The editor border carries model/thinking at the top and provider at the bottom.
 *
 * Install:
 *   - pi install npm:@tmustier/pi-session-hud
 *   - or copy/symlink pi-session-hud.ts into ~/.pi/agent/extensions/
 * Toggle: /hud (aliases: /status, /header)
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "pi-session-hud";
const LEGACY_WIDGET_ID = "pi-status-bar";
const CONTEXT_BAR_WIDTH = 6;
const SESSION_FALLBACK_WORDS = 8;
const EDITOR_GUTTER_WIDTH = 1;
const FOOTER_GUTTER_WIDTH = EDITOR_GUTTER_WIDTH;

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

type ContextBand = "healthy" | "yellow" | "amber" | "red";
type HudTheme = {
	fg?: (color: string, text: string) => string;
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

function contextBand(percent: number | null, tokens: number | null, contextWindow: number): ContextBand {
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

function padAnsiLine(line: string, width: number): string {
	if (width <= 0) return "";
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, "…", false) : line;
	return `${fitted}${RESET}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
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
	if (width <= 0) return "";
	if (width === 1) return border(leftCorner);

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

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border(leftCorner)}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border(rightCorner)}${RESET}`;
}

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[\s\S]*?(?:\x07|\x1b\\)/g, "");
}

function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return plain.includes("─") && /^[─ ↑↓0-9more]+$/.test(plain);
}

function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i > 0; i--) {
		if (isEditorBorderLine(lines[i] ?? "")) return i;
	}
	return lines.length - 1;
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

function styleSessionLabel(label: string, isFallback: boolean, theme?: HudTheme): string {
	return isFallback ? muted(label, theme) : textColor(label, theme);
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let contextPercent: number | null = null;
	let contextTokens: number | null = null;
	let contextWindow = 0;
	let gitAdded = 0;
	let gitRemoved = 0;
	let gitDirty = false;
	let gitPollTimer: ReturnType<typeof setInterval> | null = null;
	let editorInstallTimer: ReturnType<typeof setTimeout> | null = null;
	let currentCtx: ExtensionContext | null = null;
	let firstUserText: string | null = null;
	let footerTui: TUI | null = null;
	let editorTui: TUI | null = null;
	let disposed = false;

	function isStaleExtensionError(err: unknown): boolean {
		const message = err instanceof Error ? err.message : String(err ?? "");
		return message.includes("stale after session replacement");
	}

	function refreshContext(ctx: ExtensionContext | null = currentCtx) {
		if (!ctx) return;

		if (!firstUserText) firstUserText = extractFirstUserText(ctx);

		const usage = ctx.getContextUsage();
		if (usage) {
			contextPercent = usage.percent;
			contextTokens = usage.tokens;
			contextWindow = usage.contextWindow;
		} else {
			contextPercent = null;
			contextTokens = null;
			contextWindow = ctx.model?.contextWindow ?? 0;
		}
	}

	function clearGitPoll() {
		if (!gitPollTimer) return;
		clearInterval(gitPollTimer);
		gitPollTimer = null;
	}

	function clearEditorInstallTimer() {
		if (!editorInstallTimer) return;
		clearTimeout(editorInstallTimer);
		editorInstallTimer = null;
	}

	async function refreshGit(ctx: ExtensionContext | null = currentCtx) {
		if (!ctx || disposed) return;

		try {
			const cwd = ctx.cwd;
			const [diffResult, statusResult] = await Promise.all([
				pi.exec("git", ["diff", "--shortstat", "HEAD"], { cwd, timeout: 2000 }).catch(() => undefined),
				pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 2000 }).catch(() => undefined),
			]);

			if (disposed || ctx !== currentCtx) return;
			if (diffResult?.code !== 0 || statusResult?.code !== 0) {
				gitAdded = 0;
				gitRemoved = 0;
				gitDirty = false;
				footerTui?.requestRender();
				return;
			}

			const parsed = parseGitShortstat(diffResult?.stdout ?? "");
			gitAdded = parsed.added;
			gitRemoved = parsed.removed;
			gitDirty = Boolean(statusResult?.stdout.trim());
			footerTui?.requestRender();
		} catch (err) {
			if (isStaleExtensionError(err)) return;
			throw err;
		}
	}

	function startGitPoll(ctx: ExtensionContext) {
		clearGitPoll();
		void refreshGit(ctx);
		gitPollTimer = setInterval(() => { void refreshGit(); }, 10_000);
	}

	function currentModelLabel(): string {
		const model = currentCtx?.model;
		if (!model) return "";
		const thinking = pi.getThinkingLevel();
		return thinking !== "off" ? `${model.id} • ${thinking}` : model.id;
	}

	function currentProviderLabel(): string {
		const provider = currentCtx?.model?.provider;
		return provider ? `(${provider})` : "";
	}

	function requestChromeRender() {
		footerTui?.requestRender();
		editorTui?.requestRender();
	}

	function renderFooter(
		width: number,
		footerData?: { getGitBranch?: () => string | null | undefined },
		theme?: HudTheme,
	): string[] {
		if (disposed) return [""];
		try {
			refreshContext();

			const band = contextBand(contextPercent, contextTokens, contextWindow);
			const color = contextColor(band);
			const pct = contextPercent === null ? "?" : `${Math.round(contextPercent)}%`;
			const tokUsed = contextTokens === null ? "?" : fmtTokens(contextTokens);
			const tokWindow = fmtTokens(contextWindow);
			const contextPart = `${contextBar(contextPercent, band)} ${color}${pct} ${tokUsed}/${tokWindow}${RESET}`;

			const cwd = currentCtx?.cwd ?? process.cwd();
			const branch = footerData?.getGitBranch?.();
			const diffStats = formatDiffStats(gitAdded, gitRemoved, gitDirty);
			const location = `${displayPath(cwd)}${branch ? ` (${branch})` : ""}${diffStats}`;
			const sessionName = normalizeText(pi.getSessionName() ?? "");
			const isFallbackSessionLabel = !sessionName && Boolean(firstUserText);
			const sessionLabelRaw = sessionName || (firstUserText ? firstWords(firstUserText) : "");
			const sessionLabel = sessionLabelRaw ? styleSessionLabel(sessionLabelRaw, isFallbackSessionLabel, theme) : "";
			const divider = muted("│", theme);
			const sessionDivider = muted("|", theme);
			const footerContent = sessionLabel
				? `${contextPart} ${divider} ${location} ${sessionDivider} ${sessionLabel}`
				: `${contextPart} ${divider} ${location}`;
			const left = `${" ".repeat(FOOTER_GUTTER_WIDTH)}${footerContent}`;

			return [fitLine(left, width)];
		} catch (err) {
			if (isStaleExtensionError(err)) return [""];
			throw err;
		}
	}

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		currentCtx = ctx;
		firstUserText = null;
		refreshContext(ctx);

		// Clear old widget-based HUDs, then replace Pi's multi-line footer with
		// this single compact footer line. That removes the duplicated cwd/model,
		// compaction, and MCP status rows from the area below the input box.
		ctx.ui.setWidget(WIDGET_ID, undefined);
		ctx.ui.setWidget(LEGACY_WIDGET_ID, undefined);
		disposed = false;
		startGitPoll(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsubscribeBranch = footerData?.onBranchChange?.(() => tui.requestRender());
			return {
				render: (width: number) => renderFooter(width, footerData, theme),
				invalidate() {},
				dispose() {
					disposed = true;
					footerTui = null;
					clearGitPoll();
					clearEditorInstallTimer();
					if (typeof unsubscribeBranch === "function") unsubscribeBranch();
				},
			};
		});

		class HudEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: EDITOR_GUTTER_WIDTH });
				editorTui = tui;
			}

			setPaddingX(padding: number): void {
				super.setPaddingX(Math.max(EDITOR_GUTTER_WIDTH, padding));
			}

			render(width: number): string[] {
				if (width < 4) return super.render(width);

				try {
					const innerWidth = Math.max(1, width - 2);
					const lines = super.render(innerWidth);
					if (lines.length < 2) return lines.map((line) => fitLine(line, width));

					const theme = ctx.ui.theme;
					const border = (text: string) => this.borderColor(text);
					const bottomIndex = findBottomBorderIndex(lines);
					const topIndicator = scrollIndicator(lines[0] ?? "");
					const bottomIndicator = scrollIndicator(lines[bottomIndex] ?? "");
					const modelLabel = currentModelLabel();
					const providerLabel = currentProviderLabel();
					const topLeft = topIndicator ? theme.fg("dim", ` ${topIndicator} `) : "";
					const bottomLeft = bottomIndicator ? theme.fg("dim", ` ${bottomIndicator} `) : "";
					const topRight = modelLabel ? theme.fg("accent", ` ${modelLabel} `) : "";
					const bottomRight = providerLabel ? theme.fg("muted", ` ${providerLabel} `) : "";
					const rendered: string[] = [
						fitHorizontalBorder(topLeft, topRight, width, border, "╭", "╮"),
					];

					for (let i = 1; i < lines.length; i++) {
						const line = lines[i] ?? "";
						if (i === bottomIndex) {
							rendered.push(fitHorizontalBorder(bottomLeft, bottomRight, width, border, "╰", "╯"));
						} else if (i > bottomIndex) {
							rendered.push(fitLine(line, width));
						} else {
							rendered.push(`${border("│")}${padAnsiLine(line, innerWidth)}${border("│")}`);
						}
					}

					return rendered;
				} catch (err) {
					if (isStaleExtensionError(err)) return super.render(width);
					throw err;
				}
			}
		}

		const setHudEditor = () => {
			if (disposed || currentCtx !== ctx) return;
			ctx.ui.setEditorComponent((tui, theme, keybindings) => new HudEditor(tui, theme, keybindings));
		};

		setHudEditor();
		clearEditorInstallTimer();
		// Some editor extensions also install during session_start. Defer one
		// extra tick so this package's chrome remains the final editor wrapper.
		editorInstallTimer = setTimeout(() => {
			editorInstallTimer = null;
			try {
				setHudEditor();
			} catch (err) {
				if (!isStaleExtensionError(err)) throw err;
			}
		}, 0);
	}

	function refreshAndRender(ctx: ExtensionContext) {
		currentCtx = ctx;
		refreshContext(ctx);
		requestChromeRender();
	}

	pi.on("session_start", async (_event, ctx) => { install(ctx); });
	pi.on("session_shutdown", async () => {
		disposed = true;
		clearGitPoll();
		clearEditorInstallTimer();
		footerTui = null;
		editorTui = null;
	});
	pi.on("agent_start", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("agent_end", async (_event, ctx) => {
		refreshAndRender(ctx);
		void refreshGit(ctx);
	});
	pi.on("tool_call", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("tool_result", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("turn_end", async (_event, ctx) => { refreshAndRender(ctx); });
	pi.on("thinking_level_select", async () => { requestChromeRender(); });
	pi.on("model_select", async (event, ctx) => {
		currentCtx = ctx;
		refreshContext(ctx);
		contextWindow = event.model.contextWindow ?? contextWindow;
		requestChromeRender();
	});

	async function toggleSessionHud(ctx: ExtensionContext) {
		enabled = !enabled;
		if (enabled) {
			install(ctx);
			ctx.ui.notify("Session HUD enabled", "info");
		} else {
			disposed = true;
			clearGitPoll();
			clearEditorInstallTimer();
			footerTui = null;
			editorTui = null;
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setWidget(LEGACY_WIDGET_ID, undefined);
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
