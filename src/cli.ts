// ios-sim: drive iOS Simulators for checks of web pages and apps, without the user's mouse. See skill/SKILL.md.
// Runs on the pinned node with type stripping; no dependencies.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { config } from "./config.ts";
import { doctor, version } from "./doctor.ts";
import { capture, FEEDBACK_DIR, fileReport, listReports, record } from "./feedback.ts";
import { setWindow, setWindowWidth, swipePage, tapEl, WINDOW_MODES, type WindowMode } from "./page.ts";
import { clients, ensureRelay, probe, relayUrl, stopRelay, waitForClient, withProbeName } from "./probe-client.ts";
import { probeName } from "./probe-hub.ts";
import { listen, relay } from "./probe-relay.ts";
import {
  axe,
  boot,
  devices,
  ensure,
  isOrientation,
  newTab,
  ORIENTATIONS,
  openUrl,
  orientation,
  resolve,
  rotate,
  safariReset,
  safariTabs,
  screenshot,
  sleep,
  stop,
} from "./sim.ts";

/**
 * Runs the tap recorder (src/tap-recorder.mjs, vendored verbatim from the AXe fork's planning/) in this node, with
 * the configured axe and, for check and gesture, the device's UDID.
 */
async function tapRecorder(mode: "serve" | "check" | "gesture", args: string[]): Promise<number> {
  const script = new URL("./tap-recorder.mjs", import.meta.url).pathname;
  let extra: string[] = [];
  if (mode !== "serve") {
    const [name, ...more] = args;
    extra = ["--axe", config().axe, "--udid", (await resolve(name)).udid];
    args = more;
  }
  return spawnSync(process.execPath, [script, mode, ...extra, ...args], { stdio: "inherit" }).status ?? 2;
}

const USAGE = `usage: ios-sim <command>   (DEVICE = a simulator's name or UDID)
  doctor                       check Xcode, the Simulator runtime, axe (with rotate) and the config
  devices                      list available simulators (name, udid, state, runtime)
  ensure PREFIX NAME=TYPE...   create PREFIX-NAME devices that don't exist (TYPE e.g. iPhone-16) [--runtime R]
  boot DEVICE                  boot, wait until ready, show Simulator behind other apps
  stop [DEVICE...]             shut down what this session booted (or the named devices); with nothing left
                               booted, also quit Simulator and the probe relay. Keeps calibrations and screenshots
  open DEVICE URL              open a URL in the device's Safari [--probe NAME: add ios-sim-probe=NAME to it]
                               [--only: safari-reset first, so it's the only tab]
                               [--new-tab: ⌘T first, so it's in a tab of its own; checks the count]
  tabs DEVICE                  Safari's open tabs: * (active), URL, title [--json]
  safari-reset DEVICE          quit Safari and delete its saved tabs
  rotate DEVICE ORIENTATION    portrait | landscape-left | landscape-right | portrait-upside-down; waits until done
  orientation DEVICE           print the device's orientation
  screenshot DEVICE FILE       save a PNG [--upright: turn it the way the device is held]
  tap DEVICE X Y               tap screen points (current orientation)
  press DEVICE X Y             long press [--delay 1.0]
  swipe DEVICE X1 Y1 X2 Y2     swipe [--duration 0.4]
  drag DEVICE X1 Y1 X2 Y2      slow drag [--duration 1.2] [--pre-delay 0.3]
  key DEVICE CODE              press a key (HID usage code, e.g. 41 = Escape)
  type DEVICE TEXT             type text
  axe DEVICE -- ARGS...        run the configured axe with --udid added
  probe serve [--port P]       run the probe relay in the foreground
  probe start | stop           start the relay in the background (idempotent) | stop it
  probe clients                pages polling the relay
  probe wait CLIENT            wait until a page named CLIENT polls [--timeout 30000]
  probe run CLIENT SCRIPT      run an async function body in a page; prints its JSON result [--timeout MS]
                               [--wait-ms N: wait first, e.g. for Safari's animations to settle]
  tap-el DEVICE --probe CLIENT --selector CSS     tap an element's centre and check the page saw it there
  swipe-page DEVICE --probe CLIENT [--from 0.75 --to 0.3]   swipe by fractions of the visible height
  window DEVICE full|left-half|right-half --probe CLIENT    iPad: Safari full screen, or in a half
  window DEVICE --width W --probe CLIENT          iPad: resize Safari's window until innerWidth is W [--tolerance 4]
  tap-check DEVICE [--origin X,Y --size WxH] [--grid CxR]   tap a grid on a test page; PASS if taps land where sent
  gesture-check DEVICE [--origin X,Y --size WxH]            swipe and drag; PASS if the page saw the deltas sent
  tap-serve [--port 4319]      the tap recorder page alone (state at /state)
  feedback --title T < BODY    file a bug or request for ios-sim-kit; prints the report's path
                               [--kind bug|request] [--project NAME] [--attach FILE]... [--history N|all]
  feedback --list              open reports
  version    print the installed version`;

/** Numbers for axe, from command-line strings; throws on anything else. */
function nums(args: string[], count: number, what: string): number[] {
  const out = args.slice(0, count).map(Number);
  if (out.length !== count || out.some((n) => !Number.isFinite(n))) throw new Error(`${what} needs ${count} numbers`);
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const opts = <O extends ParseArgsOptionsConfig>(options: O) =>
    parseArgs({ args: rest, options, allowPositionals: true });
  switch (cmd) {
    case "doctor": {
      const d = await doctor();
      for (const line of d.lines) console.log(line);
      return d.ok ? 0 : 1;
    }
    case "devices":
      for (const d of await devices()) console.log(`${d.name}\t${d.udid}\t${d.state}\t${d.runtime}`);
      return 0;
    case "ensure": {
      const { values, positionals } = opts({ runtime: { type: "string" } });
      const [prefix, ...specs] = positionals;
      const own = config().prefix;
      if (!prefix) throw new Error("ensure PREFIX NAME=DEVICETYPE...");
      if (own && prefix !== own) throw new Error(`this config's prefix is ${own}, not ${prefix}`);
      for (const line of await ensure(prefix, specs, values.runtime as string | undefined)) console.log(line);
      return 0;
    }
    case "boot": {
      const dev = await resolve(rest[0]);
      console.log(`${dev.name} ${(await boot(dev)) ? "booted" : "was running already (not this session's to stop)"}`);
      return 0;
    }
    case "stop": {
      const named = rest.length ? await Promise.all(rest.map((n) => resolve(n))) : undefined;
      const r = await stop(named);
      console.log(r.shutDown.length ? `shut down: ${r.shutDown.join(", ")}` : "nothing of this session's was running");
      if (r.stillBooted.length) console.log(`still booted (left alone): ${r.stillBooted.join(", ")}`);
      else {
        console.log(r.quitSimulator ? "quit Simulator" : "Simulator wasn't running");
        if (await stopRelay()) console.log("stopped the probe relay");
      }
      return 0;
    }
    case "open": {
      const { values, positionals } = opts({
        probe: { type: "string" },
        only: { type: "boolean" },
        "new-tab": { type: "boolean" },
      });
      const dev = await resolve(positionals[0]);
      if (!positionals[1]) throw new Error("open DEVICE URL [--probe NAME] [--only | --new-tab]");
      if (values.only && values["new-tab"]) throw new Error("open takes --only or --new-tab, not both");
      if (values.only) await safariReset(dev);
      const url = values.probe ? withProbeName(positionals[1], probeName(values.probe)) : positionals[1];
      const tabs = values["new-tab"] ? await newTab(dev, url) : await openUrl(dev, url);
      if (tabs) console.log(`${dev.name}: ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`);
      else console.error(`ios-sim: ${dev.name}: Safari didn't show ${url} as its tab within 10s; take a screenshot`);
      return 0;
    }
    case "tabs": {
      const { values, positionals } = opts({ json: { type: "boolean" } });
      const dev = await resolve(positionals[0]);
      const tabs = safariTabs(dev);
      if (values.json) console.log(JSON.stringify(tabs));
      else for (const t of tabs) console.log(`${t.active ? "*" : " "}\t${t.url}\t${t.title}`);
      return 0;
    }
    case "safari-reset": {
      const dev = await resolve(rest[0]);
      const gone = await safariReset(dev);
      console.log(`${dev.name}: quit Safari${gone.length ? `, removed ${gone.join(", ")}` : "; it had no saved tabs"}`);
      return 0;
    }
    case "rotate": {
      const dev = await resolve(rest[0]);
      const to = rest[1];
      if (!isOrientation(to)) throw new Error(`rotate DEVICE ${ORIENTATIONS.join("|")}`);
      await rotate(dev, to);
      console.log(`${dev.name} ${to}`);
      return 0;
    }
    case "orientation":
      console.log((await orientation(await resolve(rest[0]))) ?? "unknown");
      return 0;
    case "screenshot": {
      const { values, positionals } = opts({ upright: { type: "boolean" } });
      const dev = await resolve(positionals[0]);
      if (!positionals[1]) throw new Error("screenshot DEVICE FILE [--upright]");
      await screenshot(dev, positionals[1], values.upright === true);
      console.log(positionals[1]);
      return 0;
    }
    case "tap": {
      const dev = await resolve(rest[0]);
      const [x, y] = nums(rest.slice(1), 2, "tap");
      await axe(dev, "tap", `-x=${x}`, `-y=${y}`);
      return 0;
    }
    case "press": {
      const { values, positionals } = opts({ delay: { type: "string", default: "1.0" } });
      const dev = await resolve(positionals[0]);
      const [x, y] = nums(positionals.slice(1), 2, "press");
      await axe(dev, "touch", `-x=${x}`, `-y=${y}`, "--down", "--up", `--delay=${values.delay}`);
      return 0;
    }
    case "swipe":
    case "drag": {
      const drag = cmd === "drag";
      const { values, positionals } = opts({
        duration: { type: "string", default: drag ? "1.2" : "0.4" },
        "pre-delay": { type: "string", default: "0.3" },
      });
      const dev = await resolve(positionals[0]);
      const [x1, y1, x2, y2] = nums(positionals.slice(1), 4, cmd);
      const extra = drag ? [`--pre-delay=${values["pre-delay"]}`] : [];
      await axe(
        dev,
        cmd,
        `--start-x=${x1}`,
        `--start-y=${y1}`,
        `--end-x=${x2}`,
        `--end-y=${y2}`,
        `--duration=${values.duration}`,
        ...extra,
      );
      return 0;
    }
    case "key": {
      const dev = await resolve(rest[0]);
      const [code] = nums(rest.slice(1), 1, "key");
      await axe(dev, "key", String(code));
      return 0;
    }
    case "type": {
      const dev = await resolve(rest[0]);
      if (rest[1] === undefined) throw new Error("type DEVICE TEXT");
      await axe(dev, "type", rest[1]);
      return 0;
    }
    case "axe": {
      const dev = await resolve(rest[0]);
      const args = rest[1] === "--" ? rest.slice(2) : rest.slice(1);
      const r = spawnSync(config().axe, [...args, "--udid", dev.udid], { stdio: "inherit" });
      return r.status ?? 1;
    }
    case "probe":
      return probeCommand(rest);
    case "tap-el": {
      const { values, positionals } = opts({ probe: { type: "string" }, selector: { type: "string" } });
      if (!values.probe || !values.selector) throw new Error("tap-el DEVICE --probe CLIENT --selector CSS");
      const dev = await resolve(positionals[0]);
      await ensureRelay();
      const t = await tapEl({ dev, client: values.probe as string }, values.selector as string);
      console.log(`tapped ${values.selector} at page ${t.x.toFixed(1)},${t.y.toFixed(1)}`);
      return 0;
    }
    case "swipe-page": {
      const { values, positionals } = opts({
        probe: { type: "string" },
        from: { type: "string", default: "0.75" },
        to: { type: "string", default: "0.3" },
        duration: { type: "string", default: "0.4" },
      });
      if (!values.probe) throw new Error("swipe-page DEVICE --probe CLIENT [--from 0.75 --to 0.3]");
      const dev = await resolve(positionals[0]);
      const [from, to, duration] = nums([values.from, values.to, values.duration] as string[], 3, "swipe-page");
      await ensureRelay();
      await swipePage({ dev, client: values.probe as string }, from as number, to as number, duration);
      return 0;
    }
    case "window": {
      const { values, positionals } = opts({
        probe: { type: "string" },
        width: { type: "string" },
        tolerance: { type: "string", default: "4" },
      });
      const mode = positionals[1];
      const usage = `window DEVICE ${WINDOW_MODES.join("|")} --probe CLIENT, or window DEVICE --width W --probe CLIENT`;
      const byMode = (WINDOW_MODES as readonly string[]).includes(mode ?? "");
      if (!values.probe || byMode === (values.width !== undefined)) throw new Error(usage);
      const dev = await resolve(positionals[0]);
      const ctx = { dev, client: values.probe as string };
      if (byMode) {
        await ensureRelay();
        const w = await setWindow(ctx, mode as WindowMode);
        console.log(`${dev.name} ${mode}: innerWidth ${w}`);
        return 0;
      }
      const [width, tolerance] = nums([values.width, values.tolerance] as string[], 2, "--width and --tolerance");
      await ensureRelay();
      const w = await setWindowWidth(ctx, width as number, tolerance);
      const ok = Math.abs(w - (width as number)) <= (tolerance as number);
      console.log(`${dev.name}: innerWidth ${w} (asked ${width})`);
      if (!ok) console.error(`ios-sim: couldn't get within ${tolerance}px of ${width}; iPadOS may not allow it`);
      return ok ? 0 : 1;
    }
    case "tap-check":
      return tapRecorder("check", rest);
    case "gesture-check":
      return tapRecorder("gesture", rest);
    case "tap-serve":
      return tapRecorder("serve", rest);
    case "feedback": {
      const { values } = opts({
        title: { type: "string" },
        kind: { type: "string", default: "bug" },
        project: { type: "string" },
        attach: { type: "string", multiple: true },
        history: { type: "string", default: "20" },
        list: { type: "boolean" },
      });
      if (values.list) {
        const open = listReports();
        console.log(open.length ? open.join("\n") : `no open reports in ${FEEDBACK_DIR}`);
        return 0;
      }
      const usage = "feedback --title T [--kind bug|request] [--project NAME] [--attach FILE]... < body.md";
      if (!values.title) throw new Error(usage);
      if (values.kind !== "bug" && values.kind !== "request") throw new Error(usage);
      const runs = values.history === "all" ? "all" : Number(values.history);
      if (runs !== "all" && !(Number.isInteger(runs) && runs >= 0)) throw new Error("--history N|all");
      if (process.stdin.isTTY) throw new Error(`${usage}: pipe the body (steps, expected, actual) on stdin`);
      const body = readFileSync(0, "utf8");
      if (!body.trim())
        throw new Error("the body (stdin) is empty: describe the steps, what you expected, what happened");
      console.log(
        await fileReport({
          title: values.title,
          kind: values.kind,
          project: values.project,
          body,
          attach: values.attach ?? [],
          runs,
        }),
      );
      return 0;
    }
    case "version":
      console.log(version());
      return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

async function probeCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      port: { type: "string" },
      timeout: { type: "string", default: "10000" },
      "wait-ms": { type: "string", default: "0" },
    },
    allowPositionals: true,
  });
  const port = values.port ? Number(values.port) : config().probePort;
  switch (sub) {
    case "serve": {
      const p = await listen(relay(), port);
      console.log(`probe relay on http://127.0.0.1:${p}/ (page script: /probe.js, demo: /demo)`);
      return new Promise(() => {}); // until killed
    }
    case "start":
      console.log(await ensureRelay(port));
      return 0;
    case "stop":
      console.log((await stopRelay(port)) ? "stopped" : `no relay on ${relayUrl(port)}`);
      return 0;
    case "wait": {
      const [client] = positionals;
      if (!client) throw new Error("probe wait CLIENT [--timeout MS]");
      await ensureRelay(port);
      const ms = values.timeout === "10000" ? 30_000 : Number(values.timeout);
      if (!(await waitForClient(client, ms))) throw new Error(`no page named ${client} polled within ${ms}ms`);
      console.log(`${client} is polling`);
      return 0;
    }
    case "clients":
      await ensureRelay(port);
      for (const c of await clients()) console.log(`${c.name}\t${(c.ago / 1000).toFixed(1)}s\t${c.ua}`);
      return 0;
    case "run": {
      const [client, script] = positionals;
      if (!client || script === undefined) throw new Error("probe run CLIENT SCRIPT [--wait-ms N]");
      const [waitMs] = nums([values["wait-ms"] as string], 1, "--wait-ms");
      await ensureRelay(port);
      await sleep(waitMs as number); // e.g. until Safari's toolbar animation after a swipe or rotation settles
      console.log(JSON.stringify(await probe(client, script, [], Number(values.timeout))));
      return 0;
    }
    default:
      throw new Error("probe serve|start|stop|clients|wait|run");
  }
}

// Every run but these goes into the history that feedback reports quote.
const UNRECORDED = new Set([undefined, "help", "--help", "version", "feedback"]);
const argv = process.argv.slice(2);
const output = capture();
let exit: number;
try {
  exit = await main(argv);
} catch (e) {
  console.error(`ios-sim: ${e instanceof Error ? e.message : String(e)}`);
  exit = 1;
}
process.exitCode = exit;
if (!UNRECORDED.has(argv[0])) record({ argv, exit, out: output() });
