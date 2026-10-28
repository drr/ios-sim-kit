// Tap recorder: checks that AXe's coordinates land where they should, as seen by a web page in the simulator.
// No dependencies; needs Node 18.3 or later.
//
//   node tap-recorder.mjs check   [--axe PATH] [--udid UDID] [--origin X,Y --size WxH] [--grid CxR]
//   node tap-recorder.mjs gesture [--axe PATH] [--udid UDID] [--origin X,Y --size WxH]
//   node tap-recorder.mjs serve   [--port N]      # page at http://127.0.0.1:N/, state at /state, POST /reset
//
// check opens the page in the simulator's Safari, taps a grid with `axe tap`, and fits page = A·screen + b by least
// squares. PASS when A is the identity (each entry within 0.02), every residual is under 3pt and at least 75% of the
// taps reached the page. gesture runs `axe swipe` one way and `axe drag` back, and passes when the page's
// pointerdown → pointerup delta matches the delta sent within 6pt. Both exit 0 on PASS, 1 on FAIL and 2 on errors.
//
// Defaults: --axe is `axe` on PATH; --udid is the only booted simulator. Without --origin/--size the region is found
// by calibration: one tap near the middle of the app frame (from `axe describe-ui`), and the page's own viewport
// size. The grid then stays inside the page, because taps on Safari's toolbars can open tabs, change page zoom
// (reset with Cmd-0) or pick search suggestions. Pass --origin/--size (screen points in the current orientation) to
// choose the region yourself, e.g. when calibration misses in a tiled iPad window.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 18 || (major === 18 && minor < 3)) {
  console.error(`tap-recorder needs Node 18.3 or later (this is ${process.versions.node})`);
  process.exit(2);
}

const USAGE =
  "usage: tap-recorder.mjs check|gesture [--axe PATH] [--udid UDID] [--origin X,Y --size WxH] [--grid CxR]\n" +
  "       tap-recorder.mjs serve [--port N]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    axe: { type: "string", default: "axe" },
    udid: { type: "string" },
    size: { type: "string" },
    origin: { type: "string" },
    grid: { type: "string", default: "5x4" },
  },
});

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>tap recorder</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; touch-action: none; background: #fff; font: 15px -apple-system }
  #info { position: fixed; left: 8px; top: 8px; color: #555 }
  .dot { position: fixed; width: 12px; height: 12px; margin: -6px; border-radius: 6px; background: #d22 }
</style>
<div id="info"></div>
<script>
  const info = () => ({ w: innerWidth, h: innerHeight, orientation: screen.orientation?.type ?? "" });
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const hello = () => {
    const i = info();
    document.getElementById("info").textContent = i.w + "×" + i.h + " " + i.orientation;
    post("/hello", i);
  };
  addEventListener("resize", hello);
  hello();
  for (const type of ["pointerdown", "pointerup"])
    addEventListener(type, (e) => {
      e.preventDefault();
      if (type === "pointerdown") {
        const d = document.createElement("div");
        d.className = "dot";
        d.style.left = e.clientX + "px";
        d.style.top = e.clientY + "px";
        document.body.append(d);
      }
      post("/tap", { type, x: e.clientX, y: e.clientY, ...info() });
    });
</script>`;

const state = { page: null, taps: [] };

function serve(port) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?")))
      return res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(PAGE);
    if (req.method === "GET" && req.url === "/state") return json(state);
    if (req.method === "POST" && req.url === "/hello") return json((state.page = JSON.parse(body)));
    if (req.method === "POST" && req.url === "/tap") return json(state.taps.push(JSON.parse(body)));
    if (req.method === "POST" && req.url === "/reset") return json((state.taps = []));
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e) =>
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is in use; pass --port with a free one`) : e),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const firstLine = (e) => String(e.stderr || e.message).trim().split("\n")[0];

function bootedSimulator() {
  const { devices } = JSON.parse(run("xcrun", ["simctl", "list", "devices", "booted", "-j"]));
  const booted = Object.values(devices).flat();
  if (booted.length !== 1)
    throw new Error(`pass --udid: ${booted.length} simulators are booted${booted.length ? ` (${booted.map((d) => d.name).join(", ")})` : ""}`);
  return booted[0].udid;
}

/** The app frame AXe reports, in screen points for the current orientation. */
function appFrame(axe, udid) {
  const roots = JSON.parse(run(axe, ["describe-ui", "--udid", udid]));
  const frame = roots.find((r) => r.frame)?.frame;
  if (!frame) throw new Error("axe describe-ui returned no app frame");
  return frame;
}

/** Runs `axe` with arguments and returns the page events it produced. */
async function perform(axe, args, settleMs) {
  const before = state.taps.length;
  let error = "";
  try {
    run(axe, args);
  } catch (e) {
    error = firstLine(e);
  }
  await sleep(settleMs);
  return { events: state.taps.slice(before), error };
}

async function tap(axe, udid, s) {
  const { events, error } = await perform(axe, ["tap", `-x=${s.x}`, `-y=${s.y}`, "--udid", udid], 400);
  return { down: events.find((t) => t.type === "pointerdown"), error };
}

/** Opens the page, waits for it, and returns the region to work in: {x, y, w, h} in screen points. */
async function openPage(axe, udid, port) {
  run("xcrun", ["simctl", "openurl", udid, `http://127.0.0.1:${port}/?t=${Date.now()}`]);
  for (let i = 0; i < 40 && !state.page; i++) await sleep(250);
  if (!state.page) throw new Error("the page never loaded (is Safari able to reach 127.0.0.1 on that simulator?)");

  const frame = appFrame(axe, udid);
  // After a rotation, Safari can report the old orientation for a few seconds.
  const landscape = frame.width > frame.height;
  for (let i = 0; i < 20 && state.page.orientation.startsWith("landscape") !== landscape; i++) await sleep(250);
  await sleep(1500); // let Safari settle its toolbars

  if (values.origin || values.size) {
    if (!values.origin || !values.size) throw new Error("pass --origin and --size together");
    const [x, y] = values.origin.split(",").map(Number);
    const [w, h] = values.size.split("x").map(Number);
    return { region: { x, y, w, h }, frame };
  }

  // Calibrate: find one point that reaches the page, then place the page's viewport around it.
  for (const [fx, fy] of [[0.5, 0.55], [0.25, 0.55], [0.75, 0.55]]) {
    const s = { x: Math.round(frame.x + frame.width * fx), y: Math.round(frame.y + frame.height * fy) };
    const { down } = await tap(axe, udid, s);
    if (!down) continue;
    const page = state.page;
    const x = Math.round(Math.max(frame.x, s.x - down.x));
    const y = Math.round(Math.max(frame.y, s.y - down.y));
    const w = Math.round(Math.min(page.w, frame.x + frame.width - x));
    const h = Math.round(Math.min(page.h, frame.y + frame.height - y));
    return { region: { x, y, w, h }, frame, calibration: { sent: s, seen: { x: down.x, y: down.y } } };
  }
  throw new Error("calibration taps never reached the page; pass --origin X,Y --size WxH");
}

/** Least-squares fit of v = a·x + b·y + c over the points; returns [a, b, c]. */
function fit(pts, v) {
  const s = { xx: 0, xy: 0, x: 0, yy: 0, y: 0, n: 0, vx: 0, vy: 0, v: 0 };
  pts.forEach((p, i) => {
    s.xx += p.x * p.x;
    s.xy += p.x * p.y;
    s.x += p.x;
    s.yy += p.y * p.y;
    s.y += p.y;
    s.n += 1;
    s.vx += v[i] * p.x;
    s.vy += v[i] * p.y;
    s.v += v[i];
  });
  const m = [
    [s.xx, s.xy, s.x],
    [s.xy, s.yy, s.y],
    [s.x, s.y, s.n],
  ];
  const r = [s.vx, s.vy, s.v];
  const det = (q) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((cell, j) => (j === col ? r[i] : cell)))) / d);
}

async function check(axe, udid, region) {
  const [cols, rows] = values.grid.split("x").map(Number);
  if (!(cols >= 2 && rows >= 2)) throw new Error("--grid must be at least 2x2");
  const sent = [];
  const seen = [];
  let missed = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      // Inset from the region's edges, more at the top where Safari's toolbar can overlap the page.
      const s = {
        x: Math.round(region.x + region.w * (0.08 + (0.84 * i) / (cols - 1))),
        y: Math.round(region.y + region.h * (0.15 + (0.77 * j) / (rows - 1))),
      };
      const { down, error } = await tap(axe, udid, s);
      console.log(`tap ${s.x},${s.y} -> ${down ? `${down.x.toFixed(1)},${down.y.toFixed(1)}` : "missed"} ${error}`);
      if (down) {
        sent.push(s);
        seen.push(down);
      } else missed++;
    }
  const result = { sent: sent.length + missed, received: sent.length };
  if (sent.length < 3) return { ...result, pass: false, why: "fewer than 3 taps reached the page" };
  const fx = fit(sent, seen.map((t) => t.x));
  const fy = fit(sent, seen.map((t) => t.y));
  const A = [fx[0], fx[1], fy[0], fy[1]].map((v) => +v.toFixed(4));
  const b = [fx[2], fy[2]].map((v) => +v.toFixed(1));
  if (!A.every(Number.isFinite)) return { ...result, pass: false, why: "the taps that landed are all on one line" };
  const residual = Math.max(
    ...sent.map((s, i) =>
      Math.hypot(fx[0] * s.x + fx[1] * s.y + fx[2] - seen[i].x, fy[0] * s.x + fy[1] * s.y + fy[2] - seen[i].y),
    ),
  );
  const identity = [1, 0, 0, 1].every((v, i) => Math.abs(A[i] - v) < 0.02);
  const enough = sent.length >= 0.75 * (sent.length + missed);
  const pass = identity && residual < 3 && enough;
  const why = [
    !identity && "A is not the identity",
    residual >= 3 && "residual over 3pt",
    !enough && "too many taps missed the page",
  ].filter(Boolean).join("; ");
  return { ...result, A, b, residual: +residual.toFixed(2), pass, why };
}

async function gesture(axe, udid, region) {
  const at = (fx, fy) => ({ x: Math.round(region.x + region.w * fx), y: Math.round(region.y + region.h * fy) });
  const [a, b] = [at(0.25, 0.3), at(0.75, 0.8)];
  const runs = [
    { kind: "swipe", from: a, to: b, duration: "0.4" },
    { kind: "drag", from: b, to: a, duration: "0.6" },
  ];
  const results = [];
  for (const g of runs) {
    const args = [g.kind, "--start-x", g.from.x, "--start-y", g.from.y, "--end-x", g.to.x, "--end-y", g.to.y];
    const { events, error } = await perform(axe, [...args.map(String), "--duration", g.duration, "--udid", udid], 1000);
    const down = events.find((e) => e.type === "pointerdown");
    const up = events.filter((e) => e.type === "pointerup").pop();
    const sent = [g.to.x - g.from.x, g.to.y - g.from.y];
    const r = { kind: g.kind, from: g.from, to: g.to, sent };
    if (!down || !up) {
      results.push({ ...r, pass: false, why: `the page saw no pointerdown/pointerup ${error}`.trim() });
      continue;
    }
    const got = [+(up.x - down.x).toFixed(1), +(up.y - down.y).toFixed(1)];
    const pass = Math.abs(sent[0] - got[0]) < 6 && Math.abs(sent[1] - got[1]) < 6;
    results.push({ ...r, page: got, pass, why: pass ? "" : "page delta differs from the delta sent" });
  }
  const failed = results.filter((r) => !r.pass);
  return { gestures: results, pass: !failed.length, why: failed.map((r) => `${r.kind}: ${r.why}`).join("; ") };
}

async function main() {
  const mode = positionals[0];
  if (mode === "serve") {
    const port = Number(values.port ?? 4319);
    await serve(port);
    console.log(`tap recorder on http://127.0.0.1:${port}/ (state: /state, reset: POST /reset)`);
  } else if (mode === "check" || mode === "gesture") {
    const server = await serve(Number(values.port ?? 0)); // a free port unless one is given
    let r;
    try {
      const axe = values.axe;
      const udid = values.udid ?? bootedSimulator();
      const { region, frame, calibration } = await openPage(axe, udid, server.address().port);
      const body = mode === "check" ? await check(axe, udid, region) : await gesture(axe, udid, region);
      r = { axe, udid, page: state.page, frame, region, calibration, ...body };
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
    console.log(JSON.stringify(r, null, 2));
    console.log(r.pass ? "PASS" : `FAIL: ${r.why}`);
    process.exit(r.pass ? 0 : 1);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(2);
});
