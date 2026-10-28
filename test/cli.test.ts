import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
// Its own IOS_SIM_HOME, so these runs stay out of the real history.
const env = { ...process.env, IOS_SIM_HOME: mkdtempSync(join(tmpdir(), "ios-sim-cli-")) };
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

test("help lists the commands", () => {
  const out = cli("help");
  const cmds = [
    "doctor",
    "devices",
    "ensure",
    "boot",
    "stop",
    "open",
    "tabs",
    "safari-reset",
    "rotate",
    "orientation",
    "screenshot",
    "tap",
    "press",
  ];
  cmds.push(
    "swipe",
    "drag",
    "key",
    "type",
    "axe",
    "probe",
    "tap-el",
    "swipe-page",
    "window",
    "tap-check",
    "gesture-check",
    "feedback",
    "version",
  );
  for (const cmd of cmds) assert.match(out, new RegExp(`^  ${cmd} `, "m"));
});

test("version is dev when run from the repo", () => {
  assert.equal(cli("version").trim(), "dev");
});

test("devices without this project's prefix are refused", () => {
  // A copy: the run's history is written into IOS_SIM_HOME.
  const home = mkdtempSync(join(tmpdir(), "ios-sim-prefix-"));
  cpSync(new URL("./fixtures/prefix-sk", import.meta.url).pathname, home, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, "orientation", "other-iPhone16"], {
    encoding: "utf8",
    env: { ...process.env, IOS_SIM_HOME: home },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't this project's|no available simulator/);
});

test("bad arguments fail with a message, not a stack", () => {
  const r = spawnSync(process.execPath, [CLI, "rotate"], { encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ios-sim: /);
});

test("window takes a mode or --width, not both or neither", () => {
  for (const args of [
    ["sk-iPadPro11-M4", "--probe", "p"],
    ["sk-iPadPro11-M4", "left-half", "--width", "500", "--probe", "p"],
    ["sk-iPadPro11-M4", "top-half", "--probe", "p"],
    ["sk-iPadPro11-M4", "full"],
  ]) {
    const r = spawnSync(process.execPath, [CLI, "window", ...args], { encoding: "utf8", env });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /^ios-sim: window DEVICE full\|left-half\|right-half/);
  }
});
