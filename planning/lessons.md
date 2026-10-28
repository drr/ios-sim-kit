# Lessons: what didn't work, and why

Things tried while building ios-sim, kept so nobody retries them.

- **Rotation by Simulator's menus (osascript)** works only while Simulator is the active app, so it takes the user's
  keyboard focus. If another window gets raised between the raise and the click, it also rotates the wrong device.
  Replaced by `axe rotate`, which needs neither.
- **safaridriver for Simulator Safari** connects (`safari:useSimulator`, `safari:deviceUDID`), but Safari ignores all
  touch input while a session is active, and ending the session quits Safari. Hence the probe.
- **Assuming where the page is when calibrating.** Calibration first tapped fixed fractions of the page width,
  assuming the window starts at the screen's left edge. The corner-grip drag out of full screen makes a *centred*
  floating window, and every tap missed. Calibration now searches.
- **`axe describe-ui` as the only window state.** While Safari is tiled or floating, the tree reports another app
  (`DockFolderViewService`). It's used only when it shows Safari; otherwise the window comes from the page.
- **`innerWidth` as the only full-screen test.** An open Safari sidebar takes ~340pt, so a full-screen window
  measured 870. The retry loop then tapped window-control offsets that don't exist in full screen, and those taps
  hit the page. Now the window frame and sidebar decide, and the sidebar is closed first.
- **Touches on an idle tab.** On a tab fresh from `simctl openurl`, iOS WebKit dropped raw taps on a page whose
  listeners were added after its last repaint. WebKit only forwards touches to regions it knows have listeners, and
  it learns of them at a rendering update. Clicks on real buttons still worked, which was confusing. Fix: the
  recorder appends a 1px element and waits two animation frames.
- **`simctl openurl` and hashes.** If the URL differs from an open tab's only in its hash, Safari switches to that
  tab and changes the hash without reloading. The page keeps its old probe name, and the new name never connects.
  Use a unique `?t=`.
- **Background tabs.** They don't resize on rotation, and they kept polling under their name. Jobs went to
  whichever tab polled last: a test measured 834 wide in landscape from a hidden tab. Pages now poll only while
  visible, and calibration refuses hidden pages.
- **Safari "switching tabs" in tiled mode** was ios-sim's own tap. `setWindow` aimed at the window controls' pill
  at a fixed offset (−32pt) above the page. That holds without a tab bar, but with more than one tab a regular-width
  window shows a 42pt tab bar, and the tap landed on it: no tab in front, the probe unanswered. Reproduced on demand
  (2026-10-28) going from the right half to the left with five tabs. watched-media hit the same from a floating,
  regular-width window. A first fix (pill at a fixed y for tiled windows, −38 from the page for floating ones)
  assumed floating windows are compact, which a rotated tile needn't be. The lights are now found in a screenshot,
  and every tap is preceded by a check that the page is still in front (`architecture.md`).
- **The accessibility tree as the window's state.** After a rotation it went stale: `window full` reported success
  on a 375-wide floating window (reported by watched-media). The page's own frame is now the state.
- **Resizing a floating window.** It grows about its centre, and after one drag stopped responding to edge drags.
  `--width` tiles the window first.
- **The e2e test in the caller's session.** It ran under the calling Claude session's id, so its `stop` also shut
  down an iPad the caller had booted, and its "left alone" check failed. It now sets its own `IOS_SIM_SESSION`.
- **Two booted devices** (iPhone and iPad) didn't interfere: rotating and tapping one left the other's orientation,
  width and clicks unchanged. No warning needed.
- **`window.name` to carry the probe's name past an app's URL rewrites.** The plan: `open --probe` opens a hop page
  on the relay that sets `window.name` and replaces itself with the app's URL. WebKit (iOS 26.3) clears
  `window.name` on any cross-origin navigation, including the same host on another port
  (`127.0.0.1:4321` → `127.0.0.1:8088` arrived as `""`). It survives only same-origin, where sessionStorage already
  works. Dropped. A late-loading probe needs `data-probe-name`.
- **Resizing a window from just inside its edge.** A drag starting 1pt inside the window is a long press on the
  page (it selects text); small drags from a half tile also snapped back. Starting 3pt outside the edge resizes
  to within ~1px.
- **Upstream AXe in landscape** (1.8.0 on Xcode 26.3) can't read the simulator's orientation, so it scales and
  rotates every landscape tap: the iPad fitted A ≈ [0, 0.689; −0.689, 0]. That's why axe-patched is required. The
  fit test keeps that matrix as its non-identity case, and `tap-check` detects a bad map.
