import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

/** Runs the CLI with its own IOS_SIM_HOME and session. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "ios-sim-fb-"));
  const run = (args: string[], input?: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      input: input ?? "",
      env: { ...process.env, IOS_SIM_HOME: home, IOS_SIM_SESSION: "fb-test" },
    });
  const historyLines = () => readFileSync(join(home, "history.jsonl"), "utf8").split("\n").filter(Boolean);
  return { home, run, historyLines };
}

test("runs go into the history with their exit codes and output; help and version don't", () => {
  const { run, historyLines } = sandbox();
  run(["help"]);
  run(["rotate"]); // fails: no device
  run(["window", "x", "--probe", "p"]); // fails: usage
  run(["version"]);
  const runs = historyLines().map((l) => JSON.parse(l));
  assert.deepEqual(
    runs.map((r) => [r.argv[0], r.exit, r.session]),
    [
      ["rotate", 1, "fb-test"],
      ["window", 1, "fb-test"],
    ],
  );
  assert.match(runs[0].out, /^ios-sim: /);
});

test("the history keeps the last 1000 runs once it passes 1100", () => {
  const { home, run, historyLines } = sandbox();
  const old = (i: number) => JSON.stringify({ at: "", argv: [`old${i}`], cwd: "/", session: "x", exit: 0, out: "" });
  writeFileSync(join(home, "history.jsonl"), `${Array.from({ length: 1099 }, (_, i) => old(i)).join("\n")}\n`);
  run(["rotate"]);
  assert.equal(historyLines().length, 1100, "not trimmed at 1100");
  run(["rotate"]);
  const lines = historyLines();
  assert.equal(lines.length, 1000);
  assert.equal(JSON.parse(lines.at(-1) as string).argv[0], "rotate");
  assert.equal(JSON.parse(lines[0] as string).argv[0], "old101");
});

test("feedback files a report with body, environment, recent runs and attachments", () => {
  const { home, run } = sandbox();
  for (let i = 0; i < 3; i++) run(["rotate", `dev${i}`]);
  const shot = join(home, "shots", "dev-tap-el-1.png");
  mkdirSync(join(home, "shots"));
  writeFileSync(shot, "png");
  writeFileSync(
    join(home, "history.jsonl"),
    `${JSON.stringify({ at: "", argv: ["tap-el"], cwd: "/", session: "fb-test", exit: 1, out: `ios-sim: missed; screenshot: ${shot}\n` })}\n`,
    { flag: "a" },
  );
  const att = join(home, "note.txt");
  writeFileSync(att, "attached");
  const r = run(
    ["feedback", "--title", "Open reuses the tab!", "--kind", "request", "--attach", att, "--history", "2"],
    "Steps: open twice.\nExpected: two tabs.\n",
  );
  assert.equal(r.status, 0, r.stderr);
  const file = r.stdout.trim();
  assert.equal(file, join(home, "feedback", `${new Date().toLocaleDateString("sv")}-open-reuses-the-tab.md`));
  const text = readFileSync(file, "utf8");
  assert.match(text, /^---\ntitle: "Open reuses the tab!"\nkind: request\nproject: ".+"\ndate: \d{4}-\d\d-\d\d\n---/);
  assert.match(text, /Steps: open twice\./);
  assert.match(text, /### doctor/);
  assert.match(text, /### Booted devices/);
  assert.match(text, /## Recent ios-sim commands \(2, session fb-test/);
  assert.match(text, /`ios-sim rotate dev2` → exit 1/);
  assert.doesNotMatch(text, /rotate dev1/);
  const dir = file.replace(/\.md$/, "");
  assert.deepEqual(readdirSync(dir).sort(), ["dev-tap-el-1.png", "note.txt"]);
  assert.equal(readFileSync(join(dir, "note.txt"), "utf8"), "attached");

  const again = run(["feedback", "--title", "Open reuses the tab!"], "again");
  assert.equal(again.stdout.trim(), file.replace(/\.md$/, "-2.md"));
  const list = run(["feedback", "--list"]).stdout.trim().split("\n");
  assert.equal(list.length, 2);
  assert.match(list[0] as string, /\trequest\t.+\tOpen reuses the tab!$/);
});

test("feedback refuses an empty body, a missing attachment and a bad kind, writing nothing", () => {
  const { home, run } = sandbox();
  for (const [args, input] of [
    [["--title", "t"], "  \n"],
    [["--title", "t", "--attach", "/nonexistent.png"], "body"],
    [["--title", "t", "--kind", "idea"], "body"],
  ] as const) {
    const r = run(["feedback", ...args], input);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /^ios-sim: /);
  }
  assert.equal(existsSync(join(home, "feedback")), false);
  assert.match(run(["feedback", "--list"]).stdout, /^no open reports/);
});
