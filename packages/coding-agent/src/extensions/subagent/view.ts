/**
 * The agent view: a full-screen overlay with two tabs, Agents and Chat.
 *
 * Agents: the main session and its subagents. Up/down select, Enter opens, the chat-tab key shows Chat, Esc or
 * the agent-view key closes.
 * Chat: every chat message in the session, one compact entry each, scrolled like a transcript. The agent-view
 * key returns to Agents; Esc closes.
 * Subagent: live transcript with an input line. Enter steers a running subagent or starts a follow-up
 * run on an idle one; Esc aborts a running subagent or goes back; the agent-view key goes back. Back is
 * the list, or the main session when the subagent was opened from the dock.
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
	Spacer,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { allToolNames, createToolDefinition, type ToolName } from "../../core/tools/index.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { CHAT_SEND_TOOL_NAME, type ChatDelivery, type ChatLog, type ChatLogEntry, type SendOutcome } from "./chat.ts";
import type { Subagent } from "./child.ts";
import type { SubagentRegistry } from "./registry.ts";
import {
	formatUsageStats,
	renderChatMessage,
	renderChatSendCall,
	renderChatSendResult,
	SPINNER_INTERVAL_MS,
	statusIcon,
} from "./render.ts";

type Tab = "agents" | "chat";

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

/** Local time as HH:MM. */
function clockTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface AgentViewOptions {
	cwd: string;
	scrollbar: ScrollViewScrollbar;
	/** Id of the subagent to select first. Undefined, or an id no longer listed, selects the main session. */
	initialSelection?: string;
	/** Id of a subagent to open straight away, as when chosen from the dock under the composer. */
	openId?: string;
	/** Called when the user opens a session: a subagent id, or undefined for the main session. */
	onOpen: (id: string | undefined) => void;
	close: () => void;
	/** Whether a chat message's sender is still blocked waiting for its reply. */
	isAwaitingReply?: (id: string) => boolean;
	/** The session's chat messages, for the Chat tab. */
	chatLog?: ChatLog;
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
	private readonly isAwaitingReply: ((id: string) => boolean) | undefined;
	private readonly scrollbar: ScrollViewScrollbar;
	private readonly scroll = new TranscriptScroll();
	private readonly chatLog: ChatLog | undefined;
	private readonly chatScroll = new TranscriptScroll();
	private tab: Tab = "agents";
	private scrollbarTimer: NodeJS.Timeout | undefined;
	/** Opened straight onto a subagent, as from the dock: going back closes the view instead of showing the list. */
	private readonly openedDirectly: boolean;
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
		this.isAwaitingReply = options.isAwaitingReply;
		this.scrollbar = options.scrollbar;
		this.input.focused = true;
		this.input.onSubmit = (value) => this.submit(value);
		this.chatLog = options.chatLog;
		const stopRegistry = registry.onChange(() => this.tui.requestRender());
		const stopChat = this.chatLog?.onChange(() => this.tui.requestRender());
		this.unsubscribe = () => {
			stopRegistry();
			stopChat?.();
		};
		this.animation = setInterval(() => {
			if (this.registry.list().some((subagent) => subagent.isRunning)) this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.animation.unref();
		// Start where the user last was, so switching between sessions takes one or two keys.
		const initial = options.openId ?? options.initialSelection;
		this.selectedId = initial !== undefined && registry.find(initial) ? initial : undefined;
		this.open = options.openId === undefined ? undefined : registry.find(options.openId);
		this.openedDirectly = this.open !== undefined;
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
		else if (this.tab === "chat") this.handleChatInput(data);
		else this.handleListInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		if (this.open) {
			this.scrollTranscript(() => this.scroll.scrollBy(event.wheelDelta ?? 0));
		} else if (this.tab === "chat") {
			this.scrollTranscript(() => this.chatScroll.scrollBy(event.wheelDelta ?? 0));
		} else {
			this.moveSelection(Math.sign(event.wheelDelta), false);
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const height = Math.max(5, this.tui.terminal.rows);
		const lines = this.open
			? this.renderSession(width, height, this.open)
			: this.tab === "chat"
				? this.renderChat(width, height)
				: this.renderList(width, height);
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
		if (kb.matches(data, "app.agents.view") || kb.matches(data, "tui.select.cancel")) {
			this.close();
		} else if (kb.matches(data, "app.agents.chat")) {
			this.tab = "chat";
			this.chatScroll.scrollToBottom();
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
		if (this.input.getValue() === "" && kb.matches(data, "app.agents.view")) {
			this.back();
			return;
		}
		if (kb.matches(data, "app.interrupt")) {
			if (subagent.isRunning || subagent.isQueued) void subagent.abort();
			else this.back();
			return;
		}
		if (this.handleScrollKey(data, this.scroll)) return;
		this.input.handleInput(data);
	}

	private handleChatInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "app.agents.view")) this.tab = "agents";
		else if (kb.matches(data, "tui.select.cancel")) this.close();
		else this.handleScrollKey(data, this.chatScroll);
	}

	/** Scroll `scroll` for the `tui.altScreen.*` keys. False when `data` is not one of them. */
	private handleScrollKey(data: string, scroll: TranscriptScroll): boolean {
		const kb = this.keybindings;
		const page = Math.max(1, scroll.viewportHeight - PAGE_SCROLL_OVERLAP);
		const halfPage = Math.max(1, Math.floor(scroll.viewportHeight / 2));
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
				this.scrollTranscript(() => scroll.scrollBy(lines));
				return true;
			}
		}
		if (kb.matches(data, "tui.altScreen.top")) {
			this.scrollTranscript(() => scroll.scrollToTop());
			return true;
		}
		if (kb.matches(data, "tui.altScreen.bottom")) {
			this.scrollTranscript(() => scroll.scrollToBottom());
			return true;
		}
		return false;
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

	/** Leave the open subagent: to the main session when it was opened directly, otherwise to the list. */
	private back(): void {
		if (this.openedDirectly) {
			this.close();
			return;
		}
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

	/** The tab bar with the active tab highlighted, the tab's key hint, and a blank line. */
	private renderTitle(hint: string): string[] {
		const theme = this.theme;
		const tab = (name: Tab, label: string) =>
			name === this.tab ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
		const count = this.chatLog?.entries().length ?? 0;
		const chat = tab("chat", "Chat") + (count > 0 ? theme.fg("dim", ` ${count}`) : "");
		return [` ${tab("agents", "Agents")}   ${chat}`, theme.fg("dim", ` ${hint}`), ""];
	}

	private renderList(width: number, height: number): string[] {
		const theme = this.theme;
		const subagents = this.registry.list();
		const title = this.renderTitle("↑↓ select · enter open · → chat · esc close");
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
				let text = `${statusIcon(subagent.isRunning ? "running" : subagent.status, theme)} ${theme.fg("accent", subagent.id)}`;
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
			`${statusIcon(subagent.isRunning ? "running" : subagent.status, theme)} ${theme.fg("accent", theme.bold(subagent.id))} ${subagent.options.description}${theme.fg("muted", ` (${subagent.options.agentName}) · ${status}`)}  ${theme.fg("dim", formatUsageStats(subagent.usage, subagent.model))}`,
			theme.fg("dim", subagent.sessionFile ? `session: ${subagent.sessionFile}` : "no session file"),
		];
		const below = this.scroll.linesBelow;
		const back = this.openedDirectly ? "main" : "agents";
		const hint = [
			subagent.isQueued
				? `waiting for a free slot · esc cancel · ← ${back}`
				: subagent.isRunning
					? `enter steer · esc abort · ← ${back}`
					: `enter follow up · esc ${back}`,
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
		const rows = this.withScrollbar(visible, bodyWidth, body.length, top, this.scroll);
		return [...header, ...rows, theme.fg("borderMuted", "─".repeat(width)), ...footer];
	}

	private renderChat(width: number, height: number): string[] {
		const entries = this.chatLog?.entries() ?? [];
		const bodyWidth = this.scrollbar === "hidden" || width < 2 ? width : width - 1;
		const body =
			entries.length === 0
				? [this.theme.fg("muted", "  No chat messages in this session yet.")]
				: this.renderChatEntries(entries, bodyWidth);
		const below = this.chatScroll.linesBelow;
		const title = this.renderTitle(
			["← agents · pgup/pgdn/wheel scroll · esc close", ...(below > 0 ? [`↓ ${below} more`] : [])].join(" · "),
		);
		const bodyHeight = Math.max(1, height - title.length);
		const top = this.chatScroll.layout(body.length, bodyHeight);
		const visible = body.slice(top, top + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		return [...title, ...this.withScrollbar(visible, bodyWidth, body.length, top, this.chatScroll)];
	}

	/**
	 * One entry per send: ` HH:MM M from → to  text`, the text wrapped under its own column. The marker M is `?`
	 * while the sender waits for a reply, `~` while a recipient that has not started holds it, `x` when refused.
	 */
	private renderChatEntries(entries: readonly ChatLogEntry[], width: number): string[] {
		const theme = this.theme;
		const routeWidth = Math.min(
			Math.max(8, Math.floor(width / 3)),
			Math.max(...entries.map((entry) => visibleWidth(`${entry.from} → ${entry.to}`))),
		);
		// " HH:MM M " before the route, two spaces after it.
		const textColumn = 9 + routeWidth + 2;
		const textWidth = Math.max(10, width - textColumn);
		const indent = " ".repeat(textColumn);
		return entries.flatMap((entry) => {
			const marker = entry.refused
				? theme.fg("error", "x")
				: this.isAwaitingReply?.(entry.id)
					? theme.fg("warning", "?")
					: entry.held > 0
						? theme.fg("muted", "~")
						: " ";
			const route = truncateToWidth(
				`${theme.fg("accent", entry.from)} ${theme.fg("dim", "→")} ${theme.fg("accent", entry.to)}`,
				routeWidth,
			);
			const padding = " ".repeat(Math.max(0, routeWidth - visibleWidth(route)));
			const text = entry.refused ? theme.fg("error", entry.refused) : oneLine(entry.text);
			const [first = "", ...rest] = wrapTextWithAnsi(text, textWidth);
			return [
				` ${theme.fg("dim", clockTime(entry.at))} ${marker} ${route}${padding}  ${first}`,
				...rest.map((line) => indent + line),
			];
		});
	}

	/** `visible` with a scrollbar cell appended to each row, when one shows. */
	private withScrollbar(
		visible: string[],
		bodyWidth: number,
		totalLines: number,
		top: number,
		scroll: TranscriptScroll,
	): string[] {
		const bar = this.renderScrollbar(totalLines, visible.length, top, scroll);
		if (!bar) return visible;
		return visible.map(
			(line, index) =>
				`${truncateToWidth(line, bodyWidth)}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(line)))}${bar[index]}`,
		);
	}

	/** One scrollbar cell per body row, or undefined when no scrollbar shows. Geometry matches the fullscreen one. */
	private renderScrollbar(
		totalLines: number,
		trackHeight: number,
		top: number,
		scroll: TranscriptScroll,
	): string[] | undefined {
		if (this.scrollbar === "hidden") return undefined;
		const overflows = totalLines > trackHeight;
		if (this.scrollbar === "auto" && !(overflows && scroll.recentlyScrolled)) return undefined;
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
				components: this.buildComponents(subagent),
			};
		}
		const components = [...this.transcript.components];
		if (subagent.streaming) components.push(new AssistantMessageComponent(subagent.streaming));
		return components.flatMap((component) => component.render(width));
	}

	private buildComponents(subagent: Subagent): Component[] {
		const theme = this.theme;
		const self = subagent.id;
		const components: Component[] = [];
		const toolCalls = new Map<string, ToolExecutionComponent>();
		/** chat_send calls, drawn as bubbles; their results as the outcome under the bubble. */
		const chatSends = new Map<string, string>();
		const answered = new Set<string>();
		for (const message of subagent.messages) if (message.role === "toolResult") answered.add(message.toolCallId);
		const chat = { expanded: true, outputPad: 1, self, isAwaitingReply: this.isAwaitingReply };
		for (const message of subagent.messages) {
			if (message.role === "custom") {
				const delivery = message.details ?? { id: "", from: "?", to: self, text: "", awaitingReply: false };
				components.push(new Spacer(1), renderChatMessage(delivery, chat, theme));
			} else if (message.role === "user") {
				components.push(new UserMessageComponent(userText(message)));
			} else if (message.role === "assistant") {
				components.push(new AssistantMessageComponent(message));
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					if (part.name === CHAT_SEND_TOOL_NAME) {
						const to = typeof part.arguments.to === "string" ? part.arguments.to : "?";
						const args = {
							to,
							text: typeof part.arguments.text === "string" ? part.arguments.text : "",
							waitForReply: part.arguments.waitForReply === true,
						};
						// Still waiting while it has no result and the subagent runs; an aborted run leaves none.
						const isPartial = !answered.has(part.id) && subagent.isRunning;
						const state = { ...chat, isError: false, isPartial };
						components.push(new Spacer(1), renderChatSendCall(args, theme, state));
						chatSends.set(part.id, to);
						continue;
					}
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
			} else if (message.role === "toolResult" && chatSends.has(message.toolCallId)) {
				const details = message.details as { outcome?: SendOutcome; message?: ChatDelivery } | undefined;
				const outcome = {
					text: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
					outcome: details?.outcome,
					message: details?.message,
				};
				const to = chatSends.get(message.toolCallId) ?? "?";
				const options = { ...chat, isError: message.isError, isPartial: false };
				components.push(renderChatSendResult(outcome, to, options, theme));
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
