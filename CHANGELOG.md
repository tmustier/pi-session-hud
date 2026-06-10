# Changelog

## [0.1.7] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## Unreleased

- Preserve the HUD background fill on truncated lines in narrow terminals by padding after truncation with the status background reapplied, including after hard ANSI resets emitted by `truncateToWidth()`.
- Let the status label widen with the terminal instead of always truncating to 10 columns, so stale tool labels such as `subagent 38s` reappear after expanding the terminal.
- Make context-bar colours on larger-than-GPT-5.5 context windows warn at roughly GPT-5.5-equivalent token counts, so 1M-token models stop staying green/yellow for too long.
- Apply the same context warning scale to the used-token count while keeping the `/context-window` suffix muted grey.
- Reset HUD status from the current `session_start` event instead of the obsolete `session_switch` hook.

## 0.1.6 - 2026-04-23

- Fix crash during `/resume`: the HUD's render callback (and its git/worktree pollers) now survive the brief window where pi core has invalidated the old extension runtime but hasn't yet replaced the widget, instead of throwing `Error: This extension instance is stale after session replacement or reload.` out of the TUI render timer
- `renderBar` short-circuits to an empty render when the widget is disposed or the ExtensionAPI is stale
- `refreshGit` / `refreshWorktree` / initial git branch probe now swallow the same stale-extension error

## 0.1.5 - 2026-03-12

- Clamp the context bar fill to the widget width so usage above 100% renders as a full bar instead of crashing
- Show `?` for unknown context usage/token counts (for example, right after compaction before Pi has fresh usage data)

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
