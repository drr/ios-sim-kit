# ios-sim-kit

`ios-sim`, a CLI, plus a Claude skill for checking web pages and apps on iPhone and iPad in the iOS Simulator,
without anyone at the mouse. It covers devices, rotation, iPad window tiling, taps verified by where the page saw
them, page measurements, and upright screenshots. No command takes the Mac's keyboard focus.

## Requirements

- macOS with Xcode in `/Applications/Xcode.app`, and `xcode-select -p` pointing at it. Also an iOS runtime
  (`xcodebuild -downloadPlatform iOS`).
- **`~/bin/axe-patched`**: [AXe](https://github.com/cameroncooke/AXe) built from the fork
  `github.com/drr/AXe`, branch `drr/landscape-orientation`, with `make -f drr.mk install-patched`. It adds
  `axe rotate` and maps taps correctly in landscape. Upstream AXe has neither, and ios-sim won't work without them.
- node 24.21.0 through nvm (`.nvmrc`).

`ios-sim doctor` checks all of these.

## Install

```
make setup      # once: dev tools (tsc, biome) with the pinned node
make check      # typecheck, lint, unit tests
make install    # ~/.local/share/ios-sim-kit/, ~/bin/ios-sim, the skill ~/.claude/skills/ios-sim/
```
The installed copy doesn't depend on this repo; `make install` ends with `make verify-install`, which checks that.
`make uninstall` stops a running relay and removes the installed code, wrapper, skill and state. It keeps a
`config.json` you wrote and never touches axe-patched; `make verify-uninstall` checks the result.
Optional config: `~/.config/ios-sim-kit/config.json`, e.g. `{"prefix": "app", "probePort": 4320}`. `prefix` makes
ios-sim refuse devices whose name lacks `app-`, and `axe` overrides the AXe path.

## Use

`ios-sim help` lists the commands, and `skill/SKILL.md` shows a check from start to finish. `ios-sim stop` ends a
check: it shuts down the devices the session booted, and quits Simulator and the relay once nothing else is booted.

To measure a page, the page loads the probe script from the relay that `ios-sim probe start` runs:
```html
<script src="http://127.0.0.1:4320/probe.js"></script>   <!-- named by #probe=NAME in the page's URL -->
```
Scripts can also drive it from node: `import { probe } from "~/.local/share/ios-sim-kit/src/probe-client.ts"`.

## Develop

- `./bin/ios-sim` runs this repo's `src/`, with config and state in `./dev/`.
- `make dev-skill` writes the project-only skill `ios-sim-dev`, pointing at `./bin/ios-sim`, plus
  `dev/config.json` (prefix `sk`, relay port 4321). Neither touches the installed copy.
- `make e2e` drives the `sk-*` simulators through `./bin/ios-sim`.
- Docs for maintainers are in `planning/`. Start at `planning/PLAN.md`.
