# Changelog

## [Unreleased]

## [0.6.2] - 2026-09-10

- Fix usage pace direction and colour in the quota popup: using more quota than the elapsed share of the window is now `ahead` in red; using less is `behind` in green.

## [0.6.1] - 2026-09-10

- Fix extension statuses pushing the HUD's own weekly reset countdown off the footer. Any overflow used to drop the whole right side, so with a few extensions that set statuses the countdown never appeared even on wide terminals. Statuses are ancillary: the countdown always stays, and the statuses that fit beside it are kept in order.

## [0.6.0] - 2026-09-10

Requires Pi's fullscreen TUI mode (`--tui-mode fullscreen` or the `tuiMode` setting) for the mouse features; in regular mode Pi does not capture mouse input and the HUD behaves as before.

### Added

- Model and thinking popups on the input border. The model id opens a popup listing the session's scoped models (`--models` or `enabledModels`, the same set as `/scoped-models`) plus `Other…`, which opens Pi's full model selector on the all scope; with no scope configured a click goes straight to Pi's selector. The thinking level lists the levels the current model supports. Pick with a click or the arrow keys and Enter.
- Hover to preview, click to pin. Moving the pointer onto a label opens its popup without taking focus, so typing keeps going to the editor and dismisses it; the popup follows the pointer between labels and closes when the pointer leaves. Clicking the label pins it for keyboard navigation until you pick, press Escape, click the label again, or click anywhere else that takes focus. Hover needs pointer-motion reporting, which Pi turns off under tmux, zellij and screen; there the popups still open on click.
- Usage popup on the quota label on the bottom border: one line per window the provider reports, with `% used`, the pace against a steady burn through the window (`12% ahead` in green, `12% behind` in red, or `on pace`) and the reset countdown. A `5h:` line appears when the provider reports a 5-hour window (Anthropic does; Codex plans without one show only the weekly line). Session-cost labels have no popup.
- Chrome menus for other extensions (`chrome-menu.ts`). An extension can add its own label and popup to the input border, an informational label, or rows appended to the model or thinking popup, all over `pi.events` with a request/announce handshake so load order does not matter. See the README for the protocol.
- `thinking off` is shown on reasoning models instead of dropping the thinking segment, so a click can turn thinking back on; models without thinking support show only the model id, matching Pi's footer.

### Fixed

- The Anthropic subscription quota had been missing from the HUD: the usage endpoint reports `utilization` in percent while the response headers use a 0-1 fraction, and the parser only accepted the fraction. Each source is now read in its own unit, and both supply the 5-hour window.
- The OpenAI Codex subscription usage probe on Pi 0.80.8 and newer, where `modelRegistry.authStorage` no longer exists; the account id is now read from the OAuth access token as Pi itself does.
- Usage probe and Git refresh results are kept when other events fire while they are in flight. Pi builds a fresh context object per event, so the previous identity check discarded most results and left the weekly quota missing until the next five-minute probe.
- Mouse input that is not on a label is forwarded to the wrapped editor in its own coordinate space, so click-to-position, drag selection and autocomplete clicks keep working inside the HUD frame.
- An open popup is closed when the HUD is turned off or the session shuts down.

### Changed

- Built and type-checked against Pi 0.85.1. `@earendil-works/pi-ai` joins the peer dependencies (it ships with Pi) for the list of thinking levels a model supports.

## [0.5.3] - 2026-09-01

- Stop polling Git while idle and omit expensive line counts in git-crypt repositories.
- Treat OpenAI Codex `used_percent` values as percentages so 1% usage is not displayed as 100% used.
- Keep OpenAI subscription usage visible and current across model switches.

## [0.5.2] - 2026-08-08

- Compose the HUD chrome with an existing custom editor instead of replacing it through a deferred install race.
- Preserve custom-editor behavior and content, including borderless editors and extensions that wrap the HUD later.
- Restore the previous editor cleanly when toggling the HUD off.
- Remove obsolete widget cleanup and unreachable footer-data fallbacks.

## [0.5.1] - 2026-08-08

- Read Pi's standard `fast-mode` extension status so the input-border lightning indicator updates immediately and no longer depends on package or request-hook order.
- Preserve other extensions' status text in the compact footer instead of discarding it when replacing Pi's stock footer.
- Keep serialized provider-request inspection as a fallback for fast-tier integrations that do not publish a status.

## [0.5.0] - 2026-08-08

- Show the single-column lightning symbol `↯` when the latest serialized provider request contains `service_tier: "priority"` or `speed: "fast"`.
- Observe fast-tier requests passively without depending on, configuring, or changing a fast-mode extension.
- Clear the last-request observation when the session or selected model changes.
- Keep the input border connected in narrow terminals by avoiding ambiguous-width variation sequences in the fast-mode label.

## [0.4.1] - 2026-07-16

- Keep the established fixed token colour bands when auto-compact lowers the displayed context window.
- Add a muted down arrow to capped context limits, for example `10k/200k↓`.

## [0.4.0] - 2026-07-15

- Use the active `pi-auto-compact` threshold as the HUD context limit when it is lower than the provider context window.
- Recalculate the displayed percentage and context colour against that effective limit.
- Keep the provider context window when auto-compact is absent or its threshold is not the binding limit.
- Add strict type checking and focused tests for context-limit integration.

## [0.3.2] - 2026-06-24

- Move the usage metric into the input box bottom border.
- Move provider/reset detail to the footer right side without parentheses, in muted grey.
- Show only the provider name in the footer when using API-key billing.
- Make the footer responsive: preserve context + repo/branch/diff before session text, collapse reset detail to countdown-only, then hide it on very narrow terminals.

## [0.3.1] - 2026-06-24

- Change subscription quota display from weekly percent used to weekly percent left.
- Replace `ahead +x%` with a weekly reset countdown, for example `44% left (weekly reset in 3d04h)`.

## [0.3.0] - 2026-06-24

- Add a right-aligned footer usage slot below the input box.
- Show Pi's calculated session cost for non-subscription auth.
- Show OpenAI/Codex weekly subscription utilisation when Codex rate-limit headers or the Codex usage endpoint provide it.
- Show Anthropic weekly subscription utilisation when Anthropic rate-limit headers or the Claude OAuth usage endpoint provide it.
- Add `ahead +x%` when provider usage is ahead of elapsed weekly-window time.

## [0.2.1] - 2026-06-24

- Render unnamed first-message session fallbacks in muted grey instead of italics.
- Render named sessions in the normal white text colour.

## [0.2.0] - 2026-06-23

- Replace the below-editor widget plus default Pi footer with a single compact context/location footer line.
- Remove the duplicated cwd footer row and extension status row from the area below the input box.
- Keep context bar/text colours for quick context-usage scanning.
- Restore git diff stats after the project/branch label (`+x -y`, with `~` for dirty-without-line-count changes).
- Move model/thinking into the top editor border and keep provider in the bottom editor border.
- Add a one-column editor gutter and wrap the input inside a full border.
- Add a one-space matching footer gutter so the context/location line aligns with editor content.
- Render the footer `│` divider in the same muted grey as the provider label.
- Italicize the first-message session fallback after the project path. (Revised in 0.2.1.)
- Include the session name, or the first few words of the first user message when unnamed, after the project path.

## [0.1.8] - 2026-06-10

- Preserve the HUD background fill on truncated lines in narrow terminals by padding after truncation with the status background reapplied, including after hard ANSI resets emitted by `truncateToWidth()`.
- Let the status label widen with the terminal instead of always truncating to 10 columns, so stale tool labels such as `subagent 38s` reappear after expanding the terminal.
- Make context-bar colours on larger-than-GPT-5.5 context windows warn at roughly GPT-5.5-equivalent token counts, so 1M-token models stop staying green/yellow for too long.
- Apply the same context warning scale to the used-token count while keeping the percentage and `/context-window` suffix muted grey.
- Add configurable context colour bands via `pi-session-hud.json`, including absolute-token or percentage modes plus provider/model overrides.
- Reset HUD status from the current `session_start` event instead of the obsolete `session_switch` hook.

## [0.1.7] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

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
