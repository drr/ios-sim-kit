// The page side of the probe, served by the relay as /probe.js. A page opts in by loading it:
//   <script src="http://127.0.0.1:4320/probe.js" data-probe-name="ipad"></script>
// or by loading it always and being opened with ios-sim-probe=NAME in its hash or query (`ios-sim open --probe NAME`
// adds it). The URL is read when this runs, so load it before app code rewrites the URL. It then asks the relay (the
// origin it was loaded from) for scripts from a tool on this machine, runs each here, and posts back what it
// returns. Without a name it does nothing.
(() => {
  const me = /** @type {HTMLScriptElement | null} */ (document.currentScript);
  const relay = me ? new URL(me.src).origin : "";
  const key = /[?#&]ios-sim-probe=([\w.-]{1,40})(?:[&#]|$)/;
  const fromUrl = key.exec(location.search)?.[1] || key.exec(location.hash)?.[1];
  let stored = null;
  try {
    stored = sessionStorage.getItem("ios-sim-probe");
  } catch {}
  const name = me?.dataset.probeName || fromUrl || stored;
  const w = /** @type {{ __iosSimProbe?: string }} */ (/** @type {unknown} */ (window));
  if (!relay || !name || w.__iosSimProbe) return;
  w.__iosSimProbe = name;
  // Survives in-page navigation that drops the hash (same tab, same origin).
  try {
    sessionStorage.setItem("ios-sim-probe", name);
  } catch {}

  const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

  /** Runs one job: its script is an async function body; its result must survive JSON. */
  async function run(/** @type {{ id: string, script: string }} */ job) {
    let body;
    try {
      // Running the tool's script is the point; only this machine can submit one (see probe-relay.ts).
      const value = await new Function(`return (async () => {\n${job.script}\n})()`)();
      body = JSON.stringify({ id: job.id, ok: true, value: value ?? null });
    } catch (e) {
      const err = /** @type {{ stack?: string }} */ (e);
      body = JSON.stringify({ id: job.id, ok: false, error: String(err?.stack ?? e) });
    }
    await fetch(`${relay}/result`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(
      () => {},
    );
  }

  // Polls only while the tab is visible: a background tab can't be measured or tapped, and its name then belongs to
  // whichever tab is in front. Going to the background ends the open poll.
  let poll = new AbortController();
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") poll.abort();
  });
  const visible = () =>
    document.visibilityState === "visible"
      ? Promise.resolve()
      : new Promise((r) => addEventListener("visibilitychange", r, { once: true }));

  (async () => {
    for (;;) {
      await visible();
      if (document.visibilityState !== "visible") continue;
      poll = new AbortController();
      let job = null;
      try {
        const r = await fetch(`${relay}/next?client=${encodeURIComponent(name)}`, {
          cache: "no-store",
          signal: poll.signal,
        });
        if (r.status === 200) job = await r.json();
        else if (r.status !== 204) throw new Error(`probe: HTTP ${r.status}`);
      } catch {
        await wait(1000);
        continue;
      }
      if (job) await run(job);
    }
  })();
})();
