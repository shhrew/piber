/**
 * The agent view: a full-screen overlay listing the main session and its subagents.
 *
 * List: up/down select, Enter opens, Esc or the agent-view double press closes.
 * Subagent: live transcript with an input line. Enter steers a running subagent or starts a follow-up
 * run on an idle one; Esc aborts a running subagent or returns to the list; the agent-view double press
 * returns to the list; page up/down scroll.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
	type Component,
	Input,
	type KeybindingsManager,
	type TUI,
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
import { formatUsageStats } from "./render.ts";

/** Two presses of the agent-view key within this many milliseconds open or leave the view. */
export const DOUBLE_PRESS_MS = 400;

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
		case "running":
			return theme.fg("warning", "⏳");
		case "done":
			return theme.fg("success", "✓");
		default:
			return theme.fg("error", "✗");
	}
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
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
	private readonly doublePress = new DoublePressDetector();
	private readonly input = new Input({ prompt: "› " });
	private readonly unsubscribe: () => void;
	/** 0 is the main session; 1..n are subagents in registry order. */
	private selected = 0;
	private open: Subagent | undefined;
	private scrollFromBottom = 0;
	/** Status line above the input. Info notices show only while the subagent runs; errors stay until the next action. */
	private notice: { text: string; isError: boolean } | undefined;
	private transcript: { subagent: Subagent; count: number; components: Component[] } | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		registry: SubagentRegistry,
		cwd: string,
		close: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.registry = registry;
		this.cwd = cwd;
		this.close = close;
		this.input.focused = true;
		this.input.onSubmit = (value) => this.submit(value);
		this.unsubscribe = registry.onChange(() => this.tui.requestRender());
		// Start on the most recent subagent: that is usually the one to look at.
		this.selected = registry.list().length;
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {
		this.transcript = undefined;
	}

	handleInput(data: string): void {
		if (this.open) this.handleSessionInput(data, this.open);
		else this.handleListInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(5, this.tui.terminal.rows);
		const lines = this.open ? this.renderSession(width, height, this.open) : this.renderList(width, height);
		while (lines.length < height) lines.push("");
		return lines.slice(0, height).map((line) => truncateToWidth(line, width));
	}

	private handleListInput(data: string): void {
		const count = this.registry.list().length + 1;
		const kb = this.keybindings;
		if (this.doublePress.isDoublePress(data, kb) || kb.matches(data, "tui.select.cancel")) {
			this.close();
		} else if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + count) % count;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % count;
		} else if (kb.matches(data, "tui.select.confirm")) {
			const subagent = this.registry.list()[this.selected - 1];
			if (!subagent) {
				this.close();
				return;
			}
			this.open = subagent;
			this.scrollFromBottom = 0;
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
			if (subagent.isRunning) void subagent.abort();
			else this.backToList();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollFromBottom += Math.max(1, this.tui.terminal.rows - 6);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - Math.max(1, this.tui.terminal.rows - 6));
			return;
		}
		this.input.handleInput(data);
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
		this.scrollFromBottom = 0;
		this.notice = { text: subagent.isRunning ? "Steering message sent" : "Follow-up started", isError: false };
		subagent.send(text).catch((error: unknown) => {
			this.notice = { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
			this.tui.requestRender();
		});
	}

	private renderList(width: number, height: number): string[] {
		const theme = this.theme;
		const subagents = this.registry.list();
		const lines = [
			theme.fg("accent", theme.bold(" Agents")),
			theme.fg("dim", " ↑↓ select · enter open · esc close"),
			"",
		];
		const row = (index: number, text: string) => {
			const prefix = index === this.selected ? theme.fg("accent", "› ") : "  ";
			return prefix + (index === this.selected ? theme.bold(text) : text);
		};
		lines.push(row(0, `${theme.fg("success", "●")} main session`));
		subagents.forEach((subagent, index) => {
			const usage = formatUsageStats(subagent.usage);
			let text = `${statusIcon(subagent, theme)} ${theme.fg("accent", subagent.options.agentName)}`;
			text += theme.fg("muted", ` ${subagent.id}`);
			text += ` ${theme.fg("dim", oneLine(subagent.options.task))}`;
			const line = row(index + 1, text);
			const suffix = usage ? `  ${theme.fg("dim", usage)}` : "";
			const room = width - visibleWidth(suffix);
			lines.push(room > 20 ? truncateToWidth(line, room) + suffix : line);
		});
		if (subagents.length === 0) lines.push(theme.fg("muted", "  No subagents in this session yet."));
		// Keep the selected row visible in a long list.
		const overflow = lines.length - height;
		const selectedLine = 3 + this.selected;
		return overflow > 0 && selectedLine >= height ? [...lines.slice(0, 3), ...lines.slice(3 + overflow)] : lines;
	}

	private renderSession(width: number, height: number, subagent: Subagent): string[] {
		const theme = this.theme;
		const status = subagent.isRunning ? "running" : subagent.status;
		const header = [
			`${statusIcon(subagent, theme)} ${theme.fg("accent", theme.bold(subagent.options.agentName))}${theme.fg("muted", ` ${subagent.id} · ${status}`)}  ${theme.fg("dim", formatUsageStats(subagent.usage, subagent.model))}`,
			theme.fg("dim", subagent.sessionFile ? `session: ${subagent.sessionFile}` : "no session file"),
		];
		const hint = subagent.isRunning
			? "enter steer · esc abort · ←← agents · pgup/pgdn scroll"
			: "enter follow up · esc agents · pgup/pgdn scroll";
		const footer = [
			...(this.notice && (this.notice.isError || subagent.isRunning)
				? [theme.fg(this.notice.isError ? "error" : "dim", this.notice.text)]
				: []),
			...this.input.render(width),
			theme.fg("dim", hint),
		];
		const bodyHeight = Math.max(1, height - header.length - footer.length - 1);
		const body = this.renderTranscript(width, subagent);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, Math.max(0, body.length - bodyHeight));
		const end = body.length - this.scrollFromBottom;
		const visible = body.slice(Math.max(0, end - bodyHeight), end);
		while (visible.length < bodyHeight) visible.unshift("");
		return [...header, ...visible, theme.fg("borderMuted", "─".repeat(width)), ...footer];
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
