/**
 * Compact rendering of subagents: the `subagent` tool in the transcript, and the rows shared with the dock under
 * the composer. Subagent output never appears here; it lives in the subagent's own session and the agent view.
 *
 *     ● Subagent(auth-scout) Map auth flow
 *       ⎿  ✓ Done · 4 turns · 23s · $0.0123
 *
 *     ● Subagents · 2 in parallel
 *       ⎿  ✓ a-scout  Read a.txt · Done · 3 turns · 12s
 *          ⠋ b-scout  Read b.txt · read b.txt · 2 turns · 8s
 */

import * as os from "node:os";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type Component, Container, truncateToWidth } from "@earendil-works/pi-tui";
import { formatReadLineRange } from "../../core/tools/render-utils.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentSource } from "./agents.ts";
import type { SubagentStatus, SubagentUsage } from "./child.ts";

/** The frames and timing of pi-tui's `Loader`, the spinner next to "Working", which does not export them. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

/** The spinner frame for the current time, so every running subagent spins in step on each render. */
export function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}

/** One subagent run as stored in the tool result. Plain data, so it survives the session file. */
export interface SubagentRunDetails {
	/** The caller-given one-word name. Results stored before names existed hold ids such as `sa1`. */
	id: string;
	/**
	 * Identifies the subagent instance for live lookups. Names are unique only within one pi process, so a resumed
	 * session could otherwise match an old row to a new subagent with the same name.
	 */
	key?: string;
	/** What the subagent is doing, in a few words. Absent in results stored before descriptions existed. */
	description?: string;
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	status: SubagentStatus | "pending";
	messages: Message[];
	usage: SubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionFile?: string;
	step?: number;
	/** What a running subagent is doing, from its streaming message. Absent once it stops. */
	phase?: SubagentPhase;
	/** When the latest run's process started and settled, in epoch milliseconds. */
	startedAt?: number;
	finishedAt?: number;
}

export interface SubagentToolDetails {
	mode: "single" | "parallel" | "chain";
	results: SubagentRunDetails[];
	/** The call started its subagents in the background and returned at once. */
	background?: boolean;
	/**
	 * Rows follow the subagents' live state while this process still has them, instead of the stored snapshot:
	 * set for background launches, and for `subagent_wait` while it waits.
	 */
	live?: boolean;
}

/** What one subagent row shows, built from a stored run or a live subagent. */
export interface SubagentRow {
	id: string;
	description?: string;
	status: SubagentStatus | "pending";
	usage: SubagentUsage;
	errorMessage?: string;
	startedAt?: number;
	finishedAt?: number;
	/** The latest tool call, already formatted. */
	activity?: string;
}

type ThemeFg = Theme["fg"];

export function isFailedRun(run: { status: SubagentStatus | "pending" }): boolean {
	return run.status === "failed" || run.status === "aborted";
}

export function getFinalOutput(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: Partial<SubagentUsage>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/** `8s`, `1m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const str = (value: unknown, fallback: string) => (typeof value === "string" && value ? value : fallback);
	switch (toolName) {
		case "bash": {
			const command = str(args.command, "...");
			return fg("muted", "$ ") + fg("toolOutput", command.length > 60 ? `${command.slice(0, 60)}...` : command);
		}
		case "read": {
			const lineRange = formatReadLineRange(args.offset, args.limit);
			const text = fg("accent", shortenPath(str(args.file_path ?? args.path, "...")));
			return fg("muted", "read ") + text + (lineRange ? fg("warning", lineRange) : "");
		}
		case "write": {
			const lines = str(args.content, "").split("\n").length;
			const text = fg("muted", "write ") + fg("accent", shortenPath(str(args.file_path ?? args.path, "...")));
			return lines > 1 ? text + fg("dim", ` (${lines} lines)`) : text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(str(args.file_path ?? args.path, "...")));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath(str(args.path, ".")));
		case "find":
			return (
				fg("muted", "find ") +
				fg("accent", str(args.pattern, "*")) +
				fg("dim", ` in ${shortenPath(str(args.path, "."))}`)
			);
		case "grep":
			return (
				fg("muted", "grep ") +
				fg("accent", `/${str(args.pattern, "")}/`) +
				fg("dim", ` in ${shortenPath(str(args.path, "."))}`)
			);
		default: {
			const argsStr = JSON.stringify(args);
			return fg("accent", toolName) + fg("dim", ` ${argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr}`);
		}
	}
}

/** The latest finished tool call, formatted, for rows that show what a subagent last did. */
export function latestToolCall(messages: readonly Message[], theme: Theme): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const part = message.content[j];
			if (part?.type === "toolCall") return formatToolCall(part.name, part.arguments, theme.fg.bind(theme));
		}
	}
	return undefined;
}

/** What a running subagent is doing, coarsely: shown instead of its commands. */
export type SubagentPhase = "thinking" | "responding" | "working";

/**
 * The phase from the streaming message's latest part: `thinking` or `responding`, otherwise `working` (calling
 * tools, or between turns).
 */
export function currentPhase(streaming: AssistantMessage | undefined): SubagentPhase {
	const current = streaming?.content.at(-1);
	if (current?.type === "thinking") return "thinking";
	if (current?.type === "text") return "responding";
	return "working";
}

export function formatPhase(phase: SubagentPhase, theme: Theme): string {
	return theme.fg("muted", phase === "thinking" ? "Thinking" : phase === "responding" ? "Responding" : "Working");
}

export function statusIcon(status: SubagentStatus | "pending", theme: Theme): string {
	switch (status) {
		case "queued":
			return theme.fg("muted", "◷");
		case "running":
		case "pending":
			return theme.fg("accent", spinnerFrame());
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("error", "✗");
	}
}

/**
 * The status part of a row: `Done · 3 turns · 12s · $0.0100`, `read a.txt · 2 turns · 8s`, `Queued`, ...
 *
 * A running row shows its elapsed time up to `now`. Compute the row at render time and pass the render's time;
 * without `now`, a running row leaves the time out.
 */
export function describeRowStatus(row: SubagentRow, theme: Theme, now?: number): string {
	const dim = (text: string) => theme.fg("dim", text);
	const stats: string[] = [];
	if (row.usage.turns) stats.push(`${row.usage.turns} turn${row.usage.turns > 1 ? "s" : ""}`);
	const end = row.finishedAt ?? now;
	if (row.startedAt && end !== undefined) stats.push(formatDuration(end - row.startedAt));
	const suffix = (extra: string[] = []) => {
		const parts = [...stats, ...extra];
		return parts.length > 0 ? dim(` · ${parts.join(" · ")}`) : "";
	};
	switch (row.status) {
		case "queued":
			return theme.fg("muted", "Queued");
		case "pending":
			return theme.fg("muted", "Starting");
		case "running":
			return (row.activity ?? theme.fg("muted", "Working")) + suffix();
		case "done":
			return theme.fg("success", "Done") + suffix(row.usage.cost ? [`$${row.usage.cost.toFixed(4)}`] : []);
		case "aborted":
			return theme.fg("error", "Aborted") + suffix();
		default: {
			const reason = row.errorMessage?.split("\n")[0]?.trim();
			return theme.fg("error", reason ? `Failed: ${reason}` : "Failed") + suffix();
		}
	}
}

export function rowFromRun(run: SubagentRunDetails, theme: Theme): SubagentRow {
	return { ...run, activity: run.status === "running" ? formatPhase(run.phase ?? "working", theme) : undefined };
}

/** Lines that never wrap: each is cut to the width with an ellipsis. */
export class SingleLines implements Component {
	private readonly lines: string[] | (() => string[]);

	/**
	 * `lines` as a function is called on every render. Rows with a spinner or a running timer need that: the TUI
	 * redraws often while a subagent runs, but the tool's renderers run only when the subagent reports progress.
	 */
	constructor(lines: string[] | (() => string[])) {
		this.lines = lines;
	}

	render(width: number): string[] {
		const lines = typeof this.lines === "function" ? this.lines() : this.lines;
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

interface SubagentCallStep {
	agent: string;
	task: string;
	name?: string;
	description?: string;
}

interface SubagentCallArgs {
	agent?: string;
	task?: string;
	name?: string;
	description?: string;
	tasks?: SubagentCallStep[];
	chain?: SubagentCallStep[];
	session?: string;
	background?: boolean;
}

export interface CallState {
	isPartial: boolean;
	isError: boolean;
	outputPad: number;
}

function preview(text: string, length: number): string {
	const line = text
		.replace(/\{previous\}/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > length ? `${line.slice(0, length)}...` : line;
}

/** `● Subagent(name) description`, with the bullet colored by state. */
/**
 * One call line: `● Title(argument) summary`, with the bullet colored by state. `background` is the call's own
 * flag; the actual mode also depends on config, so it is marked only when the call asked for it.
 */
export function renderCallLine(
	title: string,
	argument: string | undefined,
	summary: string,
	theme: Theme,
	state: CallState,
): Component {
	const bullet = state.isPartial
		? theme.fg("accent", "●")
		: state.isError
			? theme.fg("error", "●")
			: theme.fg("success", "●");
	const pad = " ".repeat(state.outputPad);
	const head =
		argument === undefined
			? theme.bold(title)
			: `${theme.bold(title)}${theme.fg("muted", "(")}${theme.fg("accent", argument)}${theme.fg("muted", ")")}`;
	return new SingleLines([`${pad}${bullet} ${head}${summary ? ` ${theme.fg("dim", summary)}` : ""}`]);
}

export function renderSubagentCall(args: SubagentCallArgs, theme: Theme, state: CallState): Component {
	const background = args.background ? " · background" : "";
	const steps = args.chain ?? args.tasks;
	if (steps && steps.length > 0) {
		const shape = args.chain ? `${steps.length} in a chain` : `${steps.length} in parallel`;
		return renderCallLine("Subagents", undefined, `· ${shape}${background}`, theme, state);
	}
	const name = args.session ?? args.name ?? args.agent ?? "...";
	const summary = args.session
		? `follow-up: ${preview(args.task ?? "", 50)}`
		: (args.description ?? preview(args.task ?? "", 50));
	return renderCallLine("Subagent", name, summary + background, theme, state);
}

/**
 * `⎿` lines under the call: the status of the run, or one row per run for parallel and chain calls. Running rows
 * show a phase, not commands. Expanded (by clicking the call or pressing the expand key), each row gets one more
 * line with its latest command. Subagent output never appears; it lives in the agent view.
 */
export function renderSubagentResult(
	details: SubagentToolDetails | undefined,
	fallbackText: string,
	options: {
		expanded: boolean;
		isError: boolean;
		outputPad: number;
		/** The current state of a subagent instance by key, while this process has it. Used when `details.live`. */
		lookup?: (key: string) => SubagentRunDetails | undefined;
		/** Rows show only the status icon, name, and description: no status text, turns, timer, or command. */
		compact?: boolean;
	},
	theme: Theme,
): Component {
	const pad = " ".repeat(options.outputPad);
	const elbow = `${pad}  ${theme.fg("muted", "⎿")}  `;
	const indent = `${pad}     `;
	const runs = details?.results ?? [];
	if (runs.length === 0) {
		const line = fallbackText.split("\n")[0] || "(no result)";
		return new SingleLines([elbow + theme.fg(options.isError ? "error" : "dim", line)]);
	}

	const multi = details?.mode !== "single";
	const nameWidth = Math.max(...runs.map((run) => run.id.length));
	// Built on every render, so spinners and running timers advance with each frame.
	return new SingleLines(() => {
		const now = Date.now();
		return runs.flatMap((stored, index) => {
			const current = details?.live && stored.key ? options.lookup?.(stored.key) : undefined;
			const run = current ?? stored;
			// A background subagent from an earlier pi process: its last stored state is stale, so do not spin.
			const detached = details?.background && !current && ["pending", "queued", "running"].includes(run.status);
			const row = rowFromRun(run, theme);
			let line = `${detached ? theme.fg("muted", "○") : statusIcon(row.status, theme)} `;
			if (multi) {
				const step = details?.mode === "chain" ? theme.fg("muted", `${run.step ?? index + 1}. `) : "";
				line += `${step}${theme.fg("accent", options.compact ? run.id : run.id.padEnd(nameWidth))}  `;
				if (options.compact)
					return [(index === 0 ? elbow : indent) + line + theme.fg("dim", run.description ?? "")];
				if (run.description) line += `${theme.fg("dim", run.description)} ${theme.fg("dim", "·")} `;
			}
			const status = detached ? theme.fg("muted", "Started in background") : describeRowStatus(row, theme, now);
			const lines = [(index === 0 ? elbow : indent) + line + status];
			const command = options.expanded ? latestToolCall(run.messages, theme) : undefined;
			// Align under the text after the status icon.
			if (command) lines.push(`${indent}  ${theme.fg("muted", "→ ")}${command}`);
			return lines;
		});
	});
}

interface WaitArgs {
	names?: string[];
	returnOnFirst?: boolean;
}

/**
 * `● Wait(any) · waiting for a subagent to finish`, then `· done waiting` once the wait returns. The argument is
 * the one target's name, or otherwise the mode: several named targets are listed in the rows below instead.
 */
export function renderWaitCall(args: WaitArgs, theme: Theme, state: CallState): Component {
	const single = args.names?.length === 1 ? args.names[0] : undefined;
	const mode = args.returnOnFirst ? "any" : "all";
	const target = single ? "it" : mode === "any" ? "a subagent" : "subagents";
	const summary = state.isPartial ? `· waiting for ${target} to finish` : "· done waiting";
	return renderCallLine("Wait", single ?? mode, summary, theme, state);
}

/**
 * Rows under a wait: only while it waits for two or more named targets, one compact row each with the status
 * icon, name, and description. A wait for all or any subagents would repeat the rows of the calls that started
 * them, a single target is named on the call line, and a finished wait is a single line. Errors are always shown.
 */
export function renderWaitResult(
	args: WaitArgs,
	details: SubagentToolDetails | undefined,
	fallbackText: string,
	options: {
		expanded: boolean;
		isError: boolean;
		isPartial: boolean;
		outputPad: number;
		lookup?: (key: string) => SubagentRunDetails | undefined;
	},
	theme: Theme,
): Component {
	if (!args.names || args.names.length < 2 || !options.isPartial) {
		return options.isError ? renderSubagentResult(undefined, fallbackText, options, theme) : new SingleLines([]);
	}
	// Always one row per name, even for a single target.
	const rows = details && { ...details, mode: "parallel" as const };
	return renderSubagentResult(rows, fallbackText, { ...options, compact: true }, theme);
}

/** `⎿  2 running · 1 queued · 3 done · 1 failed`: the counts behind a subagent list. */
export function renderListResult(details: SubagentToolDetails | undefined, outputPad: number, theme: Theme): Component {
	const runs = details?.results ?? [];
	const elbow = `${" ".repeat(outputPad)}  ${theme.fg("muted", "⎿")}  `;
	if (runs.length === 0) return new SingleLines([elbow + theme.fg("dim", "No subagents")]);
	const count = (statuses: Array<SubagentRunDetails["status"]>) =>
		runs.filter((run) => statuses.includes(run.status)).length;
	const parts = [
		[count(["running", "pending"]), "running"],
		[count(["queued"]), "queued"],
		[count(["done"]), "done"],
		[count(["failed", "aborted"]), "failed"],
	] as const;
	const text = parts
		.filter(([total]) => total > 0)
		.map(([total, label]) => `${total} ${label}`)
		.join(" · ");
	return new SingleLines([elbow + theme.fg("dim", text)]);
}

/** The message posted when background subagents finish: a `● Subagents finished` line with one row each. */
export function renderBackgroundNotice(
	results: SubagentRunDetails[],
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const isError = results.some(isFailedRun);
	const summary = `· ${results.length} in the background`;
	const container = new Container();
	container.addChild(
		renderCallLine("Subagents finished", undefined, summary, theme, {
			isPartial: false,
			isError,
			outputPad: options.outputPad,
		}),
	);
	container.addChild(renderSubagentResult({ mode: "parallel", results }, "", { ...options, isError }, theme));
	return container;
}
