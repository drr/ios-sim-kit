// The device test, opt-in (make e2e, or IOS_SIM_E2E=1): drives sk-iPadPro11-M4 through ./bin/ios-sim, the way a
// project would. Needs the sk-* devices (ios-sim ensure sk iPadPro11-M4=iPad-Pro-11-inch-M4-8GB) and dev/config.json
// (make dev-skill). Leaves the iPad portrait, full screen, and shut down if this run booted it. Never changes which
// macOS app is in front.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/ios-sim", import.meta.url).pathname;
const DEV = "sk-iPadPro11-M4";
const CLIENT = `e2e-${Date.now().toString(36)}`;

// Its own session, so its `stop` leaves alone a device the calling session booted.
const env = { ...process.env, IOS_SIM_SESSION: CLIENT };
const sim = (...args: string[]) =>
  execFileSync(BIN, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
const run = <T>(script: string): T => JSON.parse(sim("probe", "run", CLIENT, script)) as T;
const front = () =>
  execFileSync(
    "lsappinfo",
    ["info", "-only", "name", execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim()],
    { encoding: "utf8" },
  ).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(file: string) {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("iPad: boot, probe, rotate, tap, swipe, screenshot, tile, resize and back", {
  skip: !process.env.IOS_SIM_E2E,
}, async () => {
  const app = front();
  sim("ensure", "sk", "iPadPro11-M4=iPad-Pro-11-inch-M4-8GB");
  const bootedHere = sim("boot", DEV).endsWith("booted");
  const relay = sim("probe", "start");
  sim("rotate", DEV, "portrait");
  // A new tab: openurl switches to an open tab whose URL differs only in the hash, without reloading it.
  // A few stale tabs, so Safari shows its tab bar; then ours.
  // A plain open straight after --only used to land in the same tab (Safari still starting); open now waits for it.
  sim("open", DEV, `${relay}/demo?t=${Date.now()}a`, "--only");
  assert.equal(sim("tabs", DEV).split("\n").length, 1);
  sim("open", DEV, `${relay}/demo?t=${Date.now()}b`);
  assert.equal(sim("open", DEV, `${relay}/demo?t=${Date.now()}`, "--probe", CLIENT, "--new-tab"), `${DEV}: 3 tabs`);
  const tabs = JSON.parse(sim("tabs", DEV, "--json")) as { active: boolean; url: string }[];
  assert.deepEqual(
    tabs.map((t) => t.active),
    [false, false, true],
  );
  assert.match(tabs[2]?.url ?? "", new RegExp(`ios-sim-probe=${CLIENT}`));
  sim("probe", "wait", CLIENT);
  sim("window", DEV, "full", "--probe", CLIENT);
  assert.equal(run<number>("return innerWidth"), 834);

  sim("rotate", DEV, "landscape-left");
  assert.equal(sim("orientation", DEV), "landscape-left");
  assert.equal(run<string>("return screen.orientation.type"), "landscape-primary");
  assert.equal(run<number>("return innerWidth"), 1210);

  sim("tap-el", DEV, "--probe", CLIENT, "--selector", "#c");
  assert.deepEqual(run<string[]>("return window.clicks"), ["c"]);

  sim("swipe-page", DEV, "--probe", CLIENT);
  assert.ok(run<number>("return scrollY") > 100, "the swipe scrolled the page");

  const shot = join(mkdtempSync(join(tmpdir(), "ios-sim-e2e-")), "landscape.png");
  sim("screenshot", DEV, shot, "--upright");
  const { w, h } = pngSize(shot);
  assert.ok(w > h, `upright landscape screenshot is ${w}x${h}`);

  assert.match(sim("window", DEV, "left-half", "--probe", CLIENT), /innerWidth (\d+)/);
  const half = run<number>("return innerWidth");
  assert.ok(half > 1210 * 0.45 && half < 1210 * 0.55, `left half is ${half} wide`);
  // Below ~511, iPad Safari switches to its compact (iPhone-style) chrome.
  assert.match(sim("window", DEV, "--width", "498", "--probe", CLIENT), /innerWidth (\d+)/);
  assert.ok(Math.abs(run<number>("return innerWidth") - 498) <= 4);
  run("scrollTo(0, 0); return true");
  sim("tap-el", DEV, "--probe", CLIENT, "--selector", "#a");
  assert.equal(run<string[]>("return window.clicks").at(-1), "a");
  sim("window", DEV, "right-half", "--probe", CLIENT);
  assert.equal(run<number>("return innerWidth"), half);
  // A rotated tile, and a floating window (the corner drag), back to full screen; the page stays in front.
  sim("rotate", DEV, "portrait");
  sim("window", DEV, "full", "--probe", CLIENT);
  assert.equal(run<number>("return innerWidth"), 834);
  sim("rotate", DEV, "landscape-left");
  sim("drag", DEV, "1204", "828", "726", "667");
  await sleep(1500);
  assert.ok(run<number>("return innerWidth") < 1210, "the corner drag made a floating window");
  sim("window", DEV, "full", "--probe", CLIENT);
  assert.equal(run<number>("return innerWidth"), 1210);

  sim("rotate", DEV, "portrait");
  assert.equal(run<string>("return screen.orientation.type"), "portrait-primary");
  // stop shuts down what this run booted; a device that was running before is left alone.
  sim("stop");
  const state = sim("devices")
    .split("\n")
    .find((l) => l.startsWith(`${DEV}\t`))
    ?.split("\t")[2];
  assert.equal(state, bootedHere ? "Shutdown" : "Booted");
  assert.equal(front(), app, "the frontmost macOS app never changed");
});
