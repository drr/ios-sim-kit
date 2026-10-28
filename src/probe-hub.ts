/**
 * The probe hub: lets a tool on this machine run scripts in pages, to measure them between real gestures. Safari
 * ignores touch input while WebDriver drives it, so pages fetch their own jobs instead: each page names itself and
 * asks `/next?client=<name>`, which waits until a job comes or `POLL_MS` passes. The tool posts a job to `/run` and
 * gets the page's answer, which the page posts to `/result` (see probe-relay.ts). Job ids are random, because any
 * page may post results to the relay.
 */
import { randomUUID } from "node:crypto";

/** How long a page's poll waits for a job before an empty answer (it then polls again). */
export const POLL_MS = 20_000;
/** How long a job waits for its page by default. */
export const RUN_MS = 15_000;
/** A page that hasn't polled for this long is gone. */
const GONE_MS = POLL_MS + 10_000;

export interface ProbeJob {
  id: string;
  script: string;
}

export interface ProbeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface Client {
  ua: string;
  seen: number;
  /** The page's open poll, if it has one. */
  waiting: ((job: ProbeJob | null) => void) | null;
  queue: ProbeJob[];
}

export class ProbeHub {
  private clients = new Map<string, Client>();
  private pending = new Map<string, (r: ProbeResult) => void>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private client(name: string, ua = ""): Client {
    let c = this.clients.get(name);
    if (!c) {
      c = { ua, seen: this.now(), waiting: null, queue: [] };
      this.clients.set(name, c);
    }
    return c;
  }

  /**
   * A page asks for its next job: one queued already, else the next submitted within `waitMs`, else null. `signal`
   * ends the wait early (the page went away), so no job is handed to a request nobody reads.
   */
  next(name: string, ua: string, waitMs = POLL_MS, signal?: AbortSignal): Promise<ProbeJob | null> {
    const c = this.client(name, ua);
    c.ua = ua;
    c.seen = this.now();
    c.waiting?.(null); // a newer poll (a reload, a second tab) replaces the old one
    c.waiting = null;
    if (signal?.aborted) return Promise.resolve(null);
    const queued = c.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), waitMs);
      const done = (job: ProbeJob | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (c.waiting === done) c.waiting = null;
        c.seen = this.now();
        resolve(job);
      };
      const abort = () => done(null);
      c.waiting = done;
      signal?.addEventListener("abort", abort);
    });
  }

  /** Runs `script` in the named page; resolves with its answer, or `{ok: false}` if none comes in `timeoutMs`. */
  run(name: string, script: string, timeoutMs = RUN_MS): Promise<ProbeResult> {
    const job = { id: randomUUID(), script };
    const c = this.client(name);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        c.queue = c.queue.filter((j) => j !== job);
        resolve({ ok: false, error: `no answer from '${name}' in ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(job.id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      if (c.waiting) c.waiting(job);
      else c.queue.push(job);
    });
  }

  /** A page's answer to job `id`; false if nothing waits for it (unknown, or timed out). */
  result(id: string, r: ProbeResult): boolean {
    const settle = this.pending.get(id);
    if (!settle) return false;
    this.pending.delete(id);
    settle(r);
    return true;
  }

  /** Pages seen recently, most recent first. */
  list(): { name: string; ua: string; ago: number }[] {
    const now = this.now();
    return [...this.clients]
      .map(([name, c]) => ({ name, ua: c.ua, ago: c.waiting ? 0 : now - c.seen }))
      .filter((c) => c.ago < GONE_MS)
      .sort((a, b) => a.ago - b.ago);
  }
}

const NAME = /^[\w.-]{1,40}$/;

/** A page or tool name from a request: letters, digits, `_ . -`, at most 40. */
export function probeName(v: unknown): string {
  if (typeof v !== "string" || !NAME.test(v)) throw new Error("client must be 1-40 of A-Z a-z 0-9 _ . -");
  return v;
}
