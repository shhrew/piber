import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { createSubagentExtension } from "../../../src/extensions/subagent/index.ts";
import type { SubagentToolDetails } from "../../../src/extensions/subagent/render.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));
const NOTICE_TYPE = "subagent-background-complete";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

/** A session whose subagents run the fake child: they echo their task, after 1.5 s when it mentions "slow". */
async function createSession(projectConfig?: Record<string, unknown>): Promise<Harness> {
	const extension = createSubagentExtension({ command: { executable: process.execPath, args: [fakeChild, "auto"] } });
	const created = await createHarness({ extensionFactories: [{ name: "subagent", factory: extension }] });
	if (projectConfig) {
		const dir = join(created.tempDir, ".pi", "subagents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify(projectConfig));
	}
	created.settingsManager.setProjectTrusted(true);
	await created.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });
	return created;
}

function toolResults(session: Harness, toolName: string): ToolResultMessage[] {
	return session.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

function notices(session: Harness): CustomMessage[] {
	return session.session.messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === NOTICE_TYPE,
	);
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

describe("background subagents", () => {
	it("returns at once, then waits for all and reads the result, without a separate notice", async () => {
		harness = await createSession();
		harness.setResponses([
			call("subagent", { agent: "scout", task: "echo me", name: "bg", description: "Echo me", background: true }),
			call("subagent_wait", {}),
			call("subagent_result", { names: ["bg"] }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delegate in the background");

		const [launch] = toolResults(harness, "subagent");
		expect(getMessageText(launch)).toContain("Started in the background: bg (Echo me).");
		expect(launch.details).toMatchObject({ background: true, live: true } satisfies Partial<SubagentToolDetails>);
		expect(getMessageText(toolResults(harness, "subagent_wait")[0])).toContain(
			"All targets finished.\n- bg (Echo me): done, 1 turn",
		);
		expect(getMessageText(toolResults(harness, "subagent_result")[0])).toBe(
			'### bg (done)\n\necho: Task: echo me\n\n[subagent bg; continue it with session: "bg"]',
		);

		// The wait already reported bg, so the batched notice must not repeat it.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(notices(harness)).toEqual([]);
	});

	it("wakes the orchestrator with a notice when a background subagent finishes unwatched", async () => {
		harness = await createSession();
		harness.setResponses([
			call("subagent", { agent: "scout", task: "echo me", name: "solo", description: "Echo me", background: true }),
			fauxAssistantMessage("launched"),
			fauxAssistantMessage("noted"),
		]);

		await harness.session.prompt("Delegate and carry on");

		await vi.waitFor(
			() => {
				expect(notices(harness!)).toHaveLength(1);
				expect(harness!.getPendingResponseCount()).toBe(0);
			},
			{ timeout: 10_000 },
		);
		expect(getMessageText(notices(harness)[0])).toBe(
			"Background subagents finished:\n- solo (Echo me): done, 1 turn\nRead their results with subagent_result.",
		);
		await vi.waitFor(() => expect(harness!.session.messages.at(-1)).toMatchObject({ role: "assistant" }));
	});

	it('returns from a wait in "any" mode when the first target finishes', async () => {
		harness = await createSession();
		harness.setResponses([
			call("subagent", {
				background: true,
				tasks: [
					{ agent: "scout", task: "echo fast", name: "fast", description: "Fast job" },
					{ agent: "scout", task: "slow job", name: "slow", description: "Slow job" },
				],
			}),
			call("subagent_wait", { mode: "any" }),
			fauxAssistantMessage("one done"),
			// The slow subagent's notice starts another turn later.
			fauxAssistantMessage("noted"),
		]);

		await harness.session.prompt("Run two");

		const waitText = getMessageText(toolResults(harness, "subagent_wait")[0]);
		expect(waitText).toContain("A subagent finished.");
		expect(waitText).toContain("- fast (Fast job): done, 1 turn");
		expect(waitText).toContain("- slow (Slow job): running");
		expect(waitText).toContain("Read results with subagent_result: fast.");

		await vi.waitFor(() => expect(notices(harness!)).toHaveLength(1), { timeout: 10_000 });
		expect(getMessageText(notices(harness)[0])).toContain("- slow (Slow job): done");
		expect(getMessageText(notices(harness)[0])).not.toContain("fast");
	});

	it("follows the project config: background by default, and silent completion", async () => {
		harness = await createSession({ defaultMode: "background", onBackgroundComplete: "silent" });
		harness.setResponses([
			call("subagent", { agent: "scout", task: "echo me", name: "quiet", description: "Quiet job" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delegate");

		expect(getMessageText(toolResults(harness, "subagent")[0])).toContain("Started in the background: quiet");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(notices(harness)).toEqual([]);
	});

	it("reports results that are not ready and names that are unknown", async () => {
		harness = await createSession();
		harness.setResponses([
			call("subagent", {
				agent: "scout",
				task: "slow job",
				name: "busy",
				description: "Busy job",
				background: true,
			}),
			call("subagent_result", { names: ["busy", "ghost"] }),
			call("subagent_wait", { names: ["ghost"] }),
			call("subagent_wait", { names: ["busy"] }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Check early");

		expect(getMessageText(toolResults(harness, "subagent_result")[0])).toBe(
			"### busy (running)\n\nStill running; wait for it with subagent_wait.\n\n---\n\n### ghost\n\nUnknown subagent.",
		);
		const [unknownWait, namedWait] = toolResults(harness, "subagent_wait");
		expect(unknownWait.isError).toBe(true);
		expect(getMessageText(unknownWait)).toBe("Unknown subagents: ghost. Known: busy.");
		expect(getMessageText(namedWait)).toContain("- busy (Busy job): done, 1 turn");
	});
});
