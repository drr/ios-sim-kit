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
- **Unsolved: Safari switches tabs in tiled mode.** Twice, after `window left-half` and a `tap-check` with many
  tabs open, the page in front changed by itself to an older tab. The probe then got no answer from the page it
  expected. `window full` from that state also failed four times; a shutdown and boot fixed both. Not reproduced
  on demand. Mitigations so far: the probe's timeout error lists the pages polling, and `probe wait` fails clearly.
  Next steps if it recurs: check whether openurl in tiled mode opens a second Safari window, and whether tab count
  matters.
- **Upstream AXe in landscape** (1.8.0 on Xcode 26.3) can't read the simulator's orientation, so it scales and
  rotates every landscape tap: the iPad fitted A ≈ [0, 0.689; −0.689, 0]. That's why axe-patched is required. The
  fit test keeps that matrix as its non-identity case, and `tap-check` detects a bad map.
