---
name: @SKILL_NAME@
description: Check web pages or apps on iPhone/iPad in the iOS Simulator without the user's hands - boot, rotate, tap/swipe, measure pages in Simulator Safari, tile iPad windows, upright screenshots. Use for "iOS simulator", "simctl", "AXe", "test on iPhone/iPad", "Safari on iOS", "landscape iPad". Not for real devices or Xcode UI tests.
---

# iOS Simulator checks

CLI: `@IOS_SIM@` (not on PATH; use the full path). `@IOS_SIM@ help` lists every command; run `doctor` first if
anything fails. DEVICE = simulator name or UDID.

## Rules

- Never use the user's mouse or keyboard: no clicks in the Simulator window, no cliclick, no osascript. ios-sim
  never takes focus; use it for everything.
- Use only the project's own devices (name prefix, e.g. `app-*`). Never erase or delete others.
- Leave devices portrait, full screen. When done, run `stop`: it shuts down the devices this session booted, and
  quits Simulator and the relay if nothing else is booted. It never stops devices other sessions started.
- Test layout in Simulator Safari, not desktop browsers' device modes: those don't match iOS.

## A check, start to finish

```
S=@IOS_SIM@
$S ensure app iPhone16=iPhone-16 iPadPro11-M4=iPad-Pro-11-inch-M4-8GB  # once: creates app-iPhone16, app-iPadPro11-M4
$S boot app-iPadPro11-M4
$S probe start                                    # relay at http://127.0.0.1:4320
$S open app-iPadPro11-M4 "http://127.0.0.1:8080/?t=$(date +%s)#probe=ipad"
$S probe wait ipad                                # until the page polls (30s)
$S rotate app-iPadPro11-M4 landscape-left          # or portrait | landscape-right; waits until done
$S probe run ipad 'return { w: innerWidth, vh: visualViewport.height }'
$S tap-el app-iPadPro11-M4 --probe ipad --selector '#search'
$S swipe-page app-iPadPro11-M4 --probe ipad --from 0.75 --to 0.3
$S screenshot app-iPadPro11-M4 /tmp/shot.png --upright
$S window app-iPadPro11-M4 left-half --probe ipad  # iPad only; then: window … full
$S rotate app-iPadPro11-M4 portrait
$S stop                                           # shut down what this session booted
```
Look at screenshots with Read. Check measurements, not just pictures.

## The probe (measuring pages)

- The page must load the relay's script: `<script src="http://127.0.0.1:4320/probe.js"></script>`. The page then
  names itself from `#probe=NAME` in its URL, or from `data-probe-name="NAME"` on the tag. The page must be served
  over `http:`. To try things without a project page: `http://127.0.0.1:4320/demo#probe=NAME`.
- `probe run NAME SCRIPT`: SCRIPT is an async function body; return JSON-safe values.
- Only the visible tab answers. A background tab doesn't resize on rotation.
- Don't use safaridriver: Safari ignores touches while WebDriver is attached.
- Useful values: `innerWidth`, `visualViewport.height` (Safari's toolbar changes it), `screen.orientation.type`,
  `scrollY`, `document.documentElement.scrollWidth` (sideways scroll), `el.getBoundingClientRect()`.
- From a node script:
  ```ts
  import { probe, waitForClient } from "@KIT@/src/probe-client.ts";
  await waitForClient("ipad");
  const w = await probe<number>("ipad", "return innerWidth");
  const r = await probe("ipad", (sel: string) => document.querySelector(sel)?.getBoundingClientRect().toJSON(), ["h1"]);
  ```
  A function argument runs in the page, so it must be self-contained.

## Gotchas

- `open` opens a new tab, unless only the `#hash` differs from an open tab: then Safari switches to that tab without
  reloading it. Always add a unique `?t=`.
- `tap-el` fails if the element's centre is off screen: scroll first (`swipe-page`, or `scrollTo` through the probe).
  On a miss, it prints a screenshot path. Read it before retrying.
- Real swipes collapse Safari's floating toolbar; `scrollTo` doesn't. Two swipes up collapse it, a short swipe down
  brings it back.
- `rotate` names: `landscape-left` = `screen.orientation.type` `landscape-primary`; `landscape-right` = `landscape-secondary`.
- iOS capitalizes the first letter typed into a search field; compare text case-insensitively.
- A probe that stops answering usually means Safari now shows another tab. The error lists the pages polling;
  take a screenshot. `stop` then `boot` resets Safari's windows to full screen.
- Stray taps can open cards, Safari's menus or other apps. Recover with Escape (`key DEVICE 41`) or a fresh URL.

## Raw input (native UI, or when there's no probe)

Coordinates are screen points in the current orientation:
`tap DEVICE X Y` · `press DEVICE X Y [--delay 1.0]` · `swipe DEVICE X1 Y1 X2 Y2` · `drag DEVICE X1 Y1 X2 Y2` ·
`key DEVICE CODE` · `type DEVICE TEXT`. For anything else, `axe DEVICE -- ARGS`: e.g. `describe-ui` (Safari's own UI
only; web content isn't in it), `tap --id SidebarButton`, `key-combo --modifiers 227 --key 39` (⌘0, reset page zoom).

`tap-check DEVICE` tests whether taps land where they're sent, and `gesture-check DEVICE` tests swipes and drags. Each
opens its own page and finds the region itself; if that misses (e.g. in a tiled window), pass
`--origin X,Y --size WxH` inside the page.

## User priorities

iPad landscape, full screen and Safari in the left half (Magic Keyboard, no on-screen keyboard) first. Then iPad
portrait, then iPhone portrait; iPhone landscape last.
