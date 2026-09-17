/**
 * The monitor engine: turn a source of text into batches of lines, and stop on a
 * stated condition.
 *
 * Two sources, one pipeline. A file is tailed by byte offset; a command is
 * spawned and its stdout and stderr are read as they arrive. Both feed the same
 * framer, so `match`, `until`, the line caps and the batching behave identically
 * whichever source produced the text.
 *
 * Batching is the point, not an optimisation: every delivery wakes a turn on the
 * owning session, so a burst of a hundred lines must cost one turn rather than a
 * hundred. Lines accumulate for {@link FLUSH_MS} and go out together.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { TimerHandle } from "./host";

/** Why a monitor stopped. Every ended monitor reports exactly one. */
export type MonitorEndReason = "matched" | "exited" | "deadline" | "stopped" | "source-gone" | "session-ended";

export type MonitorTarget =
	| { kind: "file"; path: string }
	| { kind: "command"; command: string; args: string[]; cwd: string; env: Record<string, string> };

export interface MonitorSpec {
	name: string;
	target: MonitorTarget;
	/** Deliver only lines matching this pattern; absent delivers every line. */
	match?: string;
	/** Deliver the line matching this pattern, then end the monitor. */
	until?: string;
	/** Milliseconds until the monitor ends on its own; absent lives as long as the source. */
	deadlineMs?: number;
	/** Deliver a file's existing content before live output. */
	replay: boolean;
}

export interface MonitorStatus {
	name: string;
	source: string;
	state: "monitoring" | "ended";
	match?: string;
	until?: string;
	deadlineAt?: number;
	startedAt: number;
	endedAt?: number;
	endReason?: MonitorEndReason;
	/** Lines delivered so far. */
	lines: number;
	/** Batches delivered so far. */
	batches: number;
	/** Lines discarded because the source outran delivery. */
	dropped: number;
	lastMatch?: string;
	pid?: number;
	exitCode?: number;
}

/** One delivery: the lines a source produced, plus the terminal notice when it stopped. */
export interface MonitorBatch {
	name: string;
	source: string;
	lines: string[];
	dropped: number;
	ended?: MonitorEndReason;
	lastMatch?: string;
	exitCode?: number;
}

export interface MonitorHost {
	deliver(batch: MonitorBatch): void;
	setInterval(callback: () => void, ms: number): TimerHandle;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimer(timer: TimerHandle): void;
	warn(message: string, data?: unknown): void;
}

/** File tailing cadence. Fast enough that a log line feels immediate, slow enough to be free. */
const POLL_MS = 250;
/** Lines accumulate this long before a batch goes out, so one burst costs one turn. */
const FLUSH_MS = 400;
const MAX_BATCH_LINES = 50;
/** Lines held for a later batch before the oldest are dropped and counted. */
const MAX_QUEUED_LINES = 500;
const MAX_LINE_CHARS = 4_000;
const READ_BYTES = 1024 * 1024;

export function describeTarget(target: MonitorTarget): string {
	return target.kind === "file" ? target.path : [target.command, ...target.args].join(" ");
}

/**
 * Strip the control bytes that would corrupt the terminal when a delivered line
 * is rendered, keeping the printable text. A monitored log may be a PTY capture
 * full of cursor movement and colour, and none of that survives usefully as a
 * line of text in a conversation.
 */
function sanitize(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[[\]()#;?]*[0-9;]*[A-Za-z]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

class Monitor {
	readonly spec: MonitorSpec;
	readonly source: string;
	readonly #host: MonitorHost;
	readonly #matcher?: RegExp;
	readonly #until?: RegExp;
	readonly #status: MonitorStatus;
	/** Trailing partial line carried to the next read. */
	#carry = "";
	#queue: string[] = [];
	#offset = 0;
	#pollTimer?: TimerHandle;
	#flushTimer?: TimerHandle;
	#deadlineTimer?: TimerHandle;
	#child?: Bun.Subprocess<"ignore", "pipe", "pipe">;
	#polling = false;

	constructor(spec: MonitorSpec, host: MonitorHost) {
		this.spec = spec;
		this.#host = host;
		this.source = describeTarget(spec.target);
		this.#matcher = spec.match === undefined ? undefined : new RegExp(spec.match, "u");
		this.#until = spec.until === undefined ? undefined : new RegExp(spec.until, "u");
		this.#status = {
			name: spec.name,
			source: this.source,
			state: "monitoring",
			match: spec.match,
			until: spec.until,
			deadlineAt: spec.deadlineMs === undefined ? undefined : Date.now() + spec.deadlineMs,
			startedAt: Date.now(),
			lines: 0,
			batches: 0,
			dropped: 0,
		};
	}

	status(): MonitorStatus {
		return { ...this.#status };
	}

	/** Attach to the source. Throws when the source cannot be reached, so the tool call fails loudly. */
	async start(): Promise<void> {
		if (this.spec.target.kind === "file") await this.#startFile(this.spec.target.path);
		else this.#startCommand(this.spec.target);
		if (this.spec.deadlineMs === undefined) return;
		this.#deadlineTimer = this.#host.setTimeout(() => this.end("deadline"), this.spec.deadlineMs);
	}

	async #startFile(file: string): Promise<void> {
		const stat = await statOrUndefined(file);
		if (!stat) throw new Error(`Monitor source does not exist: ${file}`);
		if (stat.isDirectory()) throw new Error(`Monitor source is a directory: ${file}`);
		this.#offset = this.spec.replay ? 0 : stat.size;
		this.#pollTimer = this.#host.setInterval(() => void this.#pollFile(file), POLL_MS);
	}

	#startCommand(target: Extract<MonitorTarget, { kind: "command" }>): void {
		// Overlay onto the inherited environment rather than replacing it: a child
		// spawned with only the caller's two variables loses PATH and cannot run.
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		Object.assign(env, target.env);
		const child = Bun.spawn([target.command, ...target.args], {
			cwd: target.cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#child = child;
		this.#status.pid = child.pid;
		void this.#read(child.stdout);
		void this.#read(child.stderr);
		void child.exited.then(code => {
			this.#status.exitCode = code;
			this.end("exited");
		});
	}

	async #read(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (this.#status.state !== "monitoring") return;
				this.#frame(decoder.decode(value, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail && this.#status.state === "monitoring") this.#frame(tail);
		} catch (error) {
			this.#host.warn("Monitor stream read failed", { name: this.spec.name, error: String(error) });
		} finally {
			reader.releaseLock();
		}
	}

	async #pollFile(file: string): Promise<void> {
		if (this.#polling || this.#status.state !== "monitoring") return;
		this.#polling = true;
		try {
			const stat = await statOrUndefined(file);
			if (!stat) {
				this.end("source-gone");
				return;
			}
			// A file shorter than the cursor was truncated or rotated: continue from
			// the start of what is now there rather than reading past its end.
			if (stat.size < this.#offset) this.#offset = 0;
			if (stat.size <= this.#offset) return;
			const end = Math.min(stat.size, this.#offset + READ_BYTES);
			const text = await Bun.file(file).slice(this.#offset, end).text();
			this.#offset = end;
			this.#frame(text);
		} catch (error) {
			this.#host.warn("Monitor poll failed", { name: this.spec.name, error: String(error) });
		} finally {
			this.#polling = false;
		}
	}

	/** Split raw source text into whole lines and queue the ones that pass the filter. */
	#frame(text: string): void {
		let buffer = this.#carry + sanitize(text);
		let start = 0;
		for (;;) {
			const newline = buffer.indexOf("\n", start);
			if (newline < 0) break;
			this.#queueLine(buffer.slice(start, newline).replace(/\r$/, ""));
			start = newline + 1;
		}
		buffer = buffer.slice(start);
		// A source that never emits a newline — a progress bar, one endless JSON
		// blob — would otherwise grow the carry without bound.
		if (buffer.length > MAX_LINE_CHARS) {
			this.#queueLine(buffer.slice(0, MAX_LINE_CHARS));
			buffer = buffer.slice(MAX_LINE_CHARS);
		}
		this.#carry = buffer;
		if (this.#queue.length === 0) return;
		if (this.#until && this.#queue.some(line => this.#until?.test(line) ?? false)) {
			this.end("matched");
			return;
		}
		this.#scheduleFlush();
	}

	#queueLine(raw: string): void {
		const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
		const ends = this.#until?.test(line) ?? false;
		if (!ends && this.#matcher && !this.#matcher.test(line)) return;
		if (ends || this.#matcher) this.#status.lastMatch = line.slice(0, 500);
		this.#queue.push(line);
		if (this.#queue.length <= MAX_QUEUED_LINES) return;
		const overflow = this.#queue.length - MAX_QUEUED_LINES;
		this.#queue.splice(0, overflow);
		this.#status.dropped += overflow;
	}

	#scheduleFlush(): void {
		if (this.#flushTimer !== undefined) return;
		this.#flushTimer = this.#host.setTimeout(() => {
			this.#flushTimer = undefined;
			this.#flush();
		}, FLUSH_MS);
	}

	/** Emit one batch. Remaining lines ride the next flush, so nothing is lost to the cap. */
	#flush(ended?: MonitorEndReason): void {
		if (this.#queue.length === 0 && ended === undefined) return;
		const lines = this.#queue.splice(0, MAX_BATCH_LINES);
		const dropped = this.#status.dropped;
		this.#status.lines += lines.length;
		this.#status.batches++;
		this.#host.deliver({
			name: this.spec.name,
			source: this.source,
			lines,
			dropped,
			ended,
			lastMatch: ended === "matched" ? this.#status.lastMatch : undefined,
			exitCode: this.#status.exitCode,
		});
		if (ended !== undefined) return;
		if (this.#queue.length > 0) this.#scheduleFlush();
	}

	/**
	 * Stop the monitor and deliver its single terminal notice, so the agent learns
	 * it went deaf instead of waiting forever on a source nobody is reading.
	 * `notify` is false only when the caller asked for the stop and already knows.
	 */
	end(reason: MonitorEndReason, notify = true): void {
		if (this.#status.state === "ended") return;
		this.#status.state = "ended";
		this.#status.endedAt = Date.now();
		this.#status.endReason = reason;
		this.#teardown();
		if (notify) this.#flush(reason);
		this.#queue = [];
	}

	#teardown(): void {
		for (const timer of [this.#pollTimer, this.#flushTimer, this.#deadlineTimer]) {
			if (timer !== undefined) this.#host.clearTimer(timer);
		}
		this.#pollTimer = undefined;
		this.#flushTimer = undefined;
		this.#deadlineTimer = undefined;
		if (!this.#child) return;
		try {
			this.#child.kill();
		} catch (error) {
			this.#host.warn("Failed to stop monitored command", { name: this.spec.name, error: String(error) });
		}
		this.#child = undefined;
	}
}

async function statOrUndefined(file: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(file);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** Every monitor this session owns. One registry per loaded extension instance. */
export class MonitorRegistry {
	readonly #host: MonitorHost;
	readonly #monitors = new Map<string, Monitor>();

	constructor(host: MonitorHost) {
		this.#host = host;
	}

	/** Start a monitor, replacing any finished one of the same name. */
	async start(spec: MonitorSpec): Promise<MonitorStatus> {
		const existing = this.#monitors.get(spec.name);
		if (existing?.status().state === "monitoring") {
			throw new Error(`Monitor ${spec.name} is already running. Stop it first, or use a different name.`);
		}
		const monitor = new Monitor(spec, this.#host);
		// Register only once the source is attached, so a failed start leaves no
		// half-live entry behind for `list` or `stop` to trip over.
		await monitor.start();
		this.#monitors.set(spec.name, monitor);
		return monitor.status();
	}

	stop(name: string): MonitorStatus {
		const monitor = this.#monitors.get(name);
		if (!monitor) {
			const names = [...this.#monitors.keys()];
			throw new Error(`Unknown monitor ${name}${names.length ? `. Running: ${names.join(", ")}` : ""}`);
		}
		monitor.end("stopped", false);
		return monitor.status();
	}

	list(): MonitorStatus[] {
		return [...this.#monitors.values()].map(monitor => monitor.status());
	}

	live(): MonitorStatus[] {
		return this.list().filter(status => status.state === "monitoring");
	}

	/** Tear every monitor down without delivering notices; the session is going away. */
	stopAll(reason: MonitorEndReason): void {
		for (const monitor of this.#monitors.values()) monitor.end(reason, false);
		this.#monitors.clear();
	}
}
