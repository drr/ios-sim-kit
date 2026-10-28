# Architecture

## Modules (`src/`)

| file | what |
|---|---|
| `cli.ts` | argument parsing and dispatch; `doctor` |
| `config.ts` | `IOS_SIM_HOME`, `config()`: `axe`, `prefix`, `probePort` |
| `sim.ts` | simctl and AXe: `devices`, `resolve` (prefix guard), `ensure`, `boot`, `openUrl`, `safariReset`, `axe`, `orientation`, `rotate`, `screenshot` |
| `png.ts` | PNG decoding (8-bit RGB/RGBA, node's zlib) and `findLights`: the iPad window lights in a screenshot |
| `fit.ts` | least-squares affine fit page = A·screen + b, `apply`, `invert` |
| `probe-hub.ts` | job queue between tools and pages (long-poll) |
| `probe-relay.ts` | the HTTP relay around the hub, plus the `/demo` test page |
| `probe-page.js` | page side, served as `/probe.js` |
| `probe-client.ts` | tool side and module API: `probe`, `clients`, `waitForClient`, `ensureRelay`, `stopRelay` |
| `page.ts` | gestures aimed through the probe: calibration, `tapEl`, `swipePage`, `setWindow`, `setWindowWidth`, `safariWindow` |
| `tap-recorder.mjs` | `tap-check`, `gesture-check`, `tap-serve`: vendored verbatim from the AXe fork (`planning/tap-recorder.mjs` there) so both projects check taps the same way. Update it by copying; biome skips it |

`page.ts` sends functions to the page as source (`fn.toString()`), so those functions must be self-contained. The
tsconfig includes the DOM lib for them.

## Orientation

`axe rotate` sends the same device-orientation event as Simulator's Device menu, without focus. The current
orientation is read from the device: `simctl spawn UDID notifyutil -g com.apple.backboardd.orientation` gives 1
portrait, 2 upside down, 3 landscape-left, 4 landscape-right. It gives 0 after boot until the first rotation, and
the UI is portrait then. `rotate` polls that value, then waits 2.5s (3s for a 180° flip) for the UI.
`screenshot --upright` turns the portrait framebuffer by 270/90/180 degrees.

## Sessions and `stop`

`boot` records a device in `$IOS_SIM_HOME/booted.json`, with the session (`CLAUDE_CODE_SESSION_ID`, or
`IOS_SIM_SESSION`), only when that call actually booted it. A device that was already running belongs to whoever
started it. `stop` shuts down this session's recorded devices, or the devices named (prefix guard applies). Once
no simulator at all is booted, it quits Simulator.app (`pkill -x Simulator`, SIGTERM: no osascript, no focus) and
stops the relay. If another session is using a device this session booted, `stop` still shuts it down.

State kept for later sessions: calibrations (`cal/`; they spare re-calibration when the page geometry matches) and
failure screenshots (`shots/`, named by device, command and time). Nothing prunes `shots/`. `make uninstall`
removes both.

## Probe

Safari ignores touches while WebDriver is attached, so pages fetch their own jobs instead.
- Page: `GET /probe.js`, then a loop of `GET /next?client=NAME` (a long poll of ~20s; 200 `{id, script}` or 204).
  It runs the job as an async function body and posts `POST /result {id, ok, value|error}`. It polls only while
  its tab is visible, and aborts the open poll when the tab hides. Its name comes from `data-probe-name`, then
  `ios-sim-probe=NAME` in the query or hash, then `sessionStorage`. The key is long so it can't collide with a
  page's own (watched-media has `#probe=`); `open --probe NAME` adds it to the hash, or the query if the URL has a
  hash.
- Tool: `POST /run {client, script, timeoutMs}` answers with the page's result. `GET /clients` lists the pages seen
  in the last 30s.
- Security: the relay binds 127.0.0.1. `/probe.js`, `/next` and `/result` send `Access-Control-Allow-Origin: *`,
  since the page is on another origin. `/run` and `/clients` are loopback-only, send no CORS headers, refuse
  preflights, and refuse any request with an `Origin` header. Browsers always send one, so no web page can submit
  jobs. Job ids are random UUIDs, so a page can't answer another page's job by guessing.
- `ensureRelay()` starts `ios-sim probe serve` detached, unless `GET /` already answers `{probe: "ios-sim"}`.
  `stopRelay()` kills the pid that the relay reports.

## Calibration and verified taps

- The recorder in the page logs `pointerdown` client points into `__taps`. While `__block` is set, it swallows
  `click`s. After adding its listeners it forces a repaint (see `lessons.md`).
- Calibrating first finds the page: it taps from the left third of the page width, then a grid around the screen's
  middle band, clear of the status bar and dock, until one tap lands. From that hit it aims four more taps well
  inside the page, then fits A and b. It rejects residuals over 3pt. With axe-patched, A = identity.
- The cache lives in `$IOS_SIM_HOME/cal/<udid>-<client>.json`. It's keyed by orientation, `innerWidth`/`innerHeight`,
  `visualViewport` offset and height, and screen size. Any change recalibrates.
- `tapEl` taps the inverse of the element's centre and checks that the recorded point lies inside the rect (±2pt).
  On a miss it drops the cache, recalibrates and retries once. On a second miss it fails with a screenshot in
  `$IOS_SIM_HOME/shots/`.

## iPad windows (iPadOS 26.3)

- State comes from the page: a fresh calibration gives its origin on screen and its size. Full = `innerWidth` ≥
  screen width − 2 and the page reaches within 30pt of the screen's bottom (a top half would also span the width),
  and no window lights on screen. A half is 45–55% of the screen wide, with x < 20 (left) or its right edge within
  20 of the screen's (right). The accessibility tree is used only for the sidebar (`Sidebar`, toggled by
  `SidebarButton`), which it shows correctly in full screen. For the window frame it's unreliable: outside full
  screen it shows another app, and after rotating a tiled window it reported a full-screen frame for a 375-wide
  floating one.
- The window lights (the controls at a window's top left) are found by colour in an upright screenshot
  (`findLights`): red, yellow and green blobs in a row, evenly spaced, within 200×140pt above and left of the
  page's origin. Closed they're ~10pt apart (the pill), open ~35pt. No offsets from the page: the toolbar above it
  varies (compact, regular, regular with a 42pt tab bar when there's more than one tab), and a tap that misses the
  pill can land on a tab.
- Moves, up to four rounds: check that the page is still the visible tab (it answers within 3s), or stop with a
  screenshot; close an open sidebar; if the state is right, done. From full screen (no lights), drag the corner
  grip (6pt in from the bottom-right) to (60%, 80%), which makes a floating window. Tap the closed pill's middle
  (yellow), check that the lights opened, long-press the green one where it was found, and tap the menu item at an
  offset from it: Move & Resize → left half (−64, +83), right half (−11, +83); Fill & Arrange → Fill (−64, +162).
  The menu also has top and bottom halves and layouts for several windows; ios-sim doesn't use them. The menu items
  are the one set of offsets left, measured on iPadOS 26.3; re-measure them with screenshots after an update.
- Any width (`setWindowWidth`): from full screen, a floating window or with the sidebar open, go to the left half
  first; only a tiled window resizes predictably (a floating one grows about its centre, then stops responding).
  Then drag the window's side edge horizontally by the difference, at mid-height: the right edge, or the left one
  for a window against the screen's right edge. The grab zone is 3pt *outside* the window; 1pt inside, the drag is
  a long press on the page (text selection). Each drag lands within ~1px; up to six rounds, stopping when the width
  stops changing. iPadOS's minimum is 375 (landscape and portrait). The bottom edge isn't used: in compact layout
  the page's bottom isn't the window's.

## Safari's tabs

`safariReset` (`safari-reset`, `open --only`): `simctl terminate` Safari, then delete `SafariTabs.db*` from
`~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/Safari/`. The next `openurl` starts Safari with that
one tab. Verified on iOS 26.3.
