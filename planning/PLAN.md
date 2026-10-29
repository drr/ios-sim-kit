# ios-sim-kit: plan and status

## Goal

A reusable tool, so that Claude doesn't have to re-learn how to drive the iOS Simulator in each project. `ios-sim`
(CLI) and the `ios-sim` skill cover devices, rotation, iPad window tiling, calibrated and verified taps, upright
screenshots, and a probe for measuring pages in Simulator Safari. With them, any project can check its iPhone and
iPad experience without the user testing by hand.

More detail: `architecture.md` (modules, probe protocol, calibration, windows), `testing.md` (test layers, device
runs), `lessons.md` (what didn't work, and why).

## Invariants

- **Never take over the user's mouse or keyboard.** Touches go through AXe, rotation through `axe rotate`. No
  cliclick, osascript, Simulator menus or clicks in the Simulator window. Every command leaves the frontmost macOS
  app unchanged, and the E2E test checks this.
- **Production is a copy**, written only by `make install`: `~/.local/share/ios-sim-kit/` (code + VERSION),
  `~/bin/ios-sim`, `~/.claude/skills/ios-sim/`, `~/.config/ios-sim-kit/config.json` (optional, never overwritten).
  Editing the repo never changes what other sessions use.
- **The installed copy must not depend on this repo.** Deleting it must leave the CLI and skill working, so
  everything the skill names gets installed. `make verify-install` fails if an installed file mentions
  `ws/ios-sim-kit`, and it runs the CLI from `/`.
- **Dev copy:** `./bin/ios-sim` with `IOS_SIM_HOME=./dev`, and the project-only skill `ios-sim-dev`. In this repo,
  use these.
- State (calibration cache, failure screenshots) goes under `IOS_SIM_HOME`, never in a hard-coded path.
- Devices: this repo uses only its own `sk-*` simulators. Other prefixes belong to other projects. Never erase or
  delete them.
- Runtime: node 26.13.0 pinned (`.nvmrc`, `engines`), with type stripping; `check-node` refuses pins below the
  October 2026 security fixes. No runtime dependencies. Dev deps are exact-pinned and installed with the pinned
  node first on PATH, with install scripts off (`.npmrc`).
- Do things the way the AXe fork (`github.com/drr/AXe`) does unless there's a reason not to; its tap recorder is
  vendored as is. Deliberate differences: `rotate` waits for backboardd and the page rather than a fixed 1.5s,
  `boot` waits on `bootstatus` rather than sleeping, and `uninstall` checks before deleting because ios-sim leaves
  state and a relay.
- The skill covers usage only, kept terse: it loads into sessions. Background belongs here.
- Release: `make check`, the user commits (and tags if wanted), then `make install`. VERSION comes from
  `git describe`.

## Status (2026-10-28)

Done: tooling (`make setup`/`check`), devices (`ensure`, `boot`, `stop`, `open`, name/UDID resolution with prefix
guard), rotation, raw AXe gestures, upright screenshots, the probe relay with the module API, calibrated `tap-el` and
`swipe-page`, iPad `window full|left-half`, the skill, unit tests and an opt-in E2E test. Verified on iPad Pro 11"
and iPhone 16 (iOS 26.3); see `testing.md`.

Open:
- First commit, then `make install`, and check `~/bin/ios-sim doctor` and `verify-install`.
- An MCP server only if the CLI proves clumsy in practice. If built, it must wrap the same CLI and module, not
  duplicate them.

Done since (2026-10-28, requests from watched-media): the probe's name key is `ios-sim-probe=` (query or
hash; `#probe=` dropped), `open --probe NAME`, `window right-half`, `window --width W`, `probe run --wait-ms`, and
the fix for the tiled-mode tab switch (`lessons.md`). Then: window lights found in screenshots
(`png.ts`), the page's frame as the window state, a check before every tap, `safari-reset` / `open --only`, a
clearer "no answer" error.

Done since (2026-10-28, round 2 from watched-media): `tabs
DEVICE` (from SafariTabs.db), `open` waits until Safari shows the tab (a plain `open` right after `--only` used to
replace the first page), `open --new-tab` (⌘T, count checked), and `feedback` with the run history.

## Feedback from other projects

Sessions using the skill file bugs and requests with `ios-sim feedback`; they wait in `~/.config/ios-sim-kit/feedback/`.
Work through them with the project skill `process-feedback`. A SessionStart hook says when any are waiting.

Ideas, not committed to:
- `tap-el --scroll`: scroll the element into view first.
- Find out why Safari switches tabs in tiled mode (`lessons.md`).
