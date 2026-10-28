# Testing

## Layers

- `make check`: typecheck (tsc), lint (biome), unit tests (`node --test`):
  - `test/cli.test.ts`: help, version, the prefix guard, errors without stack traces.
  - `test/fit.test.ts`: fit and inverse for identity, pure offset, 90° rotation and a scaled rotation, with noise.
    Collinear and singular inputs are refused.
  - `test/probe.test.ts`: the hub (queueing, timeouts, newer poll, abort), and the relay over HTTP. That covers a
    full run through a fake page, CORS on the page routes only, and `Origin` → 403 on `/run` and `/clients`.
- `make e2e` (opt-in, `IOS_SIM_E2E=1`): `test/e2e.test.ts` runs `./bin/ios-sim` against `sk-iPadPro11-M4`. The
  sequence: boot, relay, open `/demo`, full screen, landscape (checked from the page), `tap-el` (click recorded),
  `swipe-page` (scrolled), upright screenshot (wider than tall), left half (40–60%), full, portrait, `stop` (the
  iPad shuts down only if this run booted it). It checks that the frontmost macOS app never changed. About 50s
  warm, 70s from a cold boot. It needs `make dev-skill` (for `dev/config.json`), and it creates the device if
  missing.
- `tap-check DEVICE` and `gesture-check DEVICE` run the AXe fork's own tap recorder (`src/tap-recorder.mjs`,
  vendored). `check` taps a grid on its own page and fits it: PASS when A = identity, residuals < 3pt and ≥75% of
  taps land. `gesture` swipes one way and drags back: PASS when the page saw the deltas sent, within 6pt. Use them
  to check an AXe build. They find the region themselves, from one tap near the middle of the app frame. Where that
  misses, pass a region inside the page (taps into Safari's chrome and the dock open tabs, menus and apps).
  Regions that worked:

  | device | orientation | window | `--origin` | `--size` |
  |---|---|---|---|---|
  | iPad Pro 11" | landscape | full | `10,140` | `1190x680` |
  | iPad Pro 11" | landscape | left half | `10,135` | `580x560` |
  | iPhone 16 | landscape | full | `66,120` | `720x260` |
  | iPhone 16 | portrait | full | `10,70` | `373x600` |

## Devices

`./bin/ios-sim ensure sk iPhone16=iPhone-16 iPadPro11-M4=iPad-Pro-11-inch-M4-8GB`. Leave them portrait and full
screen. Safari tabs pile up across runs, and that may be related to the tab switching in `lessons.md`. A
shutdown (`ios-sim stop`) resets Safari's windows to full screen.

## Last verified (2026-10-28)

Xcode 26.3, iOS 26.3, axe-patched `v1.8.0-1-ge75c433`: `make check`, `make e2e`, and `tap-check` (iPad landscape
full and left half, with explicit regions and with found ones) all pass, as does `gesture-check` (iPad landscape,
full and left half). `tap-check` iPhone portrait, and `tap-el` on iPhone portrait and landscape-right,
passed on the build before it.
