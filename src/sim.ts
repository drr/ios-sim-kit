// Simulators: find, create, boot, rotate, and drive them with AXe. Nothing here takes the user's keyboard focus.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { config, HOME } from "./config.ts";

const exec = promisify(execFile);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SIMULATOR_APP = "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app";

export async function sh(cmd: string, args: (string | number)[]): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args.map(String), { maxBuffer: 64 << 20 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    const why = (err.stderr || err.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${why}`);
  }
}

export interface Device {
  name: string;
  udid: string;
  state: string;
  runtime: string;
}

interface SimDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable: boolean;
}

export async function devices(): Promise<Device[]> {
  const list = JSON.parse(await sh("xcrun", ["simctl", "list", "devices", "-j"])) as {
    devices: Record<string, SimDevice[]>;
  };
  return Object.entries(list.devices).flatMap(([runtime, ds]) =>
    ds
      .filter((d) => d.isAvailable)
      .map((d) => ({ name: d.name, udid: d.udid, state: d.state, runtime: runtime.replace(/.*SimRuntime\./, "") })),
  );
}

/**
 * The device named `nameOrUdid`. When a prefix is configured, devices without it are refused: they belong to other
 * projects or sessions.
 */
export async function resolve(nameOrUdid: string | undefined, prefix = config().prefix): Promise<Device> {
  if (!nameOrUdid) throw new Error("name a device (its name or UDID; see ios-sim devices)");
  const all = await devices();
  const found = all.filter((d) => d.name === nameOrUdid || d.udid === nameOrUdid);
  if (found.length === 0) throw new Error(`no available simulator named ${nameOrUdid}`);
  if (found.length > 1) throw new Error(`${found.length} simulators are named ${nameOrUdid}; use its UDID`);
  const dev = found[0] as Device;
  if (prefix && !dev.name.startsWith(`${prefix}-`))
    throw new Error(`${dev.name} isn't this project's (its prefix is ${prefix}-); refusing to touch it`);
  return dev;
}

interface Runtime {
  identifier: string;
  version: string;
  name: string;
  isAvailable: boolean;
}

/** The newest available iOS runtime's identifier, or the one whose identifier, name or version matches `want`. */
export async function runtime(want?: string): Promise<string> {
  const list = (JSON.parse(await sh("xcrun", ["simctl", "list", "runtimes", "-j"])) as { runtimes: Runtime[] })
    .runtimes;
  const ios = list.filter((r) => r.isAvailable && r.name.startsWith("iOS"));
  if (want) {
    const r = ios.find(
      (r) => r.identifier === want || r.name === want || r.version === want || r.identifier.endsWith(want),
    );
    if (!r) throw new Error(`no available iOS runtime ${want}: ${ios.map((r) => r.name).join(", ") || "none"}`);
    return r.identifier;
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const newest = ios.sort((a, b) => cmp(a.version, b.version)).at(-1);
  if (!newest) throw new Error("no iOS runtime: xcodebuild -downloadPlatform iOS");
  return newest.identifier;
}

/**
 * Creates `PREFIX-NAME` for each `NAME=DEVICETYPE` that doesn't exist yet. DEVICETYPE is a simctl device type id,
 * with or without `com.apple.CoreSimulator.SimDeviceType.`. Returns one line per device.
 */
export async function ensure(prefix: string, specs: string[], wantRuntime?: string): Promise<string[]> {
  if (!/^[\w.-]+$/.test(prefix)) throw new Error("the prefix is letters, digits, _ . -");
  const parsed = specs.map((s) => {
    const m = /^([\w.-]+)=([\w.-]+)$/.exec(s);
    if (!m) throw new Error(`expected NAME=DEVICETYPE, got ${s}`);
    const type = (m[2] as string).includes(".") ? (m[2] as string) : `com.apple.CoreSimulator.SimDeviceType.${m[2]}`;
    return { name: `${prefix}-${m[1]}`, type };
  });
  if (parsed.length === 0) throw new Error("name at least one NAME=DEVICETYPE");
  const have = await devices();
  const rt = await runtime(wantRuntime);
  const out: string[] = [];
  for (const { name, type } of parsed) {
    const existing = have.find((d) => d.name === name);
    if (existing) {
      out.push(`${name}\t${existing.udid}\texists`);
      continue;
    }
    const udid = await sh("xcrun", ["simctl", "create", name, type, rt]);
    out.push(`${name}\t${udid}\tcreated`);
  }
  return out;
}

/** Boots the device (if it isn't), waits until it's up, and shows Simulator without bringing it to the front. */
/** The session that boots devices: Claude Code's session id, so `stop` shuts down only what this session booted. */
export const SESSION = process.env.IOS_SIM_SESSION ?? process.env.CLAUDE_CODE_SESSION_ID ?? "default";

interface BootRecord {
  udid: string;
  name: string;
  session: string;
  at: string;
}

const BOOTED = join(HOME, "booted.json");

function bootRecords(): BootRecord[] {
  return existsSync(BOOTED) ? (JSON.parse(readFileSync(BOOTED, "utf8")) as BootRecord[]) : [];
}

function saveBootRecords(records: BootRecord[]) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(BOOTED, `${JSON.stringify(records, null, 2)}\n`);
}

/**
 * Boots the device (if it isn't), waits until it's up, and shows Simulator without bringing it to the front. A
 * device this call boots is recorded for this session; one that was running already belongs to someone else.
 * Returns whether this call booted it.
 */
export async function boot(dev: Device): Promise<boolean> {
  const was = (await devices()).find((d) => d.udid === dev.udid)?.state;
  let booted = false;
  if (was !== "Booted")
    booted = await sh("xcrun", ["simctl", "boot", dev.udid]).then(
      () => true,
      () => false, // races: booted already
    );
  await sh("xcrun", ["simctl", "bootstatus", dev.udid, "-b"]);
  await sh("open", ["-g", SIMULATOR_APP]); // -g: stays behind; the user keeps their keyboard focus
  if (booted) {
    const records = bootRecords().filter((r) => r.udid !== dev.udid);
    records.push({ udid: dev.udid, name: dev.name, session: SESSION, at: new Date().toISOString() });
    saveBootRecords(records);
  }
  return booted;
}

export interface StopResult {
  shutDown: string[];
  stillBooted: string[];
  quitSimulator: boolean;
}

/**
 * Shuts down `targets`, or else the devices this session booted. When no simulator is left booted (anyone's), also
 * quits Simulator.app (SIGTERM; no focus change). Calibrations and failure screenshots stay for later sessions.
 */
export async function stop(targets?: Device[]): Promise<StopResult> {
  const records = bootRecords();
  const all = await devices();
  const mine = targets ?? all.filter((d) => records.some((r) => r.udid === d.udid && r.session === SESSION));
  const shutDown: string[] = [];
  for (const dev of mine) {
    if (all.find((d) => d.udid === dev.udid)?.state === "Booted") {
      await sh("xcrun", ["simctl", "shutdown", dev.udid]);
      shutDown.push(dev.name);
    }
  }
  const stopped = new Set(mine.map((d) => d.udid));
  saveBootRecords(records.filter((r) => !stopped.has(r.udid)));
  const stillBooted = (await devices()).filter((d) => d.state === "Booted").map((d) => d.name);
  let quitSimulator = false;
  if (stillBooted.length === 0)
    quitSimulator = await sh("pkill", ["-x", "Simulator"]).then(
      () => true,
      () => false, // not running
    );
  return { shutDown, stillBooted, quitSimulator };
}

const SAFARI = "com.apple.mobilesafari";

/** The device's Safari data folder: SafariTabs.db (its open tabs) and the rest of Safari's state. */
export const safariDir = (dev: Device) =>
  join(homedir(), "Library", "Developer", "CoreSimulator", "Devices", dev.udid, "data", "Library", "Safari");

/**
 * Quits Safari and deletes its saved tabs (SafariTabs.db in the device's data), so the next `openUrl` is the only
 * tab. Returns the files removed. Stale tabs pile up across runs (each `open` adds one), and a stray tap brings one
 * forward.
 */
export async function safariReset(dev: Device): Promise<string[]> {
  await sh("xcrun", ["simctl", "terminate", dev.udid, SAFARI]).catch(() => {}); // not running
  const dir = safariDir(dev);
  const gone = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("SafariTabs.db")) : [];
  for (const f of gone) rmSync(join(dir, f));
  return gone;
}

export interface Tab {
  /** Safari's window (iPad can have several), from 1. */
  window: number;
  /** Position in its window's tab group, from 0. */
  index: number;
  /** The tab its window shows. */
  active: boolean;
  private: boolean;
  url: string;
  title: string;
}

/**
 * Safari's open tabs, read from SafariTabs.db: the tabs (bookmark rows) of the group each window shows (its local
 * or private tabs; the other group isn't on screen, and the private one always holds a blank Start Page), and the
 * group's active tab from windows_tab_groups. No db (fresh device, after safari-reset), or one Safari is still
 * creating, = no tabs.
 */
export function readTabs(db: string): Tab[] {
  if (!existsSync(db)) return [];
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const rows = conn
      .prepare(
        `SELECT w.id AS window, b.order_index AS idx, b.parent = w.private_tab_group_id AS private,
                b.id = g.active_tab_id AS active, b.url AS url, b.title AS title
           FROM windows w
           JOIN bookmarks b ON b.parent = w.active_tab_group_id
           LEFT JOIN windows_tab_groups g ON g.window_id = w.id AND g.tab_group_id = b.parent
          WHERE w.date_closed IS NULL AND b.type = 0 AND b.hidden = 0 AND b.deleted = 0 AND b.date_closed IS NULL
          ORDER BY w.id, b.order_index`,
      )
      .all() as { window: number; idx: number; private: number; active: number | null; url: string; title: string }[];
    const tabs = rows.map((r) => ({
      window: r.window,
      index: r.idx,
      active: r.active === 1,
      private: r.private === 1,
      url: r.url ?? "",
      title: r.title ?? "",
    }));
    // A freshly started Safari saves its one tab before it records which tab is active.
    for (const w of new Set(tabs.map((t) => t.window))) {
      const own = tabs.filter((t) => t.window === w);
      if (own.length === 1 && !own.some((t) => t.active)) (own[0] as Tab).active = true;
    }
    return tabs;
  } catch (e) {
    if (/no such table/.test(String(e))) return []; // Safari is creating the db
    throw e;
  } finally {
    conn.close();
  }
}

export const safariTabs = (dev: Device) => readTabs(join(safariDir(dev), "SafariTabs.db"));

const sameUrl = (a: string, b: string) => URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;
const activeTab = (tabs: Tab[]) => tabs.find((t) => t.active);

/** Polls SafariTabs.db until `ok(tabs)`; returns the tabs, or null after `ms`. Safari saves a change within ~1s. */
async function waitTabs(dev: Device, ok: (tabs: Tab[]) => boolean, ms: number): Promise<Tab[] | null> {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    const tabs = safariTabs(dev);
    if (ok(tabs)) return tabs;
    if (Date.now() > end) return null;
  }
}

/**
 * Opens `url` in the device's Safari and waits until Safari has saved it as the active tab (or another URL, after a
 * redirect), so a following `openUrl` can't land in the same tab. `simctl openurl` loads into the current tab when
 * that tab is blank: while Safari is still starting (~2s after the openurl that launched it), or after ⌘T; otherwise
 * it opens a new tab, or switches to an open one whose URL differs only in the hash. Returns null if Safari didn't
 * show it within 10s.
 */
export async function openUrl(dev: Device, url: string): Promise<Tab[] | null> {
  const before = safariTabs(dev);
  const was = activeTab(before)?.url;
  await sh("xcrun", ["simctl", "openurl", dev.udid, url]);
  return waitTabs(
    dev,
    (tabs) => {
      const now = activeTab(tabs)?.url;
      return !!now && (sameUrl(now, url) || now !== was || tabs.length !== before.length);
    },
    10_000,
  );
}

/**
 * Opens `url` in a tab of its own: brings Safari to the front in the simulator (no macOS focus change), presses ⌘T
 * for a blank tab unless the active one is blank already, then opens the URL into it. Checks with SafariTabs.db that
 * there's one tab more than before with the page active, and returns the tabs.
 */
export async function newTab(dev: Device, url: string): Promise<Tab[]> {
  const fail = async (why: string) => new Error(`${dev.name}: ${why}; screenshot: ${await failShot(dev, "new-tab")}`);
  await sh("xcrun", ["simctl", "launch", dev.udid, SAFARI]);
  const start = await waitTabs(dev, (tabs) => activeTab(tabs) !== undefined, 5000);
  let count = start?.length ?? 0;
  if (activeTab(start ?? [])?.url !== "") {
    await axe(dev, "key-combo", "--modifiers", "227", "--key", "23"); // ⌘T: 227 = left ⌘, 23 = t
    const blank = await waitTabs(dev, (t) => t.length === count + 1 && activeTab(t)?.url === "", 5000);
    if (!blank) throw await fail(`⌘T didn't open a tab (Safari has ${safariTabs(dev).length}, had ${count})`);
    count = blank.length;
  }
  await sh("xcrun", ["simctl", "openurl", dev.udid, url]);
  const done = await waitTabs(dev, (t) => t.length === count && !!activeTab(t)?.url, 10_000);
  if (done) return done;
  const now = safariTabs(dev);
  throw await fail(
    `expected ${count} tabs with the page active, Safari has ${now.length} (active: ${activeTab(now)?.url || "blank"})`,
  );
}

/** Runs the configured AXe against the device. */
export const axe = (dev: Device, ...args: (string | number)[]) => sh(config().axe, [...args, "--udid", dev.udid]);

export const ORIENTATIONS = ["portrait", "portrait-upside-down", "landscape-left", "landscape-right"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export function isOrientation(v: string | undefined): v is Orientation {
  return (ORIENTATIONS as readonly string[]).includes(v ?? "");
}

/**
 * The device's orientation from backboardd (UIDeviceOrientation 1–4); null when face up/down. A device that hasn't
 * been rotated since boot reports 0 (unknown) and shows portrait.
 */
export async function orientation(dev: Device): Promise<Orientation | null> {
  const out = await sh("xcrun", ["simctl", "spawn", dev.udid, "notifyutil", "-g", "com.apple.backboardd.orientation"]);
  const n = Number(/(\d+)\s*$/.exec(out)?.[1]);
  if (n === 0) return "portrait";
  return ORIENTATIONS[n - 1] ?? null;
}

export const isLandscape = (o: Orientation | null) => o === "landscape-left" || o === "landscape-right";

/**
 * Sets the orientation with `axe rotate` (no Simulator menus, no focus change), waits until backboardd reports it,
 * then lets the UI settle. Tries twice.
 */
export async function rotate(dev: Device, to: Orientation): Promise<void> {
  const from = await orientation(dev);
  if (from === to) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    await axe(dev, "rotate", to);
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(200)) {
      if ((await orientation(dev)) !== to) continue;
      const flip = isLandscape(from) && isLandscape(to);
      await sleep(flip ? 3000 : 2500);
      return;
    }
  }
  throw new Error(`${dev.name}: still ${await orientation(dev)} after rotating to ${to}`);
}

/** Degrees `sips -r` turns a screenshot (always the portrait framebuffer) to make it upright. */
export const UPRIGHT: Record<Orientation, number> = {
  portrait: 0,
  "portrait-upside-down": 180,
  "landscape-left": 270,
  "landscape-right": 90,
};

/** Saves a screenshot; `upright` turns it the way the device is held. */
export async function screenshot(dev: Device, file: string, upright: boolean): Promise<void> {
  await axe(dev, "screenshot", "--output", file);
  const o = upright ? await orientation(dev) : null;
  const deg = o ? UPRIGHT[o] : 0;
  if (deg) await sh("sips", ["-r", deg, file]);
}

/** Saves a screenshot for a failure in `HOME/shots/` and returns its path. */
export async function failShot(dev: Device, what: string): Promise<string> {
  mkdirSync(join(HOME, "shots"), { recursive: true });
  const file = join(HOME, "shots", `${dev.name}-${what}-${Date.now()}.png`);
  await screenshot(dev, file, true).catch(() => {});
  return file;
}
