import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { withProbeName } from "../src/probe-client.ts";
import { ProbeHub } from "../src/probe-hub.ts";
import { listen, relay } from "../src/probe-relay.ts";

test("probe hub: a job reaches a waiting page or the next poll; answers, timeouts, a newer poll", async () => {
  const hub = new ProbeHub();
  // Queued before the page polls.
  const early = hub.run("ipad", "return 1");
  const job1 = await hub.next("ipad", "ua", 1000);
  assert.equal(job1?.script, "return 1");
  assert.match(job1?.id ?? "", /^[0-9a-f-]{36}$/); // random, so a page can't guess another page's job
  assert.equal(hub.result(job1?.id ?? "", { ok: true, value: 1 }), true);
  assert.deepEqual(await early, { ok: true, value: 1 });
  // Submitted while the page waits.
  const poll = hub.next("ipad", "ua", 1000);
  const late = hub.run("ipad", "return 2");
  const job2 = await poll;
  hub.result(job2?.id ?? "", { ok: false, error: "boom" });
  assert.deepEqual(await late, { ok: false, error: "boom" });
  assert.equal(hub.result(job2?.id ?? "", { ok: true }), false); // answered already
  // No page: the job times out and leaves the queue.
  assert.match((await hub.run("nobody", "x", 20)).error ?? "", /no answer from 'nobody'/);
  assert.equal(await hub.next("nobody", "ua", 10), null);
  // A newer poll ends the older one empty; an aborted poll hands out nothing.
  const old = hub.next("tab", "ua", 1000);
  const newer = hub.next("tab", "ua", 1000);
  assert.equal(await old, null);
  const gone = new AbortController();
  gone.abort();
  const aborted = hub.next("tab", "ua", 1000, gone.signal);
  assert.equal(await newer, null);
  assert.equal(await aborted, null);
  assert.deepEqual(
    hub
      .list()
      .map((c) => c.name)
      .sort(),
    ["ipad", "nobody", "tab"],
  );
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTP request, so the test can send any Origin header (fetch would set its own rules). */
function call(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<Res>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function withRelay(fn: (port: number) => Promise<void>) {
  const server = relay();
  const port = await listen(server, 0);
  try {
    await fn(port);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const JSON_TYPE = { "content-type": "application/json" };
const PAGE = { origin: "http://127.0.0.1:8080" };

test("relay: a page polls and answers across origins; only a tool without an Origin submits", async () => {
  await withRelay(async (port) => {
    assert.match((await call(port, "/")).body, /"probe":"ios-sim"/);
    const js = await call(port, "/probe.js", { headers: PAGE });
    assert.equal(js.status, 200);
    assert.equal(js.headers["access-control-allow-origin"], "*");
    assert.match(js.body, /data-probe-name/);
    assert.match(js.body, /ios-sim-probe=/);
    assert.equal((await call(port, "/demo")).status, 200);
    assert.equal((await call(port, "/next?client=bad%20name")).status, 400);
    assert.equal((await call(port, "/nope")).status, 404);
    assert.equal((await call(port, "/run")).status, 405);

    // Preflights: allowed for the page's routes, refused for the tool's.
    const pre = (path: string) =>
      call(port, path, {
        method: "OPTIONS",
        headers: { ...PAGE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
    const okPre = await pre("/result");
    assert.equal(okPre.status, 204);
    assert.equal(okPre.headers["access-control-allow-origin"], "*");
    for (const path of ["/run", "/clients"]) {
      const bad = await pre(path);
      assert.equal(bad.status, 403);
      assert.equal(bad.headers["access-control-allow-origin"], undefined);
    }

    // The page's poll gets the tool's job; the tool gets the page's answer.
    const poll = call(port, "/next?client=iphone", { headers: { ...PAGE, "user-agent": "Sim" } });
    await new Promise((r) => setTimeout(r, 50));
    const listed = JSON.parse((await call(port, "/clients")).body) as { name: string; ua: string }[];
    assert.deepEqual(
      listed.map((c) => [c.name, c.ua]),
      [["iphone", "Sim"]],
    );
    const ran = call(port, "/run", {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ client: "iphone", script: "return innerWidth" }),
    });
    const polled = await poll;
    assert.equal(polled.headers["access-control-allow-origin"], "*");
    const job = JSON.parse(polled.body) as { id: string; script: string };
    assert.equal(job.script, "return innerWidth");
    const answer = (body: unknown) =>
      call(port, "/result", { method: "POST", headers: { ...JSON_TYPE, ...PAGE }, body: JSON.stringify(body) });
    assert.equal((await answer({ id: 1, ok: true })).status, 400);
    assert.equal((await answer({ id: "guess", ok: true })).status, 404);
    assert.equal((await answer({ id: job.id, ok: true, value: 393 })).status, 204);
    assert.deepEqual(JSON.parse((await ran).body), { ok: true, value: 393 });
    assert.equal((await answer({ id: job.id, ok: true })).status, 404); // answered already

    // A page can't submit jobs or list pages, whatever its origin (it always sends one).
    for (const origin of [PAGE.origin, `http://127.0.0.1:${port}`, "null"]) {
      const fromPage = await call(port, "/run", {
        method: "POST",
        headers: { ...JSON_TYPE, origin },
        body: JSON.stringify({ client: "iphone", script: "1" }),
      });
      assert.equal(fromPage.status, 403);
      assert.equal((await call(port, "/clients", { headers: { origin } })).status, 403);
    }
    assert.equal((await call(port, "/run", { method: "POST", headers: JSON_TYPE, body: "{" })).status, 400);
  });
});

/** Runs probe-page.js in a sandbox shaped like a page; returns the name it took (undefined: it stayed off). */
function pageName(opts: { tag?: string; search?: string; hash?: string; stored?: string }) {
  const store = new Map(opts.stored ? [["ios-sim-probe", opts.stored]] : []);
  const win: Record<string, unknown> = {
    document: {
      currentScript: { src: "http://127.0.0.1:4320/probe.js", dataset: { probeName: opts.tag } },
      visibilityState: "hidden",
    },
    location: { search: opts.search ?? "", hash: opts.hash ?? "" },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    addEventListener: () => {},
    fetch: () => new Promise(() => {}),
    setTimeout,
    URL,
    AbortController,
  };
  win.window = win;
  runInNewContext(readFileSync(new URL("../src/probe-page.js", import.meta.url), "utf8"), win);
  return win.__iosSimProbe as string | undefined;
}

test("probe page: its name comes from the tag, then ios-sim-probe= in the URL, then the tab's storage", () => {
  assert.equal(pageName({ tag: "t", hash: "#ios-sim-probe=h", stored: "s" }), "t");
  assert.equal(pageName({ hash: "#ios-sim-probe=h", stored: "s" }), "h");
  assert.equal(pageName({ hash: "#/route&ios-sim-probe=h2" }), "h2");
  assert.equal(pageName({ search: "?a=1&ios-sim-probe=q" }), "q");
  assert.equal(pageName({ stored: "s" }), "s");
  // The page's own #probe= belongs to the page (watched-media has one), and a longer key isn't ours.
  assert.equal(pageName({ hash: "#probe=theirs" }), undefined);
  assert.equal(pageName({ hash: "#my-ios-sim-probe=x" }), undefined);
  assert.equal(pageName({ hash: "#ios-sim-probe=bad name" }), undefined);
});

test("withProbeName: in the hash, or the query when the URL has a hash of its own", () => {
  assert.equal(withProbeName("http://h:8080/?t=1", "ipad"), "http://h:8080/?t=1#ios-sim-probe=ipad");
  assert.equal(withProbeName("http://h/#/list", "ipad"), "http://h/?ios-sim-probe=ipad#/list");
  assert.equal(withProbeName("http://h/#ios-sim-probe=x", "ipad"), "http://h/#ios-sim-probe=x");
});
