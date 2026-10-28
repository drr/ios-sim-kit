// The probe relay: a standalone HTTP server around ProbeHub, so any project's pages can be measured. Bound to
// 127.0.0.1. Pages load /probe.js from here (cross-origin), poll /next and post /result; those three send CORS headers.
// Tools on this machine use /run and /clients: loopback only, no CORS, and refused when the request has an Origin
// header, so no web page (whatever its origin) can submit a job.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProbeHub, type ProbeResult, probeName } from "./probe-hub.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

const MAX_BODY = 4 << 20;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new HttpError(413, "body too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "send JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (status === 204) return res.writeHead(204, { "cache-control": "no-store", ...headers }).end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const isLoopback = (addr: string) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

const pageScript = () => readFileSync(new URL("./probe-page.js", import.meta.url), "utf8");

/** A page for trying the probe and calibrated taps on: buttons that count clicks, a box and a tall scroll area. */
const DEMO = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ios-sim demo</title>
<style>
  body { margin: 0; font: 17px -apple-system, sans-serif; background: #fff; color: #111 }
  header { padding: 16px }
  button { font: inherit; padding: 14px 22px; margin: 8px 8px 0 0; border-radius: 10px; border: 1px solid #888 }
  #log { color: #555; margin-top: 8px }
  .tall { height: 3000px; background: linear-gradient(#eef, #fee) }
</style>
<header>
  <h1>ios-sim demo</h1>
  <button id="a">A</button><button id="b">B</button><button id="c">C</button>
  <div id="log">no clicks yet</div>
</header>
<div class="tall"></div>
<script>
  window.clicks = [];
  for (const b of document.querySelectorAll("button"))
    b.addEventListener("click", () => {
      clicks.push(b.id);
      document.getElementById("log").textContent = "clicked " + clicks.join(" ");
    });
</script>
<script src="/probe.js"></script>`;

export function relay(hub = new ProbeHub()): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method === "HEAD" ? "GET" : req.method;
      const route = url.pathname;
      const local = isLoopback(req.socket.remoteAddress ?? "");
      const name = (v: unknown) => {
        try {
          return probeName(v);
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : String(e));
        }
      };
      const forPages = route === "/probe.js" || route === "/next" || route === "/result";
      if (method === "OPTIONS") {
        if (!forPages) throw new HttpError(403, "only /probe.js, /next and /result take cross-origin requests");
        return send(res, 204, null, CORS);
      }
      if (route === "/" && method === "GET") return send(res, 200, { probe: "ios-sim", pid: process.pid });
      if (route === "/probe.js" && method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store", ...CORS });
        return res.end(pageScript());
      }
      if (route === "/demo" && method === "GET") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        return res.end(DEMO);
      }
      if (route === "/next" && method === "GET") {
        const client = name(url.searchParams.get("client"));
        const gone = new AbortController();
        res.on("close", () => gone.abort());
        const job = await hub.next(client, req.headers["user-agent"] ?? "", undefined, gone.signal);
        return job ? send(res, 200, job, CORS) : send(res, 204, null, CORS);
      }
      if (route === "/result" && method === "POST") {
        const body = (await readJson(req)) as (Partial<ProbeResult> & { id?: unknown }) | null;
        if (typeof body?.id !== "string" || typeof body.ok !== "boolean") throw new HttpError(400, "send {id, ok, …}");
        const r: ProbeResult = { ok: body.ok };
        if ("value" in body) r.value = body.value;
        if (typeof body.error === "string") r.error = body.error;
        if (!hub.result(body.id, r)) throw new HttpError(404, `no job ${body.id} is waiting`);
        return send(res, 204, null, CORS);
      }
      if (route === "/clients" || route === "/run") {
        if (!local) throw new HttpError(403, "only this machine can probe");
        // A browser always sends Origin on cross-origin and POST requests; tools don't.
        if (req.headers.origin) throw new HttpError(403, "jobs come from a tool, not a page");
        if (route === "/clients" && method === "GET") return send(res, 200, hub.list());
        if (route === "/run" && method === "POST") {
          const body = (await readJson(req)) as { client?: unknown; script?: unknown; timeoutMs?: unknown } | null;
          if (typeof body?.script !== "string") throw new HttpError(400, "send {client, script, timeoutMs?}");
          const timeout = typeof body.timeoutMs === "number" ? Math.min(body.timeoutMs, 120_000) : undefined;
          return send(res, 200, await hub.run(name(body.client), body.script, timeout));
        }
      }
      const known = ["/", "/probe.js", "/demo", "/next", "/result", "/clients", "/run"].includes(route);
      throw new HttpError(known ? 405 : 404, "no such probe call");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    }
  });
}

/** Starts the relay on 127.0.0.1:`port` (0 = any free port); resolves with the port. */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
