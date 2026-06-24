# /hud — Session HUD

A tiny Pi extension that replaces Pi’s multi-line footer with one compact context/location/session line and gives the input box Amp-style model chrome.

```text
╭──────────────────────────────────────── gpt-5.5 • xhigh ╮
│ prompt text wraps inside a one-column gutter              │
╰───────────────────────────────────────── (openai-codex) ╯
 ██░░░░ 36% 98k/272k │ ~/projects/pi-session-hud (main) +12 -3 | Simplify HUD…     56% (ahead +8%)
```

Only the context bar/text, git diff stats, session label, and right-side usage metric use colour for quick visual scanning. The model/thinking label sits in the top editor border; the provider label stays in the bottom editor border. The footer has the same left gutter as the editor content, the `│` divider is muted grey, first-message session fallbacks render muted grey, and named sessions render white. There is no separate cwd/session-name row, activity status, extension status row, or background fill.

## What it shows

- Colour-coded context usage bar
- Colour-coded context percentage
- Colour-coded used tokens / context window
- Current working directory
- Current git branch when available
- Git diff stats (`+x -y`, or `~` for dirty-without-line-count changes)
- Session name, or the first few words of the first user message when unnamed
- Right-aligned session cost (`$0.000`) when not using subscription auth
- Right-aligned subscription utilisation when OpenAI/Codex or Anthropic OAuth usage data is available, including `ahead +x%` when consumption is ahead of elapsed window time
- Top-border model + thinking label
- Bottom-border provider label
- One-column input gutter with word wrapping inside a full border
- Matching footer gutter, muted divider, grey first-message fallback, and white named session label

## Install

### Pi package manager (npm)

```bash
pi install npm:@tmustier/pi-session-hud
```

### Pi package manager (git)

```bash
pi install git:github.com/tmustier/pi-session-hud
```

### Local clone

Symlink into Pi’s auto-discovered extensions directory:

```bash
ln -s ~/pi-session-hud/pi-session-hud.ts ~/.pi/agent/extensions/
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/pi-session-hud/pi-session-hud.ts"]
}
```

## Usage

In Pi:

- Toggle HUD: `/hud`
- Aliases: `/status`, `/header`

## Changelog

See `CHANGELOG.md`.
