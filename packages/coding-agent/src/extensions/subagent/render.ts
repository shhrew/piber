/**
 * Transcript rendering for the `subagent` tool.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatReadLineRange } from "../../core/tools/render-utils.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentSource } from "./agents.ts";
import type { SubagentStatus, SubagentUsage } from "./child.ts";

const COLLAPSED_ITEM_COUNT = 10;

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
}

export interface SubagentToolDetails {
	mode: "single" | "parallel" | "chain";
	results: SubagentRunDetails[];
}

type ThemeFg = Theme["fg"];
type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function isFailedRun(run: SubagentRunDetails): boolean {
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

function getDisplayItems(messages: readonly Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

function statusIcon(run: SubagentRunDetails, theme: Theme): string {
	if (run.status === "queued") return theme.fg("muted", "◷");
	if (run.status === "running" || run.status === "pending") return theme.fg("accent", spinnerFrame());
	return isFailedRun(run) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function aggregateUsage(runs: readonly SubagentRunDetails[]): Partial<SubagentUsage> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const run of runs) {
		total.input += run.usage.input;
		total.output += run.usage.output;
		total.cacheRead += run.usage.cacheRead;
		total.cacheWrite += run.usage.cacheWrite;
		total.cost += run.usage.cost;
		total.turns += run.usage.turns;
	}
	return total;
}

function renderDisplayItems(items: DisplayItem[], theme: Theme, expanded: boolean, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function runHeader(run: SubagentRunDetails, theme: Theme): string {
	let header = `${statusIcon(run, theme)} ${theme.fg("toolTitle", theme.bold(run.id))}`;
	if (run.description) header += ` ${theme.fg("dim", run.description)}`;
	header += theme.fg("muted", ` (${run.agent}, ${run.agentSource})`);
	if (isFailedRun(run)) header += ` ${theme.fg("error", `[${run.stopReason ?? run.status}]`)}`;
	return header;
}

/** A run's tool calls, final output as Markdown, and usage. */
function addExpandedRun(container: Container, run: SubagentRunDetails, theme: Theme): void {
	if (run.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${run.errorMessage}`), 0, 0));
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", run.task), 0, 0));
	for (const item of getDisplayItems(run.messages)) {
		if (item.type !== "toolCall") continue;
		container.addChild(
			new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
		);
	}
	const finalOutput = getFinalOutput(run.messages);
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
	}
	const usage = formatUsageStats(run.usage, run.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	if (run.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${shortenPath(run.sessionFile)}`), 0, 0));
}

function collapsedRun(run: SubagentRunDetails, theme: Theme, limit: number): string {
	const items = getDisplayItems(run.messages);
	if (run.errorMessage && isFailedRun(run)) return theme.fg("error", `Error: ${run.errorMessage}`);
	if (run.status === "queued") return theme.fg("muted", "(queued, waiting for a free slot)");
	if (items.length === 0) return theme.fg("muted", run.status === "running" ? "(running...)" : "(no output)");
	return renderDisplayItems(items, theme, false, limit);
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
}

export function renderSubagentCall(args: SubagentCallArgs, theme: Theme): Component {
	const preview = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}...` : text);
	const title = theme.fg("toolTitle", theme.bold("subagent "));
	const steps = args.chain ?? args.tasks;
	if (steps && steps.length > 0) {
		const label = args.chain ? `chain (${steps.length} steps)` : `parallel (${steps.length} tasks)`;
		let text = title + theme.fg("accent", label);
		steps.slice(0, 3).forEach((step, index) => {
			const summary = step.description ?? preview(step.task.replace(/\{previous\}/g, "").trim(), 40);
			const prefix = args.chain ? `${theme.fg("muted", `${index + 1}.`)} ` : "";
			text += `\n  ${prefix}${theme.fg("accent", step.name ?? step.agent)}${theme.fg("dim", ` ${summary}`)}`;
		});
		if (steps.length > 3) text += `\n  ${theme.fg("muted", `... +${steps.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	let text = title + theme.fg("accent", args.session ?? args.name ?? args.agent ?? "...");
	if (args.session) text += theme.fg("muted", " (continue)");
	else if (args.agent) text += theme.fg("muted", ` (${args.agent})`);
	text += `\n  ${theme.fg("dim", args.description ?? (args.task ? preview(args.task, 60) : "..."))}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	details: SubagentToolDetails | undefined,
	fallbackText: string,
	expanded: boolean,
	theme: Theme,
): Component {
	if (!details || details.results.length === 0) return new Text(fallbackText || "(no output)", 0, 0);
	const runs = details.results;
	const hint = `\n${theme.fg("muted", "(Ctrl+O to expand, ←← for the agent view)")}`;

	if (details.mode === "single") {
		const run = runs[0];
		if (expanded) {
			const container = new Container();
			container.addChild(new Text(runHeader(run, theme), 0, 0));
			addExpandedRun(container, run, theme);
			return container;
		}
		let text = `${runHeader(run, theme)}\n${collapsedRun(run, theme, COLLAPSED_ITEM_COUNT)}`;
		const usage = formatUsageStats(run.usage, run.model);
		if (usage) text += `\n${theme.fg("dim", usage)}`;
		return new Text(text + hint, 0, 0);
	}

	const queued = runs.filter((run) => run.status === "queued").length;
	const running = runs.filter((run) => run.status === "running" || run.status === "pending").length;
	const failed = runs.filter(isFailedRun).length;
	const succeeded = runs.length - queued - running - failed;
	const icon =
		running + queued > 0
			? theme.fg("accent", spinnerFrame())
			: failed > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
	const status =
		details.mode === "chain"
			? `${succeeded}/${runs.length} steps`
			: running + queued > 0
				? `${succeeded + failed}/${runs.length} done, ${running} running${queued > 0 ? `, ${queued} queued` : ""}`
				: `${succeeded}/${runs.length} tasks`;
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(`${details.mode} `))}${theme.fg("accent", status)}`;
	const label = (run: SubagentRunDetails) =>
		`${theme.fg("muted", details.mode === "chain" ? `─── Step ${run.step}: ` : "─── ")}${runHeader(run, theme)}`;

	if (expanded && running === 0) {
		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		for (const run of runs) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(label(run), 0, 0));
			addExpandedRun(container, run, theme);
		}
		const usage = formatUsageStats(aggregateUsage(runs));
		if (usage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
		}
		return container;
	}

	let text = header;
	for (const run of runs) text += `\n\n${label(run)}\n${collapsedRun(run, theme, 5)}`;
	if (running === 0) {
		const usage = formatUsageStats(aggregateUsage(runs));
		if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
	}
	return new Text(text + hint, 0, 0);
}
