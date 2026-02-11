# Changelog

## 0.1.4 - 2026-02-11

- Restore demo GIF/MP4 to the original capture with the HUD visible below the editor
- Add a static HUD placement screenshot below the demo video in README
- Continue hosting media on GitHub (not included in npm package files)

## 0.1.3 - 2026-02-11

- Refresh demo assets from latest screen recording and trim to seconds 1–7
- Update README demo media links to `main` so npm/README renders current assets from GitHub
- Keep npm package lightweight by continuing to exclude `assets/` from published files

## 0.1.2 - 2026-02-11

- Add worktree awareness on the main HUD line when a repo has multiple worktrees.
  - Shows `⎇ <name> <current>/<total>` (example: `⎇ tui-typing 13/14`)
  - Hidden automatically for single-worktree repos
- Improve worktree detection for main vs linked worktrees
- Reset worktree state on install/session switch to avoid stale labels
- Docs: update README “What it shows” and demo links for the `v0.1.2` tag

## 0.1.1 - 2026-02-07

- README demo embed (GIF + MP4 hosted on GitHub)
- Keep npm package small (demo media not included in published tarball)

## 0.1.0 - 2026-02-07

Initial release.

- Persistent session HUD widget placed **below the editor**
- Shows activity state, session/cwd, git branch + diff stats, context usage, model + thinking level
- `/hud` command (with `/status` and `/header` aliases)
