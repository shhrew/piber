/**
 * Subagents as a built-in extension.
 *
 * - `subagent` delegates tasks to agents defined in `agents/*.md` (bundled) and `.pi/subagents/agents/*.md`
 *   (trusted projects). Each subagent is a separate `pi --mode rpc` process with its own system prompt,
 *   tools, skill groups, and session file. Modes: single, parallel, and chain.
 * - `skill_search` and `load_skill` serve a subagent's skill groups. They are registered inactive and are
 *   enabled only in subagent processes, through the `--tools` list the parent passes.
 * - The agent view (`app.agents.view` pressed with an empty editor) lists the main session and its
 *   subagents, shows a subagent's live transcript, and steers it.
 *
 * See README.md in this directory.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getKeybindings } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { type AgentConfig, discoverAgents, findProjectSubagentsDir } from "./agents.ts";
import {
	CHAT_FLAG,
	CHAT_MESSAGE_TYPE,
	CHAT_PEERS_TOOL_NAME,
	CHAT_SEND_TOOL_NAME,
	CHAT_TOKEN_ENV,
	ChatClient,
	type ChatDelivery,
	type ChatDirectory,
	ChatHub,
	type ChatPeer,
	type ChatRights,
	canMessageAnyone,
	frameMessage,
	ORCHESTRATOR,
	resolvePermissions,
	type SendOutcome,
	type SendResult,
} from "./chat.ts";
import { emptyUsage, SKILL_GROUPS_FLAG, Subagent } from "./child.ts";
import { SubagentDock } from "./dock.ts";
import {
	type BackgroundCompletion,
	type ChatConfig,
	loadGlobalSystemPrompt,
	loadSubagentConfig,
	parseNameList,
} from "./paths.ts";
import { SubagentRegistry } from "./registry.ts";
import {
	currentPhase,
	getFinalOutput,
	isFailedRun,
	renderBackgroundNotice,
	renderCallLine,
	renderChatMessage,
	renderChatPeersResult,
	renderChatSendCall,
	renderChatSendResult,
	renderListResult,
	renderSubagentCall,
	renderSubagentResult,
	renderWaitCall,
	renderWaitResult,
	type SubagentRunDetails,
	type SubagentToolDetails,
} from "./render.ts";
import {
	DEFAULT_SKILL_SEARCH_LIMIT,
	listSkillTags,
	loadSkillGroups,
	type SkillCatalog,
	searchSkills,
} from "./skills.ts";
import { SlotPool } from "./slots.ts";
import { AgentView } from "./view.ts";

export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const SUBAGENT_WAIT_TOOL_NAME = "subagent_wait";
export const SUBAGENT_RESULT_TOOL_NAME = "subagent_result";
export const SUBAGENT_LIST_TOOL_NAME = "subagent_list";
/** Custom message type of the notice posted when background subagents finish. */
const BACKGROUND_NOTICE_TYPE = "subagent-background-complete";
/** Background subagents that finish within this window are announced in one notice. */
const NOTICE_BATCH_MS = 500;
/** Widget key of the subagent dock under the composer. */
const DOCK_WIDGET_KEY = "subagents";

const MAX_PARALLEL_TASKS = 8;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const RunFields = {
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
	extraTools: Type.Optional(
		Type.Array(Type.String(), { description: "Tools to add for this call, on top of the core and agent tools" }),
	),
	extraSkillGroups: Type.Optional(
		Type.Array(Type.String(), { description: "Skill groups to add for this call, on top of the agent's groups" }),
	),
};

const NameFields = {
	name: Type.Optional(
		Type.String({
			description:
				"One-word name for this subagent, such as auth-scout. It identifies the subagent in the agent view and for session.",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "What this subagent is doing in 2-4 words, such as 'Map auth flow'" }),
	),
};

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate. In a chain, {previous} is replaced by the prior output." }),
	...NameFields,
	...RunFields,
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in parallel" })),
	chain: Type.Optional(Type.Array(TaskItem, { description: "Tasks to run in order, with {previous} placeholders" })),
	session: Type.Optional(
		Type.String({
			description:
				"Continue an earlier subagent (single mode): its name, such as auth-scout, or its session file path. `task` is sent as the next message.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: `Run in the background: return at once with the subagents' names while they work. Wait for them with ${SUBAGENT_WAIT_TOOL_NAME} and read their results with ${SUBAGENT_RESULT_TOOL_NAME}.`,
		}),
	),
	...NameFields,
	...RunFields,
});

type SubagentCallParams = Static<typeof SubagentParams>;

const WaitParams = Type.Object({
	names: Type.Optional(
		Type.Array(Type.String(), {
			description: "Names of the subagents to wait for. Default: every subagent still running or queued.",
		}),
	),
	returnOnFirst: Type.Optional(
		Type.Boolean({
			description:
				"Return as soon as ONE target finishes, leaving the rest running. Leave unset to wait until EVERY target has finished, which is what you want before reading all of their results.",
		}),
	),
});

const ListParams = Type.Object({});

const ChatSendParams = Type.Object({
	to: Type.String({
		description: 'Recipient: a subagent\'s name, "orchestrator", or "all" for everyone still running',
	}),
	text: Type.String({
		description: "The message: short and concrete, such as what you found, where, and what it means for them",
	}),
	waitForReply: Type.Optional(
		Type.Boolean({
			description: "Block until the recipient replies. Only for questions you cannot continue without.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: "With waitForReply: how long to wait. Default and maximum come from the chat config.",
		}),
	),
});

const ChatPeersParams = Type.Object({});

interface ChatToolDetails {
	to: string;
	ok: boolean;
	outcome?: SendOutcome;
	message?: ChatDelivery;
}

const ResultParams = Type.Object({
	names: Type.Array(Type.String(), {
		minItems: 1,
		description: "Names of the finished subagents whose results to read. Several names read several results at once.",
	}),
});

interface RunRequest {
	agent?: string;
	task: string;
	name?: string;
	description?: string;
	cwd?: string;
	extraTools?: string[];
	extraSkillGroups?: string[];
	session?: string;
	step?: number;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output is in the subagent's session.]`;
}

/** The caller's description, or the first words of the task. */
function describeRun(request: RunRequest): string {
	const description = request.description?.trim();
	if (description) return description;
	const words = request.task
		.replace(/\{previous\}/g, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return words.length > 4 ? `${words.slice(0, 4).join(" ")}...` : words.join(" ");
}

function toDetails(subagent: Subagent, step?: number): SubagentRunDetails {
	return {
		id: subagent.id,
		key: subagent.key,
		description: subagent.options.description,
		agent: subagent.options.agentName,
		agentSource: subagent.options.agentSource,
		task: subagent.options.task,
		status: subagent.isRunning ? "running" : subagent.status,
		// Chat entries are for the agent view; results keep only the conversation.
		messages: subagent.messages.filter((message): message is Message => message.role !== "custom"),
		usage: { ...subagent.usage },
		model: subagent.model,
		stopReason: subagent.stopReason,
		errorMessage: subagent.errorMessage,
		sessionFile: subagent.sessionFile,
		step,
		startedAt: subagent.startedAt,
		finishedAt: subagent.finishedAt,
		phase: subagent.isRunning ? currentPhase(subagent.streaming) : undefined,
	};
}

/**
 * Details for rows that only report status (waits, results, notices): the transcript is cut to the last message
 * with a tool call, enough for the expanded `→ command` line, so these results do not copy whole transcripts.
 */
function statusDetails(subagent: Subagent): SubagentRunDetails {
	const details = toDetails(subagent);
	const last = details.messages.findLast(
		(message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"),
	);
	return { ...details, messages: last ? [last] : [] };
}

/** One line per subagent for the orchestrator: `- name (description): done, 3 turns`. */
function statusLine(subagent: Subagent): string {
	const label = `- ${subagent.id} (${subagent.options.description})`;
	if (subagent.isQueued) return `${label}: queued`;
	if (subagent.isRunning) return `${label}: running`;
	if (subagent.status === "failed") {
		return `${label}: failed${subagent.errorMessage ? `: ${subagent.errorMessage.split("\n")[0]}` : ""}`;
	}
	const turns = subagent.usage.turns;
	return `${label}: ${subagent.status}${turns ? `, ${turns} turn${turns > 1 ? "s" : ""}` : ""}`;
}

function isSettled(subagent: Subagent): boolean {
	return !subagent.isRunning && !subagent.isQueued;
}

function failedRun(request: RunRequest, id: string, errorMessage: string): SubagentRunDetails {
	return {
		id,
		description: describeRun(request),
		agent: request.agent ?? "?",
		agentSource: "unknown",
		task: request.task,
		status: "failed",
		messages: [],
		usage: emptyUsage(),
		errorMessage,
		step: request.step,
	};
}

/** Output for the parent model: the final text, or the error, plus how to continue the session. */
function runOutput(run: SubagentRunDetails): string {
	const output = isFailedRun(run)
		? run.errorMessage || getFinalOutput(run.messages) || "(no output)"
		: getFinalOutput(run.messages) || "(no output)";
	const resume = run.sessionFile ? `\n\n[subagent ${run.id}; continue it with session: "${run.id}"]` : "";
	return output + resume;
}

/**
 * The global subagent prompt, the agent's own prompt, and a skills section naming the tags to search and the
 * pinned skills. The chat section is added once the subagent has a name (see `chatPromptSection`).
 */
function buildSystemPrompt(
	agent: AgentConfig,
	catalog: SkillCatalog,
	hasSkillGroups: boolean,
	globalPrompt: string,
): string {
	const parts = [globalPrompt, agent.systemPrompt.trim()].filter(Boolean);
	if (hasSkillGroups) {
		const tags = listSkillTags(catalog.skills);
		const lines = [
			"## Skills",
			`You have a curated set of skills with instructions for specialized work. Before working in an area they cover, call ${SKILL_SEARCH_TOOL_NAME} with a query or tags, then ${LOAD_SKILL_TOOL_NAME} to read the best match.`,
			tags.length > 0
				? `Tags: ${tags.join(", ")}`
				: `Call ${SKILL_SEARCH_TOOL_NAME} with no query to list every skill.`,
		];
		const pinned = agent.pinnedSkills
			.map((name) => catalog.skills.find((skill) => skill.name === name))
			.filter((skill) => skill !== undefined);
		if (pinned.length > 0) {
			lines.push("", `Always relevant to your work; load them with ${LOAD_SKILL_TOOL_NAME}:`);
			for (const skill of pinned) lines.push(`- ${skill.name}: ${skill.description}`);
		}
		parts.push(lines.join("\n"));
	}
	return parts.join("\n\n");
}

export interface SubagentRunPlan {
	tools: string[];
	skillGroups: string[];
	catalog: SkillCatalog;
	systemPrompt: string;
	/** What the subagent may message, or undefined when chat is turned off. */
	chatRights: ChatRights | undefined;
}

/** The chat part of a subagent's prompt: its name and who it may message. */
export function chatPromptSection(name: string, rights: ChatRights): string {
	const targets: string[] = [];
	if (rights.orchestrator) targets.push(`the orchestrator (to: "${ORCHESTRATOR}")`);
	if (rights.subagents) targets.push(`other subagents by name (see ${CHAT_PEERS_TOOL_NAME})`);
	if (rights.broadcast) targets.push('everyone at once (to: "all")');
	const can =
		targets.length > 0
			? `You can message ${targets.join(", ")}.`
			: "You cannot send chat messages, but other agents may message you.";
	return ["## Your chat permissions", `Your name in chat is "${name}". ${can}`].join("\n");
}

/**
 * What a subagent runs with: the core tools from `config.json`, then the agent's tools, then the call's
 * `extraTools`, plus `skill_search` and `load_skill` when it has skill groups and the chat tools when it may send
 * messages; and the global prompt, the agent's prompt, and a skills section.
 */
export function planSubagentRun(
	agent: AgentConfig,
	request: Pick<RunRequest, "extraTools" | "extraSkillGroups">,
	projectDir: string | null,
): SubagentRunPlan {
	const skillGroups = unique([...agent.skillGroups, ...(request.extraSkillGroups ?? [])]);
	const catalog = loadSkillGroups(skillGroups, projectDir);
	const skillTools = skillGroups.length > 0 ? [SKILL_SEARCH_TOOL_NAME, LOAD_SKILL_TOOL_NAME] : [];
	const config = loadSubagentConfig(projectDir);
	const chatRights = config.chat.enabled
		? resolvePermissions(agent.canMessage ?? config.chat.defaultCanMessage)
		: undefined;
	const chatTools = chatRights && canMessageAnyone(chatRights) ? [CHAT_SEND_TOOL_NAME, CHAT_PEERS_TOOL_NAME] : [];
	return {
		tools: unique([...config.coreTools, ...agent.tools, ...(request.extraTools ?? []), ...skillTools, ...chatTools]),
		skillGroups,
		catalog,
		systemPrompt: buildSystemPrompt(agent, catalog, skillGroups.length > 0, loadGlobalSystemPrompt(projectDir)),
		chatRights,
	};
}

/** The skills a subagent process may search: the groups the parent passed, in the bundled and project layers. */
function loadChildCatalog(pi: ExtensionAPI, ctx: ExtensionContext): SkillCatalog {
	const groups = parseNameList(pi.getFlag(SKILL_GROUPS_FLAG));
	const projectDir = ctx.isProjectTrusted() ? findProjectSubagentsDir(ctx.cwd) : null;
	return loadSkillGroups(groups, projectDir);
}

export interface SubagentExtensionOptions {
	/** Command that starts pi for subagents. Default: the command that started this process. Tests pass a stand-in. */
	command?: { executable: string; args: string[] };
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
	return (pi) => setupSubagents(pi, options);
}

export default createSubagentExtension();

function setupSubagents(pi: ExtensionAPI, options: SubagentExtensionOptions): void {
	const registry = new SubagentRegistry();
	/** Live state of a subagent instance, for rows of background launches and waits. */
	const lookup = (key: string) => {
		const subagent = registry.findByKey(key);
		return subagent ? statusDetails(subagent) : undefined;
	};
	/** Shared by every subagent of this session. Its limit is refreshed from config before each run. */
	const slots = new SlotPool(loadSubagentConfig(null).maxConcurrent);
	const reportedDiagnostics = new Set<string>();
	let stopListening: (() => void) | undefined;
	/** The subagent last opened in the agent view, where the view starts next time. Undefined is the main session. */
	let lastViewed: string | undefined;

	/** The chat config at load time, for which tools start active; runs read the project's config. */
	const bundledChat = loadSubagentConfig(null).chat;
	/** The project whose config the chat hub reads, from the latest run or chat call. */
	let chatProjectDir: string | null = null;
	let chatHub: ChatHub | undefined;
	/**
	 * Chat messages to the orchestrator that have not reached its context yet: a steer waits for the current tool
	 * calls to end. `subagent_wait` returns at once while any are unread, so the orchestrator can answer them.
	 */
	const unreadChat = new Map<string, ChatDelivery>();
	/** Called with each chat message to the orchestrator; `subagent_wait` listens to stop waiting. */
	const chatListeners = new Set<(delivery: ChatDelivery) => void>();
	const chatPeer = (subagent: Subagent): ChatPeer => ({
		name: subagent.id,
		description: subagent.options.description,
		agent: subagent.options.agentName,
		state: subagent.isRunning ? "running" : subagent.isQueued ? "queued" : "finished",
	});
	const chatDirectory: ChatDirectory = {
		find: (name) => {
			const subagent = registry.find(name);
			return subagent ? chatPeer(subagent) : undefined;
		},
		list: () => registry.list().map(chatPeer),
	};
	/** The session's chat hub, created on first use, or undefined when chat is turned off for the project. */
	const chatHubFor = (ctx: ExtensionContext): ChatHub | undefined => {
		chatProjectDir = ctx.isProjectTrusted() ? findProjectSubagentsDir(ctx.cwd) : null;
		if (!loadSubagentConfig(chatProjectDir).chat.enabled) return undefined;
		chatHub ??= new ChatHub({
			directory: chatDirectory,
			config: (): ChatConfig => loadSubagentConfig(chatProjectDir).chat,
			// Steers the orchestrator while it works, and starts a turn when it is idle.
			deliverToOrchestrator: (delivery) => {
				unreadChat.set(delivery.id, delivery);
				pi.sendMessage(
					{
						customType: CHAT_MESSAGE_TYPE,
						content: frameMessage(delivery, true),
						display: true,
						details: delivery,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				for (const listener of [...chatListeners]) listener(delivery);
			},
		});
		return chatHub;
	};
	const closeChat = () => {
		chatHub?.close();
		chatHub = undefined;
		unreadChat.clear();
		chatClient?.close();
		chatClient = undefined;
	};

	const reportDiagnostics = (catalog: SkillCatalog, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		for (const diagnostic of catalog.diagnostics) {
			const message = diagnostic.path ? `${diagnostic.message} (${diagnostic.path})` : diagnostic.message;
			if (reportedDiagnostics.has(message)) continue;
			reportedDiagnostics.add(message);
			ctx.ui.notify(`Subagent skills: ${message}`, "warning");
		}
	};

	type Prepared = { subagent: Subagent; message: string } | { failure: SubagentRunDetails };

	/**
	 * Create (or find, for `session`) the subagent for a request and register it, without starting it. Synchronous,
	 * so a background launch knows its subagents' names before it returns.
	 */
	const prepareRun = (request: RunRequest, ctx: ExtensionContext): Prepared => {
		const projectDir = ctx.isProjectTrusted() ? findProjectSubagentsDir(ctx.cwd) : null;
		slots.setLimit(loadSubagentConfig(projectDir).maxConcurrent);

		const existing = request.session ? registry.find(request.session) : undefined;
		if (existing) {
			if (!isSettled(existing)) {
				return { failure: failedRun(request, existing.id, `Subagent ${existing.id} is still ${existing.status}`) };
			}
			return { subagent: existing, message: request.task };
		}

		const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		const agent = discovery.agents.find((candidate) => candidate.name === request.agent);
		if (!agent) {
			const available = discovery.agents.map((candidate) => candidate.name).join(", ") || "none";
			const reason = request.session
				? `Unknown subagent session "${request.session}". To continue a session file from an earlier pi run, also pass its agent.`
				: `Unknown agent "${request.agent ?? ""}". Available agents: ${available}.`;
			return { failure: failedRun(request, registry.createId(request.name ?? request.agent ?? "subagent"), reason) };
		}

		const plan = planSubagentRun(agent, request, discovery.projectDir);
		reportDiagnostics(plan.catalog, ctx);
		const inheritsModel = !agent.model;
		const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = parentSessionFile
			? path.join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId())
			: undefined;

		const id = registry.createId(request.name ?? agent.name);
		// Every subagent joins the chat when it is on, so others can message it even if it may not send.
		const hub = plan.chatRights ? chatHubFor(ctx) : undefined;
		const chat =
			hub && plan.chatRights ? { socket: hub.address(), token: hub.register(id, plan.chatRights) } : undefined;
		const systemPrompt =
			chat && plan.chatRights
				? `${plan.systemPrompt}\n\n${chatPromptSection(id, plan.chatRights)}`
				: plan.systemPrompt;

		const subagent = new Subagent({
			id,
			agentName: agent.name,
			agentSource: agent.source,
			description: describeRun(request),
			task: request.task,
			cwd: request.cwd ?? ctx.cwd,
			systemPrompt,
			tools: plan.tools,
			skillGroups: plan.skillGroups,
			model: agent.model ?? parentModel,
			thinkingLevel: inheritsModel ? (ctx.thinkingLevel as ThinkingLevel | undefined) : undefined,
			sessionDir,
			sessionFile: request.session,
			projectTrusted: ctx.isProjectTrusted(),
			ui: ctx.hasUI ? ctx.ui : undefined,
			slots,
			command: options.command,
			chat,
		});
		registry.add(subagent);
		return { subagent, message: request.session ? request.task : `Task: ${request.task}` };
	};

	/** Run a prepared subagent until it settles, reporting progress. Aborting `signal` aborts it. */
	const watchRun = async (
		subagent: Subagent,
		message: string,
		step: number | undefined,
		signal: AbortSignal | undefined,
		onProgress: (run: SubagentRunDetails) => void,
	): Promise<SubagentRunDetails> => {
		const unsubscribe = subagent.onChange(() => onProgress(toDetails(subagent, step)));
		try {
			await subagent.run(message, signal);
		} finally {
			unsubscribe();
		}
		if (signal?.aborted) throw new Error("Subagent was aborted");
		return toDetails(subagent, step);
	};

	/** Start (or continue) one subagent and wait for it to settle. */
	const runOne = async (
		request: RunRequest,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress: (run: SubagentRunDetails) => void,
	): Promise<SubagentRunDetails> => {
		const prepared = prepareRun(request, ctx);
		if ("failure" in prepared) return prepared.failure;
		return watchRun(prepared.subagent, prepared.message, request.step, signal, onProgress);
	};

	// --- Background subagents ---------------------------------------------------------------------------------

	/** Background chains still working through their steps; waiting for all subagents also waits for these. */
	const backgroundJobs = new Set<Promise<void>>();
	const jobListeners = new Set<() => void>();
	/** Subagents whose outcome a wait or result call already gave the orchestrator, so no notice repeats it. */
	const reported = new Set<string>();
	/** Subagents whose result `subagent_result` returned, for `subagent_list`. */
	const resultsRead = new Set<string>();
	/** Bumped when the session changes, so subagents of an earlier session never post notices into this one. */
	let generation = 0;
	const pendingNotices: Array<{ subagent: Subagent; completion: BackgroundCompletion }> = [];
	let noticeTimer: NodeJS.Timeout | undefined;
	/** From the orchestrator's agent_start to agent_settled: notices are held while it works. */
	let orchestratorBusy = false;

	const trackJob = (job: Promise<void>) => {
		backgroundJobs.add(job);
		void job.finally(() => {
			backgroundJobs.delete(job);
			for (const listener of [...jobListeners]) listener();
		});
	};

	/** Post one notice for the background subagents that finished in the last batch window. */
	const flushNotices = () => {
		noticeTimer = undefined;
		// A message posted mid-run is only delivered when the run ends, by which time the orchestrator may have
		// read these results itself. So wait for it to settle, and only then drop what it has seen.
		if (orchestratorBusy) return;
		const batch = pendingNotices.splice(0).filter(({ subagent }) => !reported.has(subagent.key));
		for (const completion of ["wake", "notify"] as const) {
			const subagents = batch.filter((entry) => entry.completion === completion).map((entry) => entry.subagent);
			if (subagents.length === 0) continue;
			for (const subagent of subagents) reported.add(subagent.key);
			const content = [
				// The model receives this in the user role, so say plainly that the user did not write it and what is
				// expected; without that, models remark on a "user message" that is not from the user.
				"[Automated notice from the subagent system, not a message from the user.]",
				"Background subagents you started have finished:",
				...subagents.map(statusLine),
				`If the user's request needs their results, read them with ${SUBAGENT_RESULT_TOOL_NAME} and continue. Otherwise no reply is needed.`,
			].join("\n");
			pi.sendMessage(
				{
					customType: BACKGROUND_NOTICE_TYPE,
					content,
					display: true,
					details: { results: subagents.map(statusDetails) },
				},
				// `wake` starts a turn when the orchestrator is idle, or queues after its current one; `notify`
				// waits for the next turn.
				completion === "wake" ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" },
			);
		}
	};

	/** Run a prepared background subagent and queue a notice when it settles. */
	const runInBackground = (
		subagent: Subagent,
		message: string,
		step: number | undefined,
		completion: BackgroundCompletion,
	): Promise<SubagentRunDetails> => {
		const startedIn = generation;
		return watchRun(subagent, message, step, undefined, () => {}).finally(() => {
			if (startedIn !== generation || completion === "silent") return;
			pendingNotices.push({ subagent, completion });
			noticeTimer ??= setTimeout(flushNotices, NOTICE_BATCH_MS);
		});
	};

	/** Start a call's subagents in the background and describe them, without waiting. */
	const launchBackground = (
		params: SubagentCallParams,
		shared: Pick<RunRequest, "cwd" | "extraTools" | "extraSkillGroups">,
		ctx: ExtensionContext,
		completion: BackgroundCompletion,
	): AgentToolResult<SubagentToolDetails> => {
		const results: SubagentRunDetails[] = [];
		const started: Subagent[] = [];
		let mode: SubagentToolDetails["mode"];

		if (params.chain && params.chain.length > 0) {
			mode = "chain";
			const chain = params.chain;
			const first = prepareRun({ ...shared, ...chain[0], step: 1 }, ctx);
			if ("failure" in first) {
				results.push(first.failure);
			} else {
				started.push(first.subagent);
				results.push(toDetails(first.subagent, 1));
				// Later steps start as earlier ones finish, each with the previous step's output.
				trackJob(
					(async () => {
						let run = await runInBackground(first.subagent, first.message, 1, completion);
						for (let i = 1; i < chain.length && !isFailedRun(run); i++) {
							const task = chain[i].task.replace(/\{previous\}/g, getFinalOutput(run.messages));
							const next = prepareRun({ ...shared, ...chain[i], task, step: i + 1 }, ctx);
							if ("failure" in next) break;
							run = await runInBackground(next.subagent, next.message, i + 1, completion);
						}
					})().catch(() => {}),
				);
			}
		} else {
			const parallel = params.tasks !== undefined && params.tasks.length > 0;
			mode = parallel ? "parallel" : "single";
			const requests: RunRequest[] = parallel
				? (params.tasks ?? []).map((task) => ({ ...shared, ...task }))
				: [
						{
							...shared,
							agent: params.agent,
							task: params.task ?? "",
							name: params.name,
							description: params.description,
							session: params.session,
						},
					];
			for (const request of requests) {
				const prepared = prepareRun(request, ctx);
				if ("failure" in prepared) {
					results.push(prepared.failure);
					continue;
				}
				started.push(prepared.subagent);
				results.push(toDetails(prepared.subagent));
				void runInBackground(prepared.subagent, prepared.message, undefined, completion).catch(() => {});
			}
		}

		const lines: string[] = [];
		if (started.length > 0) {
			lines.push("Started in the background:", ...started.map(statusLine));
			if (mode === "chain") lines.push("Later chain steps start as earlier ones finish.");
			lines.push(
				`They keep working while you continue. To collect them, call ${SUBAGENT_WAIT_TOOL_NAME} (it returns once all of them have finished), then ${SUBAGENT_RESULT_TOOL_NAME}.`,
			);
			if (completion !== "silent") lines.push("You will also be told when they finish.");
		}
		for (const failure of results.filter((run) => run.status === "failed")) {
			lines.push(`${failure.id} did not start: ${failure.errorMessage}`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode, results, background: true, live: true },
			isError: started.length === 0 || undefined,
		};
	};

	// --- Chat -----------------------------------------------------------------------------------------------

	pi.registerFlag(CHAT_FLAG, {
		type: "string",
		description: "Socket of the parent's subagent chat hub (set by the parent in subagent processes)",
	});

	/** In a subagent process: the connection to the parent's chat hub, once `session_start` has connected it. */
	let chatClient: ChatClient | undefined;
	const isSubagentProcess = () => {
		const socket = pi.getFlag(CHAT_FLAG);
		return typeof socket === "string" && socket !== "";
	};
	/** This process's name in chat, for bubble labels. */
	const chatSelf = () => (isSubagentProcess() ? (chatClient?.name ?? "me") : ORCHESTRATOR);
	/** Whether a message's sender is still blocked waiting for its reply. Only the parent's hub knows. */
	const isAwaitingReply = (id: string) => chatHub?.isAwaitingReply(id) === true;

	pi.registerTool<typeof ChatSendParams, ChatToolDetails>({
		name: CHAT_SEND_TOOL_NAME,
		label: "Chat Send",
		description: [
			'Send a short chat message to another agent in this session: a subagent by name, "orchestrator", or "all" for everyone still running.',
			"A busy recipient reads it after its current tool call. Use it for findings, conflicts, and questions that change the recipient's work, not for progress updates.",
			"Set waitForReply to block until the recipient answers (or the timeout passes); while you wait, any other message to you ends the wait and is returned instead.",
			`See who you can message with ${CHAT_PEERS_TOOL_NAME}.`,
		].join(" "),
		promptSnippet: "Send a chat message to another agent",
		parameters: ChatSendParams,
		defaultActive: bundledChat.enabled && bundledChat.orchestratorCanMessage.length > 0,
		renderShell: "self",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const request = {
				to: params.to,
				text: params.text,
				waitForReply: params.waitForReply,
				timeoutSeconds: params.timeoutSeconds,
			};
			let result: SendResult;
			if (isSubagentProcess()) {
				result = chatClient
					? await chatClient.send(request, signal)
					: { ok: false, text: "Chat is not connected.", outcome: "refused" };
			} else {
				const hub = chatHubFor(ctx);
				result = hub
					? await hub.send(ORCHESTRATOR, request, signal)
					: { ok: false, text: "Chat is turned off.", outcome: "refused" };
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: { to: params.to, ok: result.ok, outcome: result.outcome, message: result.message },
				isError: !result.ok || undefined,
			};
		},

		renderCall(args, theme, context) {
			return renderChatSendCall(args, theme, { ...context, self: chatSelf() });
		},

		renderResult(result, { expanded }, theme, context) {
			const first = result.content[0];
			const outcome = {
				text: first?.type === "text" ? first.text : "",
				outcome: result.details?.outcome,
				message: result.details?.message,
			};
			const options = {
				expanded,
				isError: context.isError,
				isPartial: context.isPartial,
				outputPad: context.outputPad,
				self: chatSelf(),
				isAwaitingReply,
			};
			return renderChatSendResult(outcome, context.args.to, options, theme);
		},
	});

	pi.registerTool<typeof ChatPeersParams, undefined>({
		name: CHAT_PEERS_TOOL_NAME,
		label: "Chat Peers",
		description:
			"List the agents you can message with chat_send, with what each is doing and whether it is still running.",
		promptSnippet: "List the agents you can message",
		parameters: ChatPeersParams,
		defaultActive: bundledChat.enabled && bundledChat.orchestratorCanMessage.length > 0,
		renderShell: "self",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			let text: string;
			if (isSubagentProcess()) text = chatClient ? await chatClient.peers() : "Chat is not connected.";
			else text = chatHubFor(ctx)?.peers(ORCHESTRATOR) ?? "Chat is turned off.";
			return { content: [{ type: "text", text }], details: undefined };
		},

		renderCall(_args, theme, context) {
			return renderCallLine("Peers", undefined, "", theme, context);
		},

		renderResult(result, _options, theme, context) {
			const first = result.content[0];
			return renderChatPeersResult(first?.type === "text" ? first.text : "", context.outputPad, theme);
		},
	});

	pi.registerMessageRenderer<ChatDelivery>(CHAT_MESSAGE_TYPE, (message, options, theme) =>
		message.details
			? renderChatMessage(message.details, { ...options, self: chatSelf(), isAwaitingReply }, theme)
			: undefined,
	);

	pi.registerFlag(SKILL_GROUPS_FLAG, {
		type: "string",
		description: "Skill groups served by skill_search and load_skill (set by the parent in subagent processes)",
	});

	pi.registerTool({
		name: SKILL_SEARCH_TOOL_NAME,
		label: "Skill Search",
		description:
			"Search the skills available to you by query and tags. Returns each match's name, description, and tags. Call it with no query to list every skill, then load a match with load_skill.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Words to match against skill names, descriptions, and tags" }),
			),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Tags to match, such as php or symfony" })),
			limit: Type.Optional(Type.Number({ description: `Maximum results. Default: ${DEFAULT_SKILL_SEARCH_LIMIT}` })),
		}),
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const catalog = loadChildCatalog(pi, ctx);
			if (catalog.skills.length === 0) {
				return { content: [{ type: "text", text: "No skills are available to this agent." }], details: undefined };
			}
			const matches = searchSkills(catalog.skills, params.query, params.tags, params.limit);
			const text =
				matches.length > 0
					? `${matches
							.map((match) => {
								const tags = match.tags.length > 0 ? ` [tags: ${match.tags.join(", ")}]` : "";
								return `- ${match.name}: ${match.description}${tags}`;
							})
							.join("\n")}\n\nRead a skill with ${LOAD_SKILL_TOOL_NAME}.`
					: `No skills matched. Available tags: ${listSkillTags(catalog.skills).join(", ") || "none"}.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: LOAD_SKILL_TOOL_NAME,
		label: "Load Skill",
		description: "Read the instructions of a skill found with skill_search.",
		parameters: Type.Object({ name: Type.String({ description: "Skill name, as returned by skill_search" }) }),
		defaultActive: false,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const skill = loadChildCatalog(pi, ctx).skills.find((candidate) => candidate.name === params.name);
			if (!skill) {
				return {
					content: [
						{ type: "text", text: `Skill "${params.name}" is not available. Use ${SKILL_SEARCH_TOOL_NAME}.` },
					],
					details: undefined,
					isError: true,
				};
			}
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			const text = `<skill name="${skill.name}" directory="${skill.baseDir}">\nResolve relative paths in this skill against its directory.\n\n${body}\n</skill>`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool<typeof SubagentParams, SubagentToolDetails>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents. Each runs in its own process with its own prompt, tools, and session, so its work stays out of your context.",
			"Modes: single (agent + task), parallel (tasks), chain (sequential, with {previous} replaced by the prior output).",
			"Give every subagent a one-word name and a 2-4 word description of what it is doing; both show in the agent view, and the name identifies it.",
			"Pass session with a subagent's name to send it a follow-up.",
			`Set background to keep working while subagents run; then use ${SUBAGENT_WAIT_TOOL_NAME} and ${SUBAGENT_RESULT_TOOL_NAME}.`,
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents with isolated context",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const shared = { cwd: params.cwd, extraTools: params.extraTools, extraSkillGroups: params.extraSkillGroups };
			const steps = params.chain ?? params.tasks;
			const hasSteps = (steps?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task && (params.agent || params.session));
			if (Number(hasSteps) + Number(hasSingle) !== 1 || (params.chain && params.tasks)) {
				const available = discoverAgents(ctx.cwd, ctx.isProjectTrusted()).agents;
				const list = available.map((agent) => `${agent.name}: ${agent.description}`).join("\n") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one of: agent + task, session + task, tasks, or chain.\nAvailable agents:\n${list}`,
						},
					],
					details: { mode: "single", results: [] } satisfies SubagentToolDetails,
					isError: true,
				};
			}

			const config = loadSubagentConfig(ctx.isProjectTrusted() ? findProjectSubagentsDir(ctx.cwd) : null);
			if (params.background ?? config.defaultMode === "background") {
				if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: { mode: "parallel", results: [] },
						isError: true,
					};
				}
				return launchBackground(params, shared, ctx, config.onBackgroundComplete);
			}

			if (params.chain && params.chain.length > 0) {
				const results: SubagentRunDetails[] = [];
				let previous = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const run = await runOne(
						{ ...shared, ...step, task: step.task.replace(/\{previous\}/g, previous), step: i + 1 },
						ctx,
						signal,
						(partial) =>
							onUpdate?.({
								content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
								details: { mode: "chain", results: [...results, partial] },
							}),
					);
					results.push(run);
					if (isFailedRun(run)) {
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${runOutput(run)}` },
							],
							details: { mode: "chain", results },
							isError: true,
						};
					}
					previous = getFinalOutput(run.messages);
				}
				return {
					content: [{ type: "text", text: runOutput(results[results.length - 1]) }],
					details: { mode: "chain", results },
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: { mode: "parallel", results: [] },
						isError: true,
					};
				}
				const live: SubagentRunDetails[] = params.tasks.map((task, index) => ({
					...failedRun({ ...task }, task.name ?? `#${index + 1}`, ""),
					status: "pending",
					errorMessage: undefined,
				}));
				const emit = () => {
					const done = live.filter((run) => !["pending", "queued", "running"].includes(run.status)).length;
					onUpdate?.({
						content: [{ type: "text", text: `Parallel: ${done}/${live.length} done...` }],
						details: { mode: "parallel", results: [...live] },
					});
				};
				// All tasks start together; the slot pool queues those beyond `maxConcurrent`.
				const results = await Promise.all(
					params.tasks.map(async (task, index) => {
						const run = await runOne({ ...shared, ...task }, ctx, signal, (partial) => {
							live[index] = partial;
							emit();
						});
						live[index] = run;
						emit();
						return run;
					}),
				);
				const succeeded = results.filter((run) => !isFailedRun(run)).length;
				const summaries = results.map((run) => {
					const status = isFailedRun(run) ? `failed${run.stopReason ? ` (${run.stopReason})` : ""}` : "completed";
					return `### [${run.agent}] ${status}\n\n${truncateOutput(runOutput(run))}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${succeeded}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: { mode: "parallel", results },
				};
			}

			const run = await runOne(
				{
					...shared,
					agent: params.agent,
					task: params.task ?? "",
					name: params.name,
					description: params.description,
					session: params.session,
				},
				ctx,
				signal,
				(partial) =>
					onUpdate?.({
						content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
						details: { mode: "single", results: [partial] },
					}),
			);
			const failed = isFailedRun(run);
			return {
				content: [
					{
						type: "text",
						text: failed ? `Agent ${run.stopReason || run.status}: ${runOutput(run)}` : runOutput(run),
					},
				],
				details: { mode: "single", results: [run] },
				isError: failed || undefined,
			};
		},

		// Draw a compact `● Subagent(name)` line with `⎿` status rows instead of the boxed tool block.
		renderShell: "self",

		renderCall(args, theme, context) {
			return renderSubagentCall(args, theme, context);
		},

		renderResult(result, { expanded }, theme, context) {
			const first = result.content[0];
			return renderSubagentResult(
				result.details,
				first?.type === "text" ? first.text : "",
				{ expanded, isError: context.isError, outputPad: context.outputPad, lookup },
				theme,
			);
		},
	});

	/** The heading of a wait that a chat message ended. The messages themselves follow the tool result. */
	const chatInterruption = (unread: ChatDelivery[]): string => {
		const senders = [...new Set(unread.map((delivery) => delivery.from))];
		const waiting = unread
			.filter((delivery) => delivery.awaitingReply && isAwaitingReply(delivery.id))
			.map((delivery) => delivery.from);
		const lines = [
			`Stopped waiting: ${senders.join(", ") || "another agent"} sent you a chat message, shown after this result.`,
		];
		if (waiting.length > 0) lines.push(`${[...new Set(waiting)].join(", ")} is blocked waiting for your reply.`);
		lines.push(
			`The subagents keep running. Answer it or change direction if needed; if you still want their results, call ${SUBAGENT_WAIT_TOOL_NAME} again. Status:`,
		);
		return lines.join("\n");
	};

	pi.registerTool<typeof WaitParams, SubagentToolDetails>({
		name: SUBAGENT_WAIT_TOOL_NAME,
		label: "Subagent Wait",
		description: [
			"Wait until subagents finish: the named ones, or every subagent still running or queued.",
			"By default it returns only once ALL targets have finished.",
			"Set returnOnFirst only to handle results one at a time as each subagent finishes.",
			"A chat message to you ends the wait early, so you can answer it or change direction; the subagents keep running, and you may call it again to keep waiting.",
			`Returns each target's status. Then read finished subagents' results with ${SUBAGENT_RESULT_TOOL_NAME}.`,
		].join(" "),
		promptSnippet: "Wait for background subagents to finish",
		parameters: WaitParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate) {
			const mode = params.returnOnFirst ? "any" : "all";
			const unknown = (params.names ?? []).filter((name) => !registry.find(name));
			if (unknown.length > 0) {
				const known =
					registry
						.list()
						.map((subagent) => subagent.id)
						.join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown subagents: ${unknown.join(", ")}. Known: ${known}.` }],
					details: { mode: "parallel", results: [] },
					isError: true,
				};
			}

			// Without names, every unsettled subagent is a target, including chain steps that start while waiting.
			const targets = new Map<string, Subagent>();
			const collect = (): boolean => {
				const candidates = params.names
					? params.names.map((name) => registry.find(name)).filter((subagent) => subagent !== undefined)
					: registry.list().filter((subagent) => !isSettled(subagent));
				let added = false;
				for (const subagent of candidates) {
					if (targets.has(subagent.key)) continue;
					targets.set(subagent.key, subagent);
					added = true;
				}
				return added;
			};
			collect();
			if (targets.size === 0 && (params.names !== undefined || backgroundJobs.size === 0)) {
				return {
					content: [{ type: "text", text: "No subagents are running or queued." }],
					details: { mode: "parallel", results: [] },
				};
			}

			const emitProgress = () =>
				onUpdate?.({
					content: [{ type: "text", text: "Waiting..." }],
					details: { mode: "parallel", results: [...targets.values()].map(statusDetails), live: true },
				});
			emitProgress();

			const done = (): boolean => {
				const list = [...targets.values()];
				if (mode === "any") return list.some(isSettled);
				return list.every(isSettled) && (params.names !== undefined || backgroundJobs.size === 0);
			};
			// Ends when the targets finish, the call is aborted, or a chat message to the orchestrator arrives.
			const ending = await new Promise<"done" | "aborted" | "chat">((resolve) => {
				let finished = false;
				const finish = (reason: "done" | "aborted" | "chat") => {
					if (finished) return;
					finished = true;
					unsubscribe();
					jobListeners.delete(check);
					chatListeners.delete(onChat);
					signal?.removeEventListener("abort", onAbort);
					resolve(reason);
				};
				const check = () => {
					if (!params.names && collect()) emitProgress();
					if (done()) finish("done");
				};
				const onAbort = () => finish("aborted");
				const onChat = () => finish("chat");
				const unsubscribe = registry.onChange(check);
				jobListeners.add(check);
				chatListeners.add(onChat);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) finish("aborted");
				else check();
				if (unreadChat.size > 0) finish("chat");
			});

			const list = [...targets.values()];
			const finished = list.filter(isSettled);
			for (const subagent of finished) reported.add(subagent.key);
			const heading =
				ending === "aborted"
					? "Stopped waiting."
					: ending === "chat"
						? chatInterruption([...unreadChat.values()])
						: mode === "any"
							? "A subagent finished."
							: "All targets finished.";
			const lines = [heading, ...list.map(statusLine)];
			if (finished.length > 0) {
				const names = finished.map((subagent) => subagent.id).join(", ");
				lines.push(`Read results with ${SUBAGENT_RESULT_TOOL_NAME}: ${names}.`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { mode: "parallel", results: list.map(statusDetails) },
			};
		},

		renderCall(args, theme, context) {
			return renderWaitCall(args, theme, context);
		},

		renderResult(result, { expanded }, theme, context) {
			const first = result.content[0];
			const fallback = first?.type === "text" ? first.text : "";
			const options = {
				expanded,
				isError: context.isError,
				isPartial: context.isPartial,
				outputPad: context.outputPad,
				lookup,
			};
			return renderWaitResult(context.args, result.details, fallback, options, theme);
		},
	});

	pi.registerTool<typeof ResultParams, SubagentToolDetails>({
		name: SUBAGENT_RESULT_TOOL_NAME,
		label: "Subagent Result",
		description: [
			"Read the results of finished subagents: each one's final answer, or its error.",
			`Only for subagents that have finished: running and queued ones have no result yet, so check ${SUBAGENT_LIST_TOOL_NAME} or wait with ${SUBAGENT_WAIT_TOOL_NAME} first.`,
			"Pass several names to read several results in one call.",
		].join(" "),
		promptSnippet: "Read the results of finished subagents",
		parameters: ResultParams,
		renderShell: "self",

		async execute(_toolCallId, params) {
			const sections: string[] = [];
			const results: SubagentRunDetails[] = [];
			let read = 0;
			for (const name of params.names) {
				const subagent = registry.find(name);
				if (!subagent) {
					sections.push(
						`### ${name}\n\nUnknown subagent. List this session's subagents with ${SUBAGENT_LIST_TOOL_NAME}.`,
					);
					continue;
				}
				results.push(statusDetails(subagent));
				if (!isSettled(subagent)) {
					const state = subagent.isQueued ? "queued" : "running";
					sections.push(
						`### ${subagent.id} (not finished)\n\nNo result yet: ${state}. Wait for it with ${SUBAGENT_WAIT_TOOL_NAME}, or check ${SUBAGENT_LIST_TOOL_NAME}.`,
					);
					continue;
				}
				read++;
				reported.add(subagent.key);
				resultsRead.add(subagent.key);
				sections.push(
					`### ${subagent.id} (${subagent.status})\n\n${truncateOutput(runOutput(toDetails(subagent)))}`,
				);
			}
			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: { mode: "parallel", results },
				// No result at all is an error, so the orchestrator notices it asked too early.
				isError: read === 0 || undefined,
			};
		},

		renderCall(args, theme, context) {
			return renderCallLine("Result", (args.names ?? []).join(", "), "", theme, context);
		},

		renderResult(result, { expanded }, theme, context) {
			const first = result.content[0];
			return renderSubagentResult(
				result.details,
				first?.type === "text" ? first.text : "",
				{ expanded, isError: context.isError, outputPad: context.outputPad },
				theme,
			);
		},
	});

	pi.registerTool<typeof ListParams, SubagentToolDetails>({
		name: SUBAGENT_LIST_TOOL_NAME,
		label: "Subagent List",
		description: [
			"List this session's subagents and their status: running, queued (waiting for a free slot),",
			`or finished, with whether you have read its result. Check it before ${SUBAGENT_RESULT_TOOL_NAME} to read only finished subagents.`,
		].join(" "),
		promptSnippet: "List subagents and their status",
		parameters: ListParams,
		renderShell: "self",

		async execute() {
			const subagents = registry.list();
			if (subagents.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents in this session." }],
					details: { mode: "parallel", results: [] },
				};
			}
			const running = subagents.filter((subagent) => subagent.isRunning);
			const queued = subagents.filter((subagent) => subagent.isQueued);
			const finished = subagents.filter(isSettled);
			const unread = finished.filter((subagent) => !resultsRead.has(subagent.key));
			const heading = `Subagents: ${running.length} running, ${queued.length} queued, ${finished.length} finished (${unread.length} result${unread.length === 1 ? "" : "s"} not read).`;
			const lines = subagents.map((subagent) => {
				if (!isSettled(subagent)) return statusLine(subagent);
				return `${statusLine(subagent)}; result ${resultsRead.has(subagent.key) ? "read" : "not read"}`;
			});
			return {
				content: [{ type: "text", text: [heading, ...lines].join("\n") }],
				details: { mode: "parallel", results: subagents.map(statusDetails) },
			};
		},

		renderCall(_args, theme, context) {
			return renderCallLine("List", "subagents", "", theme, context);
		},

		renderResult(result, _options, theme, context) {
			return renderListResult(result.details, context.outputPad, theme);
		},
	});

	pi.registerMessageRenderer<{ results: SubagentRunDetails[] }>(BACKGROUND_NOTICE_TYPE, (message, options, theme) =>
		message.details ? renderBackgroundNotice(message.details.results, options, theme) : undefined,
	);

	const resetBackground = () => {
		generation++;
		pendingNotices.length = 0;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = undefined;
		reported.clear();
	};

	pi.on("message_start", (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== CHAT_MESSAGE_TYPE) return;
		const id = (message.details as ChatDelivery | undefined)?.id;
		if (id) unreadChat.delete(id);
	});

	pi.on("agent_start", () => {
		orchestratorBusy = true;
	});

	pi.on("agent_settled", () => {
		orchestratorBusy = false;
		// A steer the run never delivered (dropped by an abort, say) must not end every later wait at once.
		unreadChat.clear();
		if (pendingNotices.length > 0 && !noticeTimer) flushNotices();
	});

	pi.on("session_start", async (_event, ctx) => {
		resetBackground();
		registry.clear();
		closeChat();
		lastViewed = undefined;
		stopListening?.();
		stopListening = undefined;

		// In a subagent process, join the parent's chat. Messages arrive between tool calls, or before the first turn
		// for ones held while this subagent was queued.
		const socket = pi.getFlag(CHAT_FLAG);
		const token = process.env[CHAT_TOKEN_ENV];
		if (typeof socket === "string" && socket !== "" && token) {
			const client = new ChatClient(socket, token, (delivery) =>
				pi.sendMessage(
					{
						customType: CHAT_MESSAGE_TYPE,
						content: frameMessage(delivery, false),
						display: true,
						details: delivery,
					},
					{ deliverAs: "steer" },
				),
			);
			try {
				await client.connect();
				chatClient = client;
			} catch {
				client.close();
			}
		}

		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		let dock: SubagentDock | undefined;
		ctx.ui.setWidget(
			DOCK_WIDGET_KEY,
			(tui, theme) => {
				dock = new SubagentDock(tui, theme, registry);
				return dock;
			},
			{ placement: "belowEditor" },
		);

		let viewOpen = false;
		const openView = (openId?: string) => {
			viewOpen = true;
			if (openId !== undefined) lastViewed = openId;
			void ctx.ui
				.custom<void>(
					(tui, theme, keybindings, done) =>
						new AgentView(tui, theme, keybindings, registry, {
							cwd: ctx.cwd,
							scrollbar: pi.getSettings().fullscreenScrollbar ?? "auto",
							initialSelection: lastViewed,
							openId,
							onOpen: (id) => {
								lastViewed = id;
							},
							isAwaitingReply,
							close: () => done(undefined),
						}),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
				)
				.finally(() => {
					viewOpen = false;
				});
		};

		stopListening = ctx.ui.onTerminalInput((data) => {
			if (viewOpen) return undefined;
			const keybindings = getKeybindings();
			if (dock?.isFocused) {
				const result = dock.handleKey(data, keybindings);
				if (result.type === "open") {
					openView(result.id);
					return { consume: true };
				}
				if (result.type === "consumed") return { consume: true };
				// "pass": the dock let go of focus, and the key goes on to the composer below.
			} else if (
				ctx.ui.getEditorText() === "" &&
				keybindings.matches(data, "tui.editor.cursorDown") &&
				dock?.focus()
			) {
				return { consume: true };
			}
			if (ctx.ui.getEditorText() !== "") return undefined;
			if (!keybindings.matches(data, "app.agents.view")) return undefined;
			openView();
			return { consume: true };
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetBackground();
		registry.clear();
		closeChat();
		stopListening?.();
		stopListening = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined);
	});
}
