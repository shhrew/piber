/**
 * The agent view: a full-screen overlay listing the main session and its subagents.
 *
 * List: up/down select, Enter opens, Esc or the agent-view double press closes.
 * Subagent: live transcript with an input line. Enter steers a running subagent or starts a follow-up
 * run on an idle one; Esc aborts a running subagent or returns to the list; the agent-view double press
 * returns to the list.
 *
 * The transcript scrolls like the fullscreen transcript: the `tui.altScreen.*` page, half-page, line,
 * top, and bottom keys and the mouse wheel. It follows new output until scrolled up, then holds its
 * position. The scrollbar follows the `fullscreenScrollbar` setting.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	type Component,
	Input,
	type Keybinding,
	type KeybindingsManager,
	type ScrollViewScrollbar,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { allToolNames, createToolDefinition, type ToolName } from "../../core/tools/index.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { Subagent } from "./child.ts";
import type { SubagentRegistry } from "./registry.ts";
import { formatUsageStats, SPINNER_INTERVAL_MS, spinnerFrame } from "./render.ts";

/** Two presses of the agent-view key within this many milliseconds open or leave the view. */
export const DOUBLE_PRESS_MS = 400;

/** Lines kept from the previous page when paging, as in the fullscreen transcript. */
const PAGE_SCROLL_OVERLAP = 4;
/** How long an `auto` scrollbar stays visible after scrolling. */
const SCROLLBAR_HIDE_DELAY_MS = 1000;

/** Scroll position of a transcript that follows its end until scrolled up. */
export class TranscriptScroll {
	/** First visible line, or undefined while following the end. */
	private top: number | undefined;
	private maxTop = 0;
	private lastActivity = 0;
	viewportHeight = 0;

	/** Fit `totalLines` into `viewportHeight` rows and return the first visible line. */
	layout(totalLines: number, viewportHeight: number): number {
		this.viewportHeight = viewportHeight;
		this.maxTop = Math.max(0, totalLines - viewportHeight);
		const top = Math.min(this.top ?? this.maxTop, this.maxTop);
		this.top = top >= this.maxTop ? undefined : top;
		return top;
	}

	/** Positive values scroll toward the end. Reaching the end resumes following it. */
	scrollBy(lines: number): void {
		const next = Math.max(0, Math.min(this.maxTop, (this.top ?? this.maxTop) + lines));
		this.top = next >= this.maxTop ? undefined : next;
		this.lastActivity = Date.now();
	}

	scrollToTop(): void {
		this.top = this.maxTop > 0 ? 0 : undefined;
		this.lastActivity = Date.now();
	}

	scrollToBottom(): void {
		this.top = undefined;
		this.lastActivity = Date.now();
	}

	get linesBelow(): number {
		return this.top === undefined ? 0 : this.maxTop - this.top;
	}

	get recentlyScrolled(): boolean {
		return Date.now() - this.lastActivity < SCROLLBAR_HIDE_DELAY_MS;
	}
}

/** Tracks presses of `app.agents.view` and reports the second press of a quick pair. */
export class DoublePressDetector {
	private lastPress = 0;

	/** True when `data` is the agent-view key and completes a double press. */
	isDoublePress(data: string, keybindings: KeybindingsManager): boolean {
		if (!keybindings.matches(data, "app.agents.view")) {
			this.lastPress = 0;
			return false;
		}
		const now = Date.now();
		if (now - this.lastPress <= DOUBLE_PRESS_MS) {
			this.lastPress = 0;
			return true;
		}
		this.lastPress = now;
		return false;
	}
}

function statusIcon(subagent: Subagent, theme: Theme): string {
	switch (subagent.status) {
		case "queued":
			return theme.fg("muted", "◷");
		case "running":
			return theme.fg("accent", spinnerFrame());
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("error", "✗");
	}
}

interface ListSection {
	title: string;
	subagents: Subagent[];
}

/** The list's sections below the main session, in display order, leaving out empty ones. */
function listSections(subagents: readonly Subagent[]): ListSection[] {
	return [
		{ title: "In progress", subagents: subagents.filter((subagent) => subagent.isRunning) },
		{ title: "Queued", subagents: subagents.filter((subagent) => subagent.isQueued) },
		{ title: "Completed", subagents: subagents.filter((subagent) => !subagent.isRunning && !subagent.isQueued) },
	].filter((section) => section.subagents.length > 0);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export interface AgentViewOptions {
	cwd: string;
	scrollbar: ScrollViewScrollbar;
	/** Id of the subagent to select first. Undefined, or an id no longer listed, selects the main session. */
	initialSelection?: string;
	/** Called when the user opens a session: a subagent id, or undefined for the main session. */
	onOpen: (id: string | undefined) => void;
	close: () => void;
}

function userText(message: Extract<Message, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

export class AgentView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly registry: SubagentRegistry;
	private readonly cwd: string;
	private readonly close: () => void;
	private readonly onOpen: (id: string | undefined) => void;
	private readonly scrollbar: ScrollViewScrollbar;
	private readonly scroll = new TranscriptScroll();
	private scrollbarTimer: NodeJS.Timeout | undefined;
	private readonly doublePress = new DoublePressDetector();
	private readonly input = new Input({ prompt: "› " });
	private readonly unsubscribe: () => void;
	/** Redraws running subagents' spinners. */
	private readonly animation: NodeJS.Timeout;
	/**
	 * The selected list row: a subagent id, or undefined for the main session. An id rather than a position, so
	 * the selection stays on a subagent as it moves between sections.
	 */
	private selectedId: string | undefined;
	private open: Subagent | undefined;
	/** Status line above the input. Info notices show only while the subagent runs; errors stay until the next action. */
	private notice: { text: string; isError: boolean } | undefined;
	private transcript: { subagent: Subagent; count: number; components: Component[] } | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		registry: SubagentRegistry,
		options: AgentViewOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.registry = registry;
		this.cwd = options.cwd;
		this.close = options.close;
		this.onOpen = options.onOpen;
		this.scrollbar = options.scrollbar;
		this.input.focused = true;
		this.input.onSubmit = (value) => this.submit(value);
		this.unsubscribe = registry.onChange(() => this.tui.requestRender());
		this.animation = setInterval(() => {
			if (this.registry.list().some((subagent) => subagent.isRunning)) this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.animation.unref();
		// Start where the user last was, so switching between sessions takes one or two keys.
		const initial = options.initialSelection;
		this.selectedId = initial !== undefined && registry.find(initial) ? initial : undefined;
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.animation);
		if (this.scrollbarTimer) clearTimeout(this.scrollbarTimer);
	}

	invalidate(): void {
		this.transcript = undefined;
	}

	handleInput(data: string): void {
		if (this.open) this.handleSessionInput(data, this.open);
		else this.handleListInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		if (this.open) {
			this.scrollTranscript(() => this.scroll.scrollBy(event.wheelDelta ?? 0));
		} else {
			this.moveSelection(Math.sign(event.wheelDelta), false);
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const height = Math.max(5, this.tui.terminal.rows);
		const lines = this.open ? this.renderSession(width, height, this.open) : this.renderList(width, height);
		while (lines.length < height) lines.push("");
		return lines.slice(0, height).map((line) => truncateToWidth(line, width));
	}

	/** Selectable rows in display order: the main session, then each section's subagents. Headers are not rows. */
	private selectableIds(): Array<string | undefined> {
		return [
			undefined,
			...listSections(this.registry.list()).flatMap((section) => section.subagents.map((s) => s.id)),
		];
	}

	/** Move the selection by `delta` rows, wrapping around at the ends for the keyboard but not the wheel. */
	private moveSelection(delta: number, wrap: boolean): void {
		const ids = this.selectableIds();
		const current = Math.max(0, ids.indexOf(this.selectedId));
		const next = wrap
			? (current + delta + ids.length) % ids.length
			: Math.max(0, Math.min(ids.length - 1, current + delta));
		this.selectedId = ids[next];
	}

	private handleListInput(data: string): void {
		const kb = this.keybindings;
		if (this.doublePress.isDoublePress(data, kb) || kb.matches(data, "tui.select.cancel")) {
			this.close();
		} else if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1, true);
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1, true);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const subagent = this.selectedId === undefined ? undefined : this.registry.find(this.selectedId);
			this.onOpen(subagent?.id);
			if (!subagent) {
				this.close();
				return;
			}
			this.open = subagent;
			this.scroll.scrollToBottom();
			this.notice = undefined;
			this.input.setValue("");
		}
	}

	private handleSessionInput(data: string, subagent: Subagent): void {
		const kb = this.keybindings;
		if (this.input.getValue() === "" && this.doublePress.isDoublePress(data, kb)) {
			this.backToList();
			return;
		}
		if (kb.matches(data, "app.interrupt")) {
			if (subagent.isRunning || subagent.isQueued) void subagent.abort();
			else this.backToList();
			return;
		}
		const page = Math.max(1, this.scroll.viewportHeight - PAGE_SCROLL_OVERLAP);
		const halfPage = Math.max(1, Math.floor(this.scroll.viewportHeight / 2));
		const steps: Array<[Keybinding, number]> = [
			["tui.altScreen.pageUp", -page],
			["tui.altScreen.pageDown", page],
			["tui.altScreen.halfPageUp", -halfPage],
			["tui.altScreen.halfPageDown", halfPage],
			["tui.altScreen.lineUp", -1],
			["tui.altScreen.lineDown", 1],
		];
		for (const [keybinding, lines] of steps) {
			if (kb.matches(data, keybinding)) {
				this.scrollTranscript(() => this.scroll.scrollBy(lines));
				return;
			}
		}
		if (kb.matches(data, "tui.altScreen.top")) {
			this.scrollTranscript(() => this.scroll.scrollToTop());
			return;
		}
		if (kb.matches(data, "tui.altScreen.bottom")) {
			this.scrollTranscript(() => this.scroll.scrollToBottom());
			return;
		}
		this.input.handleInput(data);
	}

	/** Apply a scroll and, for an `auto` scrollbar, render again once it should hide. */
	private scrollTranscript(apply: () => void): void {
		apply();
		if (this.scrollbar !== "auto") return;
		if (this.scrollbarTimer) clearTimeout(this.scrollbarTimer);
		this.scrollbarTimer = setTimeout(() => {
			this.scrollbarTimer = undefined;
			this.tui.requestRender();
		}, SCROLLBAR_HIDE_DELAY_MS);
		this.scrollbarTimer.unref();
	}

	private backToList(): void {
		this.open = undefined;
		this.transcript = undefined;
		this.notice = undefined;
	}

	private submit(value: string): void {
		const subagent = this.open;
		const text = value.trim();
		if (!subagent || !text) return;
		this.input.setValue("");
		this.scroll.scrollToBottom();
		this.notice = { text: subagent.isRunning ? "Steering message sent" : "Follow-up started", isError: false };
		subagent.send(text).catch((error: unknown) => {
			this.notice = { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
			this.tui.requestRender();
		});
	}

	private renderList(width: number, height: number): string[] {
		const theme = this.theme;
		const subagents = this.registry.list();
		const title = [
			theme.fg("accent", theme.bold(" Agents")),
			theme.fg("dim", " ↑↓ select · enter open · esc close"),
			"",
		];
		const lines: string[] = [];
		let selectedLine = 0;
		const row = (id: string | undefined, text: string) => {
			const selected = id === this.selectedId;
			if (selected) selectedLine = lines.length;
			return (selected ? theme.fg("accent", "› ") : "  ") + (selected ? theme.bold(text) : text);
		};
		lines.push(row(undefined, `${theme.fg("success", "●")} main session`));
		for (const section of listSections(subagents)) {
			lines.push(
				"",
				theme.fg("muted", theme.bold(` ${section.title}`)) + theme.fg("dim", ` ${section.subagents.length}`),
			);
			for (const subagent of section.subagents) {
				const usage = formatUsageStats(subagent.usage);
				let text = `${statusIcon(subagent, theme)} ${theme.fg("accent", subagent.id)}`;
				text += ` ${oneLine(subagent.options.description)}`;
				text += theme.fg("muted", ` (${subagent.options.agentName})`);
				const line = row(subagent.id, text);
				const suffix = usage ? `  ${theme.fg("dim", usage)}` : "";
				const room = width - visibleWidth(suffix);
				lines.push(room > 20 ? truncateToWidth(line, room) + suffix : line);
			}
		}
		if (subagents.length === 0) lines.push("", theme.fg("muted", "  No subagents in this session yet."));
		// In a long list, scroll the rows below the title so the selected one stays visible.
		const rows = Math.max(1, height - title.length);
		const start = Math.max(0, Math.min(selectedLine - rows + 1, lines.length - rows));
		return [...title, ...lines.slice(start, start + rows)];
	}

	private renderSession(width: number, height: number, subagent: Subagent): string[] {
		const theme = this.theme;
		const status = subagent.isRunning ? "running" : subagent.status;
		const header = [
			`${statusIcon(subagent, theme)} ${theme.fg("accent", theme.bold(subagent.id))} ${subagent.options.description}${theme.fg("muted", ` (${subagent.options.agentName}) · ${status}`)}  ${theme.fg("dim", formatUsageStats(subagent.usage, subagent.model))}`,
			theme.fg("dim", subagent.sessionFile ? `session: ${subagent.sessionFile}` : "no session file"),
		];
		const below = this.scroll.linesBelow;
		const hint = [
			subagent.isQueued
				? "waiting for a free slot · esc cancel · ←← agents"
				: subagent.isRunning
					? "enter steer · esc abort · ←← agents"
					: "enter follow up · esc agents",
			"pgup/pgdn/wheel scroll",
			...(below > 0 ? [`↓ ${below} more`] : []),
		].join(" · ");
		const footer = [
			...(this.notice && (this.notice.isError || subagent.isRunning)
				? [theme.fg(this.notice.isError ? "error" : "dim", this.notice.text)]
				: []),
			...this.input.render(width),
			theme.fg("dim", hint),
		];
		const bodyHeight = Math.max(1, height - header.length - footer.length - 1);
		// Keep a column for the scrollbar unless it is hidden, so lines do not reflow when it appears.
		const bodyWidth = this.scrollbar === "hidden" || width < 2 ? width : width - 1;
		const body = this.renderTranscript(bodyWidth, subagent);
		const top = this.scroll.layout(body.length, bodyHeight);
		const visible = body.slice(top, top + bodyHeight);
		// Short transcripts sit at the bottom, next to the input, like the main transcript.
		while (visible.length < bodyHeight) visible.unshift("");
		const bar = this.renderScrollbar(body.length, bodyHeight, top);
		const rows = bar
			? visible.map(
					(line, index) =>
						`${truncateToWidth(line, bodyWidth)}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(line)))}${bar[index]}`,
				)
			: visible;
		return [...header, ...rows, theme.fg("borderMuted", "─".repeat(width)), ...footer];
	}

	/** One scrollbar cell per body row, or undefined when no scrollbar shows. Geometry matches the fullscreen one. */
	private renderScrollbar(totalLines: number, trackHeight: number, top: number): string[] | undefined {
		if (this.scrollbar === "hidden") return undefined;
		const overflows = totalLines > trackHeight;
		if (this.scrollbar === "auto" && !(overflows && this.scroll.recentlyScrolled)) return undefined;
		if (!overflows) return new Array(trackHeight).fill(this.theme.fg("scrollbarTrack", "│"));
		const thumbHeight = Math.max(
			Math.min(2, trackHeight),
			Math.min(trackHeight, Math.round((trackHeight * trackHeight) / totalLines)),
		);
		const maxTop = totalLines - trackHeight;
		const thumbTop = Math.round((top / maxTop) * (trackHeight - thumbHeight));
		return Array.from({ length: trackHeight }, (_, row) =>
			row >= thumbTop && row < thumbTop + thumbHeight
				? this.theme.fg("scrollbarThumb", "┃")
				: this.theme.fg("scrollbarTrack", "│"),
		);
	}

	private renderTranscript(width: number, subagent: Subagent): string[] {
		if (this.transcript?.subagent !== subagent || this.transcript.count !== subagent.messages.length) {
			this.transcript = {
				subagent,
				count: subagent.messages.length,
				components: this.buildComponents(subagent.messages),
			};
		}
		const components = [...this.transcript.components];
		if (subagent.streaming) components.push(new AssistantMessageComponent(subagent.streaming));
		return components.flatMap((component) => component.render(width));
	}

	private buildComponents(messages: readonly Message[]): Component[] {
		const components: Component[] = [];
		const toolCalls = new Map<string, ToolExecutionComponent>();
		for (const message of messages) {
			if (message.role === "user") {
				components.push(new UserMessageComponent(userText(message)));
			} else if (message.role === "assistant") {
				components.push(new AssistantMessageComponent(message));
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const definition = allToolNames.has(part.name as ToolName)
						? createToolDefinition(part.name as ToolName, this.cwd)
						: undefined;
					const component = new ToolExecutionComponent(
						part.name,
						part.id,
						part.arguments,
						{},
						definition,
						this.tui,
						this.cwd,
					);
					component.setArgsComplete();
					component.markExecutionStarted();
					toolCalls.set(part.id, component);
					components.push(component);
				}
			} else if (message.role === "toolResult") {
				toolCalls.get(message.toolCallId)?.updateResult({
					content: message.content,
					details: message.details,
					isError: message.isError,
				});
			}
		}
		return components;
	}
}
