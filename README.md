# /hud — Session HUD

A Pi extension that adds a persistent heads-up display **below the editor** (above Pi’s built-in footer).

## Demo

![Session HUD demo](https://raw.githubusercontent.com/tmustier/pi-session-hud/main/assets/demo.gif)

Full-quality MP4: https://raw.githubusercontent.com/tmustier/pi-session-hud/main/assets/demo.mp4

HUD placement (below editor/input, above footer):

![HUD placement](https://raw.githubusercontent.com/tmustier/pi-session-hud/main/assets/hud-below-video.png)

(Hosted on GitHub so npm users see the media in README, but `npm install` stays small.)

## What it shows

- Activity state (idle / running / tool / error / stale)
- Session name (or cwd) and first user message fallback
- Git branch + worktree marker (`⎇ name current/total` when multiple) + diff stats
- Context usage (% + tokens)
- Current model (+ thinking level)

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

## Notes

- Uses `ctx.ui.setWidget(..., { placement: "belowEditor" })` so it’s not the footer and not a header.
- Git stats are refreshed every ~10s via `git diff --stat HEAD` + `git status --porcelain`.

## Changelog

See `CHANGELOG.md`.
