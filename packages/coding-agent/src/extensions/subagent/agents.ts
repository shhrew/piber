/**
 * Agent discovery for the subagent extension.
 *
 * Agents come from two layers:
 * - bundled: `agents/*.md` shipped inside this extension directory
 * - project: `.pi/subagents/agents/*.md` in the nearest ancestor of the cwd, only when the project is trusted
 *
 * A project agent replaces a bundled agent with the same name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { type ChatPermission, getSubagentAssetsDir, parseChatPermissions, parseNameList } from "./paths.ts";

export type AgentSource = "bundled" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	/** Tools added on top of `subagents.coreTools`. */
	tools: string[];
	/** Skill groups the agent can search with `skill_search`. */
	skillGroups: string[];
	/** Skills always listed in the agent's prompt. They must belong to one of `skillGroups`. */
	pinnedSkills: string[];
	/**
	 * Who the agent may message over subagent chat (`orchestrator`, `subagents`, `all`). Undefined uses the config's
	 * `chat.defaultCanMessage`; unknown words are ignored.
	 */
	canMessage?: ChatPermission[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	/** `.pi/subagents` of the nearest ancestor of the cwd, when one exists and the project is trusted. */
	projectDir: string | null;
}

/**
 * Raw agent frontmatter. A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the implicit index signature.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	skillGroups?: unknown;
	pinnedSkills?: unknown;
	canMessage?: unknown;
	model?: unknown;
};

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: { frontmatter: AgentFrontmatter; body: string };
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseNameList(frontmatter.tools),
			skillGroups: parseNameList(frontmatter.skillGroups),
			canMessage: frontmatter.canMessage === undefined ? undefined : parseChatPermissions(frontmatter.canMessage),
			pinnedSkills: parseNameList(frontmatter.pinnedSkills),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** `.pi/subagents` of the nearest ancestor of `cwd` that has one. */
export function findProjectSubagentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "subagents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, projectTrusted: boolean): AgentDiscoveryResult {
	const projectDir = projectTrusted ? findProjectSubagentsDir(cwd) : null;
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(path.join(getSubagentAssetsDir(), "agents"), "bundled")) {
		agentMap.set(agent.name, agent);
	}
	if (projectDir) {
		for (const agent of loadAgentsFromDir(path.join(projectDir, "agents"), "project")) {
			agentMap.set(agent.name, agent);
		}
	}
	return { agents: Array.from(agentMap.values()), projectDir };
}
