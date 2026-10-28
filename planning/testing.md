# Testing

## Layers

- `make check`: typecheck (tsc), lint (biome), unit tests (`node --test`):
  - `test/cli.test.ts`: help, version, the prefix guard, errors without stack traces.
  - `test/fit.test.ts`: fit and inverse for identity, pure offset, 90° rotation and a scaled rotation, with noise.
    Collinear and singular inputs are refused.
  - `test/png.test.ts`: the decoder (none, sub and up filters) and `findLights` (closed and open lights, a teal
    decoy, the region, a missing green) on synthesized PNGs.
  - `test/probe.test.ts`: the hub (queueing, timeouts, newer poll, abort), and the relay over HTTP. That covers a
    full run through a fake page, CORS on the page routes only, and `Origin` → 403 on `/run` and `/clients`.
- `make e2e` (opt-in, `IOS_SIM_E2E=1`): `test/e2e.test.ts` runs `./bin/ios-sim` against `sk-iPadPro11-M4`. The
  sequence: boot, relay, open `/demo`, full screen, landscape (checked from the page), `tap-el` (click recorded),
  `swipe-page` (scrolled), upright screenshot (wider than tall), left half (45–55%), `--width 498` (±4) and `tap-el`
  there, right half (same width as the left), rotate to portrait and `full` (834), back to landscape, a corner drag
  to a floating window and `full` (1210), portrait, `stop`. It opens with `--only` and then adds tabs, so Safari
  shows its tab bar throughout. It runs under its own `IOS_SIM_SESSION`, so `stop` shuts the iPad down only if this
  run booted it. It checks that the frontmost macOS app never changed. About 125s. It needs `make dev-skill` (for `dev/config.json`), and it creates the device if
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
screen. Safari tabs pile up across runs; `open --only` (or `safari-reset`) starts with one. A shutdown
(`ios-sim stop`) resets Safari's windows to full screen.

## Device isolation

Every device command goes by UDID: `resolve` turns a name into exactly one device (it refuses a name two
simulators share, and devices outside the prefix), and `rotate` sends `axe rotate --udid` and confirms it from that
device's backboardd. Nothing acts on the window in front. Checked by hand (2026-10-28), each step reading both
devices' `orientation` and their pages (`innerWidth`, `screen.orientation.type`, clicks):

- Same model: `sk-iPadPro11-M4` and a temporary second iPad Pro 11" (`ensure sk iPadPro11-M4b=…`, deleted after),
  both booted. Rotating A to landscape-left, B to landscape-right, A to portrait-upside-down, and `tap-el` on each,
  changed only the device named. Renaming B to A's name made `rotate` refuse ("2 simulators are named …; use its
  UDID"), with neither device moving.
- Different models: `sk-iPhone16` and `sk-iPadPro11-M4`, rotate and `tap-el` on each: likewise.

## Last verified (2026-10-28)

Xcode 26.3, iOS 26.3, axe-patched `v1.8.0-1-ge75c433`: `make check`, `make e2e`, and `tap-check` (iPad landscape
full and left half, with explicit regions and with found ones) all pass, as does `gesture-check` (iPad landscape,
full and left half). `tap-check` iPhone portrait, and `tap-el` on iPhone portrait and landscape-right,
passed on the build before it.

Later the same day, after watched-media's requests: `make check` (16 tests);
`make e2e` 3 of 3 from a cold iPad and once with the iPad already booted by the caller (an earlier failure was the
session mix-up in `lessons.md`). By hand on the iPad,
landscape and portrait: left/right half and full from each other with five tabs open, `--width` 498/520/800/511/400
(within 1px), 300 (stops at 375, exit 1), and `tap-el` on a 499-wide window. With four tabs: full → floating →
`--width 640` → full → floating → full → left → portrait → full → landscape → right → portrait → left → full, all
correct; `window` with another tab in front stops in ~4s with a screenshot. `safari-reset` leaves one tab. Device
isolation: see above.
