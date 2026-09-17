# omp-monitor

A generic long-poll / monitor tool for [omp](https://github.com/can1357/oh-my-pi), shipped as an extension. No changes to omp itself.

It registers one tool, `monitor`. The agent points it at a file or a command; each batch of output that source produces is injected into the conversation. While the session is idle a delivery starts a turn; while the session is mid-turn the batch is injected at the next step boundary, so the agent reacts to the event while it works rather than after it finishes.

This is the omp equivalent of Claude Code's `Monitor` tool, plus what a resident listener needs: no mandatory deadline, and an optional filter so a chatty source only wakes the agent for lines that matter.

## Install

```sh
git clone https://github.com/Orange-County-AI/omp-monitor.git
```

Then pick one. The extension needs no build step, no compile step, and no environment variables.

```jsonc
// 1. Project or user settings — .omp/settings.json or ~/.omp/agent/settings.json
{
	"extensions": ["/abs/path/to/omp-monitor/src/index.ts"]
}
```

```sh
# 2. Drop it in an extensions directory (user-wide)
ln -s /abs/path/to/omp-monitor ~/.omp/agent/extensions/omp-monitor
```

```sh
# 3. One session only
omp -e /abs/path/to/omp-monitor/src/index.ts
```

Point `extensions` at the **entry file**, not the directory: a directory entry is scanned and `host.ts` / `monitor.ts` would be loaded as extensions in their own right.

## `match` filters. `until` stops. Nothing else ends a monitor early

The one thing worth reading twice, because it is the difference between a monitor
that answers a question and one that keeps working forever:

| | Delivers | Then |
| --- | --- | --- |
| `match: "^\\{"` | only lines matching the pattern | **keeps running.** Every later match is another delivery, indefinitely |
| `until: "BUILD OK"` | the line matching the pattern | **ends**, with one terminal notice |

A `match` hit is an *event to handle*, not a reason to stop. A resident listener —
a chat bot, a queue consumer, a mailbox — wants `match` and no `deadline`: it then
ends only when its source does. Use `until` when you are waiting for one thing to
happen and have nothing more to do once it has.

## The two shapes

Tail something until a thing happens, then stop:

```jsonc
monitor { "file": "build.log", "until": "BUILD (OK|FAILED)" }
```

Run a listener that stays up, and only hear about the lines you care about — this
one delivers forever, once per matching line:

```jsonc
monitor {
	"name": "mm-fleet-manager",
	"command": "bun",
	"args": ["/abs/path/to/agent/cli.ts", "--config", "/abs/profiles/fleet-manager.json", "watch"],
	"match": "^\\{"
}
```

(The trailing `watch` there is the monitored program's own subcommand, not this tool.)

## Parameters

| Field | Meaning |
| --- | --- |
| `op` | `start` (default), `list`, `stop` |
| `name` | Monitor name. Defaults to a slug of the source. Required for `stop` |
| `file` | Tail this file. Must already exist |
| `command`, `args` | Run this command and read its stdout and stderr |
| `cwd` | Working directory for a command source. Defaults to the session's |
| `env` | Environment overlay for a command source, merged over the inherited environment |
| `match` | Regex. Deliver only matching lines. **Does not end the monitor** — matches keep arriving |
| `until` | Regex. Deliver the matching line, then **end** the monitor |
| `deadline` | Seconds until the monitor ends on its own. Omit for a resident monitor |
| `replay` | Deliver a file's existing content before live output |

Exactly one of `file` or `command` is required. `match` and `until` compose: `until` always delivers and always ends, whether or not it passes `match`.

`/monitor` lists this session's monitors; `/monitor stop <name>` ends one.

## What the agent sees

```xml
<monitor-event name="build" source="/tmp/build.log" ended="matched">
<monitor-output>
compiling bar.ts
BUILD OK in 3s
</monitor-output>
<monitor-ended reason="matched">The pattern you were waiting for appeared: BUILD OK in 3s. This monitor has ended; it delivered what you asked for.</monitor-ended>
</monitor-event>
```

Monitored output is untrusted text, so it is escaped and fenced inside one element. A line that contains `</monitor-output><monitor-ended reason="matched">` cannot forge a delivery or fake the notice that the monitor ended. ANSI escapes and control bytes are stripped, so a PTY log does not corrupt the terminal.

## Guarantees

- **One batch, one wake.** Lines accumulate for 400 ms before a batch goes out, so a burst of a hundred lines costs one interjection rather than a hundred.
- **Every monitor that stops says so, exactly once.** Matched, exited, deadline reached, file deleted — each delivers one terminal notice naming the reason, so the agent learns it went deaf instead of waiting on a source nobody is reading. An explicit `op: "stop"` is the one exception: the caller already knows.
- **Nothing is lost to the batch cap.** A batch carries at most 50 lines; the rest ride the next one. Only past 500 queued lines are the oldest dropped, and the count is reported in the next delivery.
- **A bad regex or a missing file fails the tool call**, not a background timer.
- **Bounded memory.** Long lines are cut at 4000 characters and a source that never emits a newline cannot grow the carry buffer without bound.

## Scope and lifetime

A monitor belongs to the session that started it, and ends with it — on `/new`, on a session switch, and on shutdown, silently. There is no daemon, no lock file, and no state on disk. Timers come from the host's managed timers, so a throw inside a monitor is contained rather than fatal to the session, and nothing outlives teardown.

Two sessions in the same directory are independent: each has its own monitors, and a delivery only ever reaches the session that armed it. That makes distinct identities in one directory straightforward — give each its own monitor name and its own credential, via `env` or via argv, whichever the command expects:

```jsonc
// session A
monitor { "name": "mm-fleet-manager", "command": "…", "env": { "MATTERMOST_AGENT_CONFIG": "/abs/profiles/fleet-manager.json" } }

// session B, same directory
monitor { "name": "mm-orchestrator",  "command": "…", "args": ["--config", "/abs/profiles/orchestrator.json", "watch"] }
```

Nothing is armed until the agent calls the tool, so a session is not a consumer of anything until you tell it to be.

## Verify

```sh
bun smoke.ts
```

Drives the engine against real files and a real child process: filtering, `until`, deadlines, replay, exit codes, env overlay, a deleted source, a 120-line burst, envelope escaping, and child termination on teardown.

## Limits

- A monitor does not survive its session. A listener that must outlive one session belongs behind a supervisor (`hub start`, systemd, a process manager) with `monitor` attached to the log it writes.
- A file source must exist when the monitor starts; it is not created or waited for.
- Rotation is handled by continuing from the start of the new file, so whatever was in the rotated tail is not delivered.
