/**
 * Pi Session HUD — Persistent session heads-up display below the editor.
 *
 * Shows:
 *   - Activity status with color-coded background (idle/running/tool/error/stale)
 *   - Session name or cwd basename
 *   - Git branch + worktree marker (⎇ name current/total when multiple) + diff stats (+added/-removed)
 *   - Context usage bar (% + token count)
 *   - Current model
 *
 * Install:
 *   - pi install npm:@tmustier/pi-session-hud
 *   - or copy/symlink pi-session-hud.ts into ~/.pi/agent/extensions/
 * Toggle: /hud (aliases: /status, /header)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────

type Status = "idle" | "running" | "tool" | "error" | "stale";

const WIDGET_ID = "pi-session-hud";
const LEGACY_WIDGET_ID = "pi-status-bar";

// ── Color Palette (raw ANSI truecolor) ───────────────────────

const STATUS_BG: Record<Status, string> = {
	idle:    "\x1b[48;2;30;80;50m",
	running: "\x1b[48;2;30;50;90m",
	tool:    "\x1b[48;2;90;75;20m",
	error:   "\x1b[48;2;100;30;30m",
	stale:   "\x1b[48;2;90;60;15m",
};

const STATUS_FG: Record<Status, string> = {
	idle:    "\x1b[38;2;100;220;140m",
	running: "\x1b[38;2;100;160;255m",
	tool:    "\x1b[38;2;240;200;80m",
	error:   "\x1b[38;2;255;100;100m",
	stale:   "\x1b[38;2;255;170;60m",
};

const RESET = "\x1b[0m";

const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";

// Reset foreground only (keep background)
const FG_RESET = "\x1b[39m";

const FG_WHITE = "\x1b[38;2;220;220;220m";
const FG_MUTED = "\x1b[38;2;140;140;140m";
const FG_DIM = "\x1b[38;2;90;90;90m";

const STATUS_ICON: Record<Status, string> = {
	idle:    "●",
	running: "◉",
	tool:    "⚙",
	error:   "✗",
	stale:   "⏳",
};

const STATUS_LABEL: Record<Status, string> = {
	idle:    "IDLE",
	running: "RUN",
	tool:    "TOOL",
	error:   "ERR",
	stale:   "STALE",
};

// ── Helpers ──────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return `${n}`;
}

function contextBar(percent: number, barWidth: number): string {
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;
	let barFg: string;
	if (percent < 25) barFg = "\x1b[38;2;100;200;120m";       // green — great
	else if (percent < 40) barFg = "\x1b[38;2;180;210;100m";   // yellow-green — fine
	else if (percent < 60) barFg = "\x1b[38;2;220;180;60m";    // amber — meh
	else barFg = "\x1b[38;2;240;80;80m";                       // red — bad
	return `${barFg}${"█".repeat(filled)}${FG_DIM}${"░".repeat(empty)}`;
}

async function getGitStats(pi: ExtensionAPI): Promise<{ added: number; removed: number; dirty: boolean }> {
	try {
		const result = await pi.exec("git", ["diff", "--stat", "HEAD"], { timeout: 2000 });
		if (result.code !== 0) return { added: 0, removed: 0, dirty: false };
		let added = 0, removed = 0;
		for (const line of result.stdout.split("\n")) {
			const m1 = line.match(/(\d+) insertions?\(\+\)/);
			const m2 = line.match(/(\d+) deletions?\(-\)/);
			if (m1) added = parseInt(m1[1]!, 10);
			if (m2) removed = parseInt(m2[1]!, 10);
		}
		const status = await pi.exec("git", ["status", "--porcelain"], { timeout: 2000 });
		const dirty = status.code === 0 && status.stdout.trim().length > 0;
		return { added, removed, dirty };
	} catch {
		return { added: 0, removed: 0, dirty: false };
	}
}

function pathBasename(pathValue: string): string {
	const trimmed = pathValue.endsWith("/") ? pathValue.slice(0, -1) : pathValue;
	const parts = trimmed.split("/").filter(Boolean);
	const lastPart = parts.length > 0 ? parts[parts.length - 1] : "";
	return lastPart || trimmed || "";
}

async function getWorktreeInfo(pi: ExtensionAPI): Promise<{ count: number; name: string | null; index: number | null }> {
	try {
		const listResult = await pi.exec("git", ["worktree", "list", "--porcelain"], { timeout: 2000 });
		if (listResult.code !== 0) return { count: 0, name: null, index: null };

		const worktreePaths: string[] = [];
		for (const line of listResult.stdout.split("\n")) {
			if (!line.startsWith("worktree ")) continue;
			const worktreePath = line.slice("worktree ".length).trim();
			if (worktreePath) worktreePaths.push(worktreePath);
		}

		const count = worktreePaths.length;
		if (count <= 1) return { count, name: null, index: null };

		const topLevelResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 2000 });
		if (topLevelResult.code !== 0) return { count, name: null, index: null };
		const currentPath = topLevelResult.stdout.trim();

		let zeroBasedIndex = worktreePaths.findIndex((worktreePath) => worktreePath === currentPath);
		if (zeroBasedIndex < 0) {
			const currentBase = pathBasename(currentPath);
			const matchingByBase: number[] = [];
			for (let i = 0; i < worktreePaths.length; i++) {
				if (pathBasename(worktreePaths[i]) === currentBase) matchingByBase.push(i);
			}
			if (matchingByBase.length === 1) zeroBasedIndex = matchingByBase[0];
		}

		const gitDirResult = await pi.exec("git", ["rev-parse", "--git-dir"], { timeout: 2000 });
		const gitDir = gitDirResult.code === 0 ? gitDirResult.stdout.trim() : "";
		const isMainWorktree = gitDir === ".git" || gitDir.endsWith("/.git");
		const name = isMainWorktree ? "main" : pathBasename(currentPath) || "linked";
		const index = zeroBasedIndex >= 0 ? zeroBasedIndex + 1 : null;

		return { count, name, index };
	} catch {
		return { count: 0, name: null, index: null };
	}
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;

	let status: Status = "idle";
	let toolName: string | undefined;
	let toolStartTime: number | undefined;
	let gitBranch: string | null = null;
	let gitAdded = 0;
	let gitRemoved = 0;
	let gitDirty = false;
	let worktreeCount = 0;
	let worktreeName: string | null = null;
	let worktreeIndex: number | null = null;
	let contextPercent = 0;
	let contextTokens = 0;
	let contextWindow = 0;
	let model = "";

	let currentCtx: ExtensionContext | null = null;
	let gitPollTimer: ReturnType<typeof setInterval> | null = null;
	let staleTimer: ReturnType<typeof setTimeout> | null = null;
	let staleInterval: ReturnType<typeof setInterval> | null = null;
	let widgetTui: any = null;
	let widgetTheme: any = null;
	let firstUserText: string | null = null;

	// ── Render ───────────────────────────────────────────────

	function renderBar(width: number): string[] {
		const bg = STATUS_BG[status];
		const sFg = STATUS_FG[status];
		const icon = STATUS_ICON[status];
		let label = STATUS_LABEL[status];

		if (status === "tool" && toolName) {
			label = toolName;
		}
		if (status === "stale" && toolName) {
			const elapsed = toolStartTime ? Math.floor((Date.now() - toolStartTime) / 1000) : 0;
			label = `${toolName} ${elapsed}s`;
		}

		const sep = `${FG_DIM}│${FG_RESET}`;

		const padBgLine = (prefixed: string): string => {
			// truncateToWidth() injects a hard reset (\x1b[0m) before its ellipsis.
			// That would clear our background. So ellipsis re-applies bg.
			const ellipsis = `${bg}…${FG_RESET}`;
			return truncateToWidth(prefixed, width, ellipsis, true) + RESET;
		};

		// ── Main line: directory (branch) ⎇ worktree-position: name/message ──
		const home = process.env.HOME || "";
		const cwd = process.cwd();
		let displayDir: string;
		if (home && cwd.startsWith(home)) {
			const rel = cwd.slice(home.length);
			displayDir = rel ? `~${rel}` : "~";
		} else {
			displayDir = cwd;
		}

		const sessionName = pi.getSessionName();
		const hasName = Boolean(sessionName && sessionName.trim());
		const mainTextRaw = hasName
			? sessionName!.trim()
			: (firstUserText && firstUserText.trim())
				? firstUserText.trim()
				: "";

		const mainTextStyled = hasName && widgetTheme
			? widgetTheme.fg("warning", mainTextRaw)
			: widgetTheme
				? widgetTheme.italic(widgetTheme.fg("dim", mainTextRaw))
				: `${FG_DIM}${ITALIC_ON}${mainTextRaw}${ITALIC_OFF}${FG_RESET}`;

		const branchStyled = gitBranch
			? ` ${FG_MUTED}(${FG_WHITE}${gitBranch}${FG_MUTED})${FG_RESET}`
			: "";

		// Medium format: current/total when index is known, fallback to "N wt"
		const worktreePosition = worktreeIndex !== null ? `${worktreeIndex}/${worktreeCount}` : `${worktreeCount} wt`;
		const worktreeStyled = (worktreeCount > 1 && worktreeName)
			? ` ${FG_DIM}⎇${FG_RESET} ${FG_MUTED}${worktreeName}${FG_RESET} ${FG_DIM}${worktreePosition}${FG_RESET}`
			: "";

		const mainInner =
			` ${FG_WHITE}${displayDir}${FG_RESET}` +
			branchStyled +
			worktreeStyled +
			`${FG_DIM}: ${FG_RESET}` +
			`${mainTextStyled}${FG_RESET} `;

		const lineMain = padBgLine(`${bg}${mainInner}`);

		// ── Context line: context % ... │ model + thinking ──
		const ctxParts: string[] = [];
		const bar = contextBar(contextPercent, 6);
		const pct = `${Math.round(contextPercent)}%`;
		const tok = `${fmtTokens(contextTokens)}/${fmtTokens(contextWindow)}`;
		ctxParts.push(` ${bar}${FG_RESET} ${FG_WHITE}${pct}${FG_RESET} ${FG_MUTED}${tok}${FG_RESET} `);
		if (model) {
			const thinking = pi.getThinkingLevel();
			const thinkingStr = thinking !== "off" ? ` ${FG_MUTED}• ${thinking}${FG_RESET}` : "";
			ctxParts.push(` ${FG_MUTED}${model}${FG_RESET}${thinkingStr} `);
		}
		const lineContext = padBgLine(`${bg}${ctxParts.join(sep)}`);

		// ── Status line: STATUS (+/-) ──
		const STATUS_LABEL_WIDTH = 10;
		const labelTrunc = truncateToWidth(label, STATUS_LABEL_WIDTH, "…");
		const labelPad = labelTrunc + " ".repeat(Math.max(0, STATUS_LABEL_WIDTH - visibleWidth(labelTrunc)));
		let statusInner = ` ${sFg}${BOLD}${icon} ${labelPad}${BOLD_OFF}${FG_RESET}`;

		// Git diff stats next to status
		const diffParts: string[] = [];
		if (gitAdded > 0) diffParts.push(`\x1b[38;2;100;200;120m+${gitAdded}${FG_RESET}`);
		if (gitRemoved > 0) diffParts.push(`\x1b[38;2;240;100;100m-${gitRemoved}${FG_RESET}`);
		if (gitDirty && gitAdded === 0 && gitRemoved === 0) diffParts.push(`${FG_MUTED}~${FG_RESET}`);
		if (diffParts.length) {
			statusInner += `  ${diffParts.join(" ")}`;
		}
		statusInner += " ";
		const lineStatus = padBgLine(`${bg}${statusInner}`);

		// Padding lines: just spaces, exactly width chars
		const emptyLine = truncateToWidth(`${bg}${" ".repeat(width)}${RESET}`, width);

		return [emptyLine, lineMain, lineContext, lineStatus, emptyLine, ""];
	}

	// ── Data refresh ─────────────────────────────────────────

	async function refreshGit() {
		const stats = await getGitStats(pi);
		gitAdded = stats.added;
		gitRemoved = stats.removed;
		gitDirty = stats.dirty;
		widgetTui?.requestRender();
	}

	async function refreshWorktree() {
		const info = await getWorktreeInfo(pi);
		worktreeCount = info.count;
		worktreeName = info.name;
		worktreeIndex = info.index;
		widgetTui?.requestRender();
	}

	function refreshContext() {
		if (!currentCtx) return;
		const usage = currentCtx.getContextUsage();
		if (usage) {
			contextPercent = usage.percent;
			contextTokens = usage.tokens;
			contextWindow = usage.contextWindow;
		}
		model = currentCtx.model?.id ?? "";
	}

	function clearStaleTimer() {
		if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
		if (staleInterval) { clearInterval(staleInterval); staleInterval = null; }
	}

	function startStaleTimer() {
		clearStaleTimer();
		staleTimer = setTimeout(() => {
			if (status === "tool") {
				status = "stale";
				widgetTui?.requestRender();
				staleInterval = setInterval(() => {
					if (status !== "stale") { clearInterval(staleInterval!); staleInterval = null; return; }
					widgetTui?.requestRender();
				}, 1000);
			}
		}, 30_000);
	}

	// ── Install widget ───────────────────────────────────────

	function extractFirstUserText(ctx: ExtensionContext): string | null {
		try {
			const entries: any[] = ctx.sessionManager.getEntries?.() ?? [];
			for (const e of entries) {
				if (e?.type !== "message") continue;
				const m = e.message;
				if (!m || m.role !== "user") continue;
				const parts: any[] = m.content ?? [];
				let text = "";
				for (const p of parts) {
					if (p?.type === "text" && typeof p.text === "string") text += p.text;
				}
				text = text.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
				if (text) return text;
			}
			return null;
		} catch {
			return null;
		}
	}

	function install(ctx: ExtensionContext) {
		if (!ctx.hasUI || !enabled) return;
		currentCtx = ctx;
		model = ctx.model?.id ?? "";
		firstUserText = extractFirstUserText(ctx);
		worktreeCount = 0;
		worktreeName = null;
		worktreeIndex = null;

		// Remove legacy widget from older versions
		ctx.ui.setWidget(LEGACY_WIDGET_ID, undefined);

		ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
			widgetTui = tui;
			widgetTheme = theme;
			return {
				render: (width: number) => renderBar(width),
				invalidate() {},
				dispose() {
					if (gitPollTimer) { clearInterval(gitPollTimer); gitPollTimer = null; }
					clearStaleTimer();
					widgetTui = null;
					widgetTheme = null;
				},
			};
		}, { placement: "belowEditor" });

		refreshContext();
		refreshGit();

		// Poll git diff stats every 10s (branch/worktree refreshed on install + agent_end)
		if (gitPollTimer) clearInterval(gitPollTimer);
		gitPollTimer = setInterval(() => refreshGit(), 10_000);

		// Get initial git branch + worktree info
		pi.exec("git", ["branch", "--show-current"], { timeout: 2000 }).then((r) => {
			if (r.code === 0) {
				gitBranch = r.stdout.trim() || "detached";
				widgetTui?.requestRender();
			}
		}).catch(() => {});
		refreshWorktree();
	}

	// ── Events ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => { install(ctx); });
	pi.on("session_switch", async (_event, ctx) => { status = "idle"; install(ctx); });

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		status = "running";
		toolName = undefined;
		clearStaleTimer();
		widgetTui?.requestRender();
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		status = "idle";
		toolName = undefined;
		clearStaleTimer();
		refreshContext();
		refreshGit();
		// Re-poll branch + worktree in case they changed
		pi.exec("git", ["branch", "--show-current"], { timeout: 2000 }).then((r) => {
			if (r.code === 0) {
				gitBranch = r.stdout.trim() || "detached";
				widgetTui?.requestRender();
			}
		}).catch(() => {});
		refreshWorktree();
		widgetTui?.requestRender();
	});

	pi.on("tool_call", async (event, ctx) => {
		currentCtx = ctx;
		status = "tool";
		toolName = event.toolName;
		toolStartTime = Date.now();
		startStaleTimer();
		widgetTui?.requestRender();
	});

	pi.on("tool_result", async (event, ctx) => {
		currentCtx = ctx;
		clearStaleTimer();
		status = event.isError ? "error" : "running";
		toolName = undefined;
		widgetTui?.requestRender();
	});

	pi.on("turn_end", async (_event, ctx) => {
		currentCtx = ctx;
		refreshContext();
		// Populate first user text lazily if session was empty at install time
		if (!firstUserText) firstUserText = extractFirstUserText(ctx);
		widgetTui?.requestRender();
	});

	pi.on("model_select", async (event, ctx) => {
		currentCtx = ctx;
		model = event.model.id;
		widgetTui?.requestRender();
	});

	// ── Toggle command ───────────────────────────────────────

	async function toggleSessionHud(ctx: ExtensionContext) {
		enabled = !enabled;
		if (enabled) {
			install(ctx);
			ctx.ui.notify("Session HUD enabled", "info");
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			ctx.ui.setWidget(LEGACY_WIDGET_ID, undefined);
			if (gitPollTimer) { clearInterval(gitPollTimer); gitPollTimer = null; }
			clearStaleTimer();
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
