import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { colorToRgb, rgbColor, type Color } from "@earendil-works/pi-tui";
import sessionHud from "../pi-session-hud.js";
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
const BANDS = {
	healthy: { tokens: 10_000, text: "4% 10k/272k" },
	yellow: { tokens: 80_000, text: "29% 80k/272k" },
	amber: { tokens: 120_000, text: "44% 120k/272k" },
	red: { tokens: 200_000, text: "74% 200k/272k" },
};

/** Installs the HUD in a session with `tokens` of context and a dirty tree (+3 -2), and returns its footer renderer. */
async function footerFor(theme: Theme, tokens: number): Promise<() => string> {
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
	const git: Record<string, string> = { status: " M a.ts\n", diff: " 1 file changed, 3 insertions(+), 2 deletions(-)\n" };
	sessionHud({
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: { on: () => () => {}, emit() {} }, registerCommand() {},
		getThinkingLevel: () => "medium", getSessionName: () => "theme test",
		exec: async (command: string, args: string[]) => {
			const stdout = command === "git" ? git[args[0]!] : undefined;
			return stdout === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout, stderr: "" };
		},
	} as any);
	await handlers.get("session_start")!({}, ctx);
	shutdowns.push(() => handlers.get("session_shutdown")!({}, ctx));
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); // let the git refresh land
	return () => footer!.render(200).join("\n");
}

function drawn(footer: string, theme: Theme, token: ThemeColor, text: string): boolean {
	return footer.includes(`${theme.getFgAnsi(token)}${text}`);
}

test("with the terminal's own palette indices, the footer leaves every colour to the terminal", async () => {
	const theme = ansiFallbackTheme();
	const tokens = { healthy: "success", yellow: "warning", amber: "warning", red: "error" } as const;
	for (const [band, { tokens: used, text }] of Object.entries(BANDS)) {
		const footer = (await footerFor(theme, used))();
		const token = tokens[band as keyof typeof BANDS];
		const filled = Math.round((used / WINDOW) * 6);
		assert.doesNotMatch(footer, /\x1b\[[34]8;2;/, band);
		assert.ok(drawn(footer, theme, token, text), `${band} text uses ${token}`);
		assert.ok(drawn(footer, theme, token, "█".repeat(filled)), `${band} bar uses ${token}`);
		assert.ok(drawn(footer, theme, "dim", "░".repeat(6 - filled)), `${band} bar track`);
		assert.ok(drawn(footer, theme, "toolDiffAdded", "+3") && drawn(footer, theme, "toolDiffRemoved", "-2"), "diff stats");
	}
});

function luminance(color: Color): number {
	const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
	const { r, g, b } = colorToRgb(color);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(first: Color, second: Color): number {
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (light! + 0.05) / (dark! + 0.05);
}

test("with a terminal palette, the second band sits between success and warning and stays readable", async () => {
	for (const theme of [lightPaletteTheme(), darkPaletteTheme()]) {
		for (const [band, token] of [["healthy", "success"], ["amber", "warning"], ["red", "error"]] as const) {
			assert.ok(drawn((await footerFor(theme, BANDS[band].tokens))(), theme, token, BANDS[band].text), `${theme.name} ${band}`);
		}
		const footer = (await footerFor(theme, BANDS.yellow.tokens))();
		const [r, g, b] = footer.match(new RegExp(`\\x1b\\[38;2;(\\d+);(\\d+);(\\d+)m${BANDS.yellow.text}`))!.slice(1).map(Number);
		const yellow = rgbColor(r!, g!, b!);
		const { success, warning, selectedBg } = theme.colors;
		assert.notDeepEqual(colorToRgb(yellow), colorToRgb(success));
		assert.notDeepEqual(colorToRgb(yellow), colorToRgb(warning));
		assert.ok(contrast(yellow, selectedBg) >= Math.min(contrast(success, selectedBg), contrast(warning, selectedBg)), theme.name);
	}
});

test("the footer follows a theme switch behind Pi's theme proxy", async () => {
	const active = switchableTheme(darkPaletteTheme());
	const render = await footerFor(active.theme, BANDS.yellow.tokens);
	const light = lightPaletteTheme();
	assert.notEqual(render(), (await footerFor(light, BANDS.yellow.tokens))());
	active.use(light);
	assert.equal(render(), (await footerFor(light, BANDS.yellow.tokens))());
});
