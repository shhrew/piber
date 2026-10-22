/**
 * The subagent dock: a short list under the composer with one line per active subagent.
 *
 *     ⠋ a-scout  Read a.txt · Thinking · 2 turns · 8s
 *     ✓ b-scout  Read b.txt · Done · 3 turns · 12s
 *     ◷ 3 queued
 *
 * It lists running subagents, then ones that finished in the last `FADE_MS`, at most `MAX_ROWS` at a time, and
 * renders nothing when there is nothing to show. Queued subagents appear only as a count.
 *
 * ↓ in an empty composer focuses it: ↑/↓ move, Enter opens the selection in the agent view, Esc or ↑ past the
 * top returns to the composer, and any other key returns to the composer and is handled there.
 */

import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { Subagent } from "./child.ts";
import type { SubagentRegistry } from "./registry.ts";
import {
	currentPhase,
	describeRowStatus,
	formatPhase,
	SPINNER_INTERVAL_MS,
	type SubagentRow,
	statusIcon,
} from "./render.ts";

/** How long a finished subagent stays in the dock. */
export const FADE_MS = 10_000;
/** Subagent rows shown at once. More are reached by moving the selection. */
export const MAX_ROWS = 4;

/** What a key did while the dock had focus. `pass`: the dock let go of focus and the key belongs to the composer. */
export type DockKeyResult = { type: "consumed" } | { type: "pass" } | { type: "open"; id: string };

export class SubagentDock implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly registry: SubagentRegistry;
	private readonly unsubscribe: () => void;
	private timer: NodeJS.Timeout | undefined;
	private focusedId: string | undefined;

	constructor(tui: TUI, theme: Theme, registry: SubagentRegistry) {
		this.tui = tui;
		this.theme = theme;
		this.registry = registry;
		this.unsubscribe = registry.onChange(() => {
			this.scheduleTick();
			this.tui.requestRender();
		});
		this.scheduleTick();
	}

	get isFocused(): boolean {
		return this.focusedId !== undefined;
	}

	/** Running subagents in start order, then recently finished ones, newest first. Queued ones are only counted. */
	visibleSubagents(now = Date.now()): Subagent[] {
		const subagents = this.registry.list();
		const running = subagents.filter((subagent) => subagent.isRunning);
		const finished = subagents
			.filter((subagent) => !subagent.isRunning && !subagent.isQueued && subagent.finishedAt !== undefined)
			.filter((subagent) => now - (subagent.finishedAt ?? 0) < FADE_MS)
			.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
		return [...running, ...finished];
	}

	/** Take focus on the first row. False when there is nothing to focus. */
	focus(): boolean {
		const first = this.visibleSubagents()[0];
		if (!first) return false;
		this.focusedId = first.id;
		this.tui.requestRender();
		return true;
	}

	blur(): void {
		if (this.focusedId === undefined) return;
		this.focusedId = undefined;
		this.tui.requestRender();
	}

	handleKey(data: string, keybindings: KeybindingsManager): DockKeyResult {
		const ids = this.visibleSubagents().map((subagent) => subagent.id);
		const index = ids.indexOf(this.focusedId ?? "");
		if (index === -1) {
			// The focused subagent faded out: let go rather than jump somewhere unexpected.
			this.blur();
			return { type: "pass" };
		}
		if (keybindings.matches(data, "tui.select.up")) {
			if (index === 0) this.blur();
			else this.focusedId = ids[index - 1];
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.focusedId = ids[Math.min(ids.length - 1, index + 1)];
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const id = ids[index];
			this.blur();
			return { type: "open", id };
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.blur();
		} else {
			this.blur();
			return { type: "pass" };
		}
		this.tui.requestRender();
		return { type: "consumed" };
	}

	render(width: number): string[] {
		const theme = this.theme;
		const now = Date.now();
		const subagents = this.visibleSubagents(now);
		const queued = this.registry.list().filter((subagent) => subagent.isQueued).length;
		if (subagents.length === 0 && queued === 0) {
			this.focusedId = undefined;
			return [];
		}

		// Keep the focused row inside the window of MAX_ROWS rows.
		const focusedIndex = Math.max(
			0,
			subagents.findIndex((subagent) => subagent.id === this.focusedId),
		);
		const start = Math.max(0, Math.min(focusedIndex - MAX_ROWS + 1, subagents.length - MAX_ROWS));
		const shown = subagents.slice(start, start + MAX_ROWS);
		const nameWidth = Math.max(0, ...shown.map((subagent) => subagent.id.length));
		const lines = shown.map((subagent) => {
			const focused = subagent.id === this.focusedId;
			const row: SubagentRow = {
				id: subagent.id,
				status: subagent.isRunning ? "running" : subagent.status,
				usage: subagent.usage,
				errorMessage: subagent.errorMessage,
				startedAt: subagent.startedAt,
				finishedAt: subagent.finishedAt,
				activity: subagent.isRunning ? formatPhase(currentPhase(subagent.streaming), theme) : undefined,
			};
			const name = theme.fg(
				"accent",
				focused ? theme.bold(subagent.id.padEnd(nameWidth)) : subagent.id.padEnd(nameWidth),
			);
			const prefix = focused ? theme.fg("accent", "› ") : "  ";
			const description = theme.fg("dim", `${subagent.options.description} ·`);
			return truncateToWidth(
				`${prefix}${statusIcon(row.status, theme)} ${name}  ${description} ${describeRowStatus(row, theme, now)}`,
				width,
			);
		});

		const summary: string[] = [];
		const hidden = subagents.length - shown.length;
		if (hidden > 0) summary.push(theme.fg("dim", `+${hidden} more`));
		if (queued > 0) summary.push(`${theme.fg("muted", "◷")} ${theme.fg("dim", `${queued} queued`)}`);
		if (this.isFocused) summary.push(theme.fg("dim", "↑↓ select · enter open · esc back"));
		if (summary.length > 0) lines.push(truncateToWidth(`  ${summary.join(theme.fg("dim", " · "))}`, width));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.timer) clearTimeout(this.timer);
	}

	/** Redraw for spinners while a subagent runs, otherwise when the next finished row should fade out. */
	private scheduleTick(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const now = Date.now();
		const subagents = this.visibleSubagents(now);
		let delay: number | undefined;
		if (subagents.some((subagent) => subagent.isRunning)) delay = SPINNER_INTERVAL_MS;
		else {
			const expiries = subagents.map((subagent) => (subagent.finishedAt ?? now) + FADE_MS - now);
			if (expiries.length > 0) delay = Math.max(50, Math.min(...expiries));
		}
		if (delay === undefined) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.tui.requestRender();
			this.scheduleTick();
		}, delay);
		this.timer.unref();
	}
}
