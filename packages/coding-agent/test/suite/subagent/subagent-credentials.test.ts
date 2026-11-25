import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { discoverAgents } from "../../../src/extensions/subagent/agents.ts";
import { ChatClient, ChatHub, ORCHESTRATOR, resolvePermissions } from "../../../src/extensions/subagent/chat.ts";
import {
	CREDENTIAL_NOTICE_TYPE,
	CREDENTIALS_FILE,
	type Credential,
	CredentialBoard,
	type CredentialRequest,
	CredentialStore,
	frameCredentialNotice,
	normalizeCredentialLabel,
} from "../../../src/extensions/subagent/credentials.ts";
import { createSubagentExtension, planSubagentRun } from "../../../src/extensions/subagent/index.ts";
import { loadSubagentConfig } from "../../../src/extensions/subagent/paths.ts";
import {
	renderCredentialNotice,
	renderCredentialReadResult,
	renderCredentialWriteResult,
} from "../../../src/extensions/subagent/render.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-credentials-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A board, recording what it announces. */
function createBoard(store = new CredentialStore()) {
	const announced: Array<{ id: number; from: string }> = [];
	const board = new CredentialBoard({
		store,
		config: () => loadSubagentConfig(null).credentials,
		announce: (credential, from) => announced.push({ id: credential.id, from }),
	});
	return { board, store, announced };
}

const add = (label: string, purpose = `use ${label}`, value = `secret-${label}`): CredentialRequest => ({
	action: "add",
	label,
	purpose,
	value,
});

describe("credential store", () => {
	it("numbers credentials from 1, records the adder, and announces each add", () => {
		const { board, announced } = createBoard();
		const added = board.handle("alpha", add("github-ci-token", "push to the CI repo", "ghp_xxx"));
		expect(added).toMatchObject({
			ok: true,
			text: "Stored credential 1 (github-ci-token). The orchestrator and every subagent were told.",
		});
		expect(added.credentials[0]).toMatchObject({
			id: 1,
			from: "alpha",
			label: "github-ci-token",
			purpose: "push to the CI repo",
			value: "ghp_xxx",
		});
		board.handle("bravo", add("npm-token"));
		expect(announced).toEqual([
			{ id: 1, from: "alpha" },
			{ id: 2, from: "bravo" },
		]);
	});

	it("normalizes the label and refuses empty fields", () => {
		const { board, store } = createBoard();
		expect(normalizeCredentialLabel("GitHub CI Token!")).toBe("github-ci-token");
		expect(board.handle("alpha", add("!!!")).text).toBe(
			"The label is empty. Use a short slug, such as github-ci-token.",
		);
		expect(board.handle("alpha", { action: "add", label: "a", purpose: " ", value: "x" }).text).toBe(
			"Say what the credential is for in purpose.",
		);
		expect(board.handle("alpha", { action: "add", label: "a", purpose: "p", value: "" }).text).toBe(
			"The value is empty.",
		);
		expect(store.list()).toEqual([]);

		const off = new CredentialBoard({
			store: new CredentialStore(),
			config: () => ({ enabled: false }),
			announce: () => {},
		});
		expect(off.handle("alpha", add("a"))).toEqual({
			ok: false,
			text: "Credentials are turned off.",
			credentials: [],
		});
	});

	it("reads by id with the value, and lists without it", () => {
		const { board } = createBoard();
		board.handle("alpha", add("github-ci-token", "push to the CI repo", "ghp_xxx"));
		board.handle("bravo", add("npm-token", "publish", "npm_yyy"));

		expect(board.handle("alpha", { action: "get", ids: [1, 9] })).toMatchObject({
			ok: true,
			text: [
				"Credential 1: github-ci-token",
				"From alpha, for: push to the CI repo",
				"Value: ghp_xxx",
				"",
				"There is no credential 9.",
			].join("\n"),
		});
		expect(board.handle("alpha", { action: "get", ids: [9] }).ok).toBe(false);

		const listed = board.handle("alpha", { action: "list" });
		expect(listed.text).toBe(
			[
				"2 credentials:",
				"- 1 github-ci-token (alpha): push to the CI repo",
				"- 2 npm-token (bravo): publish",
				"Read one's value with get_credential.",
			].join("\n"),
		);
		expect(listed.text).not.toContain("ghp_xxx");
		expect(board.handle("alpha", { action: "list", from: "bravo" }).credentials.map((c) => c.id)).toEqual([2]);
	});

	it("frames the announcement with the value", () => {
		const { board } = createBoard();
		const credential = board.handle("scout-a", add("github-ci-token", "push to the CI repo", "ghp_secret"))
			.credentials[0];
		expect(frameCredentialNotice([credential])).toBe(
			[
				"<agent_credentials>",
				"A subagent stored these credentials for the whole session; the user did not write this. Use them where they apply, and read any later with get_credential.",
				"- #1 github-ci-token (from scout-a) for: push to the CI repo",
				"  value: ghp_secret",
				"</agent_credentials>",
			].join("\n"),
		);
	});

	it("persists to JSONL and reloads, continuing the ids", () => {
		const file = join(tempDir(), "subagents", "session-1", CREDENTIALS_FILE);
		const store = new CredentialStore();
		store.open(file);
		const { board } = createBoard(store);
		board.handle("alpha", add("github-ci-token"));
		board.handle("bravo", add("npm-token"));
		expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(2);
		appendFileSync(file, "not json\n");

		const reopened = new CredentialStore();
		reopened.open(file);
		expect(reopened.list().map((c) => [c.id, c.from, c.label])).toEqual([
			[1, "alpha", "github-ci-token"],
			[2, "bravo", "npm-token"],
		]);
		expect(createBoard(reopened).board.handle("alpha", add("next")).credentials[0].id).toBe(3);
		reopened.open(undefined);
		expect(reopened.list()).toEqual([]);
	});
});

describe("credentials over the chat hub", () => {
	/** A hub whose directory lists the given running subagents, with each one's deliveries collected. */
	async function createHub(names: string[]) {
		const store = new CredentialStore();
		// Wire the board to the hub as index.ts does: announcing a credential broadcasts it to the subagents.
		let hub: ChatHub;
		const board = new CredentialBoard({
			store,
			config: () => loadSubagentConfig(null).credentials,
			announce: (credential, from) => hub.broadcastCredential(credential, from),
		});
		const peers = names.map((name) => ({
			name,
			description: `${name} job`,
			agent: "worker",
			state: "running" as const,
		}));
		hub = new ChatHub({
			directory: { find: (n) => peers.find((p) => p.name === n), list: () => peers },
			config: () => loadSubagentConfig(null).chat,
			deliverToOrchestrator: () => {},
			credentials: board,
		});
		cleanups.push(() => hub.close());
		const clients: Record<string, { client: ChatClient; inbox: Credential[] }> = {};
		for (const name of names) {
			const inbox: Credential[] = [];
			const client = new ChatClient(
				hub.address(),
				hub.register(name, resolvePermissions([])),
				() => {},
				(credential) => inbox.push(credential),
			);
			cleanups.push(() => client.close());
			await client.connect();
			clients[name] = { client, inbox };
		}
		return { hub, board, store, clients };
	}

	it("announces a credential to every subagent except the one that added it", async () => {
		const { hub, clients } = await createHub(["alpha", "bravo", "charlie"]);
		const added = await clients.alpha.client.credential(add("github-ci-token", "push", "ghp_xxx"));
		expect(added).toMatchObject({ ok: true, credentials: [{ id: 1, from: "alpha", value: "ghp_xxx" }] });

		await vi.waitFor(() => {
			expect(clients.bravo.inbox.map((c) => c.id)).toEqual([1]);
			expect(clients.charlie.inbox.map((c) => c.id)).toEqual([1]);
		});
		expect(clients.bravo.inbox[0].value).toBe("ghp_xxx");
		// The adder does not get its own credential back.
		expect(clients.alpha.inbox).toEqual([]);
		// The orchestrator's own broadcast skips the adder path too; every subagent gets it.
		hub.broadcastCredential(
			{ id: 2, from: ORCHESTRATOR, label: "x", purpose: "y", value: "z", createdAt: 0 },
			ORCHESTRATOR,
		);
		await vi.waitFor(() => expect(clients.alpha.inbox.map((c) => c.id)).toEqual([2]));
	});

	it("holds a credential for a subagent that has not connected yet", async () => {
		let hub: ChatHub;
		const board = new CredentialBoard({
			store: new CredentialStore(),
			config: () => loadSubagentConfig(null).credentials,
			announce: (credential, from) => hub.broadcastCredential(credential, from),
		});
		const peers = [
			{ name: "early", description: "e", agent: "worker", state: "running" as const },
			{ name: "late", description: "l", agent: "worker", state: "queued" as const },
		];
		hub = new ChatHub({
			directory: { find: (n) => peers.find((p) => p.name === n), list: () => peers },
			config: () => loadSubagentConfig(null).chat,
			deliverToOrchestrator: () => {},
			credentials: board,
		});
		cleanups.push(() => hub.close());
		const early = new ChatClient(hub.address(), hub.register("early", resolvePermissions([])), () => {});
		cleanups.push(() => early.close());
		await early.connect();
		const lateToken = hub.register("late", resolvePermissions([]));

		await early.credential(add("github-ci-token"));
		// late is queued, so its announcement is held until it connects.
		const lateInbox: Credential[] = [];
		peers[1].state = "running";
		const late = new ChatClient(
			hub.address(),
			lateToken,
			() => {},
			(credential) => lateInbox.push(credential),
		);
		cleanups.push(() => late.close());
		await late.connect();
		await vi.waitFor(() => expect(lateInbox.map((c) => c.label)).toEqual(["github-ci-token"]));
	});

	it("refuses credential requests on a hub without a board", async () => {
		const hub = new ChatHub({
			directory: { find: () => undefined, list: () => [] },
			config: () => loadSubagentConfig(null).chat,
			deliverToOrchestrator: () => {},
		});
		cleanups.push(() => hub.close());
		const client = new ChatClient(hub.address(), hub.register("alpha", resolvePermissions([])), () => {});
		cleanups.push(() => client.close());
		await client.connect();
		expect((await client.credential(add("a"))).text).toBe("Credentials are turned off.");
	});
});

describe("credentials config and run planning", () => {
	it("gives subagents the credential tools only while credentials are enabled", () => {
		const worker = discoverAgents(process.cwd(), false).agents.find((agent) => agent.name === "worker")!;
		const plan = planSubagentRun(worker, {}, null);
		expect(plan.credentials).toBe(true);
		expect(plan.tools).toEqual(expect.arrayContaining(["add_credential", "get_credential", "list_credentials"]));

		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), JSON.stringify({ credentials: { enabled: false } }));
		const off = planSubagentRun(worker, {}, dir);
		expect(off.credentials).toBe(false);
		expect(off.tools).not.toContain("add_credential");
	});
});

describe("rendering credentials", () => {
	beforeAll(() => initTheme("dark"));
	const render = (component: { render(width: number): string[] }) =>
		component
			.render(120)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");

	it("shows the announcement as one line each, and the credential as JSON when expanded", () => {
		const { board, store } = createBoard();
		const credential = board.handle("scout-a", add("github-ci-token", "push to the CI repo", "ghp_xxx"))
			.credentials[0];
		const lookup = (id: number) => store.get(id);

		expect(render(renderCredentialNotice([credential], { expanded: false, outputPad: 0, lookup }, theme))).toBe(
			"⚷ #1 github-ci-token · scout-a · push to the CI repo",
		);
		const expanded = render(renderCredentialNotice([credential], { expanded: true, outputPad: 0, lookup }, theme));
		expect(expanded).toContain('"label": "github-ci-token"');
		expect(expanded).toContain('"value": "ghp_xxx"');
	});

	it("shows a credential tool's result, with the value only when expanded", () => {
		const { board } = createBoard();
		const result = board.handle("alpha", add("npm-token", "publish", "npm_zzz"));
		const options = { isError: false, outputPad: 0 };
		expect(render(renderCredentialWriteResult(result, result.text, { ...options, expanded: false }, theme))).toBe(
			"  ⎿  #1 npm-token · everyone told",
		);
		expect(render(renderCredentialWriteResult(result, result.text, { ...options, expanded: true }, theme))).toContain(
			'"value": "npm_zzz"',
		);

		const list = board.handle("alpha", { action: "list" });
		expect(
			render(renderCredentialReadResult(list, list.text, { ...options, expanded: false, list: true }, theme)),
		).toBe("  ⎿  1 credential · #1 npm-token");
	});
});

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function toolResults(session: Harness, toolName: string): ToolResultMessage[] {
	return session.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

function credentialNotices(session: Harness): CustomMessage<{ credentials: Credential[] }>[] {
	return session.session.messages.filter(
		(message): message is CustomMessage<{ credentials: Credential[] }> =>
			message.role === "custom" && message.customType === CREDENTIAL_NOTICE_TYPE,
	);
}

describe("credentials from a real subagent process", () => {
	it("announces a subagent's credential to the orchestrator, ends its wait, and summarizes it in the result", async () => {
		const extension = createSubagentExtension({
			command: { executable: process.execPath, args: [fakeChild, "auto"] },
		});
		const harness = await createHarness({ extensionFactories: [{ name: "subagent", factory: extension }] });
		cleanups.push(() => harness.cleanup());
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });
		harness.setResponses([
			call("subagent", {
				agent: "scout",
				task: "slow add credential: github-ci-token",
				name: "finder",
				description: "Find a token",
				background: true,
			}),
			call("subagent_wait", {}),
			call("get_credential", { ids: [1] }),
			call("subagent_wait", {}),
			call("subagent_result", { names: ["finder"] }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Find a token in the background");

		const waits = toolResults(harness, "subagent_wait").map(getMessageText);
		expect(waits[0].split("\n")[0]).toBe(
			"Stopped waiting: finder stored credential 1 (github-ci-token), shown after this result. Read it with get_credential.",
		);
		expect(waits[1]).toContain("All targets finished.");

		const [notice] = credentialNotices(harness);
		expect(notice.details?.credentials.map((c) => c.id)).toEqual([1]);
		expect(getMessageText(notice)).toContain("value: secret-github-ci-token");

		expect(getMessageText(toolResults(harness, "get_credential")[0])).toContain(
			"Credential 1: github-ci-token\nFrom finder, for: use github-ci-token\nValue: secret-github-ci-token",
		);
		expect(getMessageText(toolResults(harness, "subagent_result")[0])).toContain(
			"Credentials by finder: 1 github-ci-token. Read them with get_credential.",
		);
	}, 20_000);
});
