import { Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";

type Value = string | number;
type Roles = { text: Value; muted: Value; dim: Value; accent: Value; success: Value; warning: Value; error: Value };

const FOREGROUND_ROLES = {
	accent: "accent", border: "accent", borderAccent: "accent", borderMuted: "muted", success: "success", error: "error",
	warning: "warning", muted: "muted", dim: "dim", text: "text", thinkingText: "muted", scrollbarTrack: "muted",
	scrollbarThumb: "text", searchMatchText: "text", userMessageText: "text", customMessageText: "text",
	customMessageLabel: "accent", toolTitle: "text", toolOutput: "muted", mdHeading: "accent", mdLink: "accent",
	mdLinkUrl: "muted", mdCode: "accent", mdCodeBlock: "text", mdCodeBlockBorder: "muted", mdQuote: "muted",
	mdQuoteBorder: "muted", mdHr: "muted", mdListBullet: "accent", toolDiffAdded: "success", toolDiffRemoved: "error",
	toolDiffContext: "muted", syntaxComment: "muted", syntaxKeyword: "accent", syntaxFunction: "accent",
	syntaxVariable: "text", syntaxString: "success", syntaxNumber: "warning", syntaxType: "accent",
	syntaxOperator: "text", syntaxPunctuation: "muted", thinkingOff: "muted", thinkingMinimal: "muted",
	thinkingLow: "accent", thinkingMedium: "accent", thinkingHigh: "accent", thinkingXhigh: "accent",
	thinkingMax: "accent", bashMode: "warning",
} satisfies Record<ThemeColor, keyof Roles>;

const BACKGROUNDS: ThemeBg[] = [
	"selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
];

function buildTheme(name: string, roles: Roles, background: Value, mode: "256color" | "truecolor", dim: ThemeColor[] = []): Theme {
	const fg = Object.fromEntries(Object.entries(FOREGROUND_ROLES).map(([token, role]) => [token, roles[role]]));
	const bg = Object.fromEntries(BACKGROUNDS.map((token) => [token, background]));
	return new Theme(fg as ConstructorParameters<typeof Theme>[0], bg as ConstructorParameters<typeof Theme>[1], mode, { name, dim });
}

/** Like Pi's system theme when the terminal reports no colours: palette indices the terminal draws itself. */
export function ansiFallbackTheme(): Theme {
	return buildTheme("ansi-fallback", { text: "", muted: 8, dim: "", accent: 4, success: 2, warning: 3, error: 1 }, "", "256color", ["dim"]);
}

/** Like Pi's system theme built from a light terminal palette. */
export function lightPaletteTheme(): Theme {
	return buildTheme("light-palette", {
		text: "#24292f", muted: "#57606a", dim: "#6e7781", accent: "#8250df",
		success: "#1a7f37", warning: "#9a6700", error: "#cf222e",
	}, "#f6f8fa", "truecolor");
}

/** Like Pi's system theme built from a dark terminal palette. */
export function darkPaletteTheme(): Theme {
	return buildTheme("dark-palette", {
		text: "#cdd6f4", muted: "#a6adc8", dim: "#7f849c", accent: "#cba6f7",
		success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
	}, "#313244", "truecolor");
}

/** Pi hands extensions a proxy to the active theme, so a theme switch is visible through the same object. */
export function switchableTheme(initial: Theme): { theme: Theme; use(next: Theme): void } {
	let current = initial;
	const theme = new Proxy({} as Theme, { get: (_target, prop) => current[prop as keyof Theme] });
	return { theme, use: (next) => { current = next; } };
}
