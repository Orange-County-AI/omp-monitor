/**
 * omp-monitor — a generic long-poll / monitor tool for omp.
 *
 * Registers one `monitor` tool. The agent points it at a file or a command; each
 * batch of output the source produces is injected into the session and, when the
 * session is idle, wakes a turn. The agent keeps working in between.
 *
 * Two shapes, one mechanism:
 *
 *   monitor { file: "build.log", until: "BUILD (OK|FAILED)" }
 *   monitor { command: "bun", args: ["listen.ts"], match: "^\\{" }
 *
 * The first ends itself on the match. The second is resident: it lives as long
 * as the command does, and every matching line wakes the agent.
 *
 * The wake itself is `pi.sendMessage(..., { deliverAs: "steer", triggerTurn:
 * true })`. Idle, that starts a real turn. Mid-turn, the batch is injected at the
 * next step boundary of the turn already running, so the agent reacts to an event
 * while it works instead of after it finishes. `nextTurn` is deliberately NOT
 * used: it hides the message until some later turn begins, which in a one-shot
 * (`-p`) run is never, and even interactively defers an event past the work it
 * was supposed to inform.
 *
 * Monitors belong to the session that started them and end with it. There is no
 * background daemon and nothing to install beyond this extension.
 */

import { AUTOSTART_ENV, type DeclaredMonitor, discoverDeclared } from "./declared";
import { formatBatch, formatStatus, formatStatusLine } from "./format";
import type { ExtensionApi, ExtensionCtx, ToolDefinition, ToolResult } from "./host";
import { type MonitorBatch, MonitorRegistry, type MonitorSpec, type MonitorStatus, type MonitorTarget } from "./monitor";

const CUSTOM_TYPE = "monitor-event";
const STATUS_KEY = "omp-monitor";
const MAX_DEADLINE_SECONDS = 24 * 60 * 60;

/** Guidance the agent reads once per delivery, so behaviour does not depend on a skill being loaded. */
const TOOL_DESCRIPTION = `Monitor a file or a command in the background and receive its output as it arrives, without blocking.

Each batch of lines is delivered into this conversation on its own; while you are idle a delivery wakes you, so you can start a monitor and keep working. Use it to tail a log until something appears, poll a job until its status changes, or run a resident listener whose every line is an event you must handle.

A source is the only required argument: exactly one of \`file\` or \`command\`. \`monitor { file: "app.log" }\` is a complete call — it delivers every line of that file, for as long as the file exists.
- \`file\`: tail a file that already exists. \`replay\` delivers what is already in it first, otherwise reading starts at the end of the file.
- \`command\` + \`args\`: run a command and read its stdout and stderr. \`env\` and \`cwd\` set its environment; pass credentials or config paths either way, whichever the command expects.

Conditions, all optional:
- \`until\`: a regex. The line matching it is delivered and the monitor ends. This is "tell me when X happens". Omit it and nothing ends the monitor but its own source.
- \`match\`: a regex. Only matching lines are delivered and the monitor KEEPS RUNNING — a match is an event to handle, never a reason to stop. This is "tell me about X, ignore the rest". Omit it and every line is delivered.
- \`deadline\`: seconds until the monitor ends on its own. Omit it and the monitor lives as long as its source, which is what a resident listener wants.

So: a resident listener is \`command\` plus an optional \`match\`, and nothing else. A one-shot wait is a source plus \`until\`.

\`label\` is what this monitor is called in the status line the person you are working with is watching — a few words naming what it is waiting for, like "deploy prod" or "mailbox". Omitted, the status line shows \`name\`, which is an identifier and may be an auto-derived slug. A label is cosmetic: it never affects delivery.

A label is not fixed at start. \`op: "label"\` with \`name\` and \`label\` renames a monitor that is already running, so a long-lived one can say what it is doing now — "deploy prod: waiting on rollout" then "deploy prod: smoke tests" — rather than what it was started for. Pass \`label: ""\` to clear it and fall back to \`name\`.

Every monitor that stops — matched, exited, deadline, or its file vanished — delivers exactly one notice saying so. Until that notice arrives the monitor is live and you need not check on it. Once it arrives, nothing from that source will reach you again until you start it.

\`op: "list"\` shows this session's monitors; \`op: "stop"\` ends one; \`op: "label"\` renames one.`;

interface MonitorParams {
	op?: "start" | "list" | "stop" | "label";
	name?: string;
	label?: string;
	file?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	match?: string;
	until?: string;
	deadline?: number;
	replay?: boolean;
}

function textResult(body: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text: body }], details };
}

/** Reject a pattern at the tool boundary so a bad regex fails the call, not a background timer. */
function validatePattern(pattern: string | undefined, field: string): void {
	if (pattern === undefined) return;
	try {
		new RegExp(pattern, "u");
	} catch (error) {
		throw new Error(`${field} is not a valid regular expression: ${String(error)}`);
	}
}

function resolveTarget(params: MonitorParams, cwd: string): MonitorTarget {
	const hasFile = params.file !== undefined && params.file.length > 0;
	const hasCommand = params.command !== undefined && params.command.length > 0;
	if (hasFile === hasCommand) throw new Error("Pass exactly one of file or command");
	if (hasFile) {
		const file = params.file ?? "";
		return { kind: "file", path: file.startsWith("/") ? file : `${cwd}/${file}` };
	}
	if (params.replay === true) throw new Error("replay applies to a file source; a command is read from its start already");
	return {
		kind: "command",
		command: params.command ?? "",
		args: params.args ?? [],
		cwd: params.cwd ?? cwd,
		env: params.env ?? {},
	};
}

/** Derive a stable default name from the source, so the simple case needs no name at all. */
function defaultName(target: MonitorTarget): string {
	const basis =
		target.kind === "file"
			? (target.path.split("/").pop() ?? "file")
			: (target.command.split("/").pop() ?? "command");
	const slug = basis.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug.slice(0, 40) : "monitor";
}

function resolveDeadlineMs(deadline: number | undefined): number | undefined {
	if (deadline === undefined || deadline <= 0) return undefined;
	if (deadline > MAX_DEADLINE_SECONDS) throw new Error(`deadline must be at most ${MAX_DEADLINE_SECONDS} seconds`);
	return Math.round(deadline * 1000);
}

export default function ompMonitor(pi: ExtensionApi): void {
	let registry: MonitorRegistry | undefined;
	let statusCtx: ExtensionCtx | undefined;
	/** Declarations seen and not armed, reprinted by `/monitor`. */
	let declaredWarnings: string[] = [];

	const publishStatus = (): void => {
		if (!statusCtx?.hasUI) return;
		statusCtx.ui.setStatus(STATUS_KEY, formatStatusLine(registry?.live() ?? []));
	};

	const deliver = (batch: MonitorBatch): void => {
		try {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: formatBatch(batch),
					details: batch,
					display: true,
				},
				// triggerTurn wakes an idle session; steer reaches a session that is
				// mid-turn at its next step boundary rather than hiding the batch
				// until some later turn that may never come.
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch (error) {
			pi.logger?.warn?.("Failed to deliver monitor batch", { name: batch.name, error: String(error) });
		}
		publishStatus();
	};

	/**
	 * The registry is built lazily against the first context that needs it,
	 * because managed timers come from the context: a timer taken from the host
	 * is contained on throw and cleared on session teardown, which raw
	 * `setInterval` is not.
	 */
	const ensureRegistry = (ctx: ExtensionCtx): MonitorRegistry => {
		statusCtx = ctx;
		registry ??= new MonitorRegistry({
			deliver,
			setInterval: (callback, ms) => ctx.setInterval(callback, ms),
			setTimeout: (callback, ms) => ctx.setTimeout(callback, ms),
			clearTimer: timer => ctx.clearTimer(timer),
			warn: (message, data) => pi.logger?.warn?.(message, data),
		});
		return registry;
	};

	const start = async (params: MonitorParams, ctx: ExtensionCtx): Promise<ToolResult> => {
		validatePattern(params.match, "match");
		validatePattern(params.until, "until");
		const target = resolveTarget(params, ctx.cwd);
		const spec: MonitorSpec = {
			name: params.name ?? defaultName(target),
			label: params.label,
			target,
			match: params.match,
			until: params.until,
			deadlineMs: resolveDeadlineMs(params.deadline),
			replay: params.replay ?? false,
		};
		const status = await ensureRegistry(ctx).start(spec);
		publishStatus();
		const note =
			spec.until === undefined
				? "Output will be delivered as it arrives. You will get one notice when this monitor ends."
				: "You will be woken when the pattern appears, or when the monitor ends for another reason.";
		return textResult(`Monitoring ${formatStatus(status)}\n${note}`, status);
	};

	const tool: ToolDefinition = {
		name: "monitor",
		label: "Monitor",
		description: TOOL_DESCRIPTION,
		// Starting a monitor runs a command or reads a file the caller names, which is
		// exactly the authority bash already carries.
		approval: "exec",
		parameters: pi.arktype({
			"op?": "'start' | 'list' | 'stop' | 'label'",
			"name?": "string",
			"label?": "string",
			"file?": "string",
			"command?": "string",
			"args?": "string[]",
			"cwd?": "string",
			"env?": { "[string]": "string" },
			"match?": "string",
			"until?": "string",
			"deadline?": "number",
			"replay?": "boolean",
		}),
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<ToolResult> {
			const params = rawParams as MonitorParams;
			switch (params.op ?? "start") {
				case "list": {
					const statuses = ensureRegistry(ctx).list();
					return textResult(
						statuses.length === 0 ? "No monitors in this session." : statuses.map(formatStatus).join("\n"),
						statuses,
					);
				}
				case "stop": {
					if (!params.name) throw new Error("stop requires name");
					const status = ensureRegistry(ctx).stop(params.name);
					publishStatus();
					return textResult(`Stopped ${formatStatus(status)}`, status);
				}
				case "label": {
					if (!params.name) throw new Error("label requires name");
					if (params.label === undefined) throw new Error('label requires label; pass "" to clear it');
					const status = ensureRegistry(ctx).relabel(params.name, params.label);
					publishStatus();
					return textResult(`Relabelled ${formatStatus(status)}`, status);
				}
				default:
					return start(params, ctx);
			}
		},
	};

	pi.setLabel("Monitor");
	pi.registerTool(tool);

	/**
	 * Declared monitors are armed once per session, at the point a session
	 * exists: `session_start` for a fresh or resumed one, `session_switch` for
	 * the next one in the same process. A declaration is a command that runs
	 * unasked, so this happens only where there is a UI — a `-p` run and every
	 * subagent get the tool and none of the arming.
	 */
	const armDeclared = async (ctx: ExtensionCtx): Promise<void> => {
		statusCtx = ctx;
		const autostart = process.env[AUTOSTART_ENV] ?? "on";
		if (!ctx.hasUI || autostart === "0" || autostart === "false" || autostart === "off") return;
		const { monitors, warnings } = await discoverDeclared({
			home: process.env.HOME ?? "",
			env: process.env,
			cwd: ctx.cwd,
		});
		// Seen and not armed: a missing identity variable, a trigger this host
		// cannot fire, a malformed entry. `/monitor` reprints them, because the
		// difference between "nothing declared" and "declared and skipped" is
		// the difference between a quiet mailbox and a deaf one.
		declaredWarnings = warnings;
		for (const warning of warnings) pi.logger?.warn?.(warning);
		for (const declared of monitors) await armOne(declared, ctx);
	};

	const armOne = async (declared: DeclaredMonitor, ctx: ExtensionCtx): Promise<void> => {
		const spec: MonitorSpec = {
			name: declared.name,
			label: declared.label ?? declared.name.split(":").pop(),
			description: declared.description,
			target: {
				kind: "command",
				// Through a shell, because a declaration is one command STRING —
				// the shape Claude Code's monitors.json uses, and what lets a
				// manifest quote a path with spaces in it.
				command: "/bin/sh",
				args: ["-c", declared.command],
				cwd: ctx.cwd,
				env: {},
			},
			match: declared.match,
			replay: false,
		};
		try {
			await ensureRegistry(ctx).start(spec);
			publishStatus();
		} catch (error) {
			// One plugin's broken declaration must not stop the next plugin's
			// listener from coming up.
			pi.logger?.warn?.("Failed to arm declared monitor", { name: declared.name, origin: declared.origin, error: String(error) });
			declaredWarnings = [...declaredWarnings, `[monitor] ${declared.name} from ${declared.origin} failed to start: ${String(error)}`];
		}
	};

	pi.registerCommand("monitor", {
		description: "List, relabel, or stop this session's monitors",
		handler: (args, ctx) => {
			const [verb, name, ...rest] = args.trim().split(/\s+/);
			const live = ensureRegistry(ctx);
			if (verb === "stop" && name) {
				const status = live.stop(name);
				publishStatus();
				return `Stopped ${formatStatus(status)}`;
			}
			if (verb === "label" && name) {
				// No text left is a deliberate clear: the footer falls back to the name.
				const status = live.relabel(name, rest.join(" "));
				publishStatus();
				return `Relabelled ${formatStatus(status)}`;
			}
			const statuses = live.list();
			const lines = statuses.length === 0 ? ["No monitors in this session."] : statuses.map(formatStatus);
			return [...lines, ...declaredWarnings].join("\n");
		},
	});

	// A monitor belongs to the conversation that started it. Switching sessions or
	// shutting down ends every monitor silently: the successor never asked to
	// listen, and a notice delivered into a transcript that is going away is noise.
	const release = (_event: unknown, ctx: ExtensionCtx): void => {
		statusCtx = ctx;
		registry?.stopAll("session-ended");
		registry = undefined;
		declaredWarnings = [];
		publishStatus();
	};
	pi.on("session_start", async (_event, ctx) => {
		await armDeclared(ctx as ExtensionCtx);
	});
	pi.on("session_switch", async (event, ctx) => {
		release(event, ctx as ExtensionCtx);
		await armDeclared(ctx as ExtensionCtx);
	});
	pi.on("session_shutdown", release);
}

export type { MonitorBatch, MonitorStatus };
