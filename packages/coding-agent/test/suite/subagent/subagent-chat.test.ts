import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { discoverAgents } from "../../../src/extensions/subagent/agents.ts";
import {
	CHAT_FLAG,
	CHAT_LOG_LIMIT,
	CHAT_MESSAGE_TYPE,
	CHAT_TOKEN_ENV,
	ChatClient,
	type ChatDelivery,
	ChatHub,
	ChatLog,
	type ChatPeer,
	frameMessage,
	ORCHESTRATOR,
	resolvePermissions,
} from "../../../src/extensions/subagent/chat.ts";
import subagentExtension, {
	chatPromptSection,
	createSubagentExtension,
	planSubagentRun,
} from "../../../src/extensions/subagent/index.ts";
import { type ChatConfig, type ChatPermission, loadSubagentConfig } from "../../../src/extensions/subagent/paths.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("chat permissions and prompts", () => {
	it("resolves canMessage words, with all implying everything", () => {
		expect(resolvePermissions([])).toEqual({ orchestrator: false, subagents: false, broadcast: false });
		expect(resolvePermissions(["orchestrator"])).toEqual({ orchestrator: true, subagents: false, broadcast: false });
		expect(resolvePermissions(["subagents"])).toEqual({ orchestrator: false, subagents: true, broadcast: false });
		expect(resolvePermissions(["all"])).toEqual({ orchestrator: true, subagents: true, broadcast: true });
	});

	it("frames messages so the recipient knows the user did not write them", () => {
		const delivery: ChatDelivery = {
			id: "m1",
			from: "scout-a",
			to: "worker",
			text: "Found it in src/a.ts",
			awaitingReply: true,
		};
		expect(frameMessage(delivery, false)).toBe(
			[
				"[Chat message from scout-a (a subagent) to you, not from the user]",
				"Found it in src/a.ts",
				'scout-a is blocked waiting for your reply: answer now with chat_send to "scout-a", even if only to say you got it.',
			].join("\n"),
		);
		const broadcast = { id: "m2", from: ORCHESTRATOR, to: "all", text: "Stop editing a.ts", awaitingReply: false };
		expect(frameMessage(broadcast, false).split("\n")[0]).toBe(
			"[Chat message from the orchestrator to everyone, not from the user]",
		);
		expect(frameMessage({ ...delivery, awaitingReply: false }, true).split("\n")[0]).toBe(
			"[Chat message from scout-a (one of your subagents) to you, not from the user]",
		);
	});

	it("gives subagents the global prompt, and the chat tools only when they may send", () => {
		const worker = discoverAgents(process.cwd(), false).agents.find((agent) => agent.name === "worker")!;

		const plan = planSubagentRun(worker, {}, null);
		expect(plan.systemPrompt.startsWith("# Working as a subagent")).toBe(true);
		expect(plan.systemPrompt).toContain("You are a worker agent");
		expect(plan.tools).toContain("chat_send");
		expect(plan.chatRights).toEqual(
			resolvePermissions(worker.canMessage ?? loadSubagentConfig(null).chat.defaultCanMessage),
		);

		const silent = planSubagentRun({ ...worker, canMessage: [] }, {}, null);
		expect(silent.tools).not.toContain("chat_send");
		expect(silent.chatRights).toEqual({ orchestrator: false, subagents: false, broadcast: false });
	});

	it("tells each subagent its chat name and who it may message", () => {
		expect(chatPromptSection("scout-a", resolvePermissions(["orchestrator", "subagents"]))).toBe(
			[
				"## Your chat permissions",
				'Your name in chat is "scout-a". You can message the orchestrator (to: "orchestrator"), other subagents by name (see chat_peers).',
			].join("\n"),
		);
		expect(chatPromptSection("quiet", resolvePermissions([]))).toContain(
			"You cannot send chat messages, but other agents may message you.",
		);
	});

	it("never names a subagent after a chat address", () => {
		const registry = new SubagentRegistry();
		expect(registry.createId("orchestrator")).toBe("orchestrator-2");
		expect(registry.createId("All")).toBe("all-2");
	});
});

/** A hub over a real socket, with subagents described by `peers` and messages to the orchestrator collected. */
function createHub(overrides: Partial<ChatConfig> = {}) {
	const peers = new Map<string, ChatPeer>();
	const toOrchestrator: ChatDelivery[] = [];
	const config: ChatConfig = { ...loadSubagentConfig(null).chat, ...overrides };
	const log = new ChatLog();
	const hub = new ChatHub({
		directory: { find: (name) => peers.get(name), list: () => [...peers.values()] },
		config: () => config,
		deliverToOrchestrator: (delivery) => toOrchestrator.push(delivery),
		log,
	});
	cleanups.push(() => hub.close());

	/** Register a subagent; `connect` then plays its process. */
	const join = (name: string, words: ChatPermission[], state: ChatPeer["state"] = "running") => {
		const peer: ChatPeer = { name, description: `${name} job`, agent: "worker", state };
		peers.set(name, peer);
		const token = hub.register(name, resolvePermissions(words));
		const connect = async () => {
			const inbox: ChatDelivery[] = [];
			const client = new ChatClient(hub.address(), token, (delivery) => inbox.push(delivery));
			cleanups.push(() => client.close());
			await client.connect();
			return { client, inbox };
		};
		return { peer, token, connect };
	};
	return { hub, peers, join, toOrchestrator, log };
}

describe("chat hub", () => {
	it("routes between subagents and to the orchestrator, and refuses what is not allowed", async () => {
		const { hub, join, toOrchestrator } = createHub();
		const scout = await join("scout", ["orchestrator", "subagents"]).connect();
		const worker = await join("worker", ["orchestrator"]).connect();
		join("done", [], "finished");

		expect(await scout.client.send({ to: "worker", text: "Use src/auth.ts" })).toEqual({
			ok: true,
			text: "Delivered to worker.",
			outcome: "delivered",
		});
		await vi.waitFor(() =>
			expect(worker.inbox).toEqual([
				{ id: expect.any(String), from: "scout", to: "worker", text: "Use src/auth.ts", awaitingReply: false },
			]),
		);
		expect(await worker.client.send({ to: "orchestrator", text: "Blocked on config" })).toMatchObject({ ok: true });
		expect(toOrchestrator).toEqual([
			{
				id: expect.any(String),
				from: "worker",
				to: "orchestrator",
				text: "Blocked on config",
				awaitingReply: false,
			},
		]);

		expect(await worker.client.send({ to: "scout", text: "hi" })).toEqual({
			ok: false,
			text: "You are not allowed to message other subagents.",
			outcome: "refused",
		});
		expect((await scout.client.send({ to: "scout", text: "me" })).text).toBe("You cannot message yourself.");
		expect((await scout.client.send({ to: "done", text: "x" })).text).toBe(
			"done has finished and cannot receive messages.",
		);
		expect((await scout.client.send({ to: "ghost", text: "x" })).text).toBe(
			'There is no subagent named "ghost". Subagents: worker, done.',
		);
		expect((await scout.client.send({ to: "all", text: "x" })).text).toBe("You are not allowed to message everyone.");
		expect(await hub.send(ORCHESTRATOR, { to: "worker", text: "Carry on" })).toEqual({
			ok: true,
			text: "Delivered to worker.",
			outcome: "delivered",
		});
	});

	it("holds messages for queued subagents until they connect", async () => {
		const { hub, peers, join } = createHub();
		const later = join("later", ["orchestrator"], "queued");

		expect((await hub.send(ORCHESTRATOR, { to: "later", text: "Start with a.ts" })).text).toBe(
			"Held for later, which has not started yet; it gets the message when it starts.",
		);

		peers.get("later")!.state = "running";
		const { inbox } = await later.connect();
		await vi.waitFor(() => expect(inbox.map((delivery) => delivery.text)).toEqual(["Start with a.ts"]));
	});

	it("refuses an unknown token", async () => {
		const { hub } = createHub();
		const intruder = new ChatClient(hub.address(), "not-a-token", () => {});
		cleanups.push(() => intruder.close());
		await expect(intruder.connect(300)).rejects.toThrow();
	});

	it("broadcasts to everyone still running, holding for queued ones, never for finished ones", async () => {
		const { hub, join, toOrchestrator } = createHub();
		const lead = await join("lead", ["all"]).connect();
		const helper = await join("helper", ["orchestrator"]).connect();
		join("waiting", [], "queued");
		join("gone", [], "finished");

		expect(await lead.client.send({ to: "all", text: "Switching to plan B" })).toEqual({
			ok: true,
			text: "Sent to everyone: 2 delivered, 1 held until they start.",
			outcome: "broadcast",
		});
		await vi.waitFor(() => expect(helper.inbox.map((delivery) => delivery.to)).toEqual(["all"]));
		expect(toOrchestrator.map((delivery) => delivery.from)).toEqual(["lead"]);
		expect((await lead.client.send({ to: "all", text: "?", waitForReply: true })).text).toBe(
			'waitForReply cannot be used with to: "all".',
		);
		expect((await hub.send(ORCHESTRATOR, { to: "all", text: "Wrap up" })).text).toBe(
			"Sent to everyone: 2 delivered, 1 held until they start.",
		);
	});

	it("enforces the length and rate limits", async () => {
		const { join } = createHub({ maxMessageLength: 10, maxMessagesPerMinute: 2 });
		const chatty = await join("chatty", ["orchestrator"]).connect();

		expect((await chatty.client.send({ to: "orchestrator", text: "x".repeat(11) })).text).toBe(
			"The message is 11 characters; the limit is 10. Shorten it.",
		);
		expect((await chatty.client.send({ to: "orchestrator", text: "one" })).ok).toBe(true);
		expect((await chatty.client.send({ to: "orchestrator", text: "two" })).ok).toBe(true);
		expect((await chatty.client.send({ to: "orchestrator", text: "three" })).text).toBe(
			"You have sent 2 messages in the last minute; wait before sending more.",
		);
	});
});

describe("chat log", () => {
	it("records delivered, refused, held, and broadcast sends in order", async () => {
		const { hub, peers, join, log } = createHub();
		const scout = await join("scout", ["orchestrator", "all"]).connect();
		const later = join("later", [], "queued");

		await scout.client.send({ to: "orchestrator", text: "Found  it\nin a.ts" });
		await scout.client.send({ to: "scout", text: "nope" });
		await hub.send(ORCHESTRATOR, { to: "later", text: "Start with a.ts" });
		await scout.client.send({ to: "all", text: "Plan B" });

		const summary = () =>
			log.entries().map(({ from, to, text, held, refused }) => ({ from, to, text, held, refused }));
		expect(summary()).toEqual([
			{ from: "scout", to: "orchestrator", text: "Found  it\nin a.ts", held: 0, refused: undefined },
			{
				from: "scout",
				to: "scout",
				text: "nope",
				held: 0,
				refused: "You cannot message yourself.",
			},
			{ from: "orchestrator", to: "later", text: "Start with a.ts", held: 1, refused: undefined },
			{ from: "scout", to: "all", text: "Plan B", held: 1, refused: undefined },
		]);
		expect(log.entries()[1].id).toBe("");

		peers.get("later")!.state = "running";
		await later.connect();
		await vi.waitFor(() => expect(summary().map((entry) => entry.held)).toEqual([0, 0, 0, 0]));
	});

	it("records a send that waits for a reply when it is sent, not when the reply arrives", async () => {
		const { join, log } = createHub();
		const asker = await join("asker", ["subagents"]).connect();
		await join("answerer", ["subagents"]).connect();

		const pending = asker.client.send({ to: "answerer", text: "Ready?", waitForReply: true, timeoutSeconds: 30 });
		await vi.waitFor(() => expect(log.entries().map((entry) => entry.awaitingReply)).toEqual([true]));
		asker.client.close();
		await pending;
	});

	it("keeps at most CHAT_LOG_LIMIT entries and notifies listeners", () => {
		const log = new ChatLog();
		let changes = 0;
		const stop = log.onChange(() => changes++);
		for (let i = 0; i < CHAT_LOG_LIMIT + 5; i++) {
			log.add({ id: `m${i}`, at: 0, from: "a", to: "b", text: `${i}`, awaitingReply: false, held: 0 });
		}
		expect(log.entries()).toHaveLength(CHAT_LOG_LIMIT);
		expect(log.entries()[0].text).toBe("5");
		expect(changes).toBe(CHAT_LOG_LIMIT + 5);
		stop();
		log.clear();
		expect(changes).toBe(CHAT_LOG_LIMIT + 5);
		expect(log.entries()).toEqual([]);
	});
});

describe("waiting for replies", () => {
	it("returns the target's reply", async () => {
		const { hub, join } = createHub();
		const asker = await join("asker", ["subagents"]).connect();
		const answerer = await join("answerer", ["subagents"]).connect();

		const asking = asker.client.send({ to: "answerer", text: "Which file?", waitForReply: true });
		await vi.waitFor(() => expect(answerer.inbox).toHaveLength(1));
		expect(answerer.inbox[0].awaitingReply).toBe(true);
		expect(hub.isAwaitingReply(answerer.inbox[0].id)).toBe(true);
		await answerer.client.send({ to: "asker", text: "src/auth.ts" });

		expect(await asking).toMatchObject({
			ok: true,
			text: "answerer replied:\nsrc/auth.ts",
			outcome: "reply",
			message: { from: "answerer", text: "src/auth.ts" },
		});
		expect(hub.isAwaitingReply(answerer.inbox[0].id)).toBe(false);
		expect(asker.inbox).toEqual([]);
	});

	it("ends the wait when someone else messages the waiter, instead of delivering it twice", async () => {
		const { join } = createHub();
		const asker = await join("asker", ["subagents"]).connect();
		await join("slow", ["subagents"]).connect();
		const other = await join("other", ["subagents"]).connect();

		const asking = asker.client.send({ to: "slow", text: "Which file?", waitForReply: true });
		await vi.waitFor(async () =>
			expect((await other.client.send({ to: "asker", text: "Stop: a.ts is mine" })).ok).toBe(true),
		);

		const result = await asking;
		expect(result.text).toContain("While you waited for slow, other messaged you:\nStop: a.ts is mine");
		expect(result.text).toContain("You stopped waiting for slow; its reply will arrive as a chat message.");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(asker.inbox).toEqual([]);
	});

	it("resolves two agents waiting on each other", async () => {
		const { join } = createHub();
		const a = await join("a", ["subagents"]).connect();
		const b = await join("b", ["subagents"]).connect();

		const aWaits = a.client.send({ to: "b", text: "Done with x?", waitForReply: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const bWaits = b.client.send({ to: "a", text: "Done with y?", waitForReply: true });

		// b's question ends a's wait as its reply; b then waits until a answers.
		expect((await aWaits).text).toBe("b replied:\nDone with y?");
		await a.client.send({ to: "b", text: "Yes" });
		expect((await bWaits).text).toBe("a replied:\nYes");
	});

	it("times out, and a later reply then arrives as a normal message", async () => {
		const { join } = createHub();
		const asker = await join("asker", ["subagents"]).connect();
		const quiet = await join("quiet", ["subagents"]).connect();

		const result = await asker.client.send({ to: "quiet", text: "Anyone?", waitForReply: true, timeoutSeconds: 1 });
		expect(result.text).toBe("Sent to quiet. No reply within 1 s; a later reply will arrive as a chat message.");

		await quiet.client.send({ to: "asker", text: "Late answer" });
		await vi.waitFor(() => expect(asker.inbox.map((delivery) => delivery.text)).toEqual(["Late answer"]));
	});

	it("stops waiting when the call is aborted", async () => {
		const { join } = createHub();
		const asker = await join("asker", ["subagents"]).connect();
		await join("quiet", ["subagents"]).connect();
		const controller = new AbortController();

		const asking = asker.client.send({ to: "quiet", text: "Anyone?", waitForReply: true }, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();

		expect(await asking).toEqual({ ok: false, text: "Stopped waiting for a reply.", outcome: "stopped" });
	});
});

function chatMessages(session: Harness): CustomMessage<ChatDelivery>[] {
	return session.session.messages.filter(
		(message): message is CustomMessage<ChatDelivery> =>
			message.role === "custom" && message.customType === CHAT_MESSAGE_TYPE,
	);
}

describe("chat in a subagent process", () => {
	it("joins the parent's hub at session start, sends with chat_send, and receives messages", async () => {
		const { hub, join, toOrchestrator } = createHub();
		const { token } = join("child", ["orchestrator"]);
		const extensionsResult = await createTestExtensionsResult([{ name: "subagent", factory: subagentExtension }]);
		extensionsResult.runtime.flagValues.set(CHAT_FLAG, hub.address());
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["chat_send", "chat_peers"],
		});
		cleanups.push(() => harness.cleanup());
		const previous = process.env[CHAT_TOKEN_ENV];
		process.env[CHAT_TOKEN_ENV] = token;
		cleanups.push(() => {
			if (previous === undefined) delete process.env[CHAT_TOKEN_ENV];
			else process.env[CHAT_TOKEN_ENV] = previous;
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("chat_send", { to: "orchestrator", text: "Found the bug" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("chat_peers", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Report back");

		expect(toOrchestrator).toEqual([
			{ id: expect.any(String), from: "child", to: "orchestrator", text: "Found the bug", awaitingReply: false },
		]);
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(getMessageText(results[0])).toBe("Delivered to orchestrator.");
		expect(getMessageText(results[1])).toBe("You are child. You can message:\n- orchestrator");

		await hub.send(ORCHESTRATOR, { to: "child", text: "Also check b.ts" });
		await vi.waitFor(() => expect(chatMessages(harness)).toHaveLength(1));
		expect(getMessageText(chatMessages(harness)[0])).toContain("[Chat message from the orchestrator to you");
		expect(getMessageText(chatMessages(harness)[0])).toContain("Also check b.ts");
	});
});

describe("chat from a real subagent process to the orchestrator", () => {
	it("passes the hub to the subagent, and its message wakes the idle orchestrator", async () => {
		const extension = createSubagentExtension({
			command: { executable: process.execPath, args: [fakeChild, "auto"] },
		});
		const harness = await createHarness({ extensionFactories: [{ name: "subagent", factory: extension }] });
		cleanups.push(() => harness.cleanup());
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", {
					agent: "scout",
					task: "tell orchestrator: found the bug in a.ts",
					name: "finder",
					description: "Find the bug",
					background: true,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("launched"),
			// The chat message wakes the orchestrator; then the completion notice does.
			fauxAssistantMessage("got the message"),
			fauxAssistantMessage("noted"),
		]);

		await harness.session.prompt("Find it in the background");

		await vi.waitFor(
			() => expect(chatMessages(harness).map((message) => message.details?.text)).toEqual(["found the bug in a.ts"]),
			{
				timeout: 10_000,
			},
		);
		expect(chatMessages(harness)[0].details?.from).toBe("finder");
		expect(getMessageText(chatMessages(harness)[0])).toContain(
			"[Chat message from finder (one of your subagents) to you",
		);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 10_000 });
	}, 20_000);
});
