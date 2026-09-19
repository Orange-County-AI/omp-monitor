/**
 * Declared monitors: the ones a plugin ships, armed at session start without
 * the agent asking.
 *
 * A resident listener has a bootstrap problem the tool alone cannot solve. The
 * agent must call `monitor` before anything is delivered, so a session that
 * never makes that call is deaf — and for a mailbox or a queue consumer, deaf
 * looks exactly like quiet. Claude Code answers this with a plugin component:
 * `monitors/monitors.json`, one entry per monitor, `when: "always"`, started
 * for the lifetime of the session. This is that component for omp, with the
 * same file, the same field names and the same defaults, because a plugin that
 * serves both harnesses should not need two manifests.
 *
 * Where they are read from is omp's own plugin surface, not Claude's install
 * database: every directory below an extensions directory or a plugins
 * `node_modules`, which is where `omp plugin install`, `omp plugin link` and a
 * hand-made symlink all put a plugin. A Claude plugin directory works verbatim
 * when it is linked there, because `.claude-plugin/plugin.json` is read
 * alongside `.omp-plugin/plugin.json`.
 *
 * Two deliberate limits, both matching Claude Code:
 *
 *   - USER SCOPE ONLY. Nothing is read from the project directory. A monitor
 *     is a command that runs unasked at session start; taking that from a
 *     checkout would make cloning a repository enough to run code.
 *   - INTERACTIVE ONLY. Arming happens where there is a UI, so a headless
 *     `-p` run and every subagent stay out of it — one listener per human
 *     session, not one per spawned turn.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** One entry of a `monitors.json` array, as written by a plugin author. */
export interface MonitorDeclaration {
	name: string;
	command: string;
	description: string;
	/** `always` (the default) arms at session start. Anything else is not armed here. */
	when?: string;
	/** Status-footer text. omp-specific: Claude Code's task panel shows the description instead. */
	label?: string;
	/** Deliver only matching lines. omp-specific, and the reason a chatty source can be declared at all. */
	match?: string;
}

/** A declaration resolved against one plugin root, ready to hand to the registry. */
export interface DeclaredMonitor {
	/** Registry name, scoped `plugin:entry` the way omp scopes every other plugin component. */
	name: string;
	plugin: string;
	description: string;
	label?: string;
	match?: string;
	command: string;
	/** The manifest this came from, so a bad entry can be found and fixed. */
	origin: string;
}

export interface DiscoveryOptions {
	home: string;
	env: Record<string, string | undefined>;
	/** The session's working directory: what `${OMP_PROJECT_DIR}` expands to. */
	cwd: string;
}

export interface Discovery {
	monitors: DeclaredMonitor[];
	warnings: string[];
}

/** Colon-separated plugin roots, replacing the default search. The smoke test's hook, and an escape hatch. */
export const ROOTS_ENV = "OMP_MONITOR_PLUGIN_DIRS";
/** Set to `0`, `false` or `off` to arm nothing: the tool without the declarations. */
export const AUTOSTART_ENV = "OMP_MONITOR_AUTOSTART";

const MANIFESTS = [
	path.join(".omp-plugin", "plugin.json"),
	path.join(".claude-plugin", "plugin.json"),
	"package.json",
] as const;
const DEFAULT_PATH = path.join("monitors", "monitors.json");
/**
 * Where a manifest may carry the declarations: `monitors` at the top level, or
 * nested under the key each harness namespaces its unstable components with —
 * `experimental.monitors` in a Claude manifest, `omp.monitors` in a package.
 * Either holds the array itself or a path to the file holding it.
 */
const MANIFEST_KEYS = ["monitors", "experimental", "omp"] as const;

async function readJson(file: string): Promise<unknown> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		// A plugin that ships no manifest of this kind is the common case, not a fault.
		return undefined;
	}
	return JSON.parse(raw) as unknown;
}

/**
 * The directories a plugin can be installed into, user scope only.
 *
 * `~/.omp/agent/extensions` is where an extension package is dropped or
 * symlinked; `~/.omp/plugins/node_modules` is where a marketplace install and
 * `omp plugin link` put theirs. XDG relocates the second one, so both are
 * looked at and a missing directory is not an error.
 */
function rootBases(options: DiscoveryOptions): string[] {
	const override = options.env[ROOTS_ENV]?.trim();
	if (override !== undefined && override.length > 0) {
		return override
			.split(":")
			.map(entry => entry.trim())
			.filter(entry => entry.length > 0);
	}
	const bases = [
		path.join(options.home, ".omp", "agent", "extensions"),
		path.join(options.home, ".omp", "plugins", "node_modules"),
	];
	const xdg = options.env.XDG_DATA_HOME?.trim();
	if (xdg !== undefined && xdg.length > 0) bases.push(path.join(xdg, "omp", "plugins", "node_modules"));
	return bases;
}

/**
 * Plugin roots, sorted, so two plugins declaring one name resolve the same way
 * on every start rather than by directory order.
 */
async function pluginRoots(options: DiscoveryOptions): Promise<string[]> {
	const roots: string[] = [];
	for (const base of rootBases(options)) {
		let entries: string[];
		try {
			// Names only: a linked plugin directory is the normal install shape,
			// and the manifest read below is what decides whether this is a
			// plugin at all.
			entries = await fs.readdir(base);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (entry.startsWith(".")) continue;
			roots.push(path.join(base, entry));
		}
	}
	return roots;
}

/**
 * The declarations one plugin root carries, from the first manifest that has
 * them, else the conventional `monitors/monitors.json`.
 */
async function declarationsFor(root: string, warnings: string[]): Promise<{ entries: unknown[]; origin: string } | undefined> {
	for (const manifestPath of MANIFESTS) {
		const file = path.join(root, manifestPath);
		let manifest: unknown;
		try {
			manifest = await readJson(file);
		} catch (error) {
			warnings.push(`[monitor] Invalid JSON in ${file}: ${String(error)}`);
			continue;
		}
		if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) continue;
		const fields = manifest as Record<string, unknown>;
		for (const key of MANIFEST_KEYS) {
			const nested = fields[key];
			const declared =
				key === "monitors"
					? nested
					: typeof nested === "object" && nested !== null && !Array.isArray(nested)
						? (nested as Record<string, unknown>).monitors
						: undefined;
			if (Array.isArray(declared)) return { entries: declared, origin: file };
			const relative = typeof declared === "string" ? declared.trim() : "";
			if (relative.length === 0) continue;
			const target = path.resolve(root, relative);
			// A manifest may not reach out of its own tree: the path is data from
			// the plugin, and the file it names is about to be executed from.
			const inside = path.relative(root, target);
			if (inside.startsWith("..") || path.isAbsolute(inside)) {
				warnings.push(`[monitor] Ignoring monitors path outside the plugin root of ${root}: ${relative}`);
				continue;
			}
			let entries: unknown;
			try {
				entries = await readJson(target);
			} catch (error) {
				warnings.push(`[monitor] Invalid JSON in ${target}: ${String(error)}`);
				continue;
			}
			if (entries === undefined) {
				warnings.push(`[monitor] Missing monitors file declared by ${file}: ${target}`);
				continue;
			}
			if (!Array.isArray(entries)) {
				warnings.push(`[monitor] ${target} must hold an array of monitor declarations`);
				continue;
			}
			return { entries, origin: target };
		}
	}
	const fallback = path.join(root, DEFAULT_PATH);
	let entries: unknown;
	try {
		entries = await readJson(fallback);
	} catch (error) {
		warnings.push(`[monitor] Invalid JSON in ${fallback}: ${String(error)}`);
		return undefined;
	}
	if (entries === undefined) return undefined;
	if (!Array.isArray(entries)) {
		warnings.push(`[monitor] ${fallback} must hold an array of monitor declarations`);
		return undefined;
	}
	return { entries, origin: fallback };
}

/**
 * `${VAR}` expansion, with the same placeholders omp already substitutes for a
 * plugin's MCP servers plus the project directory.
 *
 * An unresolved variable skips the monitor rather than expanding to nothing.
 * That is what makes a declaration conditional: a mail listener whose identity
 * variable is unset is not a broken monitor to report, it is a machine that is
 * not a consumer of that mailbox, and a command started to fail immediately
 * would tell every session on that machine otherwise.
 */
function substitute(value: string, root: string, options: DiscoveryOptions): { text?: string; missing?: string } {
	const builtins: Record<string, string> = {
		OMP_PLUGIN_ROOT: root,
		CLAUDE_PLUGIN_ROOT: root,
		OMP_PROJECT_DIR: options.cwd,
		CLAUDE_PROJECT_DIR: options.cwd,
	};
	let missing: string | undefined;
	const text = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const resolved = builtins[name] ?? options.env[name];
		if (resolved === undefined || resolved.length === 0) {
			missing ??= name;
			return "";
		}
		return resolved;
	});
	return missing === undefined ? { text } : { missing };
}

function parseEntry(
	entry: unknown,
	root: string,
	origin: string,
	options: DiscoveryOptions,
	warnings: string[],
): DeclaredMonitor | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		warnings.push(`[monitor] Skipping a non-object monitor declaration in ${origin}`);
		return undefined;
	}
	const declaration = entry as Partial<MonitorDeclaration>;
	const { name, command, description } = declaration;
	if (typeof name !== "string" || name.trim().length === 0) {
		warnings.push(`[monitor] Skipping a monitor declaration without a name in ${origin}`);
		return undefined;
	}
	if (typeof command !== "string" || command.trim().length === 0) {
		warnings.push(`[monitor] Skipping monitor ${name} in ${origin}: no command`);
		return undefined;
	}
	if (typeof description !== "string" || description.trim().length === 0) {
		warnings.push(`[monitor] Skipping monitor ${name} in ${origin}: no description`);
		return undefined;
	}
	const when = declaration.when ?? "always";
	if (when !== "always") {
		// `on-skill-invoke:<skill>` is Claude Code's other trigger. omp gives an
		// extension no skill-dispatch hook, so the honest answer is to say the
		// entry was seen and not armed, rather than to arm it at session start
		// and call that the same thing.
		warnings.push(`[monitor] Monitor ${name} in ${origin} declares when="${when}", which this host cannot trigger; not armed`);
		return undefined;
	}
	const expanded = substitute(command, root, options);
	if (expanded.text === undefined) {
		warnings.push(`[monitor] Monitor ${name} needs \${${expanded.missing}}, which is not set; not armed`);
		return undefined;
	}
	if (declaration.match !== undefined) {
		try {
			new RegExp(declaration.match, "u");
		} catch (error) {
			warnings.push(`[monitor] Skipping monitor ${name} in ${origin}: match is not a valid regular expression: ${String(error)}`);
			return undefined;
		}
	}
	const plugin = path.basename(root);
	return {
		name: `${plugin}:${name.trim()}`,
		plugin,
		description: description.trim(),
		label: declaration.label,
		match: declaration.match,
		command: expanded.text,
		origin,
	};
}

/**
 * Every monitor declared by an installed plugin, in a stable order, with one
 * warning per entry that was seen and not armed.
 */
export async function discoverDeclared(options: DiscoveryOptions): Promise<Discovery> {
	const warnings: string[] = [];
	const monitors: DeclaredMonitor[] = [];
	const claimed = new Set<string>();
	for (const root of await pluginRoots(options)) {
		const declared = await declarationsFor(root, warnings);
		if (declared === undefined) continue;
		for (const entry of declared.entries) {
			const monitor = parseEntry(entry, root, declared.origin, options, warnings);
			if (monitor === undefined) continue;
			if (claimed.has(monitor.name)) {
				warnings.push(`[monitor] Ignoring duplicate declaration of ${monitor.name} in ${declared.origin}`);
				continue;
			}
			claimed.add(monitor.name);
			monitors.push(monitor);
		}
	}
	return { monitors, warnings };
}
