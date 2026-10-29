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
import {
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatReadLineRange } from "../../core/tools/render-utils.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { AgentSource } from "./agents.ts";
import { BROADCAST, type ChatDelivery, type SendOutcome } from "./chat.ts";
import type { SubagentStatus, SubagentUsage } from "./child.ts";
import type { SkillSearchMatch } from "./skills.ts";

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
		case "paused":
			return theme.fg("warning", "‖");
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
		case "paused":
			return theme.fg("warning", "Paused") + suffix();
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
			const detached =
				details?.background && !current && ["pending", "queued", "running", "paused"].includes(run.status);
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
 * `● Waiting(any) · waiting for a subagent to finish`, then `· done waiting` once the wait returns. The argument is
 * the one target's name, or otherwise the mode: several named targets are listed in the rows below instead.
 */
export function renderWaitCall(args: WaitArgs, theme: Theme, state: CallState): Component {
	const single = args.names?.length === 1 ? args.names[0] : undefined;
	const mode = args.returnOnFirst ? "any" : "all";
	const target = single ? "it" : mode === "any" ? "a subagent" : "subagents";
	const summary = state.isPartial ? `· waiting for ${target} to finish` : "· done waiting";
	return renderCallLine("Waiting", single ?? mode, summary, theme, state);
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

interface ChatSendArgs {
	to?: string;
	text?: string;
	waitForReply?: boolean;
}

/** Wrapped lines a collapsed chat bubble shows; a longer message ends with a `… N more lines` line. */
const CHAT_PREVIEW_LINES = 6;

/** The room between the side pads, and the widest a bubble may be, so sent and received bubbles stay apart. */
function bubbleBounds(width: number, pad: number): { room: number; maxWidth: number } {
	const room = Math.max(1, width - pad * 2);
	return { room, maxWidth: Math.min(room, Math.max(24, Math.floor(room * 0.8))) };
}

export interface ChatBubbleSpec {
	/** `in` for a received message, drawn on the left; `out` for a sent one, drawn on the right. */
	direction: "in" | "out";
	/** The other agent: the sender of a received message, the recipient of a sent one. */
	peer: string;
	/** The agent whose transcript this is, or `all` for a received broadcast. */
	self: string;
	text: string;
	/** Text set into the bottom border, such as `waiting for your reply`. */
	footer?: string;
	/** Border and footer color. Defaults to `borderMuted` for received and `borderAccent` for sent messages. */
	color?: ThemeColor;
	/** Show every line; otherwise a long message is cut to `CHAT_PREVIEW_LINES`. */
	expanded: boolean;
	pad: number;
}

/**
 * A chat message in a rounded box: received ones on the left, sent ones on the right. The current agent is always
 * on the right of the label, so the arrow shows the direction:
 *
 *     ╭─ scout-a → orchestrator ──────────────╮
 *     │ Is the session token cached anywhere? │
 *     ╰────────────── waiting for your reply ─╯
 *                             ╭─ scout-a ← orchestrator ─╮
 *                             │ Yes, in src/cache.ts     │
 *                             ╰──────────────────────────╯
 */
export class ChatBubble implements Component {
	private readonly spec: ChatBubbleSpec | (() => ChatBubbleSpec);
	private readonly theme: Theme;

	/** `spec` as a function is read on every render, for a footer that follows live state. */
	constructor(spec: ChatBubbleSpec | (() => ChatBubbleSpec), theme: Theme) {
		this.spec = spec;
		this.theme = theme;
	}

	render(width: number): string[] {
		const spec = typeof this.spec === "function" ? this.spec() : this.spec;
		const theme = this.theme;
		const { room, maxWidth } = bubbleBounds(width, spec.pad);
		const color = spec.color ?? (spec.direction === "in" ? "borderMuted" : "borderAccent");
		const border = (text: string) => theme.fg(color, text);
		const name = (agent: string) => (agent === BROADCAST ? "everyone" : agent);
		const arrow = spec.direction === "in" ? "→" : "←";
		const label = `${theme.fg("accent", theme.bold(name(spec.peer)))} ${theme.fg("muted", `${arrow} ${name(spec.self)}`)}`;
		const maxInner = maxWidth - 4;
		let lines = wrapTextWithAnsi(spec.text.replace(/\t/g, "  ").trim(), Math.max(1, maxInner));
		if (!spec.expanded && lines.length > CHAT_PREVIEW_LINES) {
			const hidden = lines.length - (CHAT_PREVIEW_LINES - 1);
			lines = [...lines.slice(0, CHAT_PREVIEW_LINES - 1), theme.fg("dim", `… ${hidden} more lines`)];
		}
		// Too narrow for a box: the label, then the text.
		if (maxInner < 8) return [label, ...lines].map((line) => truncateToWidth(" ".repeat(spec.pad) + line, width));

		const footerWidth = spec.footer ? visibleWidth(spec.footer) : 0;
		const inner = Math.min(maxInner, Math.max(visibleWidth(label) + 2, footerWidth + 2, ...lines.map(visibleWidth)));
		const shownLabel = truncateToWidth(label, inner - 2);
		const top = border("╭─ ") + shownLabel + border(` ${"─".repeat(inner - 1 - visibleWidth(shownLabel))}╮`);
		const body = lines.map(
			(line) => `${border("│")} ${line}${" ".repeat(inner - visibleWidth(line))} ${border("│")}`,
		);
		const footer = spec.footer ? truncateToWidth(spec.footer, inner - 2) : undefined;
		const bottom = footer
			? border(`╰${"─".repeat(inner - 1 - visibleWidth(footer))} ${footer} ─╯`)
			: border(`╰${"─".repeat(inner + 2)}╯`);
		const indent = " ".repeat(spec.pad + (spec.direction === "out" ? room - (inner + 4) : 0));
		return [top, ...body, bottom].map((line) => indent + line);
	}

	invalidate(): void {}
}

/** Lines flush with the right edge of sent bubbles, for a send's outcome. */
class SentStatus implements Component {
	private readonly text: string;
	private readonly pad: number;

	constructor(text: string, pad: number) {
		this.text = text;
		this.pad = pad;
	}

	render(width: number): string[] {
		const { room, maxWidth } = bubbleBounds(width, this.pad);
		return wrapTextWithAnsi(this.text, maxWidth).map(
			(line) => " ".repeat(this.pad + Math.max(0, room - visibleWidth(line))) + line,
		);
	}

	invalidate(): void {}
}

/** A sent message as a bubble on the right, with `waiting for a reply` in its border while a reply wait runs. */
export function renderChatSendCall(
	args: ChatSendArgs,
	theme: Theme,
	state: CallState & { expanded: boolean; self: string },
): Component {
	return new ChatBubble(
		{
			direction: "out",
			peer: args.to ?? "...",
			self: state.self,
			text: args.text ?? "",
			footer: args.waitForReply && state.isPartial ? "waiting for a reply" : undefined,
			color: state.isError ? "error" : undefined,
			expanded: state.expanded,
			pad: state.outputPad,
		},
		theme,
	);
}

/** What a `chat_send` returned, from its text and details. */
export interface ChatSendOutcome {
	text: string;
	outcome?: SendOutcome;
	/** The reply, or the message that ended the wait. */
	message?: ChatDelivery;
}

/** `✓ delivered`, `◷ held until worker starts`, `✗ not sent: …`: how a send ended, under its bubble. */
function sendStatus(result: ChatSendOutcome, to: string, isError: boolean, theme: Theme): string {
	const status = (icon: string, color: ThemeColor, text: string) =>
		`${theme.fg(color, icon)} ${theme.fg("dim", text)}`;
	switch (result.outcome) {
		case "delivered":
		case "reply":
			return status("✓", "success", "delivered");
		case "held":
			return status("◷", "muted", `held until ${to} starts`);
		case "broadcast":
			return status("✓", "success", result.text.replace(/^Sent to everyone: /, "").replace(/\.$/, ""));
		case "interrupted":
			return status(
				"✓",
				"success",
				`delivered · stopped waiting, ${result.message?.from ?? "another agent"} wrote first`,
			);
		case "timeout":
			return status("✓", "success", "delivered · no reply in time");
		case "stopped":
			return status("!", "warning", "delivered · stopped waiting");
		default: {
			const reason = result.text.trim().replace(/\s+/g, " ");
			return isError ? theme.fg("error", `✗ not sent: ${reason}`) : theme.fg("dim", reason);
		}
	}
}

/**
 * The send's outcome on the right, under the sent bubble; then, when the wait returned a message (the reply, or
 * one that ended the wait), that message as a received bubble.
 */
export function renderChatSendResult(
	result: ChatSendOutcome,
	to: string,
	options: {
		expanded: boolean;
		isError: boolean;
		isPartial: boolean;
		outputPad: number;
		self: string;
		isAwaitingReply?: (id: string) => boolean;
	},
	theme: Theme,
): Component {
	const container = new Container();
	if (options.isPartial) return container;
	container.addChild(new SentStatus(sendStatus(result, to, options.isError, theme), options.outputPad));
	if (result.message) {
		container.addChild(new Spacer(1));
		container.addChild(renderChatMessage(result.message, options, theme));
	}
	return container;
}

/** One line of `ChatHub.peers`: `- name (description; agent): state`, `- orchestrator`, or `- all: ...`. */
interface PeerLine {
	name: string;
	description?: string;
	agent?: string;
	state?: string;
}

function parsePeerLine(line: string): PeerLine | undefined {
	const match = /^- ([^\s:(]+)(?: \((.*); ([^;]+)\))?(?:: (.*))?$/.exec(line);
	if (!match) return undefined;
	return { name: match[1], description: match[2], agent: match[3], state: match[4] };
}

/** `●` running, `◷` queued, `‖` paused, `○` finished; none for the orchestrator and `all`. */
function peerIcon(peer: PeerLine, theme: Theme): string {
	if (!peer.agent) return "";
	if (peer.state?.startsWith("running")) return `${theme.fg("accent", "●")} `;
	if (peer.state?.startsWith("queued")) return `${theme.fg("muted", "◷")} `;
	if (peer.state?.startsWith("paused")) return `${theme.fg("warning", "‖")} `;
	return `${theme.fg("dim", "○")} `;
}

/**
 * The agents `chat_peers` listed, each with its state icon: `⎿  orchestrator · ● alpha · ◷ bravo · all`. Expanded,
 * one row each with the subagent's description, agent, and state.
 */
export function renderChatPeersResult(
	text: string,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const pad = " ".repeat(options.outputPad);
	const elbow = `${pad}  ${theme.fg("muted", "⎿")}  `;
	const peers = text.split("\n").flatMap((line) => parsePeerLine(line) ?? []);
	if (peers.length === 0) {
		const none = text.includes("- no other subagents yet") ? "No other subagents yet" : text.split("\n")[0];
		return new SingleLines([elbow + theme.fg("dim", none ?? "")]);
	}
	const label = (peer: PeerLine) => peerIcon(peer, theme) + theme.fg(peer.agent ? "accent" : "toolOutput", peer.name);
	if (!options.expanded) return new SingleLines([elbow + peers.map(label).join(theme.fg("dim", " · "))]);

	const width = Math.max(...peers.map((peer) => peer.name.length + (peer.agent ? 2 : 0)));
	return new SingleLines(
		peers.map((peer, index) => {
			const about = peer.agent ? `${peer.description} · ${peer.agent} · ${peer.state}` : (peer.state ?? "");
			const gap = " ".repeat(width - peer.name.length - (peer.agent ? 2 : 0) + 2);
			return `${index === 0 ? elbow : `${pad}     `}${label(peer)}${gap}${theme.fg("dim", about)}`;
		}),
	);
}

interface SkillSearchArgs {
	query?: string;
	tags?: string[];
	limit?: number;
}

/** What `skill_search` returned, for its renderer. */
export interface SkillSearchDetails {
	matches: SkillSearchMatch[];
	/** Skills the agent has, matched or not. */
	available: number;
	/** Every tag of those skills, suggested when nothing matched. */
	tags: string[];
}

/** `● Search skills(path traversal) #security · up to 3`, or `● Search skills(all)` with neither a query nor tags. */
export function renderSkillSearchCall(args: SkillSearchArgs, theme: Theme, state: CallState): Component {
	const query = args.query?.trim();
	const tags = (args.tags ?? []).map((tag) => `#${tag}`).join(" ");
	const limit = args.limit !== undefined ? `· up to ${args.limit}` : "";
	const argument = query || (tags ? undefined : "all");
	return renderCallLine("Search skills", argument, [tags, limit].filter(Boolean).join(" "), theme, state);
}

/**
 * `⎿  2 matches · security-review, review-checklist`, or `⎿  No match · try #php #review`. Expanded, one row per
 * match with its description and tags.
 */
export function renderSkillSearchResult(
	details: SkillSearchDetails | undefined,
	fallbackText: string,
	options: { expanded: boolean; isError: boolean; outputPad: number },
	theme: Theme,
): Component {
	const pad = " ".repeat(options.outputPad);
	const elbow = `${pad}  ${theme.fg("muted", "⎿")}  `;
	const dim = (text: string) => theme.fg("dim", text);
	if (!details || options.isError) {
		return new SingleLines([elbow + theme.fg(options.isError ? "error" : "dim", fallbackText.split("\n")[0] ?? "")]);
	}
	if (details.available === 0) return new SingleLines([elbow + dim("No skills available")]);
	const matches = details.matches;
	if (matches.length === 0) {
		const hint = details.tags.length > 0 ? ` · try ${details.tags.map((tag) => `#${tag}`).join(" ")}` : "";
		return new SingleLines([elbow + theme.fg("warning", "No match") + dim(hint)]);
	}
	const count = `${matches.length} match${matches.length > 1 ? "es" : ""}`;
	if (!options.expanded) {
		const names = matches.map((match) => theme.fg("accent", match.name)).join(dim(", "));
		return new SingleLines([`${elbow}${dim(`${count} · `)}${names}`]);
	}
	const width = Math.max(...matches.map((match) => match.name.length));
	return new SingleLines([
		elbow + dim(count),
		...matches.map((match) => {
			const tags =
				match.tags.length > 0 ? ` ${theme.fg("muted", match.tags.map((tag) => `#${tag}`).join(" "))}` : "";
			return `${pad}     ${theme.fg("accent", match.name.padEnd(width))}  ${dim(match.description)}${tags}`;
		}),
	]);
}

/** What `load_skill` returned, for its renderer. */
export interface LoadSkillDetails {
	name: string;
	description: string;
	directory: string;
	/** Lines in the skill's body. */
	lines: number;
}

/** `● Load skill(security-review)`. */
export function renderLoadSkillCall(args: { name?: string }, theme: Theme, state: CallState): Component {
	return renderCallLine("Load skill", args.name || "...", "", theme, state);
}

/**
 * `⎿  42 lines · Review code for security issues`. Expanded, the skill's directory and its body follow. The body is
 * read back from the result text, which wraps it in a `<skill>` tag after one line of instructions.
 */
export function renderLoadSkillResult(
	details: LoadSkillDetails | undefined,
	text: string,
	options: { expanded: boolean; isError: boolean; outputPad: number },
	theme: Theme,
): Component {
	const pad = " ".repeat(options.outputPad);
	const elbow = `${pad}  ${theme.fg("muted", "⎿")}  `;
	if (!details || options.isError) {
		return new SingleLines([elbow + theme.fg(options.isError ? "error" : "dim", text.split("\n")[0] ?? "")]);
	}
	const summary = new SingleLines([
		`${elbow}${theme.fg("dim", `${details.lines} line${details.lines === 1 ? "" : "s"}`)}${details.description ? theme.fg("dim", ` · ${details.description}`) : ""}`,
	]);
	if (!options.expanded) return summary;
	const body = /^<skill[^>]*>\n[^\n]*\n\n([\s\S]*)\n<\/skill>$/.exec(text)?.[1] ?? text;
	const container = new Container();
	container.addChild(summary);
	container.addChild(new SingleLines([`${pad}     ${theme.fg("muted", shortenPath(details.directory))}`]));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("toolOutput", body), options.outputPad + 5, 0));
	return container;
}

/**
 * A received message as a bubble on the left. When the sender is waiting for a reply, the border says so: in the
 * warning color while the sender is still blocked, as `isAwaitingReply` reports, dim once it no longer is.
 */
export function renderChatMessage(
	delivery: ChatDelivery,
	options: { expanded: boolean; outputPad: number; self: string; isAwaitingReply?: (id: string) => boolean },
	theme: Theme,
): Component {
	return new ChatBubble(() => {
		const waiting = delivery.awaitingReply && options.isAwaitingReply?.(delivery.id) === true;
		return {
			direction: "in",
			peer: delivery.from,
			self: delivery.to === BROADCAST ? BROADCAST : options.self,
			text: delivery.text,
			footer: waiting ? "waiting for your reply" : delivery.awaitingReply ? "asked for a reply" : undefined,
			color: waiting ? "warning" : undefined,
			expanded: options.expanded,
			pad: options.outputPad,
		};
	}, theme);
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
		[count(["paused"]), "paused"],
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
