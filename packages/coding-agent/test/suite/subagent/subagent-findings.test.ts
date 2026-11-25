import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	FINDING_NOTICE_TYPE,
	FINDINGS_FILE,
	type Finding,
	FindingBoard,
	type FindingRequest,
	FindingStore,
	frameFindingNotice,
	normalizeFindingKey,
} from "../../../src/extensions/subagent/findings.ts";
import { createSubagentExtension, planSubagentRun } from "../../../src/extensions/subagent/index.ts";
import {
	type FindingPriority,
	type FindingsConfig,
	loadSubagentConfig,
} from "../../../src/extensions/subagent/paths.ts";
import {
	renderFindingNotice,
	renderFindingReadResult,
	renderFindingWriteResult,
} from "../../../src/extensions/subagent/render.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

const fakeChild = fileURLToPath(new URL("./fake-rpc-child.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-findings-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A board with the bundled findings config plus `overrides`, recording what it delivers to the orchestrator. */
function createBoard(overrides: Partial<FindingsConfig> = {}, store = new FindingStore()) {
	const config: FindingsConfig = { ...loadSubagentConfig(null).findings, ...overrides };
	const delivered: Array<{ id: number; revision: number; delivery: string }> = [];
	const board = new FindingBoard({
		store,
		config: () => config,
		deliver: (finding, delivery) => delivered.push({ id: finding.id, revision: finding.revision, delivery }),
	});
	return { board, store, delivered };
}

const add = (
	priority: FindingPriority,
	key: string,
	extra: Partial<Extract<FindingRequest, { action: "add" }>> = {},
): FindingRequest => ({ action: "add", key, description: `About ${key}`, priority, ...extra });

describe("findings board", () => {
	it("numbers findings from 1 and delivers them by priority, never the orchestrator's own", () => {
		const { board, delivered } = createBoard();

		const critical = board.handle("alpha", add("critical", "auth.token-cache", { metadata: { line: 42 } }));
		expect(critical).toMatchObject({
			ok: true,
			text: "Added finding 1 (critical). The orchestrator was told.",
			delivery: "wake",
		});
		expect(critical.findings[0]).toMatchObject({
			id: 1,
			from: "alpha",
			key: "auth.token-cache",
			description: "About auth.token-cache",
			metadata: { line: 42 },
			revision: 1,
		});
		expect(board.handle("bravo", add("high", "db.index")).text).toBe(
			"Added finding 2 (high). The orchestrator was told.",
		);
		expect(board.handle("bravo", add("medium", "chat.hub")).text).toBe(
			"Added finding 3 (medium). The orchestrator sees it on its next turn.",
		);
		expect(board.handle("charlie", add("low", "misc.note")).text).toBe(
			"Added finding 4 (low). It is stored; the orchestrator was not told, but can list it.",
		);
		expect(board.handle(ORCHESTRATOR, add("critical", "plan.change")).text).toBe("Added finding 5 (critical).");

		expect(delivered).toEqual([
			{ id: 1, revision: 1, delivery: "wake" },
			{ id: 2, revision: 1, delivery: "wake" },
			{ id: 3, revision: 1, delivery: "notify" },
		]);
	});

	it("follows the delivery config per priority", () => {
		const delivery = { ...loadSubagentConfig(null).findings.delivery, low: "wake" as const };
		const { board, delivered } = createBoard({ delivery });
		board.handle("alpha", add("low", "misc.note"));
		expect(delivered).toEqual([{ id: 1, revision: 1, delivery: "wake" }]);
	});

	it("normalizes keys to slugs", () => {
		expect(normalizeFindingKey("Chat Hub Socket!")).toBe("chat-hub-socket");
		expect(normalizeFindingKey("  .Auth.Token_Cache.  ")).toBe("auth.token_cache");
		expect(normalizeFindingKey("x".repeat(80))).toHaveLength(64);
	});

	it("refuses invalid findings and stores nothing", () => {
		const { board, store } = createBoard({ maxDescriptionLength: 10, maxMetadataBytes: 20 });

		expect(board.handle("alpha", add("low", "!!!")).text).toBe(
			"The key is empty. Use a short dotted slug, such as auth.token-cache.",
		);
		expect(board.handle("alpha", add("low", "a.b", { description: "  " })).text).toBe("The description is empty.");
		expect(board.handle("alpha", add("low", "a.b", { description: "x".repeat(11) })).text).toBe(
			"The description is 11 characters; the limit is 10. Shorten it and put details in metadata.",
		);
		expect(
			board.handle("alpha", { action: "add", key: "a.b", description: "ok", priority: "urgent" as FindingPriority })
				.text,
		).toBe("Priority must be one of: low, medium, high, critical.");
		const nested = { nested: { a: 1 } } as unknown as Record<string, string>;
		expect(board.handle("alpha", add("low", "a.b", { description: "ok", metadata: nested })).text).toBe(
			'Metadata "nested" must be a string, number, or boolean.',
		);
		expect(
			board.handle("alpha", add("low", "a.b", { description: "ok", metadata: { file: "x".repeat(20) } })).text,
		).toBe("The metadata is 31 bytes as JSON; the limit is 20. Shorten it.");
		expect(store.list()).toEqual([]);

		const off = createBoard({ enabled: false });
		expect(off.board.handle("alpha", add("low", "a.b"))).toEqual({
			ok: false,
			text: "Findings are turned off.",
			findings: [],
		});
	});

	it("lets only the creator update a finding, merges metadata, and redelivers only on a stronger priority", () => {
		const { board, delivered } = createBoard();
		board.handle("alpha", add("low", "docs.typo", { metadata: { file: "README.md", line: 3 } }));

		expect(board.handle("bravo", { action: "update", id: 1, priority: "high" })).toEqual({
			ok: false,
			text: "Finding 1 belongs to alpha; only it can update it. Add your own finding instead.",
			findings: [],
		});
		expect(board.handle(ORCHESTRATOR, { action: "update", id: 1, priority: "high" }).ok).toBe(false);
		expect(board.handle("alpha", { action: "update", id: 9, priority: "high" }).text).toBe("There is no finding 9.");
		expect(board.handle("alpha", { action: "update", id: 1 }).text).toBe(
			"Nothing to update: set key, description, priority, or metadata.",
		);

		const merged = board.handle("alpha", { action: "update", id: 1, metadata: { line: 4, file: null } });
		expect(merged.text).toBe("Updated finding 1 (revision 2, low).");
		expect(merged.findings[0].metadata).toEqual({ line: 4 });

		const raised = board.handle("alpha", {
			action: "update",
			id: 1,
			priority: "high",
			description: "The typo is in a public API name",
		});
		expect(raised.text).toBe("Updated finding 1 (revision 3, high). The orchestrator was told.");
		expect(raised.findings[0]).toMatchObject({ description: "The typo is in a public API name", priority: "high" });

		// critical has the same delivery as high, so it is not news.
		expect(board.handle("alpha", { action: "update", id: 1, priority: "critical" }).text).toBe(
			"Updated finding 1 (revision 4, critical).",
		);
		expect(delivered).toEqual([{ id: 1, revision: 3, delivery: "wake" }]);
	});

	it("lists by priority with filters, and reads findings in full by id", () => {
		const { board } = createBoard();
		expect(board.handle("alpha", { action: "list" }).text).toBe("No findings in this session yet.");

		board.handle("alpha", add("low", "auth.session"));
		board.handle("alpha", add("critical", "auth.token-cache", { metadata: { file: "src/cache.ts", line: 42 } }));
		board.handle("bravo", add("high", "db.index"));
		board.handle("bravo", add("medium", "auth.cookie"));
		const ids = (request: FindingRequest) => board.handle("bravo", request).findings.map((finding) => finding.id);

		expect(board.handle("bravo", { action: "list" }).text).toBe(
			[
				"4 findings:",
				"- 2 [critical] auth.token-cache (alpha): About auth.token-cache",
				"- 3 [high] db.index (bravo): About db.index",
				"- 4 [medium] auth.cookie (bravo): About auth.cookie",
				"- 1 [low] auth.session (alpha): About auth.session",
				"Read one in full with get_finding.",
			].join("\n"),
		);
		expect(ids({ action: "list", from: "alpha" })).toEqual([2, 1]);
		expect(ids({ action: "list", key: "auth" })).toEqual([2, 4, 1]);
		expect(ids({ action: "list", minPriority: "high" })).toEqual([2, 3]);
		expect(ids({ action: "list", after: 2 })).toEqual([3, 4]);
		const limited = board.handle("bravo", { action: "list", limit: 2 });
		expect(limited.total).toBe(4);
		expect(limited.text.split("\n")[0]).toBe("4 findings, showing the first 2:");
		expect(board.handle("bravo", { action: "list", key: "nothing" }).text).toBe("No findings match.");

		expect(board.handle("bravo", { action: "get", ids: [2, 9] })).toMatchObject({
			ok: true,
			text: [
				"Finding 2 [critical] auth.token-cache",
				"From alpha, revision 1",
				"About auth.token-cache",
				"Metadata:",
				"- file: src/cache.ts",
				"- line: 42",
				"",
				"There is no finding 9.",
			].join("\n"),
		});
		expect(board.handle("bravo", { action: "get", ids: [9] }).ok).toBe(false);
	});

	it("frames notices with the id, sender, priority, and key only", () => {
		const { board } = createBoard();
		const first = board.handle("alpha", add("critical", "auth.token-cache", { metadata: { secret: "s3cret" } }));
		board.handle("alpha", add("low", "docs.typo"));
		const raised = board.handle("alpha", { action: "update", id: 2, priority: "high" });
		const notice = frameFindingNotice([first.findings[0], raised.findings[0]]);

		expect(notice).toBe(
			[
				"<agent_findings>",
				'<finding id="1" from="alpha" priority="critical" key="auth.token-cache"/>',
				'<finding id="2" from="alpha" priority="high" key="docs.typo" revision="2"/>',
				"</agent_findings>",
				"Subagents added these findings, or raised their priority; the user did not write this. Read them with get_finding (ids: 1, 2) if they matter to your work.",
			].join("\n"),
		);
		expect(notice).not.toContain("About");
		expect(notice).not.toContain("s3cret");
	});
});

describe("findings persistence", () => {
	it("appends every revision, reloads the last one per id, and continues the ids", () => {
		const file = join(tempDir(), "subagents", "session-1", FINDINGS_FILE);
		const store = new FindingStore();
		store.open(file);
		const { board } = createBoard({}, store);
		board.handle("alpha", add("low", "docs.typo"));
		board.handle("bravo", add("medium", "db.index"));
		board.handle("alpha", { action: "update", id: 1, priority: "high" });
		expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(3);
		appendFileSync(file, "not json\n");

		const reopened = new FindingStore();
		reopened.open(file);
		expect(reopened.list().map((finding) => [finding.id, finding.from, finding.priority, finding.revision])).toEqual([
			[1, "alpha", "high", 2],
			[2, "bravo", "medium", 1],
		]);
		expect(createBoard({}, reopened).board.handle("alpha", add("low", "next")).findings[0].id).toBe(3);

		reopened.open(undefined);
		expect(reopened.list()).toEqual([]);
	});
});

describe("findings over the chat hub", () => {
	it("takes the creator from the token, so subagents can read but not update each other's findings", async () => {
		const { board } = createBoard();
		const hub = new ChatHub({
			directory: { find: () => undefined, list: () => [] },
			config: () => loadSubagentConfig(null).chat,
			deliverToOrchestrator: () => {},
			findings: board,
		});
		cleanups.push(() => hub.close());
		const connect = async (name: string) => {
			const client = new ChatClient(hub.address(), hub.register(name, resolvePermissions([])), () => {});
			cleanups.push(() => client.close());
			await client.connect();
			return client;
		};
		const alpha = await connect("alpha");
		const bravo = await connect("bravo");

		const added = await alpha.finding(add("high", "auth.token-cache"));
		expect(added).toMatchObject({ ok: true, text: "Added finding 1 (high). The orchestrator was told." });
		expect(added.findings[0].from).toBe("alpha");
		expect((await bravo.finding({ action: "get", ids: [1] })).text).toContain("From alpha, revision 1");
		expect((await bravo.finding({ action: "update", id: 1, priority: "low" })).text).toBe(
			"Finding 1 belongs to alpha; only it can update it. Add your own finding instead.",
		);
		expect((await alpha.finding({ action: "update", id: 1, priority: "low" })).ok).toBe(true);
	});

	it("refuses chat sends when chat is off but still serves findings", async () => {
		const { board } = createBoard();
		const hub = new ChatHub({
			directory: { find: () => undefined, list: () => [] },
			config: () => ({ ...loadSubagentConfig(null).chat, enabled: false }),
			deliverToOrchestrator: () => {},
			findings: board,
		});
		cleanups.push(() => hub.close());
		const client = new ChatClient(hub.address(), hub.register("alpha", resolvePermissions(["all"])), () => {});
		cleanups.push(() => client.close());
		await client.connect();

		expect(await client.send({ to: ORCHESTRATOR, text: "hi" })).toEqual({
			ok: false,
			text: "Chat is turned off.",
			outcome: "refused",
		});
		expect((await client.finding(add("low", "a.b"))).ok).toBe(true);
	});

	it("refuses finding requests on a hub without a board", async () => {
		const hub = new ChatHub({
			directory: { find: () => undefined, list: () => [] },
			config: () => loadSubagentConfig(null).chat,
			deliverToOrchestrator: () => {},
		});
		cleanups.push(() => hub.close());
		const client = new ChatClient(hub.address(), hub.register("alpha", resolvePermissions([])), () => {});
		cleanups.push(() => client.close());
		await client.connect();
		expect((await client.finding(add("low", "a.b"))).text).toBe("Findings are turned off.");
	});
});

describe("findings config and run planning", () => {
	it("gives subagents the finding tools only while findings are enabled", () => {
		const worker = discoverAgents(process.cwd(), false).agents.find((agent) => agent.name === "worker")!;
		const plan = planSubagentRun(worker, {}, null);
		expect(plan.findings).toBe(true);
		expect(plan.tools).toEqual(
			expect.arrayContaining(["add_finding", "update_finding", "get_finding", "list_findings"]),
		);

		const dir = tempDir();
		writeFileSync(join(dir, "config.json"), JSON.stringify({ findings: { enabled: false } }));
		const off = planSubagentRun(worker, {}, dir);
		expect(off.findings).toBe(false);
		expect(off.tools).not.toContain("add_finding");
	});

	it("lets a project override single priorities and limits, ignoring invalid values", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				findings: { delivery: { medium: "wake", low: "loud" }, maxMetadataBytes: 100, maxDescriptionLength: -1 },
			}),
		);
		expect(loadSubagentConfig(dir).findings).toEqual({
			enabled: true,
			delivery: { critical: "wake", high: "wake", medium: "wake", low: "silent" },
			maxDescriptionLength: 1000,
			maxMetadataBytes: 100,
		});
	});
});

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function toolResults(session: Harness, toolName: string): ToolResultMessage[] {
	return session.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

function findingNotices(session: Harness): CustomMessage<{ findings: Finding[] }>[] {
	return session.session.messages.filter(
		(message): message is CustomMessage<{ findings: Finding[] }> =>
			message.role === "custom" && message.customType === FINDING_NOTICE_TYPE,
	);
}

describe("findings from a real subagent process", () => {
	it("wakes the orchestrator for urgent findings, ends its wait, and summarizes them in the result", async () => {
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
				task: "slow add finding: critical auth.token-cache add finding: low misc.note add finding: medium db.index",
				name: "finder",
				description: "Find things",
				background: true,
			}),
			call("subagent_wait", {}),
			call("get_finding", { ids: [1] }),
			call("subagent_wait", {}),
			call("subagent_result", { names: ["finder"] }),
			call("update_finding", { id: 1, priority: "low" }),
			call("add_finding", { key: "plan.next", description: "Fix the cache first", priority: "high" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Find things in the background");

		const waits = toolResults(harness, "subagent_wait").map(getMessageText);
		expect(waits[0].split("\n")[0]).toBe(
			"Stopped waiting: finder added critical finding 1, shown after this result. Read it with get_finding.",
		);
		expect(waits[1]).toContain(
			"All targets finished.\n- finder (Find things): done, 1 turn; 3 findings (1 critical)",
		);

		const [wake] = findingNotices(harness);
		expect(wake.details?.findings.map((finding) => finding.id)).toEqual([1]);
		expect(getMessageText(wake)).toContain(
			'<finding id="1" from="finder" priority="critical" key="auth.token-cache"/>',
		);
		expect(getMessageText(wake)).not.toContain("About");

		expect(getMessageText(toolResults(harness, "get_finding")[0])).toContain(
			"Finding 1 [critical] auth.token-cache\nFrom finder, revision 1\nAbout auth.token-cache",
		);
		expect(getMessageText(toolResults(harness, "subagent_result")[0])).toContain(
			"Findings by finder: 1 critical auth.token-cache, 3 medium db.index, 2 low misc.note. Read them with get_finding.",
		);
		expect(getMessageText(toolResults(harness, "update_finding")[0])).toBe(
			"Finding 1 belongs to finder; only it can update it. Add your own finding instead.",
		);
		expect(getMessageText(toolResults(harness, "add_finding")[0])).toBe("Added finding 4 (high).");

		// The medium finding waits for the next turn; the low one and the orchestrator's own never reach it.
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("Anything else?");
		await vi.waitFor(() =>
			expect(findingNotices(harness).map((notice) => notice.details?.findings.map((finding) => finding.id))).toEqual(
				[[1], [3]],
			),
		);
	}, 20_000);
});

describe("expanding findings", () => {
	beforeAll(() => initTheme("dark"));
	const render = (component: { render(width: number): string[] }) =>
		component
			.render(120)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");

	it("shows the finding notice as one line each, and the current finding as JSON when expanded", () => {
		const { board, store } = createBoard();
		const sent = board.handle("alpha", add("critical", "auth.token-cache", { metadata: { line: 42 } })).findings[0];
		board.handle("alpha", { action: "update", id: 1, metadata: { line: 44 } });
		const lookup = (id: number) => store.get(id);

		const collapsed = render(renderFindingNotice([sent], { expanded: false, outputPad: 0, lookup }, theme));
		expect(collapsed).toBe("⚑ #1 critical · alpha · auth.token-cache");

		const expanded = render(renderFindingNotice([sent], { expanded: true, outputPad: 0, lookup }, theme));
		expect(expanded).toContain('"key": "auth.token-cache"');
		expect(expanded).toContain('"line": 44');
		expect(expanded).toContain('"revision": 2');

		// Without the board, the copy the notice was sent with.
		const stored = render(renderFindingNotice([sent], { expanded: true, outputPad: 0 }, theme));
		expect(stored).toContain('"line": 42');
	});

	it("shows a finding tool's result as JSON when expanded", () => {
		const { board } = createBoard();
		const result = board.handle("alpha", add("high", "db.index", { metadata: { table: "users" } }));
		const options = { isError: false, outputPad: 0 };

		expect(render(renderFindingWriteResult(result, result.text, { ...options, expanded: false }, theme))).toBe(
			"  ⎿  #1 high db.index · orchestrator told",
		);
		const expanded = render(renderFindingWriteResult(result, result.text, { ...options, expanded: true }, theme));
		expect(expanded).toContain('"description": "About db.index"');
		expect(expanded).toContain('"table": "users"');

		const read = board.handle("bravo", { action: "get", ids: [1] });
		expect(render(renderFindingReadResult(read, read.text, { ...options, expanded: true }, theme))).toContain(
			'"from": "alpha"',
		);
	});
});
