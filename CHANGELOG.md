# Changelog

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
