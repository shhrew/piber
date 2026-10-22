import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Subagent, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";
import { createTestUiContext } from "../harness.ts";

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

describe("subagent process", () => {
	it("runs a prompt to completion, records the transcript and usage, and continues with a follow-up", async () => {
		const subagent = createSubagent("echo");
		const registry = new SubagentRegistry();
		registry.add(subagent);
		const changes = vi.fn();
		registry.onChange(changes);

		await subagent.run("Task: Do the thing");

		expect(subagent.status).toBe("done");
		expect(subagent.isRunning).toBe(false);
		expect(subagent.sessionFile).toBe("/fake/session.jsonl");
		expect(subagent.model).toBe("faux/fake-model");
		expect(subagent.getFinalOutput()).toBe("echo: Task: Do the thing");
		expect(subagent.usage).toMatchObject({ turns: 1, input: 10, output: 5, cost: 0.01 });
		expect(changes).toHaveBeenCalled();
		expect(registry.find("/fake/session.jsonl")).toBe(subagent);

		await subagent.send("And another");

		expect(texts(subagent)).toEqual([
			"Task: Do the thing",
			"echo: Task: Do the thing",
			"And another",
			"echo: And another",
		]);
		expect(subagent.usage.turns).toBe(2);
	});

	it("steers a running subagent", async () => {
		const subagent = createSubagent("hang");
		const running = subagent.run("Task: wait");
		await vi.waitFor(() => expect(texts(subagent)).toEqual(["Task: wait"]));

		await subagent.send("go left");
		await running;

		expect(subagent.status).toBe("done");
		expect(subagent.getFinalOutput()).toBe("steered: go left");
	});

	it("aborts when the signal aborts", async () => {
		const subagent = createSubagent("hang");
		const controller = new AbortController();
		const running = subagent.run("Task: wait", controller.signal);
		await vi.waitFor(() => expect(texts(subagent)).toEqual(["Task: wait"]));

		controller.abort();
		await running;

		expect(subagent.status).toBe("aborted");
	});

	it("fails instead of hanging when the child process dies", async () => {
		const subagent = createSubagent("crash");

		await subagent.run("Task: crash");

		expect(subagent.status).toBe("failed");
		expect(subagent.errorMessage).toContain("code=3");
	});

	it("forwards the child's dialogs to the parent UI, labeled with the agent name", async () => {
		const confirm = vi.fn(async () => true);
		const subagent = createSubagent("confirm", { ui: createTestUiContext({ confirm }) });

		await subagent.run("Task: ask");

		expect(confirm).toHaveBeenCalledWith("[worker] Proceed?", "Run it", { timeout: undefined });
		expect(subagent.getFinalOutput()).toBe("confirmed: true");
	});

	it("cancels the child's dialogs when there is no parent UI", async () => {
		const subagent = createSubagent("confirm");

		await subagent.run("Task: ask");

		expect(subagent.getFinalOutput()).toBe("confirmed: false");
	});

	it("queues runs beyond the slot limit and starts them when a slot frees up", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const second = createSubagent("echo", { id: "second", slots });

		const firstRun = first.run("Task: wait");
		const secondRun = second.run("Task: next");
		await vi.waitFor(() => expect(texts(first)).toEqual(["Task: wait"]));

		expect(second.status).toBe("queued");
		expect(second.isQueued).toBe(true);
		expect(second.isRunning).toBe(false);
		await expect(second.send("hello")).rejects.toThrow("queued");

		await first.send("finish");
		await Promise.all([firstRun, secondRun]);

		expect(first.status).toBe("done");
		expect(second.status).toBe("done");
		expect(second.getFinalOutput()).toBe("echo: Task: next");
		expect([slots.running, slots.queued]).toEqual([0, 0]);
	});

	it("cancels a queued run without starting its process", async () => {
		const slots = new SlotPool(1);
		const first = createSubagent("hang", { id: "first", slots });
		const second = createSubagent("echo", { id: "second", slots });
		const firstRun = first.run("Task: wait");
		const secondRun = second.run("Task: never");
		await vi.waitFor(() => expect(second.status).toBe("queued"));

		await second.abort();
		await secondRun;

		expect(second.status).toBe("aborted");
		expect(second.messages).toEqual([]);
		expect(second.sessionFile).toBeUndefined();

		await first.abort();
		await firstRun;
		expect([slots.running, slots.queued]).toEqual([0, 0]);
	});
});
