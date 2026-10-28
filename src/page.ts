// Gestures aimed at a page through the probe: calibrate (where taps land on the page), tap an element and check
// where the page saw it, swipe the page, and tile an iPad's Safari window. See planning/architecture.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.ts";
import { type Affine, fitAffine, invert, type Pt } from "./fit.ts";
import { probe } from "./probe-client.ts";
import { axe, type Device, isLandscape, orientation, screenshot, sleep } from "./sim.ts";

/**
 * Records where touches land (`__taps`) and, while `__block` is set, swallows them (calibration taps). iOS WebKit
 * sends touches only to regions it knows have listeners, and learns of new listeners at its next rendering update:
 * on an idle page (e.g. a tab just opened by `simctl openurl`) touches are dropped until something repaints. So this
 * adds a 1px element and waits two frames.
 */
async function installRecorder() {
  const w = window as unknown as { __iosSimRec?: boolean; __taps: Pt[]; __block: boolean };
  if (w.__iosSimRec) return true;
  w.__iosSimRec = true;
  w.__taps = [];
  w.__block = false;
  addEventListener(
    "pointerdown",
    (e) => {
      w.__taps.push({ x: e.clientX, y: e.clientY });
      if (w.__block) e.preventDefault();
    },
    { capture: true },
  );
  addEventListener(
    "click",
    (e) => {
      if (!w.__block) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true },
  );
  const mark = document.createElement("div");
  mark.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none";
  document.documentElement.append(mark);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
}

/** What the page's geometry is now; a calibration holds while this doesn't change. */
function viewKey() {
  const vv = window.visualViewport;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    orientation: screen.orientation?.type ?? "",
    w: innerWidth,
    h: innerHeight,
    vvTop: r1(vv?.offsetTop ?? 0),
    vvH: r1(vv?.height ?? innerHeight),
    screenShort: Math.min(screen.width, screen.height),
    screenLong: Math.max(screen.width, screen.height),
  };
}
type ViewKey = ReturnType<typeof viewKey>;

export interface Calibration extends Affine {
  key: ViewKey;
  /** The screen size in the current orientation, in points. */
  screen: { w: number; h: number };
}

export interface Ctx {
  dev: Device;
  client: string;
}

const calFile = (ctx: Ctx) => join(HOME, "cal", `${ctx.dev.udid}-${ctx.client}.json`);

export function forgetCalibration(ctx: Ctx) {
  rmSync(calFile(ctx), { force: true });
}

const takeTaps = (client: string) => probe<Pt[]>(client, "const t = window.__taps ?? []; window.__taps = []; return t");

/** Taps a few screen points inside the page, sees where the page got them, and fits page = A·sent + b. */
async function calibrate(ctx: Ctx, key: ViewKey): Promise<Calibration> {
  const { dev, client } = ctx;
  const landscape = isLandscape(await orientation(dev));
  const scr = landscape ? { w: key.screenLong, h: key.screenShort } : { w: key.screenShort, h: key.screenLong };
  await probe(client, installRecorder);
  await probe(client, "window.__block = true; window.__taps = []; return true");
  const sent: Pt[] = [];
  const seen: Pt[] = [];
  const tap = async (s: Pt) => {
    await axe(dev, "tap", `-x=${s.x}`, `-y=${s.y}`);
    await sleep(350);
    const t = (await takeTaps(client)).at(0);
    if (t) {
      sent.push(s);
      seen.push(t);
    }
    return t;
  };
  try {
    // Find the page: where its window is isn't known (full screen, left half, or a floating window anywhere). Try
    // the middle band of the screen, clear of the status bar and the dock, from the left edge (the usual window)
    // and then from the centre out, until one tap lands.
    const candidates: Pt[] = [{ x: Math.round(key.w / 3), y: Math.round(scr.h * 0.45) }];
    for (const fy of [0.45, 0.35, 0.55])
      for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8])
        candidates.push({ x: Math.round(scr.w * fx), y: Math.round(scr.h * fy) });
    let first: Pt | undefined;
    for (const s of candidates) {
      first = await tap(s);
      if (first) break;
    }
    if (!first) throw new Error(`${dev.name}: no calibration tap reached the page (is it in front?)`);
    // A correct AXe has A = identity, so one hit gives the offset; aim the rest well inside the page.
    const s0 = sent[0] as Pt;
    const off = { x: first.x - s0.x, y: first.y - s0.y };
    for (const [fx, fy] of [
      [0.3, 0.35],
      [0.7, 0.35],
      [0.3, 0.65],
      [0.7, 0.65],
    ] as const)
      await tap({ x: Math.round(key.w * fx - off.x), y: Math.round(key.vvH * fy - off.y) });
  } finally {
    await probe(client, "window.__block = false; return true");
  }
  if (sent.length < 3) throw new Error(`${dev.name}: only ${sent.length} calibration taps reached the page`);
  const k = fitAffine(sent, seen);
  if (k.residual > 3) throw new Error(`${dev.name}: calibration taps don't fit (residual ${k.residual.toFixed(1)}pt)`);
  return { ...k, key, screen: scr };
}

/** The calibration for the page as it is now: cached unless the page's geometry changed, else measured. */
export async function calibration(ctx: Ctx): Promise<Calibration> {
  if ((await probe<string>(ctx.client, "return document.visibilityState")) !== "visible")
    throw new Error(`the page ${ctx.client} is in a background tab (or Safari isn't in front); taps can't reach it`);
  const key = await probe<ViewKey>(ctx.client, viewKey);
  const file = calFile(ctx);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as Calibration;
    if (JSON.stringify(cached.key) === JSON.stringify(key)) return cached;
  }
  const k = await calibrate(ctx, key);
  mkdirSync(join(HOME, "cal"), { recursive: true });
  writeFileSync(file, JSON.stringify(k));
  return k;
}

/** The screen point to send for page point `p`, rounded. */
function toScreen(k: Calibration, p: Pt): Pt {
  const s = invert(k, p);
  return { x: Math.round(s.x), y: Math.round(s.y) };
}

const tapAt = (dev: Device, s: Pt) => axe(dev, "tap", `-x=${s.x}`, `-y=${s.y}`);

/** Saves a screenshot for a failure and returns its path. */
async function failShot(ctx: Ctx, what: string): Promise<string> {
  mkdirSync(join(HOME, "shots"), { recursive: true });
  const file = join(HOME, "shots", `${ctx.dev.name}-${what}-${Date.now()}.png`);
  await screenshot(ctx.dev, file, true).catch(() => {});
  return file;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Taps the middle of the first element matching `selector` and checks the touch landed in it; recalibrates and
 * tries again once if not. Returns the point the page saw.
 */
export async function tapEl(ctx: Ctx, selector: string): Promise<Pt> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = await calibration(ctx);
    await probe(ctx.client, installRecorder);
    const r = await probe<Box | null>(
      ctx.client,
      (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        (window as unknown as { __taps: unknown[] }).__taps = [];
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      },
      [selector],
    );
    if (!r) throw new Error(`no ${selector} on the page`);
    if (r.w === 0 || r.h === 0) throw new Error(`${selector} has no size (hidden?)`);
    const vv = k.key.vvH;
    const mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (mid.x < 0 || mid.x > k.key.w || mid.y < 0 || mid.y > vv)
      throw new Error(`${selector}'s centre (${mid.x.toFixed(0)}, ${mid.y.toFixed(0)}) is off screen; scroll first`);
    await tapAt(ctx.dev, toScreen(k, mid));
    await sleep(500);
    const t = (await takeTaps(ctx.client)).at(0);
    if (t && t.x >= r.x - 2 && t.x <= r.x + r.w + 2 && t.y >= r.y - 2 && t.y <= r.y + r.h + 2) return t;
    forgetCalibration(ctx);
  }
  throw new Error(`could not tap ${selector}; screenshot: ${await failShot(ctx, "tap-el")}`);
}

/** A vertical swipe on the page from fraction `from` to `to` of the visible height (up: content scrolls down). */
export async function swipePage(ctx: Ctx, from: number, to: number, duration = 0.4): Promise<void> {
  const k = await calibration(ctx);
  const a = toScreen(k, { x: k.key.w / 2, y: k.key.vvH * from });
  const b = toScreen(k, { x: k.key.w / 2, y: k.key.vvH * to });
  await axe(
    ctx.dev,
    "swipe",
    `--start-x=${a.x}`,
    `--start-y=${a.y}`,
    `--end-x=${b.x}`,
    `--end-y=${b.y}`,
    `--duration=${duration}`,
  );
  await sleep(1200);
}

export type WindowMode = "full" | "left-half";

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AXNode {
  AXUniqueId?: string | null;
  frame?: Frame;
  children?: AXNode[];
}

export interface SafariWindow {
  /** The screen in the current orientation (the app's root frame). */
  screen: Frame;
  /** Safari's window. */
  window: Frame;
  /** Whether Safari's sidebar is open (it takes ~340pt of the window from the page). */
  sidebar: boolean;
}

/** Safari's window and sidebar from the accessibility tree; null if Safari isn't the app in front. */
export async function safariWindow(dev: Device): Promise<SafariWindow | null> {
  const roots = JSON.parse(await axe(dev, "describe-ui")) as AXNode[] | AXNode;
  const root = (Array.isArray(roots) ? roots[0] : roots) as AXNode | undefined;
  let window: Frame | undefined;
  let sidebar = false;
  const walk = (n: AXNode) => {
    const id = n.AXUniqueId ?? "";
    if (!window && id.startsWith("SafariWindow?")) window = n.frame;
    if (id === "Sidebar") sidebar = true;
    for (const c of n.children ?? []) walk(c);
  };
  if (root) walk(root);
  if (!root?.frame || !window) return null;
  return { screen: root.frame, window, sidebar };
}

/**
 * The window as the page sees it, for when the accessibility tree doesn't show Safari (it reports another app while
 * Safari is tiled or floating): the page's top-left on screen and its size. The sidebar is taken as closed.
 */
async function fromPage(ctx: Ctx): Promise<SafariWindow> {
  forgetCalibration(ctx);
  const k = await calibration(ctx);
  const o = toScreen(k, { x: 0, y: 0 });
  return {
    screen: { x: 0, y: 0, width: k.screen.w, height: k.screen.h },
    window: { x: o.x, y: 0, width: k.key.w, height: k.screen.h },
    sidebar: false,
  };
}

const isFull = (s: SafariWindow) => s.window.width >= s.screen.width - 2 && s.window.height >= s.screen.height - 2;
const isLeftHalf = (s: SafariWindow) =>
  s.window.x < 20 && s.window.width > s.screen.width * 0.4 && s.window.width < s.screen.width * 0.6;

/**
 * Puts Safari full screen or in the left half (iPadOS 26), with its sidebar closed so the page gets the window's
 * width. The window's frame and the sidebar come from the accessibility tree. From full screen, dragging the window's
 * corner grip makes it a floating window; a floating or tiled window has controls at its top left (a pill that opens
 * into three buttons), and a long press on the green one opens a menu: Move & Resize (left half first) and Fill &
 * Arrange (fill first). The controls and the menu aren't in the accessibility tree, so those taps go by offsets from
 * the page's top-left, measured on iPadOS 26.3. Returns the final innerWidth.
 */
export async function setWindow(ctx: Ctx, mode: WindowMode): Promise<number> {
  const { dev, client } = ctx;
  const half = mode === "left-half";
  let last: SafariWindow | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = (await safariWindow(dev)) ?? (await fromPage(ctx));
    last = now;
    if (now.sidebar) {
      await axe(dev, "tap", "--id", "SidebarButton");
      await sleep(1000);
      continue;
    }
    if (half ? isLeftHalf(now) : isFull(now)) {
      forgetCalibration(ctx);
      return probe<number>(client, "return innerWidth");
    }
    if (isFull(now)) {
      // Full screen has no window controls: shrink it to a floating window first.
      const { width: w, height: h } = now.screen;
      await axe(
        dev,
        "drag",
        `--start-x=${w - 6}`,
        `--start-y=${h - 6}`,
        `--end-x=${Math.round(w * 0.6)}`,
        `--end-y=${Math.round(h * 0.8)}`,
        "--duration=1.2",
        "--pre-delay=0.3",
      );
      await sleep(1500);
    }
    forgetCalibration(ctx);
    const k = await calibration(ctx);
    const origin = toScreen(k, { x: 0, y: 0 });
    const pill = { x: origin.x + 41, y: origin.y - 32 };
    const green = { x: pill.x + 63, y: pill.y };
    const target = { x: green.x - 64, y: green.y + (half ? 83 : 162) };
    await tapAt(dev, pill);
    await sleep(800);
    await axe(dev, "touch", `-x=${green.x}`, `-y=${green.y}`, "--down", "--up", "--delay=1.0");
    await sleep(900);
    await tapAt(dev, target);
    await sleep(2000);
  }
  forgetCalibration(ctx);
  const at = last ? JSON.stringify(last.window) : "unknown";
  throw new Error(
    `${dev.name}: could not put Safari ${half ? "in the left half" : "full screen"} (window ${at}); ` +
      `screenshot: ${await failShot(ctx, "window")}`,
  );
}
