/**
 * The envelope a delivered batch arrives in.
 *
 * Monitored output is untrusted text: a log line, or a message somebody else
 * wrote. It is escaped and fenced inside one element whose attributes carry the
 * facts the agent needs to act — which monitor, which source, whether it is still
 * running — so a line of content can never forge a delivery or impersonate the
 * notice that the monitor ended.
 */

import { normalizeLabel } from "./monitor";
import type { MonitorBatch, MonitorEndReason, MonitorStatus } from "./monitor";

/**
 * Attribute values are quoted, so anything that could close the quote, close the
 * tag, or start another one is escaped. Newlines and tabs become numeric
 * references rather than spaces: lossless, and a value can never spill onto a
 * second line where it might read as markup.
 */
function attribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
		.replace(/[\t\n\r]/g, character => `&#${character.charCodeAt(0)};`);
}

/**
 * Escaped rather than wrapped in CDATA: a body containing `]]>` would end a
 * CDATA section, so the section would need splitting to stay safe, whereas
 * escaping `&` and `<` has no such edge.
 */
function text(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Characters of labels the footer spends before the remainder becomes a count. */
const MAX_STATUS_CHARS = 48;

/**
 * The status footer segment: how many monitors are live and which ones. Names
 * are listed until the character budget is spent, and the rest become `+N`, so
 * a session with a dozen monitors still leaves room for every other segment.
 */
export function formatStatusLine(live: MonitorStatus[]): string | undefined {
	if (live.length === 0) return undefined;
	const shown: string[] = [];
	let width = 0;
	for (const status of live) {
		// The label is already normalized; a name is agent-supplied too and is not.
		const label = normalizeLabel(status.label ?? status.name) ?? "monitor";
		const cost = shown.length === 0 ? label.length : label.length + 2;
		if (shown.length > 0 && width + cost > MAX_STATUS_CHARS) break;
		shown.push(label);
		width += cost;
	}
	const hidden = live.length - shown.length;
	if (hidden > 0) shown.push(`+${hidden}`);
	return `monitor ${live.length}: ${shown.join(", ")}`;
}

/** What the agent should do about a monitor that stopped. */
function endNotice(reason: MonitorEndReason, batch: MonitorBatch): string {
	switch (reason) {
		case "matched":
			return `The pattern you were waiting for appeared${batch.lastMatch ? `: ${batch.lastMatch}` : ""}. This monitor has ended; it delivered what you asked for.`;
		case "exited":
			return `The monitored command exited${batch.exitCode === undefined ? "" : ` with code ${batch.exitCode}`}. This monitor has ended. Nothing from this source will reach you until you start it again.`;
		case "deadline":
			return "This monitor reached its deadline and has ended. Nothing from this source will reach you until you start it again — do that now if the reason you were monitoring still stands.";
		case "source-gone":
			return "The monitored file no longer exists, so this monitor has ended.";
		case "stopped":
			return "This monitor was stopped.";
		case "session-ended":
			return "This monitor ended with its session.";
	}
}

/** Render one delivered batch as the message the agent reads. */
export function formatBatch(batch: MonitorBatch): string {
	const attributes = [
		`name="${attribute(batch.name)}"`,
		`source="${attribute(batch.source)}"`,
		batch.ended ? `ended="${attribute(batch.ended)}"` : `lines="${batch.lines.length}"`,
	];
	const body: string[] = [];
	if (batch.dropped > 0) {
		body.push(`<monitor-dropped count="${batch.dropped}">The source produced lines faster than they could be delivered; this many were discarded.</monitor-dropped>`);
	}
	if (batch.lines.length > 0) body.push(`<monitor-output>\n${batch.lines.map(text).join("\n")}\n</monitor-output>`);
	if (batch.ended) body.push(`<monitor-ended reason="${attribute(batch.ended)}">${text(endNotice(batch.ended, batch))}</monitor-ended>`);
	return `<monitor-event ${attributes.join(" ")}>\n${body.join("\n")}\n</monitor-event>`;
}

function describeState(status: MonitorStatus): string {
	if (status.state === "monitoring") {
		const deadline =
			status.deadlineAt === undefined
				? ""
				: `, ${Math.max(0, Math.round((status.deadlineAt - Date.now()) / 1000))}s left`;
		return `monitoring${deadline}`;
	}
	return `ended (${status.endReason ?? "unknown"})`;
}

/** One line per monitor, for `/monitor` and for the tool's own list and start replies. */
export function formatStatus(status: MonitorStatus): string {
	const filters = [
		status.match === undefined ? undefined : `match=${status.match}`,
		status.until === undefined ? undefined : `until=${status.until}`,
	].filter(part => part !== undefined);
	const counts = `${status.lines} line(s) in ${status.batches} batch(es)${status.dropped > 0 ? `, ${status.dropped} dropped` : ""}`;
	return [
		`${status.name}: ${describeState(status)}`,
		status.label === undefined ? undefined : `label=${status.label}`,
		status.description === undefined ? undefined : `watching=${status.description}`,
		`source=${status.source}`,
		...filters,
		counts,
		status.pid === undefined ? undefined : `pid=${status.pid}`,
	]
		.filter(part => part !== undefined)
		.join("; ");
}
