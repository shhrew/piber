import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ChatLog, type ChatLogEntry } from "../../../src/extensions/subagent/chat.ts";
import { Subagent, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";
import { AgentView, TranscriptScroll } from "../../../src/extensions/subagent/view.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

const KEYS = {
	enter: "\r",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	escape: "\x1b",
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

/** An agent view over `subagents` in an 80x20 terminal. `opened` records each `onOpen` call; `closed()` whether it closed. */
function createView(
	subagents: Subagent[],
	options: {
		scrollbar?: "hidden" | "auto" | "always";
		initialSelection?: string;
		openId?: string;
		isAwaitingReply?: (id: string) => boolean;
		chatLog?: ChatLog;
	} = {},
) {
	const registry = new SubagentRegistry();
	for (const subagent of subagents) registry.add(subagent);
	const opened: Array<string | undefined> = [];
	let closes = 0;
	const tui = { terminal: { rows: 20 }, requestRender: () => {} } as unknown as TUI;
	const view = new AgentView(tui, theme, new KeybindingsManager(), registry, {
		cwd: process.cwd(),
		scrollbar: options.scrollbar ?? "hidden",
		initialSelection: options.initialSelection,
		openId: options.openId,
		onOpen: (id) => opened.push(id),
		close: () => {
			closes++;
		},
		isAwaitingReply: options.isAwaitingReply,
		chatLog: options.chatLog,
	});
	const lines = () => view.render(80).map((line) => stripVTControlCharacters(line));
	/** The list row marked as selected. */
	const selectedRow = () => lines().find((line) => line.startsWith("› "));
	return { view, lines, selectedRow, opened, closed: () => closes > 0 };
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

/** A chat log entry sent at 12:01 local time. */
function chatEntry(overrides: Partial<ChatLogEntry>): ChatLogEntry {
	return {
		id: "m",
		at: new Date(2026, 0, 1, 12, 1).getTime(),
		from: "orchestrator",
		to: "scout",
		text: "hi",
		awaitingReply: false,
		held: 0,
		...overrides,
	};
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
		const { view, selectedRow, closed } = createView(subagents, { initialSelection: "alpha" });
		view.handleInput(KEYS.enter);

		view.handleInput(KEYS.left);

		expect(selectedRow()).toContain("alpha");
		expect(closed()).toBe(false);

		view.handleInput(KEYS.left);
		expect(closed()).toBe(true);
	});

	it("returns to the main session from a subagent opened from the dock", () => {
		const subagents = [createSubagent("alpha", "First job")];
		const viaLeft = createView(subagents, { openId: "alpha" });
		expect(viaLeft.lines().join("\n")).toContain("esc main");

		viaLeft.view.handleInput(KEYS.left);
		expect(viaLeft.closed()).toBe(true);

		const viaEsc = createView(subagents, { openId: "alpha" });
		viaEsc.view.handleInput("\x1b");
		expect(viaEsc.closed()).toBe(true);
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

	it("shows chat messages in a subagent's transcript as bubbles", () => {
		const subagent = createSubagent("scout", "Map auth flow");
		subagent.messages.push(
			{
				role: "custom",
				customType: "subagent-chat",
				content: "[Chat message from the orchestrator to you, not from the user]\nCheck b.ts",
				display: true,
				details: { id: "m1", from: "orchestrator", to: "scout", text: "Check b.ts", awaitingReply: true },
				timestamp: 0,
			},
			{
				...assistant(""),
				content: [
					{
						type: "toolCall",
						id: "c1",
						name: "chat_send",
						arguments: { to: "worker", text: "Use a.ts", waitForReply: true },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "chat_send",
				content: [{ type: "text", text: "worker replied:\nok" }],
				details: {
					to: "worker",
					ok: true,
					outcome: "reply",
					message: { id: "m2", from: "worker", to: "scout", text: "ok", awaitingReply: false },
				},
				isError: false,
				timestamp: 0,
			},
		);
		const { view, lines } = createView([subagent], {
			initialSelection: "scout",
			isAwaitingReply: (id) => id === "m1",
		});
		view.handleInput(KEYS.enter);
		const screen = lines();

		const received = screen.findIndex((line) => line.includes("╭─ orchestrator → scout"));
		expect(received).toBeGreaterThanOrEqual(0);
		expect(screen[received].startsWith(" ╭")).toBe(true);
		expect(screen[received + 1]).toContain("Check b.ts");
		expect(screen[received + 2]).toContain("waiting for your reply");
		const sent = screen.find((line) => line.includes("╭─ worker ← scout"));
		expect(sent?.trimEnd().endsWith("╮")).toBe(true);
		expect(sent?.startsWith(" ╭")).toBe(false);
		expect(screen.some((line) => line.trim() === "✓ delivered")).toBe(true);
		expect(screen.some((line) => line.includes("╭─ worker → scout"))).toBe(true);
		expect(screen.join("\n")).not.toContain("[Chat message");
	});
});

describe("subagent agent view chat tab", () => {
	it("switches tabs with the arrows, and the agent-view key on Agents still closes", () => {
		const { view, lines, closed } = createView([], { chatLog: new ChatLog() });
		expect(lines()[1]).toContain("→ chat");

		view.handleInput(KEYS.right);
		expect(lines()[1]).toContain("← agents");
		expect(lines().join("\n")).toContain("No chat messages in this session yet.");

		view.handleInput(KEYS.left);
		expect(lines()[1]).toContain("→ chat");
		expect(closed()).toBe(false);

		view.handleInput(KEYS.left);
		expect(closed()).toBe(true);

		const viaEsc = createView([], { chatLog: new ChatLog() });
		viaEsc.view.handleInput(KEYS.right);
		viaEsc.view.handleInput(KEYS.escape);
		expect(viaEsc.closed()).toBe(true);
	});

	it("shows one entry per send with markers, wrapping long text under the text column", () => {
		const chatLog = new ChatLog();
		chatLog.add(chatEntry({ id: "m1", text: "Check b.ts too" }));
		chatLog.add(chatEntry({ id: "m2", from: "scout", to: "worker", text: "Ready?", awaitingReply: true }));
		chatLog.add(chatEntry({ id: "m3", to: "later", text: "Start with a.ts", held: 1 }));
		chatLog.add(chatEntry({ id: "", from: "worker", to: "all", text: "x", refused: "Not allowed." }));
		chatLog.add(chatEntry({ id: "m5", text: `${"word ".repeat(30)}end` }));
		const { view, lines } = createView([], { chatLog, isAwaitingReply: (id) => id === "m2" });
		view.handleInput(KEYS.right);
		const screen = lines();

		expect(screen[0]).toContain("Chat 5");
		const body = screen.slice(3).filter((line) => line.trim() !== "");
		expect(body[0]).toBe(" 12:01   orchestrator → scout  Check b.ts too");
		expect(body[1]).toBe(" 12:01 ? scout → worker        Ready?");
		expect(body[2]).toBe(" 12:01 ~ orchestrator → later  Start with a.ts");
		expect(body[3]).toBe(" 12:01 x worker → all          Not allowed.");
		expect(body[4].startsWith(" 12:01   orchestrator → scout  word")).toBe(true);
		expect(body[5]).toMatch(/^ {31}word/);
		expect(body.at(-1)?.trimEnd().endsWith("end")).toBe(true);
	});

	it("follows new messages, and holds its position once scrolled up", () => {
		const chatLog = new ChatLog();
		for (let i = 0; i < 40; i++) chatLog.add(chatEntry({ id: `m${i}`, text: `msg-${i}` }));
		const { view, lines } = createView([], { chatLog });
		view.handleInput(KEYS.right);
		const visible = () =>
			[
				...lines()
					.join("\n")
					.matchAll(/msg-(\d+)/g),
			].map((match) => Number(match[1]));
		expect(visible()).toContain(39);

		chatLog.add(chatEntry({ id: "m40", text: "msg-40" }));
		expect(visible()).toContain(40);

		view.handleInput(KEYS.pageUp);
		const held = visible();
		expect(held).not.toContain(40);
		chatLog.add(chatEntry({ id: "m41", text: "msg-41" }));
		expect(visible()).toEqual(held);
		expect(lines()[1]).toMatch(/↓ \d+ more/);
	});
});
