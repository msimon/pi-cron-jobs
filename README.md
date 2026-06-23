# pi-cron-jobs

Schedule **headless [pi](https://pi.dev) runs** — at a precise date or on a recurring
cron schedule — that fire from the OS even when no pi session is open. Then **list**
your jobs, get **notified** when one ran (or failed) the next time you open pi, and
**resume the conversation** any run produced.

Unlike in-session pi schedulers, jobs here run via the real OS scheduler (launchd),
so they survive reboot/sleep and don't need pi to already be running.

## How it works — 3 surfaces

| Surface | What it is | Responsibility |
|---|---|---|
| **launchd** | `~/Library/LaunchAgents/com.pi-cron-jobs.<id>.plist` | Scheduling only. Fires the wrapper on time, even with no pi open. |
| **wrapper CLI** (`pi-cron-jobs`) | a self-contained Bun binary | Runs `pi --print` headlessly, derives status, writes the ledger + logs. Also the terminal UI (`add`/`list`/`run`/…). |
| **pi extension** | loaded inside pi | `/jobs` list + drill-in, `session_start` notice, status-line widget, resume. |

They share state under `~/.pi/cron-jobs/`:

```
~/.pi/cron-jobs/
  jobs.json            # job definitions (source of truth)
  executions.jsonl     # append-only run ledger
  state.json           # extension "last seen" marker
  logs/<jobId>/<executionId>.log
  bin/pi-cron-jobs     # installed binary
```

### Conversation model

Each job has many **executions**; by default each execution gets its **own**
conversation (`threadMode: per-execution`), so threads stay clean — no context
bloat across runs. Every conversation is independently resumable. Opt into
`continuous` for a single growing thread.

### Failure detection (the status marker)

Exit codes alone are unreliable (a loaded extension can crash on teardown and a
task can "fail" while exiting 0). So the runner injects an instruction telling the
agent to end every run with:

```
PI_JOB_STATUS: success
# or
PI_JOB_STATUS: failure - <short reason>
```

That marker is the authoritative task status — it catches **soft failures** like
"no room available" that exit 0. Exit code/timeout are fallbacks for hard crashes.

## Requirements

- macOS (launchd). Linux cron fallback is on the roadmap.
- [Bun](https://bun.sh) ≥ 1.3
- [pi](https://pi.dev) on your PATH, already logged into a provider
  (`pi` reads `~/.pi/agent/auth.json` — no API keys needed in the job env)

## Install

```bash
git clone https://github.com/msimon/pi-cron-jobs.git
cd pi-cron-jobs
bun install

# 1. build the self-contained binary
bun run build

# 2. install it to a stable path (~/.pi/cron-jobs/bin)
./dist/pi-cron-jobs install-bin

# 3. put it on your PATH
ln -sf ~/.pi/cron-jobs/bin/pi-cron-jobs ~/.local/bin/pi-cron-jobs

# 4. register the pi extension (adds the path to ~/.pi/agent/settings.json
#    "extensions" array), then restart pi or run /reload
```

For step 4, add the absolute path to `extension/index.ts` to the `extensions`
array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-cron-jobs/extension/index.ts"
  ]
}
```

> Extensions run with full system permissions. Review the source before installing.

## Usage (CLI)

```bash
# recurring weekday 9am triage
pi-cron-jobs add --name "Morning triage" \
  --prompt "Check open GitHub issues, pick one, start a draft fix." \
  --cron "0 9 * * 1-5" --cwd ~/work/repo

# one-shot reminder at a precise time
pi-cron-jobs add --name "Renew cert" --prompt "Renew the TLS cert and verify." \
  --at 2026-07-01T09:00:00

pi-cron-jobs list                 # all jobs + last status
pi-cron-jobs show <jobId>         # job detail + recent executions
pi-cron-jobs executions <jobId>   # full run history
pi-cron-jobs run <jobId>          # run now (also what launchd calls)
pi-cron-jobs resume <executionId> # prints `cd <cwd> && pi --session <id>`
pi-cron-jobs rm <jobId>           # unschedule + delete
pi-cron-jobs sync                 # reconcile launchd with jobs.json
pi-cron-jobs status               # launchd load state per job
```

### `add` options

| Flag | Meaning |
|---|---|
| `--name N` | display name (required) |
| `--prompt P` | the prompt pi runs (required) |
| `--cron "EXPR"` | 5-field cron (`m h dom mon dow`); or… |
| `--at ISO` | one-shot timestamp |
| `--tz TZ` | timezone for cron (informational) |
| `--cwd DIR` | working dir for the run (default: current) |
| `--model M` | model override |
| `--isolate` | run with `--no-extensions` |
| `--tools a,b` / `--exclude-tools a,b` | scope pi's tool surface |
| `--thread per-execution\|continuous` | conversation model (default per-execution) |
| `--timeout 10m` | per-run wall-clock timeout (default 10m) |
| `--max-runs N` | cap total executions |

Cron is expanded into launchd `StartCalendarInterval` entries (ranges, lists,
steps, `*/n` supported). `* * * * *` = every minute; `0 9 * * 1-5` = weekdays 9am.

## Usage (in pi)

- **`/jobs`** — pick a job → see its executions → resume one (switches your pi
  session into that conversation).
- **`/jobs sync`** — reconcile launchd with `jobs.json`.
- **At session start** — a one-line notice: *"⏰ 3 scheduled runs since last visit
  — 1 failed (morning-triage). /jobs"*.
- **Status line** — always-on badge `⏰ jobs: 5 · 1 failing ⚠`.

## Development

```bash
bun test            # unit + integration tests
bun run typecheck   # tsc --noEmit
bun run build       # compile the binary
```

Runs on Bun; the extension is loaded as TypeScript directly by pi. The wrapper is
compiled to a standalone binary so launchd needs no interpreter on PATH.

## Limitations

- macOS-only for now (launchd); cron fallback planned.
- Soft-failure detection relies on the model emitting the status marker; weak
  models may occasionally omit it (recorded as success + warning).
- If both day-of-month and day-of-week are restricted in a cron expr, launchd uses
  AND where cron uses OR (a warning is printed).

## License

MIT
