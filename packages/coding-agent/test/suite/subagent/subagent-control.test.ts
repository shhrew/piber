import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handbackPrompt,
	resumePrompt,
	Subagent,
	type SubagentOptions,
} from "../../../src/extensions/subagent/child.ts";
import { createSubagentExtension } from "../../../src/extensions/subagent/index.ts";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));

function createSubagent(mode: string, overrides: Partial<SubagentOptions> = {}): Subagent {
	return new Subagent({
		id: "sa1",
		agentName: "worker",
		agentSource: "bundled",
		description: "Do the thing",
		task: "Do the thing",
		cwd: process.cwd(),
		systemPrompt: "You are a test agent.",
		tools: ["read"],
		skillGroups: [],
		projectTrusted: false,
		sessionDir: "/fake",
		command: { executable: process.execPath, args: [fakeChild, mode] },
		...overrides,
	});
}

function texts(subagent: Subagent): string[] {
	return subagent.messages.map((message) => {
		if (message.role === "user") return typeof message.content === "string" ? message.content : "";
		if (message.role === "assistant")
			return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return "";
	});
}

describe("subagent pause, resume, start now, and handback", () => {
	it("pauses a running subagent to free its slot for a queued one, then resumes it on its session", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const second = createSubagent("echo", { id: "second", slots });
		const firstRun = first.run("Task: wait");
		const secondRun = second.run("Task: next");
		await vi.waitFor(() => expect(texts(first)).toEqual(["Task: wait"]));
		expect(second.isQueued).toBe(true);

		await first.pause();

		expect(first.status).toBe("paused");
		expect([first.isPaused, first.isRunning, first.isQueued]).toEqual([true, false, false]);
		await secondRun;
		expect(second.getFinalOutput()).toBe("echo: Task: next");
		expect([slots.running, slots.queued]).toEqual([0, 0]);

		await first.resume("focus on a.ts");
		expect(first.isRunning).toBe(true);
		await vi.waitFor(() => expect(texts(first)).toContain(resumePrompt("focus on a.ts")));
		await first.send("finish");
		await firstRun;

		expect(first.status).toBe("done");
		expect(texts(first)).toEqual([
			"Task: wait",
			"stopped",
			resumePrompt("focus on a.ts"),
			"finish",
			"steered: finish",
		]);
		expect([slots.running, slots.queued]).toEqual([0, 0]);
	});

	it("resumes into the queue when no slot is free", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const firstRun = first.run("Task: wait");
		await vi.waitFor(() => expect(texts(first)).toEqual(["Task: wait"]));
		await first.pause();
		const second = createSubagent("hang", { id: "second", slots });
		const secondRun = second.run("Task: other");
		await vi.waitFor(() => expect(texts(second)).toEqual(["Task: other"]));

		await first.resume();

		expect(first.isQueued).toBe(true);
		await second.send("done");
		await secondRun;
		await vi.waitFor(() => expect(texts(first).at(-1)).toBe(resumePrompt()));
		await first.abort();
		await firstRun;
		expect(first.status).toBe("aborted");
	});

	it("pauses a queued subagent and sends its task when it resumes", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const second = createSubagent("echo", { id: "second", slots });
		const firstRun = first.run("Task: wait");
		const secondRun = second.run("Task: next");
		await vi.waitFor(() => expect(second.isQueued).toBe(true));

		await second.pause();
		expect(second.isPaused).toBe(true);
		expect(slots.queued).toBe(0);
		await expect(second.handback()).rejects.toThrow("paused before it started");

		await second.startNow("be quick");
		await secondRun;

		expect(texts(second)).toEqual([
			'Task: next\n<note from="orchestrator">\nbe quick\n</note>',
			'echo: Task: next\n<note from="orchestrator">\nbe quick\n</note>',
		]);
		await first.abort();
		await firstRun;
		expect([slots.running, slots.queued]).toEqual([0, 0]);
	});

	it("starts a queued subagent ahead of the queue, past the limit, without starting the others", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const second = createSubagent("echo", { id: "second", slots });
		const third = createSubagent("echo", { id: "third", slots });
		const firstRun = first.run("Task: wait");
		const secondRun = second.run("Task: second");
		const thirdRun = third.run("Task: third");
		await vi.waitFor(() => expect(texts(first)).toEqual(["Task: wait"]));

		await third.startNow();
		await thirdRun;

		expect(third.getFinalOutput()).toBe("echo: Task: third");
		expect(second.isQueued).toBe(true);
		expect([slots.running, slots.queued]).toEqual([1, 1]);

		await first.send("finish");
		await Promise.all([firstRun, secondRun]);
		expect(second.getFinalOutput()).toBe("echo: Task: second");
	});

	it("asks a running subagent to hand back by steering it", async () => {
		const subagent = createSubagent("hang");
		const running = subagent.run("Task: wait");
		await vi.waitFor(() => expect(texts(subagent)).toEqual(["Task: wait"]));

		await subagent.handback("include file names");
		await running;

		expect(subagent.status).toBe("done");
		expect(subagent.getFinalOutput()).toBe(`steered: ${handbackPrompt("include file names")}`);
	});

	it("resumes a paused subagent to hand back, and terminates a paused one", async () => {
		const reporter = createSubagent("auto", { id: "reporter" });
		const reporterRun = reporter.run("Task: slow job");
		await vi.waitFor(() => expect(texts(reporter)).toEqual(["Task: slow job"]));
		await reporter.pause();

		await reporter.handback();
		await reporterRun;

		expect(reporter.status).toBe("done");
		expect(reporter.getFinalOutput()).toBe(`echo: ${handbackPrompt()}`);

		const dropped = createSubagent("hang", { id: "dropped" });
		const droppedRun = dropped.run("Task: wait");
		await vi.waitFor(() => expect(texts(dropped)).toEqual(["Task: wait"]));
		await dropped.pause();
		await dropped.abort();
		await droppedRun;
		expect(dropped.status).toBe("aborted");
		await expect(dropped.resume()).rejects.toThrow("not paused");
	});
});

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function toolResults(session: Harness, toolName: string): ToolResultMessage[] {
	return session.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

describe("subagent_control tool", () => {
	it("starts a queued subagent now, pauses and resumes another, and holds chat for the paused one", async () => {
		const extension = createSubagentExtension({
			command: { executable: process.execPath, args: [fakeChild, "auto"] },
		});
		harness = await createHarness({ extensionFactories: [{ name: "subagent", factory: extension }] });
		const dir = join(harness.tempDir, ".pi", "subagents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ maxConcurrent: 1 }));
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });
		harness.setResponses([
			call("subagent", {
				background: true,
				tasks: [
					{ agent: "scout", task: "slow one", name: "one", description: "First" },
					{ agent: "scout", task: "echo two", name: "two", description: "Second" },
				],
			}),
			call("subagent_control", { action: "start", names: ["two"] }),
			call("subagent_wait", { names: ["two"] }),
			call("subagent_control", { action: "pause", names: ["one", "ghost"] }),
			call("subagent_list", {}),
			call("chat_send", { to: "one", text: "check b.ts too" }),
			call("subagent_wait", {}),
			call("subagent_control", { action: "resume", names: ["one"], message: "focus on a.ts" }),
			call("subagent_wait", {}),
			call("subagent_result", { names: ["one"] }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Juggle two subagents");

		const [start, pause, resume] = toolResults(harness, "subagent_control");
		expect(getMessageText(start)).toBe("- two: started ahead of the queue\nSlots: 2 of 1 in use, 0 queued.");
		expect(getMessageText(pause)).toBe(
			[
				"- one: paused; its slot is free",
				"- ghost: unknown subagent. List this session's subagents with subagent_list.",
				"Slots: 0 of 1 in use, 0 queued.",
			].join("\n"),
		);
		expect(pause.isError).toBeFalsy();
		expect(getMessageText(toolResults(harness, "subagent_list")[0])).toBe(
			[
				"Subagents: 0 running, 0 queued, 1 paused, 1 finished (1 result not read).",
				"- one (First): paused",
				"- two (Second): done, 1 turn; result not read",
			].join("\n"),
		);
		expect(getMessageText(toolResults(harness, "chat_send")[0])).toBe(
			"Held for one, which is paused; it gets the message when it resumes.",
		);
		const [, pausedWait, finalWait] = toolResults(harness, "subagent_wait");
		expect(getMessageText(pausedWait)).toBe(
			[
				"No target is running or queued.",
				"- one (First): paused",
				"Paused, so not waited for: one. Resume them or ask for a handback with subagent_control.",
			].join("\n"),
		);
		expect(getMessageText(resume)).toContain("- one: resumed");
		expect(getMessageText(finalWait)).toContain("All targets finished.\n- one (First): done");
		// Paused before or after its task reached it, the resumed subagent gets the orchestrator's note.
		expect(getMessageText(toolResults(harness, "subagent_result")[0])).toContain(
			'<note from="orchestrator">\nfocus on a.ts\n</note>',
		);
	}, 20_000);
});
