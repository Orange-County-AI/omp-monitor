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
	"label": "fleet mailbox",
	"command": "bun",
	"args": ["/abs/path/to/agent/cli.ts", "--config", "/abs/profiles/fleet-manager.json", "watch"],
	"match": "^\\{"
}
```

(The trailing `watch` there is the monitored program's own subcommand, not this tool.)

## Parameters

The **only** requirement is a source: exactly one of `file` or `command`. Every
other field is optional, including both conditions. The smallest useful call is:

```jsonc
monitor { "file": "app.log" }
```

That delivers every line of `app.log` as it is written, for as long as the file
exists — no filter, no deadline, no end condition.

| Field | Required | Meaning |
| --- | --- | --- |
| `file` | one of | Tail this file. Must already exist |
| `command`, `args` | one of | Run this command and read its stdout and stderr |
| `op` | no | `start` (default), `list`, `stop`, `label` |
| `name` | for `stop`, `label` | Monitor name. Otherwise defaults to a slug of the source |
| `label` | no | A few words naming what this monitor is for, shown in the status line. Omitted, the status line shows `name` |
| `cwd` | no | Working directory for a command source. Defaults to the session's |
| `env` | no | Environment overlay for a command source, merged over the inherited environment |
| `match` | no | Regex. Deliver only matching lines. **Does not end the monitor** — matches keep arriving. Omitted, every line is delivered |
| `until` | no | Regex. Deliver the matching line, then **end** the monitor. Omitted, nothing ends it but its source |
| `deadline` | no | Seconds until the monitor ends on its own. Omitted, it is resident |
| `replay` | no | Deliver a file's existing content before live output. Defaults to `false`, i.e. start at the end of the file |

`match` and `until` compose: `until` always delivers and always ends, whether or
not the line passes `match`.

`/monitor` lists this session's monitors; `/monitor stop <name>` ends one;
`/monitor label <name> <text…>` renames one, and with no text clears its label.

## The status line

Live monitors occupy one segment of omp's status footer, and a `label` is what
the monitor is called there — so the person watching sees what the agent is
waiting on, not just how many things it is waiting on:

```
monitor 3: deploy prod, mailbox, waiting on the nightl…
```

Unlabelled monitors fall back to their `name`. Labels are listed until the
segment's character budget is spent and the rest become `+N`, so a session with
a dozen monitors still leaves room for every other segment. A label is cosmetic:
it never affects delivery, it is capped at 24 characters, and control bytes and
newlines are stripped, because the footer is written to the terminal unescaped.
The segment disappears when the last monitor ends.

A label is not fixed at start. `op: "label"` with `name` and `label` renames a
monitor that is already running, so a resident one can say what it is doing now
rather than what it was started for, and `label: ""` clears it back to the name:

```jsonc
monitor { "name": "deploy", "file": "deploy.log", "label": "deploy prod: rollout" }
monitor { "op": "label", "name": "deploy", "label": "deploy prod: smoke" }
monitor { "op": "label", "name": "deploy", "label": "" }
```

Relabelling touches the footer and nothing else: the monitor is not restarted,
its source, filters and deadline are untouched, and no delivery is interrupted.

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

A session arms its own monitors from its own environment, which is what makes two agents in one directory workable: same declaration, different `MATTERMOST_AGENT_CONFIG`, two listeners that never see each other's mail. Nothing is armed until the agent calls the tool — or until a plugin declares one, below.

## Monitors a plugin declares

A resident listener has a bootstrap problem the tool cannot solve on its own: the agent has to call `monitor` before anything is delivered, and a session that never makes the call is deaf while posts pile up unread. So a plugin can ship the declaration, and this extension arms it at session start — the same component Claude Code has, with the same file, the same field names and the same defaults, so one plugin directory serves both harnesses.

`monitors/monitors.json` in the plugin root:

```json
[
  {
    "name": "mailbox",
    "command": "\"${OMP_PLUGIN_ROOT}\"/bin/mattermost-monitor",
    "description": "Mattermost messages in the configured channels",
    "label": "mattermost inbox"
  }
]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique within the plugin. Armed as `plugin:name`, the way omp scopes every other plugin component |
| `command` | yes | One shell command string, run in the session's working directory for the life of the session |
| `description` | yes | What is being watched. `/monitor` prints it as `watching=…` |
| `when` | no | `"always"` (the default) arms at session start. Claude Code's `"on-skill-invoke:<skill>"` is recognised and **not** armed here: omp gives an extension no skill-dispatch hook, and `/monitor` says so rather than pretending |
| `label` | no | Status-footer text; omp-specific, defaults to the entry name |
| `match` | no | Deliver only matching lines; omp-specific, and what lets a chatty source be declared at all |

Declarations are also read from `monitors` or `experimental.monitors` in `.omp-plugin/plugin.json`, `.claude-plugin/plugin.json` or `package.json` (`omp.monitors`), either as the array itself or as a path to it, which must stay inside the plugin.

`${OMP_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` both expand to the plugin directory, `${OMP_PROJECT_DIR}` and `${CLAUDE_PROJECT_DIR}` to the session's working directory, and any other `${VAR}` to that variable in the session's environment.

**An unset variable does not expand to nothing — it withholds the monitor**, with one line in `/monitor` saying which variable was missing. That is how a declaration stays conditional: a mailbox listener pinned to `${MATTERMOST_AGENT_CONFIG}` arms itself on the machines that have an identity and stays silent on the ones that do not, instead of starting a command that fails on every session.

Where they are read from is omp's own plugin surface, user scope only:

- `~/.omp/agent/extensions/<plugin>/` — a dropped or symlinked package
- `~/.omp/plugins/node_modules/<plugin>/` — `omp plugin install` and `omp plugin link`, plus the `$XDG_DATA_HOME` equivalent

Two limits are deliberate, and both match Claude Code. **Nothing is read from the project directory**, because a monitor is a command that runs unasked and a checkout must not be able to arm one. And **arming happens only in an interactive session**, so a `-p` run and every subagent get the tool without the listener — one listener per human session, not one per spawned turn. `OMP_MONITOR_AUTOSTART=0` turns the whole mechanism off; `OMP_MONITOR_PLUGIN_DIRS=/a:/b` replaces the search path.

A declared monitor is an ordinary monitor once armed: `/monitor` lists it, `op: "stop"` ends it, and it dies with its session. If two plugins declare the same scoped name the first wins and the second is reported, so a reload or a second install cannot double-start a listener.

## Verify

```sh
bun smoke.ts
```

Drives the engine against real files and a real child process: filtering, `until`, deadlines, replay, exit codes, env overlay, a deleted source, a 120-line burst, envelope escaping, status-line labelling and relabelling, child termination on teardown, and declaration discovery — plugin scoping, Claude-shaped manifests, variable substitution, the unset-variable gate, the path-escape refusal and the shell-run delivery.

## Limits

- A monitor does not survive its session. A listener that must outlive one session belongs behind a supervisor (`hub start`, systemd, a process manager) with `monitor` attached to the log it writes.
- A file source must exist when the monitor starts; it is not created or waited for.
- Rotation is handled by continuing from the start of the new file, so whatever was in the rotated tail is not delivered.
