/**
 * The slice of OMP's extension API this package uses, declared structurally so
 * the extension needs no build-time dependency on the host and can be dropped
 * into any omp install.
 *
 * Source of truth for these shapes: `packages/coding-agent/src/extensibility/
 * extensions/types.ts` (`ExtensionAPI`, `ExtensionContext`, `ToolDefinition`).
 */

export interface ExtensionUi {
	/** Write one segment of the persistent status footer. */
	setStatus(key: string, text: string | undefined): void;
}

/**
 * The host builds a FRESH context object for every handler and tool
 * invocation, so object identity says nothing about which session is calling:
 * `sessionManager.getSessionId()` plus the live `cwd` is what identifies it.
 */
export interface ExtensionCtx {
	cwd: string;
	hasUI: boolean;
	isIdle(): boolean;
	sessionManager: { getSessionId(): string };
	ui: ExtensionUi;
	/**
	 * Managed timers. Unlike raw `setInterval`, a throw inside the callback is
	 * contained and reported instead of escaping as a process-fatal
	 * `uncaughtException`, and every handle is cleared on session teardown.
	 * Background work MUST use these.
	 */
	setInterval(callback: () => void, ms?: number): TimerHandle;
	setTimeout(callback: () => void, ms?: number): TimerHandle;
	clearTimer(timer: TimerHandle): void;
}

/** Opaque handle returned by the host's managed timers. */
export type TimerHandle = unknown;

export interface CustomMessagePayload {
	customType: string;
	content: string;
	details?: unknown;
	display?: boolean;
}

export interface SendOptions {
	/** `nextTurn` keeps the message out of the editable pending-message UI. */
	deliverAs?: "steer" | "followUp" | "nextTurn";
	/** Start a turn: this is what wakes an idle session. */
	triggerTurn?: boolean;
}

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	isError?: boolean;
	details?: unknown;
}

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	/** An omptype schema built with the injected `pi.arktype`. */
	parameters: unknown;
	approval?: "read" | "write" | "exec";
	loadMode?: "essential" | "discoverable";
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionCtx,
	): Promise<ToolResult>;
	onSession?(event: { reason: string }, ctx: ExtensionCtx): void | Promise<void>;
}

export interface ExtensionLogger {
	debug?(message: string, data?: unknown): void;
	warn?(message: string, data?: unknown): void;
	error?(message: string, data?: unknown): void;
}

/** Arktype/omptype builder: `pi.arktype({ "field?": "string" })`. */
export type ArkTypeBuilder = (definition: unknown) => unknown;

export interface ExtensionApi {
	arktype: ArkTypeBuilder;
	logger?: ExtensionLogger;
	setLabel(label: string): void;
	on(event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown): void;
	registerTool(tool: ToolDefinition): void;
	registerCommand(
		name: string,
		definition: { description: string; handler: (args: string, ctx: ExtensionCtx) => unknown },
	): void;
	sendMessage(message: CustomMessagePayload, options?: SendOptions): void;
}
