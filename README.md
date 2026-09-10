# pi-session-hud

`pi-session-hud` replaces [Pi](https://github.com/earendil-works/pi)'s multi-line footer with one compact context/location/session line and gives the input box Amp-style chrome: model and thinking level in the top border, your remaining weekly quota (or session cost) in the bottom border, and provider/reset detail on the footer's right edge.

![Session HUD editor chrome and footer](https://raw.githubusercontent.com/tmustier/pi-session-hud/main/assets/hud-chrome.png)

```text
╭───────────────────────────── ↯ • gpt-5.6-sol • medium ╮
│ prompt text wraps inside a one-column gutter              │
╰────────────────────────────────────────────── 44% left ╯
 ██░░░░ 36% 98k/272k │ ~/projects/pi-session-hud (main) +12 -3 | Simplify HUD…     openai-codex weekly reset in 3d04h
```

Only the context bar/text, git diff stats, session label, and usage metric use colour, so the line stays scannable. The stock footer's separate cwd row, activity status, extension status row, and background fill are gone.

## What it shows

The footer line, left to right:

- colour-coded context usage bar, percentage, and used/window token counts; when `pi-auto-compact` lowers the window, the limit gets a down arrow such as `200k↓`
- current working directory and git branch
- git diff stats (`+x -y`, or `~` when dirty); git-crypt repositories show dirty state without line counts
- session name, or the first few words of the first user message when unnamed
- right edge: active extension statuses followed by provider detail, for example `openai-codex weekly reset in 3d04h`, or just the provider name on API-key billing; an active `fast-mode` status is promoted to the editor-border lightning symbol instead of duplicated here

The editor border:

- top right: current model and thinking level, for example `gpt-5.6-sol • medium`; when fast mode is active, the single-column lightning symbol `↯` appears first. Like Pi's own footer, reasoning models show `thinking off` when thinking is off, and models without thinking support show only the model id
- in Pi's fullscreen TUI mode (`--tui-mode fullscreen` or the `tuiMode` setting), both labels open a small popup above the input box:
  - the model id lists the session's scoped models (`--models` or the `enabledModels` setting, the same set as `/scoped-models`) with the current one checked, plus `Other…`, which opens Pi's full model selector on the all scope; with no scope configured a click goes straight to Pi's selector
  - the thinking level lists the levels the current model supports, with the current one checked
  - hovering a label shows its popup without taking focus: click a row to pick, or keep typing and it gets out of the way; it follows the pointer to the other label and closes when the pointer leaves
  - clicking a label pins the popup: the arrow keys and Enter work, and it stays until you pick, press Escape, click the label again, or click anywhere else that takes focus
- other extensions can add their own labels and popup rows next to these; see [Chrome menus for other extensions](#chrome-menus-for-other-extensions)
- bottom right: `44% left` weekly subscription quota, or session cost (`$0.042`) when using API-key billing
  - the quota opens a read-only popup on hover or click, one line per window the provider reports: `Weekly: 56% used (12% ahead) | resets in 4d18h`, plus a `5h:` line when there is a 5-hour window (Anthropic; Codex plans without one show only the weekly line)
  - the pace compares what you have used with how much of the window has elapsed: `12% ahead` (green) means 12 points less used than a steady burn would have reached by now, `12% behind` (red) means 12 points more, `on pace` when they match
- one-column input gutter with word wrapping inside a full rounded border; scroll indicators (`↑ 3 more`) stay visible in the border

## Install

Install from npm:

```bash
pi install npm:@tmustier/pi-session-hud
```

Or from GitHub:

```bash
pi install git:github.com/tmustier/pi-session-hud
```

Try it for one run without installing:

```bash
pi -e npm:@tmustier/pi-session-hud
```

For local development from a clone:

```bash
pi -e ./pi-session-hud.ts
```

To persist a local clone, symlink it into Pi's auto-discovered extensions directory (`ln -s ~/pi-session-hud/pi-session-hud.ts ~/.pi/agent/extensions/`) or add it to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/pi-session-hud/pi-session-hud.ts"]
}
```

## Use

The HUD installs itself on session start and survives `/reload`, `/resume`, and model switches.

- `/hud` toggles the HUD on and off (restoring Pi's stock footer and editor)
- `/status` and `/header` are aliases

How to read the numbers:

- context colours run green → yellow-green → amber → red; thresholds are calibrated to a GPT-5.5-sized (272k) window and applied as absolute token counts on larger windows, so 1M-token models start warning at the same real usage instead of staying green too long
- with [`pi-auto-compact`](https://github.com/tmustier/pi-auto-compact) v0.1.2 or newer loaded, the HUD resolves the active model's configured threshold and uses it when it is lower than the provider context window; for example, `98k/372k` becomes `98k/200k↓`, with the percentage recalculated against 200k
- context colours keep their established fixed token thresholds even when the displayed window is capped; the cap changes the denominator and percentage, not the colour band
- if auto-compact is absent, does not answer the policy request, or has a threshold at or above the model context window, the HUD keeps Pi's provider context window
- `?` in the context slot means Pi has no fresh usage data yet, for example right after compaction
- named sessions render white; the unnamed fallback (first words of your first message) renders muted grey
- `↯` means fast mode is active: the HUD reads Pi's standard `fast-mode` extension status immediately and also passively observes serialized requests containing `service_tier: "priority"` or `speed: "fast"` as a fallback; it never enables or modifies fast mode
- the standard extension-status path is independent of package and request-hook order; payload-only integrations update the indicator on the next provider request and still need their payload patch to run before the HUD's observation hook
- `44% left` is your weekly subscription quota remaining; it appears when Pi is authenticated via OpenAI Codex or Anthropic subscription OAuth
- quota comes from a background probe of the provider usage endpoint at session start, after model switches, and every 5 minutes, plus provider rate-limit headers on each response when the transport exposes them (OpenAI Codex only does so on the SSE transport, not the default WebSocket transport); if neither is available the metric simply stays absent
- on API-key billing the bottom border shows Pi's calculated session cost instead, with no popup

The HUD and auto-compact communicate through Pi's shared extension event bus. The HUD does not read or duplicate auto-compact's configuration rules. Run `/reload` after installing or changing either extension.

Git state refreshes at session start and after each agent run, not while idle.

Mouse clicks are only delivered in Pi's fullscreen TUI mode; in regular mode the terminal owns the scrollback and Pi does not capture mouse input. Hover needs pointer-motion reporting, which Pi turns off inside tmux, zellij and screen to keep those multiplexers responsive; there the popups still open on click.

## Chrome menus for other extensions

An extension can put its own label in the input border, with a popup, or append rows to the model or thinking popup. It talks to the HUD over Pi's extension event bus, so neither extension imports the other and load order does not matter. `chrome-menu.ts` exports the event names and types.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST = "pi-session-hud:chrome-menu-request:v1";
const MENU = "pi-session-hud:chrome-menu:v1";

export default function (pi: ExtensionAPI) {
	let mode = "high";
	const publish = () => pi.events.emit(MENU, {
		protocolVersion: 1,
		id: "pi-dial",                 // stable key; re-emitting replaces the menu
		label: `dial ${mode}`,         // border segment, after the thinking level
		title: "Dial mode",            // popup title (defaults to the label)
		items: [                       // popup rows, or a function called when the popup opens
			{ value: "medium", label: "medium", description: "balanced" },
			{ value: "ultra", label: "ultra", description: "everything" },
		],
		current: () => mode,           // row shown with a check mark
		onSelect: (value: string) => { mode = value; publish(); },
	});
	pi.events.on(REQUEST, publish);  // the HUD asks on install, in case it loaded after you
	pi.on("session_start", async () => { publish(); });
}
```

- a label without `items` is informational: it is drawn but not clickable
- `extend: "model"` or `extend: "thinking"` appends the rows to that built-in popup instead; `onSelect` still receives the row's own `value`
- `{ protocolVersion: 1, id, remove: true }` withdraws a menu
- malformed payloads are ignored; the HUD re-renders the border whenever a menu changes

On narrow terminals the footer collapses gracefully: context + repo/branch/diff survive first, then the session label; the right-side reset detail shrinks to just the countdown (`3d04h`) and then disappears.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).
