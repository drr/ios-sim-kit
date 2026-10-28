// The tool side of the probe, for ios-sim and for project scripts:
//   import { probe, clients } from "<kit>/src/probe-client.ts";
//   const w = await probe<number>("ipad", "return innerWidth");
//   const box = await probe("ipad", (sel: string) => document.querySelector(sel)?.getBoundingClientRect(), ["h1"]);
// A function is sent as source and runs in the page, so it must be self-contained; its result must survive JSON.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, HOME } from "./config.ts";

// biome-ignore lint/suspicious/noExplicitAny: page functions take JSON arguments of any shape
export type PageFn = (...args: any[]) => unknown;

export const relayUrl = (port = config().probePort) => `http://127.0.0.1:${port}`;

/** `url` with `ios-sim-probe=NAME` added: in the hash, or in the query when the URL has a hash of its own. */
export function withProbeName(url: string, name: string): string {
  if (/[?#&]ios-sim-probe=/.test(url)) return url;
  const u = new URL(url);
  if (u.hash) u.searchParams.set("ios-sim-probe", name);
  else u.hash = `ios-sim-probe=${name}`;
  return u.href;
}

/** Runs `fn` (a function, or an async function body as a string) in the page named `client`; throws if it fails. */
export async function probe<T>(client: string, fn: PageFn | string, args: unknown[] = [], timeoutMs = 10_000) {
  const script = typeof fn === "string" ? fn : `return (${fn.toString()})(...${JSON.stringify(args)});`;
  const res = await fetch(`${relayUrl()}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client, script, timeoutMs }),
  });
  const body = (await res.json()) as { ok?: boolean; value?: unknown; error?: string };
  if (!body.ok && body.error?.startsWith("no answer")) {
    // Usually the page isn't the visible tab any more (Safari switched tabs, or it never loaded).
    const all = await clients().catch(() => []);
    const polling = all.filter((c) => c.ago < 3000).map((c) => c.name);
    const mine = all.find((c) => c.name === client);
    const last = mine
      ? `'${client}' last polled ${(mine.ago / 1000).toFixed(0)}s ago`
      : `'${client}' hasn't polled for 30s or more`;
    throw new Error(
      `probe ${client}: ${body.error}; ${last}; pages polling now: ${polling.join(", ") || "none"}. ` +
        "Only the visible tab polls: run `ios-sim screenshot DEVICE FILE --upright` to see which page is in front.",
    );
  }
  if (!body.ok) throw new Error(`probe ${client}: ${body.error ?? `HTTP ${res.status}`}`);
  return body.value as T;
}

export interface ProbeClient {
  name: string;
  ua: string;
  ago: number;
}

/** Pages polling the relay now, most recent first. */
export async function clients(): Promise<ProbeClient[]> {
  return (await (await fetch(`${relayUrl()}/clients`)).json()) as ProbeClient[];
}

/** Waits up to `ms` for the page named `client` to poll; false if it doesn't. */
export async function waitForClient(client: string, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300)))
    if ((await clients().catch(() => [])).some((c) => c.name === client)) return true;
  return false;
}

/** Whether a relay answers on the port. */
export async function relayUp(port = config().probePort): Promise<boolean> {
  try {
    const r = await fetch(`${relayUrl(port)}/`, { signal: AbortSignal.timeout(1000) });
    return ((await r.json()) as { probe?: string }).probe === "ios-sim";
  } catch {
    return false;
  }
}

const STATE = join(HOME, "relay.json");

/** Starts the relay in the background (`ios-sim probe serve`) unless one already answers. Returns its URL. */
export async function ensureRelay(port = config().probePort): Promise<string> {
  if (await relayUp(port)) return relayUrl(port);
  mkdirSync(HOME, { recursive: true });
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, "probe", "serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  writeFileSync(STATE, JSON.stringify({ pid: child.pid, port }));
  for (let i = 0; i < 50; i++) {
    if (await relayUp(port)) return relayUrl(port);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the probe relay didn't start on port ${port}`);
}

/** Stops the relay on the port (it reports its own pid); false if none answers. */
export async function stopRelay(port = config().probePort): Promise<boolean> {
  try {
    const r = await fetch(`${relayUrl(port)}/`, { signal: AbortSignal.timeout(1000) });
    const { probe, pid } = (await r.json()) as { probe?: string; pid?: number };
    if (probe !== "ios-sim" || !pid) return false;
    process.kill(pid);
    if (existsSync(STATE)) writeFileSync(STATE, "{}");
    return true;
  } catch {
    return false;
  }
}
