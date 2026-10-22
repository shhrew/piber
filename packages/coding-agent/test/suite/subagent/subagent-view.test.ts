import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { Subagent, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";
import { AgentView, TranscriptScroll } from "../../../src/extensions/subagent/view.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

const KEYS = {
	enter: "\r",
	down: "\x1b[B",
	left: "\x1b[D",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	ctrlHome: "\x1b[1;5H",
	ctrlEnd: "\x1b[1;5F",
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function wheel(delta: number): TuiMouseEvent {
	return {
		type: "wheel",
		button: "none",
		x: 0,
		y: 5,
		screenX: 0,
		screenY: 5,
		width: 80,
		height: 20,
		shift: false,
		alt: false,
		ctrl: false,
		wheelDelta: delta,
	};
}

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));

function createSubagent(
	id: string,
	description: string,
	agentName = "worker",
	overrides: Partial<SubagentOptions> = {},
): Subagent {
	const subagent = new Subagent({
		id,
		agentName,
		agentSource: "bundled",
		description,
		task: `${description} in detail`,
		cwd: process.cwd(),
		systemPrompt: "",
		tools: [],
		skillGroups: [],
		projectTrusted: false,
		...overrides,
	});
	subagent.status = "done";
	return subagent;
}

/** An agent view over `subagents` in an 80x20 terminal. `opened` records each `onOpen` call. */
function createView(
	subagents: Subagent[],
	options: { scrollbar?: "hidden" | "auto" | "always"; initialSelection?: string } = {},
) {
	const registry = new SubagentRegistry();
	for (const subagent of subagents) registry.add(subagent);
	const opened: Array<string | undefined> = [];
	const tui = { terminal: { rows: 20 }, requestRender: () => {} } as unknown as TUI;
	const view = new AgentView(tui, theme, new KeybindingsManager(), registry, {
		cwd: process.cwd(),
		scrollbar: options.scrollbar ?? "hidden",
		initialSelection: options.initialSelection,
		onOpen: (id) => opened.push(id),
		close: () => {},
	});
	const lines = () => view.render(80).map((line) => stripVTControlCharacters(line));
	/** The list row marked as selected. */
	const selectedRow = () => lines().find((line) => line.startsWith("› "));
	return { view, lines, selectedRow, opened };
}

/** An agent view opened on a finished subagent with `count` messages, in a 20-row terminal. */
function openView(count: number, scrollbar: "hidden" | "auto" | "always" = "hidden") {
	const subagent = createSubagent("long-run", "Long task");
	for (let i = 0; i < count; i++) subagent.messages.push(assistant(`msg-${i}`));
	const { view } = createView([subagent], { scrollbar, initialSelection: "long-run" });
	view.handleInput(KEYS.enter);
	const screen = () => view.render(80).join("\n");
	/** Message numbers visible on screen. */
	const visible = () => [...screen().matchAll(/msg-(\d+)/g)].map((match) => Number(match[1]));
	// The TUI renders before any input arrives; scrolling needs the viewport height from that render.
	screen();
	return { view, subagent, screen, visible };
}

beforeAll(() => initTheme("dark"));

describe("subagent transcript scroll", () => {
	it("follows the end, holds its position when scrolled up, and resumes following at the end", () => {
		const scroll = new TranscriptScroll();
		expect(scroll.layout(100, 10)).toBe(90);

		scroll.scrollBy(-5);
		expect(scroll.layout(100, 10)).toBe(85);
		expect(scroll.layout(120, 10)).toBe(85);
		expect(scroll.linesBelow).toBe(25);

		scroll.scrollBy(1000);
		expect(scroll.layout(130, 10)).toBe(120);
		expect(scroll.linesBelow).toBe(0);

		scroll.scrollToTop();
		expect(scroll.layout(130, 10)).toBe(0);
		scroll.scrollToBottom();
		expect(scroll.layout(130, 10)).toBe(120);
	});
});

describe("subagent agent view scrolling", () => {
	it("pages with the fullscreen keys and jumps to the top and bottom", () => {
		const { view, visible } = openView(40);
		expect(visible()).toContain(39);
		expect(visible()).not.toContain(0);

		view.handleInput(KEYS.pageUp);
		const afterPageUp = visible();
		expect(Math.max(...afterPageUp)).toBeLessThan(39);

		view.handleInput(KEYS.pageDown);
		expect(visible()).toContain(39);

		view.handleInput(KEYS.ctrlHome);
		expect(visible()).toContain(0);
		view.handleInput(KEYS.ctrlEnd);
		expect(visible()).toContain(39);
	});

	it("scrolls with the mouse wheel", () => {
		const { view, visible } = openView(40);

		expect(view.handleMouse(wheel(-6))).toEqual({ handled: true });
		const scrolled = visible();
		expect(Math.max(...scrolled)).toBeLessThan(39);

		view.handleMouse(wheel(100));
		expect(visible()).toContain(39);
	});

	it("keeps the view still while new output arrives below, and says how much is below", () => {
		const { view, subagent, screen, visible } = openView(40);
		view.handleInput(KEYS.pageUp);
		const before = visible();

		subagent.messages.push(assistant("msg-40"));
		view.invalidate();

		expect(visible()).toEqual(before);
		expect(screen()).toMatch(/↓ \d+ more/);
	});

	it("draws a scrollbar in the last column when set to always", () => {
		const { view } = openView(40, "always");
		const lines = view.render(80);

		expect(lines.some((line) => line.includes("┃"))).toBe(true);
		expect(lines.some((line) => line.includes("│"))).toBe(true);
	});
});

describe("subagent agent view list", () => {
	it("lists subagents by name and description, with the agent alongside", () => {
		const { lines } = createView([createSubagent("auth-scout", "Map auth flow", "scout")]);

		const row = lines().find((line) => line.includes("auth-scout"));
		expect(row).toContain("auth-scout Map auth flow (scout)");
		expect(row).not.toContain("in detail");
	});

	it("starts on the main session until a subagent is opened, then on the last opened session", () => {
		const subagents = [createSubagent("alpha", "First job"), createSubagent("beta", "Second job")];
		const first = createView(subagents);
		expect(first.selectedRow()).toContain("main session");

		first.view.handleInput(KEYS.down);
		first.view.handleInput(KEYS.down);
		first.view.handleInput(KEYS.enter);
		expect(first.opened).toEqual(["beta"]);

		const second = createView(subagents, { initialSelection: "beta" });
		expect(second.selectedRow()).toContain("beta");

		const missing = createView(subagents, { initialSelection: "gone" });
		expect(missing.selectedRow()).toContain("main session");
		missing.view.handleInput(KEYS.enter);
		expect(missing.opened).toEqual([undefined]);
	});

	it("returns to the list on the subagent that was open", () => {
		const subagents = [createSubagent("alpha", "First job"), createSubagent("beta", "Second job")];
		const { view, selectedRow } = createView(subagents, { initialSelection: "alpha" });
		view.handleInput(KEYS.enter);

		view.handleInput(KEYS.left);
		view.handleInput(KEYS.left);

		expect(selectedRow()).toContain("alpha");
	});

	it("groups subagents under In progress, Queued, and Completed, and moves between rows without stopping on headers", async () => {
		const slots = new SlotPool(1);
		const hang = { slots, command: { executable: process.execPath, args: [fakeChild, "hang"] } };
		const finished = createSubagent("finished", "Old job");
		const runner = createSubagent("runner", "Busy job", "worker", hang);
		const waiter = createSubagent("waiter", "Next job", "worker", hang);
		const runs = [runner.run("Task: wait"), waiter.run("Task: wait too")];
		try {
			await vi.waitFor(() => expect([runner.isRunning, waiter.isQueued]).toEqual([true, true]));
			const { view, lines, selectedRow } = createView([finished, runner, waiter]);

			const labels = lines()
				.map((line) => line.trim())
				.filter((line) => /^(› )?(● main|.? ?\w+ (Busy|Next|Old) job|In progress|Queued|Completed)/.test(line));
			expect(labels.map((line) => line.replace(/^› /, "").split(" (")[0])).toEqual([
				"● main session",
				"In progress 1",
				expect.stringMatching(/^. runner Busy job$/),
				"Queued 1",
				"◷ waiter Next job",
				"Completed 1",
				"✓ finished Old job",
			]);

			const order = [];
			for (let i = 0; i < 4; i++) {
				view.handleInput(KEYS.down);
				order.push(selectedRow()?.split(" ")[2]);
			}
			expect(order).toEqual(["runner", "waiter", "finished", "main"]);
		} finally {
			await runner.abort();
			await waiter.abort();
			await Promise.all(runs);
		}
	});
});
