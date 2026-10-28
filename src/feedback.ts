// Feedback reports: a project's session files a bug or a request with `ios-sim feedback`, and a session in the
// ios-sim-kit repo picks it up from `$IOS_SIM_HOME/feedback/` and deletes it once the fix ships. Each report carries
// what a fixer needs and a reporter forgets: version, doctor, booted devices, and the recent ios-sim commands with
// their output, from a ring buffer of every run (`history.jsonl`). Local only: no network, no git.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { HOME } from "./config.ts";
import { doctor, version } from "./doctor.ts";
import { devices, orientation, SESSION } from "./sim.ts";

export const FEEDBACK_DIR = join(HOME, "feedback");
const HISTORY = join(HOME, "history.jsonl");
/** History keeps this many runs, rewriting the file once it's KEEP + SLACK lines long. */
const KEEP = 1000;
const SLACK = 100;
const MAX_OUT = 1 << 20;

export interface Run {
  at: string;
  argv: string[];
  cwd: string;
  session: string;
  exit: number;
  /** What the command printed (stdout and stderr, interleaved), up to 1MB. */
  out: string;
}

/** Appends a run to the history and trims it. Never throws: a full disk mustn't fail the command that ran. */
export function record(run: Omit<Run, "at" | "cwd" | "session">): void {
  try {
    mkdirSync(HOME, { recursive: true });
    const out = run.out.length > MAX_OUT ? `${run.out.slice(0, MAX_OUT)}\n… (cut at 1MB)` : run.out;
    const entry: Run = {
      at: new Date().toISOString(),
      argv: run.argv,
      cwd: process.cwd(),
      session: SESSION,
      exit: run.exit,
      out,
    };
    appendFileSync(HISTORY, `${JSON.stringify(entry)}\n`);
    const lines = readFileSync(HISTORY, "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP + SLACK) {
      writeFileSync(`${HISTORY}.new`, `${lines.slice(-KEEP).join("\n")}\n`);
      renameSync(`${HISTORY}.new`, HISTORY);
    }
  } catch {}
}

export function history(): Run[] {
  if (!existsSync(HISTORY)) return [];
  return readFileSync(HISTORY, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Run];
      } catch {
        return []; // a line cut short by a concurrent trim
      }
    });
}

/** Tees console.log and console.error into a buffer for the history; returns a reader. */
export function capture(): () => string {
  let buf = "";
  for (const k of ["log", "error"] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => {
      if (buf.length < MAX_OUT) buf += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
      orig(...args);
    };
  }
  return () => buf;
}

export interface Report {
  title: string;
  kind: "bug" | "request";
  project?: string | undefined;
  body: string;
  attach: string[];
  /** How many recent runs to include, or "all". */
  runs: number | "all";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "") || "report";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A fence that no backtick run in `text` can close. */
const fence = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
const block = (text: string) => {
  const f = fence(text);
  return `${f}\n${text.replace(/\n$/, "")}\n${f}`;
};

function project(): string {
  try {
    return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: "pipe" }).trim());
  } catch {
    return basename(process.cwd());
  }
}

/** The runs to put in a report: this session's when it has any (else everyone's), the last `n`. */
function recentRuns(n: number | "all"): { runs: Run[]; whose: string } {
  const all = history();
  const own = all.filter((r) => r.session === SESSION);
  const pick = SESSION !== "default" && own.length ? own : all;
  const whose = pick === own ? `session ${SESSION}` : "all sessions";
  return { runs: n === "all" ? pick : pick.slice(-n), whose };
}

const RAW = new Set(["axe", "tap-check", "gesture-check", "tap-serve"]);

async function environment(): Promise<string> {
  const lines = [`- ios-sim: ${version()}`, `- node: ${process.version}`];
  try {
    lines.push(`- macOS: ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`);
  } catch {}
  lines.push(`- cwd: ${process.cwd()}`, `- session: ${SESSION}`);
  const doc = await doctor().catch((e) => ({ lines: [`!!  doctor failed: ${e}`], ok: false }));
  let booted: string;
  try {
    const on = (await devices()).filter((d) => d.state === "Booted");
    const rows = await Promise.all(
      on.map(
        async (d) => `- ${d.name} (${d.udid}, ${d.runtime}): ${(await orientation(d).catch(() => null)) ?? "unknown"}`,
      ),
    );
    booted = rows.join("\n") || "none";
  } catch (e) {
    booted = `couldn't list devices: ${e instanceof Error ? e.message : e}`;
  }
  return [
    lines.join("\n"),
    `### doctor (${doc.ok ? "all ok" : "problems"})\n\n${block(doc.lines.join("\n"))}`,
    `### Booted devices\n\n${booted}`,
  ].join("\n\n");
}

/** Failure screenshots (`$IOS_SIM_HOME/shots/…png`) that the runs' output names and that still exist. */
function shotsIn(runs: Run[]): string[] {
  const dir = join(HOME, "shots");
  const found = runs.flatMap((r) => [...r.out.matchAll(/(\/\S+?\.png)\b/g)].map((m) => m[1] as string));
  return [...new Set(found)].filter((f) => f.startsWith(`${dir}/`) && existsSync(f));
}

/** Writes the report and its attachments; returns the report's path. */
export async function fileReport(r: Report): Promise<string> {
  const attach = r.attach.map((f) => resolve(f));
  for (const f of attach) if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`no such file to attach: ${f}`);
  const { runs, whose } = recentRuns(r.runs);
  const files = [...attach, ...shotsIn(runs).filter((s) => !attach.includes(s))];

  mkdirSync(FEEDBACK_DIR, { recursive: true });
  const base = `${today()}-${slug(r.title)}`;
  let stem = base;
  for (let i = 2; existsSync(join(FEEDBACK_DIR, `${stem}.md`)) || existsSync(join(FEEDBACK_DIR, stem)); i++)
    stem = `${base}-${i}`;
  const copied: string[] = [];
  if (files.length) {
    mkdirSync(join(FEEDBACK_DIR, stem));
    for (const f of files) {
      let name = basename(f);
      for (let i = 2; copied.includes(name); i++) name = `${i}-${basename(f)}`;
      copyFileSync(f, join(FEEDBACK_DIR, stem, name));
      copied.push(name);
    }
  }

  const runText = runs.length
    ? runs
        .map((run) => {
          const head = `#### \`ios-sim ${run.argv.join(" ")}\` → exit ${run.exit}\n\n${run.at}, in ${run.cwd}`;
          const out = RAW.has(run.argv[0] ?? "") ? "(its output went straight to the terminal)" : run.out;
          return `${head}\n\n${out ? block(out) : "(no output)"}`;
        })
        .join("\n\n")
    : "none recorded";
  const text = [
    "---",
    `title: ${JSON.stringify(r.title)}`,
    `kind: ${r.kind}`,
    `project: ${JSON.stringify(r.project ?? project())}`,
    `date: ${today()}`,
    "---",
    "",
    `# ${r.title}`,
    "",
    r.body.trim(),
    "",
    ...(copied.length ? ["## Attachments", "", ...copied.map((n) => `- [${n}](${stem}/${encodeURI(n)})`), ""] : []),
    "## Environment",
    "",
    await environment(),
    "",
    `## Recent ios-sim commands (${runs.length}, ${whose}, oldest first)`,
    "",
    runText,
    "",
  ].join("\n");
  const file = join(FEEDBACK_DIR, `${stem}.md`);
  writeFileSync(file, text);
  return file;
}

/** One line per open report: file, date, kind, project, title. */
export function listReports(): string[] {
  if (!existsSync(FEEDBACK_DIR)) return [];
  return readdirSync(FEEDBACK_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort() // by stem, so a report sorts before its -2
    .map((stem) => `${stem}.md`)
    .map((f) => {
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(FEEDBACK_DIR, f), "utf8"))?.[1] ?? "";
      const field = (k: string) => {
        const v = new RegExp(`^${k}: (.*)$`, "m").exec(head)?.[1] ?? "";
        try {
          return v.startsWith('"') ? (JSON.parse(v) as string) : v;
        } catch {
          return v;
        }
      };
      return [join(FEEDBACK_DIR, f), field("date"), field("kind"), field("project"), field("title")].join("\t");
    });
}
