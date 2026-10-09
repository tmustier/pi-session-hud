import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToRgb, mixColors, type Color } from "@earendil-works/pi-tui";
import sessionHud, { paintContext, yellowBandColor } from "../pi-session-hud.js";
import { ansiFallbackTheme, darkPaletteTheme, lightPaletteTheme, switchableTheme } from "./theme-fixture.js";

// Keep compaction off so the footer shows the provider window, independent of the developer's settings.
const agentDir = mkdtempSync(join(tmpdir(), "pi-session-hud-theme-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }), "utf-8");
const shutdowns: Array<() => unknown> = [];
after(async () => {
	for (const shutdown of shutdowns) await shutdown();
	rmSync(agentDir, { recursive: true, force: true });
});

const WINDOW = 272_000;
const RAW_RGB = /\x1b\[[34]8;2;/;

async function footerFor(theme: Theme, tokens: number) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let footer: { render(width: number): string[] } | undefined;
	const ctx = {
		hasUI: true, cwd: "/tmp", isProjectTrusted: () => false,
		model: { provider: "anthropic", id: "claude", api: "anthropic-messages", reasoning: true, contextWindow: WINDOW },
		getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: (tokens / WINDOW) * 100 }),
		sessionManager: { getBranch: () => [] },
		modelRegistry: { isUsingOAuth: () => false },
		ui: {
			theme,
			setFooter(factory: any) {
				footer = factory({ requestRender() {} }, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} });
			},
			getEditorComponent: () => undefined,
			setEditorComponent() {},
		},
	};
	const gitOutput: Record<string, string> = {
		status: " M pi-session-hud.ts\n",
		diff: " 1 file changed, 3 insertions(+), 2 deletions(-)\n",
	};
	sessionHud({
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: { on: () => () => {}, emit() {} }, registerCommand() {},
		getThinkingLevel: () => "medium", getSessionName: () => "theme test",
		exec: async (command: string, args: string[]) => {
			const output = command === "git" ? gitOutput[args[0] ?? ""] : undefined;
			return output === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: output, stderr: "" };
		},
	} as any);
	await handlers.get("session_start")?.({}, ctx);
	shutdowns.push(() => handlers.get("session_shutdown")?.({}, ctx));
	// Let the git refresh settle.
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	return () => footer!.render(200).join("\n");
}

const BANDS = [
	{ band: "healthy", tokens: 10_000, text: "4% 10k/272k" },
	{ band: "yellow", tokens: 80_000, text: "29% 80k/272k" },
	{ band: "amber", tokens: 120_000, text: "44% 120k/272k" },
	{ band: "red", tokens: 200_000, text: "74% 200k/272k" },
] as const;

test("with the terminal's own palette, the footer leaves every colour to the terminal", async () => {
	const theme = ansiFallbackTheme();
	const expectedToken = { healthy: "success", yellow: "warning", amber: "warning", red: "error" } as const;
	for (const { band, tokens, text } of BANDS) {
		const footer = (await footerFor(theme, tokens))();
		assert.doesNotMatch(footer, RAW_RGB, `${band} band`);
		assert.ok(footer.includes(theme.fg(expectedToken[band], text)), `${band} band uses ${expectedToken[band]}`);
		assert.ok(footer.includes(theme.fg("toolDiffAdded", "+3")));
		assert.ok(footer.includes(theme.fg("toolDiffRemoved", "-2")));
		const filled = Math.round((tokens / WINDOW) * 6);
		assert.ok(footer.includes(`${theme.fg(expectedToken[band], "█".repeat(filled))}${theme.fg("dim", "░".repeat(6 - filled))}`), `${band} bar`);
	}
});

test("with a terminal palette, context bands use the theme's success, warning and error colours", async () => {
	for (const theme of [lightPaletteTheme(), darkPaletteTheme()]) {
		const yellow = mixColors(theme.colors.success, theme.colors.warning, 0.5);
		const expected = {
			healthy: theme.fg("success", BANDS[0].text),
			yellow: theme.style(BANDS[1].text, { fg: yellow }),
			amber: theme.fg("warning", BANDS[2].text),
			red: theme.fg("error", BANDS[3].text),
		};
		for (const { band, tokens } of BANDS) {
			assert.ok((await footerFor(theme, tokens))().includes(expected[band]), `${theme.name} ${band} band`);
		}
	}
});

function contrast(first: Color, second: Color): number {
	const luminance = (color: Color) => {
		const { r, g, b } = colorToRgb(color);
		const linear = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
		return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	};
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (light! + 0.05) / (dark! + 0.05);
}

test("the yellow band stays about as readable as the colours it blends", () => {
	for (const theme of [lightPaletteTheme(), darkPaletteTheme()]) {
		const yellow = yellowBandColor(theme)!;
		const background = theme.colors.selectedBg;
		const floor = Math.min(contrast(theme.colors.success, background), contrast(theme.colors.warning, background));
		// agent-default (not a user rule): 2026-09-30 — allow 10% for OKLCH-vs-WCAG luminance drift.
		assert.ok(contrast(yellow, background) >= floor * 0.9, `${theme.name}: ${contrast(yellow, background)} vs ${floor}`);
	}
});

test("the footer follows a theme switch behind Pi's theme proxy", async () => {
	const dark = darkPaletteTheme();
	const light = lightPaletteTheme();
	const active = switchableTheme(dark);
	const render = await footerFor(active.theme, BANDS[1].tokens);
	assert.ok(render().includes(paintContext("yellow", BANDS[1].text, dark)));
	active.use(light);
	const switched = render();
	assert.ok(switched.includes(paintContext("yellow", BANDS[1].text, light)));
	assert.ok(!switched.includes(paintContext("yellow", BANDS[1].text, dark)));
});
