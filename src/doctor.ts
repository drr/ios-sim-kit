// `doctor`: checks everything the skill relies on. Shared by the CLI and feedback reports.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config, HOME } from "./config.ts";
import { sh } from "./sim.ts";

const XCODE_DEV = "/Applications/Xcode.app/Contents/Developer";

async function tryRun(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await sh(cmd, args) };
  } catch (e) {
    return { ok: false, out: (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "" };
  }
}

/** The installed version (`make install` writes VERSION), or "dev" when run from the repo. */
export function version(): string {
  const file = new URL("../VERSION", import.meta.url);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "dev";
}

/** One line per check (`ok ` or `!! `), and whether all passed. */
export async function doctor(): Promise<{ lines: string[]; ok: boolean }> {
  const cfg = config();
  const checks: [string, boolean, string][] = [];
  const sel = await tryRun("xcode-select", ["-p"]);
  checks.push(["xcode-select points at Xcode", sel.out === XCODE_DEV, sel.out]);
  const runtimes = await tryRun("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const ios = runtimes.ok
    ? (JSON.parse(runtimes.out) as { runtimes: { name: string; isAvailable: boolean }[] }).runtimes
        .filter((r) => r.isAvailable && r.name.startsWith("iOS"))
        .map((r) => r.name)
    : [];
  checks.push(["an iOS Simulator runtime", ios.length > 0, ios.join(", ") || runtimes.out]);
  const ax = await tryRun(cfg.axe, ["--version"]);
  checks.push([`axe (${cfg.axe})`, ax.ok, ax.out]);
  // Rotation goes through `axe rotate` (axe-patched), which needs neither Simulator's menus nor Accessibility.
  const rot = await tryRun(cfg.axe, ["rotate", "--help"]);
  checks.push(["axe supports rotate (axe-patched)", rot.ok, rot.ok ? "" : rot.out]);
  const file = join(HOME, "config.json");
  checks.push(["config", true, `${existsSync(file) ? file : "defaults"}; prefix ${cfg.prefix || "(none)"}`]);
  checks.push(["probe relay port", true, `${cfg.probePort}`]);
  return {
    lines: checks.map(([what, ok, detail]) => `${ok ? "ok " : "!! "} ${what}${detail ? `: ${detail}` : ""}`),
    ok: checks.every(([, ok]) => ok),
  };
}
