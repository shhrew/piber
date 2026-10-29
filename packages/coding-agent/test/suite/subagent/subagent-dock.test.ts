import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { Subagent, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import { FADE_MS, MAX_ROWS, SubagentDock } from "../../../src/extensions/subagent/dock.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import {
	currentPhase,
	formatPhase,
	latestToolCall,
	renderBackgroundNotice,
	renderChatMessage,
	renderChatSendCall,
	renderChatSendResult,
	renderListResult,
	renderSubagentCall,
	renderSubagentResult,
	renderWaitCall,
	renderWaitResult,
	type SubagentRunDetails,
} from "../../../src/extensions/subagent/render.ts";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));
const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", letter: "x" };
const keybindings = new KeybindingsManager();
const tui = { requestRender: () => {} } as unknown as TUI;

function createSubagent(id: string, overrides: Partial<SubagentOptions> = {}): Subagent {
	return new Subagent({
		id,
		agentName: "scout",
		agentSource: "bundled",
		description: `Job ${id}`,
		task: `Do ${id}`,
		cwd: process.cwd(),
		systemPrompt: "",
		tools: [],
		skillGroups: [],
		projectTrusted: false,
		...overrides,
	});
}

/** A finished subagent that ended `ago` milliseconds before now. */
function finished(id: string, ago: number): Subagent {
	const subagent = createSubagent(id);
	subagent.status = "done";
	subagent.startedAt = Date.now() - ago - 5000;
	subagent.finishedAt = Date.now() - ago;
	return subagent;
}

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line));
const running: Array<{ subagent: Subagent; run: Promise<void> }> = [];

/** Subagents running (and, beyond `limit`, queued) against the fake child, until the test ends. */
function startHanging(ids: string[], limit: number): Subagent[] {
	const slots = new SlotPool(limit);
	return ids.map((id) => {
		const subagent = createSubagent(id, {
			slots,
			command: { executable: process.execPath, args: [fakeChild, "hang"] },
		});
		running.push({ subagent, run: subagent.run("Task: wait") });
		return subagent;
	});
}

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const { subagent } of running) await subagent.abort();
	await Promise.all(running.splice(0).map(({ run }) => run));
});

describe("subagent dock", () => {
	it("renders nothing without active or recently finished subagents", () => {
		const registry = new SubagentRegistry();
		registry.add(finished("old", FADE_MS + 1000));
		const dock = new SubagentDock(tui, theme, registry);

		expect(dock.render(100)).toEqual([]);
		expect(dock.focus()).toBe(false);
		dock.dispose();
	});

	it("lists running subagents, then recently finished ones, capped, with hidden and queued counts", async () => {
		const [active, waiting] = startHanging(["active", "waiting"], 1);
		await vi.waitFor(() => expect([active.isRunning, waiting.isQueued]).toEqual([true, true]));
		const registry = new SubagentRegistry();
		for (const subagent of [finished("f1", 3000), finished("f2", 1000), finished("f3", 2000), finished("f4", 4000)]) {
			registry.add(subagent);
		}
		registry.add(finished("faded", FADE_MS + 1000));
		registry.add(active);
		registry.add(waiting);
		const dock = new SubagentDock(tui, theme, registry);

		const lines = plain(dock.render(120));

		expect(lines).toHaveLength(MAX_ROWS + 1);
		expect(lines.slice(0, MAX_ROWS).map((line) => line.trim().split(/\s+/)[1])).toEqual(["active", "f2", "f3", "f1"]);
		expect(lines[1]).toContain("Job f2 · Done");
		expect(lines.join("\n")).not.toContain("faded");
		expect(lines[MAX_ROWS]).toBe("  +1 more · ◷ 1 queued");
		dock.dispose();
	});

	it("moves with the arrow keys, opens on Enter, and hands other keys back to the composer", () => {
		const registry = new SubagentRegistry();
		for (const subagent of [finished("first", 1000), finished("second", 2000)]) registry.add(subagent);
		const dock = new SubagentDock(tui, theme, registry);
		const selected = () => plain(dock.render(120)).find((line) => line.startsWith("› "));

		expect(dock.focus()).toBe(true);
		expect(selected()).toContain("first");
		expect(plain(dock.render(120)).at(-1)).toContain("enter open · esc back");

		expect(dock.handleKey(KEYS.down, keybindings)).toEqual({ type: "consumed" });
		expect(selected()).toContain("second");
		expect(dock.handleKey(KEYS.down, keybindings)).toEqual({ type: "consumed" });
		expect(selected()).toContain("second");

		expect(dock.handleKey(KEYS.enter, keybindings)).toEqual({ type: "open", id: "second" });
		expect(dock.isFocused).toBe(false);

		dock.focus();
		expect(dock.handleKey(KEYS.up, keybindings)).toEqual({ type: "consumed" });
		expect(dock.isFocused).toBe(false);

		dock.focus();
		expect(dock.handleKey(KEYS.escape, keybindings)).toEqual({ type: "consumed" });
		expect(dock.isFocused).toBe(false);

		dock.focus();
		expect(dock.handleKey(KEYS.letter, keybindings)).toEqual({ type: "pass" });
		expect(dock.isFocused).toBe(false);
		dock.dispose();
	});
});

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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function run(id: string, overrides: Partial<SubagentRunDetails> = {}): SubagentRunDetails {
	return {
		id,
		description: `Job ${id}`,
		agent: "scout",
		agentSource: "bundled",
		task: `Investigate ${id} thoroughly`,
		status: "done",
		messages: [assistant(`SECRET OUTPUT of ${id}`)],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 15, turns: 3 },
		startedAt: 1_000,
		finishedAt: 13_000,
		sessionFile: `/sessions/${id}.jsonl`,
		...overrides,
	};
}

describe("subagent tool rendering in the main chat", () => {
	const callState = { isPartial: false, isError: false, outputPad: 1 };
	const resultOptions = { expanded: false, isError: false, outputPad: 1 };

	it("draws the call as one line with the name and description", () => {
		const single = plain(
			renderSubagentCall(
				{ agent: "scout", task: "t", name: "auth-scout", description: "Map auth flow" },
				theme,
				callState,
			).render(100),
		);
		expect(single).toEqual([" ● Subagent(auth-scout) Map auth flow"]);

		const parallel = plain(
			renderSubagentCall(
				{
					tasks: [
						{ agent: "scout", task: "a" },
						{ agent: "scout", task: "b" },
					],
				},
				theme,
				callState,
			).render(100),
		);
		expect(parallel).toEqual([" ● Subagents · 2 in parallel"]);
	});

	it("shows one status line per run, its latest command when expanded, and never the subagent's output", () => {
		const readCall: AssistantMessage = {
			...assistant(""),
			content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.txt" } }],
		};
		const details = {
			mode: "parallel" as const,
			results: [
				run("alpha", { messages: [readCall, assistant("SECRET OUTPUT of alpha")] }),
				run("beta", { status: "failed", errorMessage: "boom\nstack" }),
			],
		};

		const lines = plain(renderSubagentResult(details, "", resultOptions, theme).render(120));
		expect(lines).toEqual([
			"   ⎿  ✓ alpha  Job alpha · Done · 3 turns · 12s · $0.0100",
			"      ✗ beta   Job beta · Failed: boom · 3 turns · 12s",
		]);
		expect(lines.join("\n")).not.toContain("SECRET OUTPUT");

		const expanded = plain(
			renderSubagentResult(details, "", { ...resultOptions, expanded: true }, theme).render(120),
		);
		// beta ran no commands, so it gets no extra line.
		expect(expanded).toEqual([lines[0], "        → read a.txt", lines[1]]);
		expect(expanded.join("\n")).not.toContain("SECRET OUTPUT");
	});

	it("shows a single run's status on the elbow line", () => {
		const details = { mode: "single" as const, results: [run("solo")] };
		expect(plain(renderSubagentResult(details, "", resultOptions, theme).render(120))).toEqual([
			"   ⎿  ✓ Done · 3 turns · 12s · $0.0100",
		]);
	});

	it("advances a running row's spinner and timer on every render, without waiting for a progress update", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(10_000);
			const details = {
				mode: "single" as const,
				results: [run("live", { status: "running", startedAt: 2_000, finishedAt: undefined, messages: [] })],
			};
			const component = renderSubagentResult(details, "", resultOptions, theme);

			const [first] = plain(component.render(120));
			vi.setSystemTime(13_000);
			const [second] = plain(component.render(120));

			expect(first).toMatch(/^ {3}⎿ {2}\S Working · 3 turns · 8s$/);
			expect(second).toMatch(/^ {3}⎿ {2}\S Working · 3 turns · 11s$/);
			// The character after the elbow is the spinner; its frame follows the clock.
			expect(first[6]).not.toBe(second[6]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("subagent activity", () => {
	const toolCall: AssistantMessage = {
		...assistant(""),
		content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.txt" } }],
	};
	const text = (value: string | undefined) => stripVTControlCharacters(value ?? "");

	it("derives a coarse phase from the streaming message, never the command", () => {
		const thinking: AssistantMessage = { ...assistant(""), content: [{ type: "thinking", thinking: "hmm" }] };

		expect(currentPhase(thinking)).toBe("thinking");
		expect(currentPhase(assistant("partial answer"))).toBe("responding");
		expect(currentPhase(toolCall)).toBe("working");
		expect(currentPhase(undefined)).toBe("working");
		expect(text(formatPhase("responding", theme))).toBe("Responding");
	});

	it("shows the stored phase in the transcript's running rows, not the command", () => {
		const details = {
			mode: "single" as const,
			results: [run("live", { status: "running", phase: "thinking", finishedAt: undefined, messages: [toolCall] })],
		};
		const [line] = plain(
			renderSubagentResult(details, "", { expanded: false, isError: false, outputPad: 1 }, theme).render(120),
		);

		expect(line).toMatch(/^ {3}⎿ {2}\S Thinking · 3 turns · \d+/);
		expect(line).not.toContain("read a.txt");
	});

	it("shows Working in the dock for a subagent that is running tools", async () => {
		const [busy] = startHanging(["busy"], 1);
		await vi.waitFor(() => expect(busy.isRunning).toBe(true));
		busy.messages.push(toolCall);
		const registry = new SubagentRegistry();
		registry.add(busy);
		const dock = new SubagentDock(tui, theme, registry);

		const [row] = plain(dock.render(120));
		expect(row).toMatch(/busy {2}Job busy · Working · \d+s$/);
		expect(row).not.toContain("read a.txt");
		dock.dispose();
	});

	it("finds the latest tool call for the transcript's expanded rows", () => {
		expect(text(latestToolCall([toolCall], theme))).toBe("read a.txt");
		expect(latestToolCall([assistant("no tools")], theme)).toBeUndefined();
	});
});

describe("background rendering", () => {
	const options = { expanded: false, isError: false, outputPad: 1 };

	it("follows a background subagent's live state, and stops spinning once it belongs to an earlier process", () => {
		const details = {
			mode: "single" as const,
			results: [run("bg", { key: "k1", status: "running" })],
			background: true,
			live: true,
		};

		const live = plain(
			renderSubagentResult(details, "", { ...options, lookup: () => run("bg", { key: "k1" }) }, theme).render(120),
		);
		expect(live).toEqual(["   ⎿  ✓ Done · 3 turns · 12s · $0.0100"]);

		const detached = plain(
			renderSubagentResult(details, "", { ...options, lookup: () => undefined }, theme).render(120),
		);
		expect(detached).toEqual(["   ⎿  ○ Started in background"]);
	});

	it("marks background calls on the call line", () => {
		const line = plain(
			renderSubagentCall(
				{ agent: "scout", task: "t", name: "bg", description: "Echo me", background: true },
				theme,
				{ isPartial: true, isError: false, outputPad: 1 },
			).render(100),
		);
		expect(line).toEqual([" ● Subagent(bg) Echo me · background"]);
	});

	it("draws the completion notice as a call line with one row per subagent", () => {
		const lines = plain(
			renderBackgroundNotice([run("a"), run("b")], { expanded: false, outputPad: 1 }, theme).render(120),
		);
		expect(lines).toEqual([
			" ● Subagents finished · 2 in the background",
			"   ⎿  ✓ a  Job a · Done · 3 turns · 12s · $0.0100",
			"      ✓ b  Job b · Done · 3 turns · 12s · $0.0100",
		]);
	});
});

describe("wait rendering", () => {
	const waiting = { isPartial: true, isError: false, outputPad: 1 };
	const options = { expanded: false, isError: false, isPartial: true, outputPad: 1 };
	const details = { mode: "parallel" as const, results: [run("a"), run("b", { status: "running" })] };

	it("shows only the call line when waiting for all or any subagents", () => {
		expect(plain(renderWaitCall({}, theme, waiting).render(100))).toEqual([
			" ● Waiting(all) · waiting for subagents to finish",
		]);
		expect(plain(renderWaitCall({ returnOnFirst: true }, theme, waiting).render(100))).toEqual([
			" ● Waiting(any) · waiting for a subagent to finish",
		]);
		expect(plain(renderWaitCall({}, theme, { ...waiting, isPartial: false }).render(100))).toEqual([
			" ● Waiting(all) · done waiting",
		]);
		expect(renderWaitResult({ returnOnFirst: true }, details, "", options, theme).render(100)).toEqual([]);
	});

	it("names the mode on the call line for several targets, and the target itself for one", () => {
		const several = plain(
			renderWaitCall({ names: ["scout-a", "scout-b"], returnOnFirst: true }, theme, waiting).render(100),
		);
		expect(several).toEqual([" ● Waiting(any) · waiting for a subagent to finish"]);

		const one = plain(renderWaitCall({ names: ["scout-a"], returnOnFirst: true }, theme, waiting).render(100));
		expect(one).toEqual([" ● Waiting(scout-a) · waiting for it to finish"]);
		expect(renderWaitResult({ names: ["a"] }, details, "", options, theme).render(100)).toEqual([]);
	});

	it("lists named targets by name and description only", () => {
		const lines = plain(renderWaitResult({ names: ["a", "b"] }, details, "", options, theme).render(100));
		expect(lines[0]).toBe("   ⎿  ✓ a  Job a");
		expect(lines[1]).toMatch(/^ {6}\S b {2}Job b$/);
		expect(lines.join("\n")).not.toMatch(/turns|Done|\d+s/);
	});

	it("collapses to the call line once the wait is done", () => {
		const done = { ...options, isPartial: false };
		expect(renderWaitResult({ names: ["a", "b"] }, details, "", done, theme).render(100)).toEqual([]);
	});

	it("still shows errors, such as unknown names", () => {
		const lines = plain(
			renderWaitResult({}, undefined, "Unknown subagents: ghost.", { ...options, isError: true }, theme).render(100),
		);
		expect(lines).toEqual(["   ⎿  Unknown subagents: ghost."]);
	});
});

describe("list rendering", () => {
	it("summarizes the list in one line of counts", () => {
		const details = {
			mode: "parallel" as const,
			results: [
				run("a", { status: "running" }),
				run("b", { status: "queued" }),
				run("c"),
				run("d", { status: "failed" }),
			],
		};
		expect(plain(renderListResult(details, 1, theme).render(100))).toEqual([
			"   ⎿  1 running · 1 queued · 1 done · 1 failed",
		]);
		expect(plain(renderListResult({ mode: "parallel", results: [] }, 1, theme).render(100))).toEqual([
			"   ⎿  No subagents",
		]);
	});
});

describe("chat rendering in the main chat", () => {
	const received = {
		id: "m1",
		from: "scout-a",
		to: "orchestrator",
		text: "Found it\nin src/a.ts",
		awaitingReply: false,
	};
	const inbound = { expanded: false, outputPad: 1, self: "orchestrator" };

	it("draws a received message as a bubble on the left, labeled sender → current", () => {
		expect(plain(renderChatMessage(received, inbound, theme).render(50))).toEqual([
			" ╭─ scout-a → orchestrator ─╮",
			" │ Found it                 │",
			" │ in src/a.ts              │",
			" ╰──────────────────────────╯",
		]);
		const broadcast = { ...received, to: "all", text: "Stop" };
		expect(plain(renderChatMessage(broadcast, inbound, theme).render(50))[0]).toBe(" ╭─ scout-a → everyone ─╮");
	});

	it("tells the receiver while the sender waits for a reply, and after", () => {
		let waiting = true;
		const bubble = renderChatMessage(
			{ ...received, awaitingReply: true },
			{ ...inbound, isAwaitingReply: (id) => waiting && id === "m1" },
			theme,
		);
		expect(plain(bubble.render(50)).at(-1)).toBe(" ╰─ waiting for your reply ─╯");
		waiting = false;
		expect(plain(bubble.render(50)).at(-1)).toBe(" ╰────── asked for a reply ─╯");
	});

	it("cuts a long message to a preview until expanded", () => {
		const long = { ...received, text: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") };
		const collapsed = plain(renderChatMessage(long, inbound, theme).render(50));
		expect(collapsed).toHaveLength(8);
		expect(collapsed.at(-2)).toContain("… 5 more lines");
		expect(plain(renderChatMessage(long, { ...inbound, expanded: true }, theme).render(50))).toHaveLength(12);
	});

	it("draws a send as a bubble on the right, labeled receiver ← current", () => {
		const state = { isPartial: true, isError: false, outputPad: 1, expanded: false, self: "orchestrator" };
		const lines = plain(
			renderChatSendCall({ to: "worker", text: "Use a.ts", waitForReply: true }, theme, state).render(50),
		);
		expect(lines).toEqual([
			`${" ".repeat(22)}╭─ worker ← orchestrator ─╮`,
			`${" ".repeat(22)}│ Use a.ts                │`,
			`${" ".repeat(22)}╰─── waiting for a reply ─╯`,
		]);
		const sent = plain(renderChatSendCall({ to: "worker", text: "Use a.ts" }, theme, state).render(50));
		expect(sent.at(-1)).toBe(`${" ".repeat(22)}╰─────────────────────────╯`);
	});

	it("puts the outcome under the sent bubble, and the reply below it", () => {
		const done = { expanded: false, isError: false, isPartial: false, outputPad: 1, self: "orchestrator" };
		const reply = { id: "m2", from: "worker", to: "orchestrator", text: "yes", awaitingReply: false };
		const lines = plain(
			renderChatSendResult(
				{ text: "worker replied:\nyes", outcome: "reply", message: reply },
				"worker",
				done,
				theme,
			).render(50),
		);
		expect(lines).toEqual([
			`${" ".repeat(38)}✓ delivered`,
			"",
			" ╭─ worker → orchestrator ─╮",
			" │ yes                     │",
			" ╰─────────────────────────╯",
		]);
		const held = renderChatSendResult({ text: "", outcome: "held" }, "worker", done, theme);
		expect(plain(held.render(50))).toEqual([`${" ".repeat(23)}◷ held until worker starts`]);
		const refused = renderChatSendResult(
			{ text: "You are not allowed to message other subagents.", outcome: "refused" },
			"worker",
			{ ...done, isError: true },
			theme,
		);
		expect(plain(refused.render(50)).join(" ")).toContain("✗ not sent: You are not allowed");
		expect(renderChatSendResult({ text: "" }, "worker", { ...done, isPartial: true }, theme).render(50)).toEqual([]);
	});
});
