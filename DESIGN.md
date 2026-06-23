# pi-cron-jobs — Design Doc

> Working name. A scheduler for **headless pi runs** (precise-date or recurring),
> with a pi extension that lists jobs, surfaces run results/failures, and lets you
> **resume the conversation** any run produced.

Status: **Reviewed — decisions locked.** All v1 open questions resolved (§9).

---

## 1. Goals

1. Schedule pi to run at a **precise date/time** or on a **recurring** schedule.
2. Jobs run **headlessly via the real OS scheduler** (launchd primary, cron
   fallback) — they fire even when no interactive pi session is open, and survive
   reboot/sleep.
3. **List all jobs** and, per job, **list all its runs**.
4. **Be notified** when a job ran and especially when it failed — at pi
   `session_start` and via an ambient **status-line widget** during a conversation.
5. **Resume the conversation** a run produced, so you can pick up the work
   interactively.

### Non-goals (v1)

- Cloud / remote execution (local-only, your machine, your tokens).
- A web GUI; cross-machine sync; publishing to npm (build for ourselves first).
- Summary extraction, per-run permission models, global throttling (deferred).

---

## 2. Verified facts (tested against installed pi)

These drive the design; confirmed by experiment on 2026-06-22:

1. **Thread continuity:** `pi --print --session-id <id> "<prompt>"` (no
   `--continue` needed) grows **one thread** — a later run with the same id
   remembers earlier context. ✅
2. **Session storage is cwd-scoped:**
   `~/.pi/agent/sessions/<cwd-slug>/<ts>_<sessionId>.jsonl`. `--session-id` is
   scoped to the current cwd and **auto-creates if missing** (so the same id in a
   different cwd starts fresh, with no prompt). → headless runs must always fire
   from the job's fixed cwd.
3. **Resume works from anywhere:** `pi --session <id>` (or `pi --resume` picker,
   which lets you choose scope) resolves a session **globally**. If you run it
   outside the session's original project, pi prompts
   *"Session found in different project: <path>"* to confirm before re-creating
   `.pi` there. `cd <job.cwd>` first to skip that prompt.
4. **`--session` is interactive:** in `--print` mode `pi --session <id>` blocks on
   the cross-project confirm. → **runs use `--session-id` (auto-create, no
   prompt); resume uses `--session` / `--resume` (interactive).**
5. **Exit codes are NOT reliable when extensions are loaded:** pi exits **1** on
   real config / provider / auth / crash errors and **0** on success — BUT a
   print-unsafe extension can also force exit 1 *after a successful task*. So exit
   code is a fallback signal only; task status comes from a marker (§6, Q12).
6. **Auth needs no env:** pi reads keys from `~/.pi/agent/auth.json`. launchd does
   **not** need API keys injected.
7. **PATH footgun (mostly solved by compiling the wrapper):** the **wrapper**
   is shipped as a `bun build --compile` standalone binary (embeds the Bun
   runtime), so launchd calls an absolute binary path with **no bun/node on
   PATH** — verified running under `env -i`. The *only* residual: the wrapper
   spawns `pi`, which is an nvm shim (`#!/usr/bin/env node`), so the plist must
   still expose `node` + `pi` on PATH (resolved at install time) for the spawned
   pi (§9). Auth still needs no env (fact 6).
8. **Print-mode lifecycle race in cosmetic extensions:** `pi-usage` (a footer
   status-line extension polling provider usage) fires an async `poll()` on load;
   in `--print` it resolves *after* session teardown, reads `ctx.hasUI`, hits
   pi's stale-ctx guard, throws → unhandled rejection → **exit 1 even though the
   task printed its answer and succeeded**. → don't blanket-disable extensions;
   use **per-job extension selection** (§5) and the **status marker** (§6) as the
   source of truth so such crashes degrade to success+warning.

---

## 3. Decisions locked in

- **OS scheduler, not an in-pi timer.** Real always-on. (Existing pi scheduling
  extensions all run *inside a live session*; they can't fire when pi is closed —
  that's the gap we fill.)
- **launchd primary on macOS**, cron fallback, behind one `Scheduler` interface.
  - *Why launchd:* runs missed jobs on wake (laptop sleep), built-in per-job
    logging + exit-code visibility, explicit env (fixes the PATH footgun), clean
    one-shot calendar fires. cron silently skips sleep-missed runs.
- **Job → executions, one conversation per execution (DEFAULT).** Each firing is
  an *execution* with its **own** session/conversation (unique `--session-id`),
  independently resumable. Avoids context bloat/stale-context decay across runs
  (stateless tasks start clean). The ledger lists every execution of a job.
  - **Opt-in `threadMode: "continuous"`** keeps the old single growing thread for
    rare long-running/babysitter jobs that must resume where they left off.
  - **Cross-run memory** (when needed) = an explicit per-job state/notes file the
    prompt reads+updates (or hindsight), NOT transcript carryover.
- **Everything global**: jobs, ledger, config under `~/.pi/cron-jobs/`.
- **Per-job cwd** = the cwd where the job was created (jobs are created from pi).

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ OS scheduler (launchd agent / cron entry)  — fires even with no pi open │
│                                                                        │
│   on fire →  pi-cron-jobs run <jobId>     (the runner CLI)             │
│                 │                                                       │
│                 ├─ (cd job.cwd) pi --print [capability flags] \         │
│                 │       --session-id <execution id> --name <name> \    │
│                 │       [--model ...]  "<prompt>"                       │
│                 │                                                       │
│                 └─ append execution → ~/.pi/cron-jobs/executions.jsonl   │
└──────────────────────────────────────────────────────────────────────┘
                 ▲                                  │ reads
                 │ writes jobs.json                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ pi extension (UX layer, loaded in interactive pi)                      │
│   • /jobs            list jobs + drill into a job's runs                │
│   • /jobs add|rm|... create/edit/pause/delete  → scheduler.sync()      │
│   • /jobs sync       reconcile OS scheduler with jobs.json             │
│   • session_start    one-line notice: "N runs since last seen, M failed"│
│   • status widget    persistent footer badge (active / failed)         │
│   • resume action    hand off to pi --session <id>                     │
└──────────────────────────────────────────────────────────────────────┘
```

### The 3 surfaces

| # | Surface | Lives in | Responsibility |
|---|---------|----------|----------------|
| 1 | **launchd / cron** | OS (`~/Library/LaunchAgents/*.plist`, or crontab) | **Scheduling only.** Fires `pi-cron-jobs run <id>` on time, even with no pi open. Knows nothing about pi internals. Generated/managed by surface 2. |
| 2 | **wrapper CLI** (`pi-cron-jobs`) | a `bun build --compile` standalone binary (abs path) | **Headless runtime + data layer.** `run <id>` = what launchd calls (→ `pi --print`, parse marker, write ledger + log). Plus terminal commands: `add` / `list` / `rm` / `pause` / `resume` / `sync` (sync generates+reconciles the plists). Owns `jobs.json`, `executions.jsonl`, logs, plist generation. Self-contained: no bun/node on PATH. Needs no interactive pi. |
| 3 | **pi extension** | `~/.pi/agent/extensions/` | **In-pi UX.** `/jobs` list + drill-in, `session_start` notice, status widget, resume hand-off. *Reads* the files surface 2 writes; mutations route through the shared core (→ re-sync launchd). Never required for jobs to fire. |

Responsibility nuances:

- **notify → extension only** (it must run inside an interactive pi to show you
  anything; the wrapper often runs with no UI open).
- **list / resume → both** (extension = nice in-pi view; wrapper = terminal use
  without opening pi).
- **logs / ledger writes → wrapper only** (it's the thing executing jobs).
- **plist/cron generation → wrapper** (surface 2 manages surface 1); §9.

### Shared core

Surfaces 2 and 3 import one **core library** so neither duplicates logic:

```
core lib  ──┬── wrapper CLI  (bin: launchd + terminal)
            └── pi extension (UI: in-pi)
```

Core owns: read/write `jobs.json` + `executions.jsonl`, plist/cron generation +
`sync`, and building the `pi --session <id>` resume command. Both surfaces touch
the **same files**; launchd just fires the wrapper.

This split is what makes "always running pi" true: the OS owns the schedule.

---

## 5. Data model & storage (global, `~/.pi/cron-jobs/`)

```
~/.pi/cron-jobs/
  jobs.json            # job definitions (source of truth)
  executions.jsonl     # append-only execution ledger (one JSON object per line)
  state.json           # extension state (lastSeenTs for "since last seen")
  logs/<jobId>/<executionId>.log   # raw stdout+stderr of each execution
  launchd/             # generated *.plist files (macOS)
```

### Job

```jsonc
{
  "id": "morning-triage",             // stable slug
  "name": "Morning issue triage",
  "prompt": "Check open GitHub issues, pick one, start a draft fix.",
  "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Europe/Paris" },
  // or { "kind": "once", "at": "2026-07-01T09:00:00+02:00" }
  "threadMode": "per-execution",       // per-execution (default) | continuous
  // per-execution: each run gets a fresh session-id <id>__<executionId> (no bloat)
  // continuous:    all runs reuse one session-id <id> (single growing thread)
  "cwd": "/Users/marc/some/project",  // where job was created; runs fire here
  "model": null,                       // optional override
  "isolate": false,                    // true = --no-extensions; default loads all
  "tools": null,                       // optional --tools allowlist (e.g. ["read","grep"])
  "excludeTools": null,                // optional --exclude-tools denylist
  "enabled": true,
  "createdAt": "...",
  "maxRuns": null,
  "timeoutMs": 600000                  // 10 min default
}
```

### Execution (one line in executions.jsonl)

```jsonc
{
  "jobId": "morning-triage",
  "executionId": "2026-06-22T07:00:01Z-ab12",
  "sessionId": "morning-triage__2026-06-22T07:00:01Z-ab12", // this execution's own convo
  "startedAt": "...", "endedAt": "...",
  "exitCode": 0,
  "status": "success",                 // from marker: success|failure|timeout|skipped
  "reason": null,                      // marker reason on failure ("no room available")
  "warning": false,                    // marker=success but exitCode!=0 (e.g. ext crash)
  "logPath": "logs/morning-triage/<executionId>.log"
}
```

`status` is set from the **status marker** (§6), not the exit code. A `warning`
flag is added when the marker says success but pi still exited non-zero (e.g. a
print-unsafe extension crashed during teardown).

**Capability control (per-job).** pi loads extensions/tools **only at launch** —
the agent cannot activate an extension mid-run, and there is no `--enable
<package>` flag. So the *runner* picks launch flags; the real levers are:

| Job field | pi flag | Use |
|---|---|---|
| *(default)* `isolate:false` | none — full discovery | Load all settings.json extensions+packages. Full capability (browse/search). Cosmetic crashers (pi-usage) only set `warning`; marker keeps status correct. **Default.** |
| `tools: [...]` | `--tools a,b,c` | Allowlist the tool surface (e.g. read-only review: `read,grep,find,ls`). |
| `excludeTools: [...]` | `--exclude-tools ...` | Denylist specific tools. |
| `isolate: true` | `--no-extensions` | Disable **all** discovery (pure-reasoning jobs; loses web/browser tools too). |

Note: `--no-extensions` is all-or-nothing — you can't keep just `pi-web-access`
by name. Narrow with `--tools` instead of trying to cherry-pick packages.
Default = full discovery + marker, so a "book a room" job has the browser tool
and a triage job has web search without any per-package wiring.

Append-only JSONL = cheap concurrent writes from headless runs, trivial
"since lastSeen" diffing, full run history per job, no DB.

---

## 6. How an execution runs  (`pi-cron-jobs run <jobId>`)

```
1. load job from jobs.json; bail if disabled or maxRuns hit
2. acquire per-job lock (flock); if held → overlap policy = DROP (record skipped)
3. mint executionId; sessionId = (threadMode==continuous ? job.id : `${job.id}__${executionId}`)
   record execution start (status=running) + log file
4. cd job.cwd; exec:
     pi --print [--no-extensions | --tools ... | --exclude-tools ...] \
        --session-id <sessionId> --name <job.name> [--model job.model] \
        --append-system-prompt <STATUS_MARKER_INSTRUCTION>  "<job.prompt>"
     - stdout+stderr → logs/<jobId>/<executionId>.log
     - wall-clock TIMEOUT = job.timeoutMs (default 10 min) → kill → status=timeout
5. determine status (precedence):
     a. parse log for last `PI_JOB_STATUS:` marker line →
        `success` | `failure — <reason>`  (authoritative task result; soft fails)
     b. no marker + killed by timeout            → status=timeout
     c. no marker + non-zero exit                → status=failed (hard crash)
     d. marker=success but exit≠0                → status=success, warning=true
6. append final execution record to executions.jsonl (incl. sessionId, reason, exitCode)
7. if job.schedule.kind === "once": unload+delete the launchd agent AND delete the
   job from jobs.json — BUT keep the log and the pi session (the conversation) as
   the trace.
```

- **Status marker (the soft-failure contract, Q8):** the runner appends a system
  instruction telling the agent to end every run with exactly one line:
  `PI_JOB_STATUS: success` or `PI_JOB_STATUS: failure — <short reason>` (e.g.
  `failure — no room available for 14:00`). This is what catches task-level
  failures that exit 0. The reason string is stored and shown in `/jobs`.
- **Why marker over exit code:** fact §2.5/§2.8 — exit code is unreliable with
  extensions loaded; the marker is emitted as part of the agent's final answer,
  before any teardown crash.
- **Thread model:** default `per-execution` → unique `sessionId` per run = fresh
  clean conversation, no context bloat. `continuous` → reuse `job.id` as the
  session-id every run ⇒ one growing thread (fact §2.1). Either way each
  conversation is resumable via `pi --session <sessionId>`.

---

## 7. Notifications & status (requirement 4)

**Mechanism = decoupled via the ledger (no direct IPC).** The execution and your
interactive pi are separate processes that may never overlap. The execution
**publishes** (appends a line to `executions.jsonl` on finish); the extension
**subscribes** (reads/watches that file). The execution never pushes a
notification — it can't, since often no pi is open. So:

```
execution ──append──▶ executions.jsonl ──watch/read──▶ extension ──▶ you
```

- **`session_start` (no toast):** extension reads `executions.jsonl`, diffs against
  `state.json.lastSeenTs`, prints **one inline notice**:
  `⏰ 3 scheduled runs since you were last here — 1 failed (morning-triage). /jobs`
  then advances lastSeen. Plain printed line, not an interrupting popup.
- **Live while chatting:** extension `fs.watch`es (or polls) `executions.jsonl`;
  a new line landing mid-conversation refreshes the widget (no toast, per Q7).
- **Status-line widget (always on):** persistent footer badge
  `⏰ jobs: 5 active · 1 failed ⚠`. The ambient status line, refreshed as
  executions land. Hidden when no jobs exist.

---

## 8. `/jobs` UX

```
/jobs                 → overlay: list of jobs
   columns: name · schedule (human) · next run · last run · last status · #execs
   keys: ↑↓ select · enter = drill into executions · a add · e edit · p pause/resume
         x delete · r run-now · q close
/jobs sync            → reconcile OS scheduler with jobs.json (also runs on load)

drill-in (a job's executions):
   list of executions: time · status · duration · reason (if failed)
   keys: ↑↓ select · enter = RESUME conversation · l = view raw log · q back
```

**Resume hand-off (fact §2.3/2.4):** each execution has its **own** conversation
(`execution.sessionId`). Preferred: extension launches/hands off to
`pi --session <execution.sessionId>` (scoped to `job.cwd` so no cross-project
prompt). If the extension API can't spawn a replacement session cleanly, **fall
back to printing the exact command**: `cd <job.cwd> && pi --session <sessionId>`
— runnable from anywhere (pi will ask to confirm if you're in a different project).

---

## 9. Scheduler mechanics (surface 1, owned by the wrapper)

Not a heavyweight framework — just the small bit of core that **generates and
reconciles** the OS scheduler entries. The OS does the actual firing.

```ts
interface Scheduler {
  install(job: Job): Promise<void>   // create launchd plist / cron line
  remove(jobId: string): Promise<void>
  sync(jobs: Job[]): Promise<void>   // reconcile OS state with jobs.json
  status(): Promise<SchedulerEntry[]>
}
```

- **LaunchdScheduler** (macOS): writes
  `~/Library/LaunchAgents/com.pi-cron-jobs.<id>.plist`,
  `launchctl bootstrap`/`bootout`. `StartCalendarInterval` for cron-like + once;
  wake-catch-up for free; per-job `StandardOutPath`/`StandardErrorPath`.
  - **ProgramArguments** = `[<abs pi-cron-jobs binary>, "run", <jobId>]` — the
    compiled binary needs no interpreter (fact §2.7).
  - **PATH fix for the spawned `pi`:** at install, resolve `node` + `pi` dirs and
    set `EnvironmentVariables.PATH` so the nvm-shim `pi` resolves `node`.
    Re-resolve on `sync` (nvm upgrades move it).
- **CronScheduler** (fallback/Linux): manages a delimited block in `crontab`,
  with an explicit `PATH=...` line in the block.
- **jobs.json is source of truth.** `sync()` reconciles after every
  add/edit/delete, on extension load, and via `/jobs sync` (so hand-edits to
  jobs.json get applied).

---

## 10. Resolved review questions

| # | Decision |
|---|----------|
| Q1 | **Job → executions, one conversation per execution (default).** Each run mints a unique `--session-id` (fresh clean thread, no bloat); opt-in `threadMode:continuous` reuses one growing thread. Resume via `pi --session <id>` / `--resume`, works from anywhere with a cross-project confirm. |
| Q2 | One-shot job: after firing, unload+delete launchd agent AND delete the job; **keep log + conversation** as trace. |
| Q3 | Overlap → **drop** (skip, record `skipped`). |
| Q4 | **10 min** timeout; on timeout → `status=timeout` (treated as failed) + session stays resumable. |
| Q5 | cwd = where the job was created (jobs created from pi). Runs fire from that cwd. |
| Q6 | No summary extraction. Status from exit code. |
| Q7 | No toast. **Persistent status-line widget always** + one-line `session_start` notice. |
| Q8 | Resume from the extension if possible; else print `cd <cwd> && pi --session <id>`. Soft-failure detection **required** → status-marker convention (§6). |
| Q9 | Sync on pi load **and** `/jobs sync` command. |
| Q10 | No approval system in pi — headless runs need no special handling. |
| Q11 | No API-key env needed (auth.json). Only PATH/node must be set for launchd/cron (§8). |
| Q12 | **Resolved via status marker (§6), now required.** Agent ends each run with `PI_JOB_STATUS: success` / `failure — <reason>`; runner parses it as authoritative task status. Exit code/timeout are fallback only (and unreliable with extensions — fact §2.8). Catches soft fails like "no room available". |
| Q13 | Ignore concurrency throttling for now; let launchd/cron fire. |

---

## 11. Build phases

1. **Runner CLI core** — jobs.json/executions.jsonl read/write, `run <jobId>` doing the
   headless `pi --print` (per-job extensions) + status-marker parsing + ledger +
   lock + timeout.
   Testable with no scheduler.
2. **LaunchdScheduler** — plist gen with PATH fix, install/remove/sync. Cron fallback.
3. **Extension read-only** — `/jobs` list + drill-in + `session_start` notice + widget.
4. **Extension write** — add/edit/pause/delete/`run-now`/`sync` wired to scheduler.
5. **Resume** — hand-off to `pi --session`.
6. Polish: one-shot cleanup, timeout handling, cron fallback hardening.

---

## 12. Prior art reused (for parsing/ideas, not architecture)

- `brunoorsolon/pi-clockwork` — job/run terminology, status widget, overlap policy.
- `Davidcreador/pi-routines` — cron+tz parsing, run history, widget patterns.
- `tintinweb/pi-schedule-prompt` — NL schedule parsing, jobs overlay hotkeys.

All three run *in-session*; none do headless OS-scheduled runs with a resumable
conversation per job — our differentiator.

```
