/**
 * Subagents as a built-in extension.
 *
 * - `subagent` delegates tasks to agents defined in `agents/*.md` (bundled) and `.pi/subagents/agents/*.md`
 *   (trusted projects). Each subagent is a separate `pi --mode rpc` process with its own system prompt,
 *   tools, skill groups, and session file. Modes: single, parallel, and chain.
 * - `skill_search` and `load_skill` serve a subagent's skill groups. They are registered inactive and are
 *   enabled only in subagent processes, through the `--tools` list the parent passes.
 * - The agent view (`app.agents.view` pressed twice with an empty editor) lists the main session and its
 *   subagents, shows a subagent's live transcript, and steers it.
 *
 * See README.md in this directory.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getKeybindings } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { type AgentConfig, discoverAgents, findProjectSubagentsDir } from "./agents.ts";
import { emptyUsage, SKILL_GROUPS_FLAG, Subagent } from "./child.ts";
import { loadSubagentConfig, parseNameList } from "./paths.ts";
import { SubagentRegistry } from "./registry.ts";
import {
	getFinalOutput,
	isFailedRun,
	renderSubagentCall,
	renderSubagentResult,
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
import { AgentView, DoublePressDetector } from "./view.ts";

export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const LOAD_SKILL_TOOL_NAME = "load_skill";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate. In a chain, {previous} is replaced by the prior output." }),
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
				"Continue an earlier subagent (single mode): its id, such as sa1, or its session file path. `task` is sent as the next message.",
		}),
	),
	...RunFields,
});

interface RunRequest {
	agent?: string;
	task: string;
	cwd?: string;
	extraTools?: string[];
	extraSkillGroups?: string[];
	session?: string;
	step?: number;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(Math.max(1, Math.min(concurrency, items.length))).fill(null).map(async () => {
		while (nextIndex < items.length) {
			const current = nextIndex++;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output is in the subagent's session.]`;
}

function toDetails(subagent: Subagent, step?: number): SubagentRunDetails {
	return {
		id: subagent.id,
		agent: subagent.options.agentName,
		agentSource: subagent.options.agentSource,
		task: subagent.options.task,
		status: subagent.isRunning ? "running" : subagent.status,
		messages: [...subagent.messages],
		usage: { ...subagent.usage },
		model: subagent.model,
		stopReason: subagent.stopReason,
		errorMessage: subagent.errorMessage,
		sessionFile: subagent.sessionFile,
		step,
	};
}

function failedRun(request: RunRequest, id: string, errorMessage: string): SubagentRunDetails {
	return {
		id,
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

/** The agent's prompt plus a skills section naming the tags to search and the pinned skills. */
function buildSystemPrompt(agent: AgentConfig, catalog: SkillCatalog, hasSkillGroups: boolean): string {
	const parts = [agent.systemPrompt.trim()];
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
}

/**
 * What a subagent runs with: the core tools from `config.json`, then the agent's tools, then the call's
 * `extraTools`, plus `skill_search` and `load_skill` when it has skill groups; and the agent's prompt with
 * a skills section.
 */
export function planSubagentRun(
	agent: AgentConfig,
	request: Pick<RunRequest, "extraTools" | "extraSkillGroups">,
	projectDir: string | null,
): SubagentRunPlan {
	const skillGroups = unique([...agent.skillGroups, ...(request.extraSkillGroups ?? [])]);
	const catalog = loadSkillGroups(skillGroups, projectDir);
	const skillTools = skillGroups.length > 0 ? [SKILL_SEARCH_TOOL_NAME, LOAD_SKILL_TOOL_NAME] : [];
	const coreTools = loadSubagentConfig(projectDir).coreTools;
	return {
		tools: unique([...coreTools, ...agent.tools, ...(request.extraTools ?? []), ...skillTools]),
		skillGroups,
		catalog,
		systemPrompt: buildSystemPrompt(agent, catalog, skillGroups.length > 0),
	};
}

/** The skills a subagent process may search: the groups the parent passed, in the bundled and project layers. */
function loadChildCatalog(pi: ExtensionAPI, ctx: ExtensionContext): SkillCatalog {
	const groups = parseNameList(pi.getFlag(SKILL_GROUPS_FLAG));
	const projectDir = ctx.isProjectTrusted() ? findProjectSubagentsDir(ctx.cwd) : null;
	return loadSkillGroups(groups, projectDir);
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const registry = new SubagentRegistry();
	const reportedDiagnostics = new Set<string>();
	let stopListening: (() => void) | undefined;

	const reportDiagnostics = (catalog: SkillCatalog, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		for (const diagnostic of catalog.diagnostics) {
			const message = diagnostic.path ? `${diagnostic.message} (${diagnostic.path})` : diagnostic.message;
			if (reportedDiagnostics.has(message)) continue;
			reportedDiagnostics.add(message);
			ctx.ui.notify(`Subagent skills: ${message}`, "warning");
		}
	};

	/** Start (or continue) one subagent and wait for it to settle. */
	const runOne = async (
		request: RunRequest,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onProgress: (run: SubagentRunDetails) => void,
	): Promise<SubagentRunDetails> => {
		const watch = async (subagent: Subagent, message: string) => {
			const unsubscribe = subagent.onChange(() => onProgress(toDetails(subagent, request.step)));
			try {
				await subagent.run(message, signal);
			} finally {
				unsubscribe();
			}
			if (signal?.aborted) throw new Error("Subagent was aborted");
			return toDetails(subagent, request.step);
		};

		const existing = request.session ? registry.find(request.session) : undefined;
		if (existing) {
			if (existing.isRunning) return failedRun(request, existing.id, `Subagent ${existing.id} is still running`);
			return watch(existing, request.task);
		}

		const discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		const agent = discovery.agents.find((candidate) => candidate.name === request.agent);
		if (!agent) {
			const available = discovery.agents.map((candidate) => candidate.name).join(", ") || "none";
			const reason = request.session
				? `Unknown subagent session "${request.session}". To continue a session file from an earlier pi run, also pass its agent.`
				: `Unknown agent "${request.agent ?? ""}". Available agents: ${available}.`;
			return failedRun(request, registry.createId(), reason);
		}

		const plan = planSubagentRun(agent, request, discovery.projectDir);
		reportDiagnostics(plan.catalog, ctx);
		const inheritsModel = !agent.model;
		const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const parentSessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = parentSessionFile
			? path.join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId())
			: undefined;

		const subagent = new Subagent({
			id: registry.createId(),
			agentName: agent.name,
			agentSource: agent.source,
			task: request.task,
			cwd: request.cwd ?? ctx.cwd,
			systemPrompt: plan.systemPrompt,
			tools: plan.tools,
			skillGroups: plan.skillGroups,
			model: agent.model ?? parentModel,
			thinkingLevel: inheritsModel ? (ctx.thinkingLevel as ThinkingLevel | undefined) : undefined,
			sessionDir,
			sessionFile: request.session,
			projectTrusted: ctx.isProjectTrusted(),
			ui: ctx.hasUI ? ctx.ui : undefined,
		});
		registry.add(subagent);
		return watch(subagent, request.session ? request.task : `Task: ${request.task}`);
	};

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
			"Pass session with a subagent id to send it a follow-up.",
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
					...failedRun({ ...task }, `#${index + 1}`, ""),
					status: "pending",
					errorMessage: undefined,
				}));
				const emit = () => {
					const done = live.filter((run) => run.status !== "running" && run.status !== "pending").length;
					onUpdate?.({
						content: [{ type: "text", text: `Parallel: ${done}/${live.length} done...` }],
						details: { mode: "parallel", results: [...live] },
					});
				};
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const run = await runOne({ ...shared, ...task }, ctx, signal, (partial) => {
						live[index] = partial;
						emit();
					});
					live[index] = run;
					emit();
					return run;
				});
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
				{ ...shared, agent: params.agent, task: params.task ?? "", session: params.session },
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

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, { expanded }, theme) {
			const first = result.content[0];
			return renderSubagentResult(result.details, first?.type === "text" ? first.text : "", expanded, theme);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		registry.clear();
		stopListening?.();
		stopListening = undefined;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const detector = new DoublePressDetector();
		let viewOpen = false;
		stopListening = ctx.ui.onTerminalInput((data) => {
			if (viewOpen || ctx.ui.getEditorText() !== "") return undefined;
			if (!detector.isDoublePress(data, getKeybindings())) return undefined;
			viewOpen = true;
			void ctx.ui
				.custom<void>(
					(tui, theme, keybindings, done) =>
						new AgentView(tui, theme, keybindings, registry, ctx.cwd, () => done(undefined)),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
				)
				.finally(() => {
					viewOpen = false;
				});
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		registry.clear();
		stopListening?.();
		stopListening = undefined;
	});
}
