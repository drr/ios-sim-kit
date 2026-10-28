import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("help lists the commands", () => {
  const out = cli("help");
  const cmds = [
    "doctor",
    "devices",
    "ensure",
    "boot",
    "stop",
    "open",
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
    "version",
  );
  for (const cmd of cmds) assert.match(out, new RegExp(`^  ${cmd} `, "m"));
});

test("version is dev when run from the repo", () => {
  assert.equal(cli("version").trim(), "dev");
});

test("devices without this project's prefix are refused", () => {
  const r = spawnSync(process.execPath, [CLI, "orientation", "other-iPhone16"], {
    encoding: "utf8",
    env: { ...process.env, IOS_SIM_HOME: new URL("./fixtures/prefix-sk", import.meta.url).pathname },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't this project's|no available simulator/);
});

test("bad arguments fail with a message, not a stack", () => {
  const r = spawnSync(process.execPath, [CLI, "rotate"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^ios-sim: /);
});
