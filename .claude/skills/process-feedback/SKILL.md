---
name: process-feedback
description: Triage and work through ios-sim feedback reports, the bugs and requests other projects' sessions file with `ios-sim feedback`. Use for "process feedback", "check feedback", "triage the reports", or when the session-start reminder says reports are waiting.
---

# Processing feedback reports

Reports wait in two places, as `<date>-<slug>.md` plus an optional `<date>-<slug>/` folder of attachments:
- `~/bin/ios-sim feedback --list`: the installed copy's, `~/.config/ios-sim-kit/feedback/`. These are from other
  projects.
- `./bin/ios-sim feedback --list`: the dev copy's, `dev/feedback/`. These are usually from testing in this repo.

## 1. Read and triage

Read each report in full, and its attachments (Read the screenshots). The report shows the ios-sim version it was
filed with (compare `make status`), `doctor`, booted devices, and the reporter's recent commands with their output.
For each, decide:
- **fix**: a real bug, or a request worth building. Reproduce bugs with the dev copy (`./bin/ios-sim`) on this repo's
  `sk-*` devices, never the reporter's own devices (other prefixes).
- **already fixed**: by a later version than the one it was filed with. Check it in that version.
- **decline**: out of scope, or the reporter misused a command. Then the fix may be in the docs.
- **needs info**: it can't be reproduced, and the report lacks what would help.

Show the user a short table: report, kind, verdict, a one-line reason, and the proposed change. Wait for their go
before building. Plan anything that isn't trivial; the global rules say where the plan goes (`planning/<topic>.md`).

## 2. Build and verify

- Follow `planning/PLAN.md`'s invariants. `make check` always. Run `make e2e` when device behaviour changed, and
  check the reporter's own scenario on a device.
- Update `skill/SKILL.md` (usage only, terse) and the planning docs: `architecture.md` for how it works, `lessons.md`
  for what didn't work, `testing.md` for what was verified.

## 3. The interim planning file

Decide whether the batch's plan (or a request file copied into `planning/`) is worth keeping:
- **Keep it** if it records decisions, the user's choices, rejected approaches or investigation results that aren't
  now in `architecture.md`, `lessons.md` or `testing.md`. Track it: include it in the commit.
- **Delete it** once everything in it has landed elsewhere.

Say which you chose, and why, in the summary. Don't link it from `PLAN.md`: a file is either in `planning/` or it
isn't.

## 4. Close the reports

- Implemented and verified: delete the report and its folder. There is no `done/` folder.
- Declined or already fixed: tell the user, and delete it once they agree.
- Needs info: leave it, and tell the user what's missing.

## Rules

- This repo is public. Reports hold local paths, URLs and other projects' names: never copy them verbatim into
  tracked files. Paraphrase, and use `~` and placeholders.
- Never commit or push without the user asking. Release: the user commits, then `make install`.
