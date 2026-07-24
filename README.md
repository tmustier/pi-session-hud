# pi-session-hud

`pi-session-hud` replaces [Pi](https://github.com/earendil-works/pi)'s multi-line footer with one compact context/location/session line and gives the input box Amp-style chrome: model and thinking level in the top border, your remaining weekly quota (or session cost) in the bottom border, and provider/reset detail on the footer's right edge.

![Session HUD editor chrome and footer](https://raw.githubusercontent.com/tmustier/pi-session-hud/main/assets/hud-chrome.png)

```text
╭───────────────────────────── ⚡︎ • gpt-5.6-sol • medium ╮
│ prompt text wraps inside a one-column gutter              │
╰────────────────────────────────────────────── 44% left ╯
 ██░░░░ 36% 98k/272k │ ~/projects/pi-session-hud (main) +12 -3 | Simplify HUD…     openai-codex weekly reset in 3d04h
```

Only the context bar/text, git diff stats, session label, and usage metric use colour, so the line stays scannable. The stock footer's separate cwd row, activity status, extension status row, and background fill are gone.

## What it shows

The footer line, left to right:

- colour-coded context usage bar, percentage, and used/window token counts; when `pi-auto-compact` lowers the window, the limit gets a down arrow such as `200k↓`
- current working directory and git branch
- git diff stats (`+x -y`, or `~` for dirty-without-line-count changes)
- session name, or the first few words of the first user message when unnamed
- right edge: provider detail, for example `openai-codex weekly reset in 3d04h`, or just the provider name on API-key billing

The editor border:

- top right: current model and thinking level, for example `gpt-5.6-sol • medium`; when [`pi-fast-mode`](https://github.com/RimuruW/pi-fast-mode) reports that fast mode is active for the selected model/API, the text-presentation lightning symbol `⚡︎` appears first: `⚡︎ • gpt-5.6-sol • medium`
- bottom right: `44% left` weekly subscription quota, or session cost (`$0.042`) when using API-key billing
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
- when `pi-fast-mode` is loaded, the HUD requires both its active status and its persisted enabled setting before showing `⚡︎`; the glyph stays hidden when fast mode is off or unavailable for the selected model/API
- `44% left` is your weekly subscription quota remaining; it appears when Pi is authenticated via OpenAI Codex or Anthropic subscription OAuth
- quota comes from provider rate-limit headers on each response, plus a background probe of the provider usage endpoint every 5 minutes; if neither is available the metric simply stays absent
- on API-key billing the bottom border shows Pi's calculated session cost instead

The HUD and auto-compact communicate through Pi's shared extension event bus. The HUD does not read or duplicate auto-compact's configuration rules. Run `/reload` after installing or changing either extension.

On narrow terminals the footer collapses gracefully: context + repo/branch/diff survive first, then the session label; the right-side reset detail shrinks to just the countdown (`3d04h`) and then disappears.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).
