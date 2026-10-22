import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../../../src/extensions/subagent/agents.ts";
import { buildChildArgs, Subagent, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import subagentExtension, { planSubagentRun } from "../../../src/extensions/subagent/index.ts";
import { getSubagentAssetsDir, loadSubagentConfig } from "../../../src/extensions/subagent/paths.ts";
import { SubagentRegistry } from "../../../src/extensions/subagent/registry.ts";
import type { SubagentToolDetails } from "../../../src/extensions/subagent/render.ts";
import { loadSkillGroups, searchSkills } from "../../../src/extensions/subagent/skills.ts";
import { createHarness, getMessageText, getToolResult } from "../harness.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project directory with `.pi/subagents` files written from `files` (paths relative to `.pi/subagents`). */
function createProject(files: Record<string, string>): { cwd: string; subagentsDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-config-"));
	tempDirs.push(cwd);
	const subagentsDir = join(cwd, ".pi", "subagents");
	for (const [relativePath, content] of Object.entries(files)) {
		const filePath = join(subagentsDir, relativePath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, content);
	}
	return { cwd, subagentsDir };
}

function skill(name: string, description: string, extraFrontmatter = ""): string {
	return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n\nInstructions for ${name}.\n`;
}

describe("subagent agent discovery", () => {
	it("loads the bundled agents without anything in the user's agent directory", () => {
		const { cwd } = createProject({});
		const { agents, projectDir } = discoverAgents(cwd, true);

		expect(agents.map((agent) => agent.name).sort()).toEqual(["planner", "reviewer", "scout", "worker"]);
		expect(agents.every((agent) => agent.source === "bundled")).toBe(true);
		expect(projectDir).toBeNull();
		const reviewer = agents.find((agent) => agent.name === "reviewer");
		expect(reviewer?.skillGroups).toEqual(["review"]);
		expect(reviewer?.pinnedSkills).toEqual(["review-checklist"]);
	});

	it("lets a trusted project override a bundled agent and add its own", () => {
		const { cwd, subagentsDir } = createProject({
			"agents/scout.md":
				"---\nname: scout\ndescription: Project scout\ntools: bash, edit\n---\n\nProject scout prompt.\n",
			"agents/php.md":
				"---\nname: php\ndescription: PHP work\nskillGroups: [php]\npinnedSkills: symfony\n---\n\nPHP prompt.\n",
		});

		const trusted = discoverAgents(cwd, true);
		expect(trusted.projectDir).toBe(subagentsDir);
		const scout = trusted.agents.find((agent) => agent.name === "scout");
		expect(scout).toMatchObject({ source: "project", description: "Project scout", tools: ["bash", "edit"] });
		expect(trusted.agents.find((agent) => agent.name === "php")).toMatchObject({
			skillGroups: ["php"],
			pinnedSkills: ["symfony"],
		});

		const untrusted = discoverAgents(cwd, false);
		expect(untrusted.projectDir).toBeNull();
		expect(untrusted.agents.find((agent) => agent.name === "scout")?.source).toBe("bundled");
		expect(untrusted.agents.some((agent) => agent.name === "php")).toBe(false);
	});
});

describe("subagent skill groups", () => {
	it("reads tags from lists, comma-separated strings, and metadata.tags", () => {
		const { subagentsDir } = createProject({
			"skills/php/symfony/SKILL.md": skill("symfony", "Symfony controllers and services", "tags: [PHP, symfony]\n"),
			"skills/php/laravel/SKILL.md": skill(
				"laravel",
				"Laravel routing and Eloquent",
				"tags: php, laravel\nmetadata:\n  tags: eloquent, php\n",
			),
		});

		const { skills } = loadSkillGroups(["php"], subagentsDir);
		const tagsByName = Object.fromEntries(skills.map((entry) => [entry.name, entry.tags]));

		expect(tagsByName).toEqual({ symfony: ["php", "symfony"], laravel: ["php", "laravel", "eloquent"] });
		expect(skills.every((entry) => entry.groups.join() === "php")).toBe(true);
	});

	it("warns about skills without tags and invalid group names, and skips skills without a description", () => {
		const { subagentsDir } = createProject({
			"skills/misc/untagged/SKILL.md": skill("untagged", "No tags here"),
			"skills/misc/broken/SKILL.md": "---\nname: broken\n---\n\nNo description.\n",
		});

		const { skills, diagnostics } = loadSkillGroups(["misc", "../escape"], subagentsDir);

		expect(skills.map((entry) => entry.name)).toEqual(["untagged"]);
		const messages = diagnostics.map((diagnostic) => diagnostic.message);
		expect(messages).toContain('invalid skill group name "../escape"');
		expect(messages.some((message) => message.includes('"untagged" has no tags'))).toBe(true);
		expect(messages).toContain("description is required");
	});

	it("adds project skills to a bundled group, replacing bundled skills with the same name", () => {
		const { subagentsDir } = createProject({
			"skills/review/review-checklist/SKILL.md": skill("review-checklist", "Project checklist", "tags: [review]\n"),
			"skills/review/php-review/SKILL.md": skill("php-review", "PHP review", "tags: [review, php]\n"),
		});

		const { skills } = loadSkillGroups(["review"], subagentsDir);
		const byName = new Map(skills.map((entry) => [entry.name, entry]));

		expect([...byName.keys()].sort()).toEqual(["php-review", "review-checklist", "security-review"]);
		expect(byName.get("review-checklist")?.description).toBe("Project checklist");
	});

	it("ranks tag matches first, then name matches, then description matches", () => {
		const { subagentsDir } = createProject({
			"skills/php/symfony/SKILL.md": skill("symfony", "Symfony framework", "tags: [php, symfony]\n"),
			"skills/php/laravel/SKILL.md": skill("laravel", "Laravel framework", "tags: [php, laravel]\n"),
			"skills/php/composer/SKILL.md": skill(
				"composer",
				"Dependency management, works with symfony flex",
				"tags: [deps]\n",
			),
		});
		const { skills } = loadSkillGroups(["php"], subagentsDir);

		expect(searchSkills(skills, "php symfony", undefined).map((match) => match.name)).toEqual([
			"symfony",
			"laravel",
			"composer",
		]);
		expect(searchSkills(skills, undefined, ["laravel"]).map((match) => match.name)).toEqual(["laravel"]);
		expect(searchSkills(skills, "flex", undefined).map((match) => match.name)).toEqual(["composer"]);
		expect(searchSkills(skills, "kubernetes", undefined)).toEqual([]);
		expect(searchSkills(skills, undefined, undefined).map((match) => match.name)).toEqual([
			"composer",
			"laravel",
			"symfony",
		]);
	});
});

describe("subagent run planning", () => {
	it("combines core, agent, and call tools and adds the skill tools for agents with skill groups", () => {
		const { cwd } = createProject({});
		const reviewer = discoverAgents(cwd, true).agents.find((agent) => agent.name === "reviewer")!;

		const plan = planSubagentRun(reviewer, { extraTools: ["edit", "read"], extraSkillGroups: ["extra"] }, null);

		expect(plan.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "skill_search", "load_skill"]);
		expect(plan.skillGroups).toEqual(["review", "extra"]);
		expect(plan.systemPrompt).toContain("You are a senior code reviewer.");
		expect(plan.systemPrompt).toContain("Tags: quality, review, security, tests");
		expect(plan.systemPrompt).toContain("- review-checklist: General code review checklist");
		expect(plan.systemPrompt).not.toContain("- security-review:");
	});

	it("uses a trusted project's config.json for the core tools and leaves skill tools out without groups", () => {
		const { cwd, subagentsDir } = createProject({ "config.json": JSON.stringify({ coreTools: ["read"] }) });
		const planner = discoverAgents(cwd, true).agents.find((agent) => agent.name === "planner")!;

		const plan = planSubagentRun(planner, {}, subagentsDir);

		expect(plan.tools).toEqual(["read"]);
		expect(plan.systemPrompt).not.toContain("## Skills");
	});

	it("reads the background settings, lets a project override them, and ignores invalid values", () => {
		const { subagentsDir } = createProject({
			"config.json": JSON.stringify({ defaultMode: "background", onBackgroundComplete: "silent" }),
		});
		expect(loadSubagentConfig(subagentsDir)).toMatchObject({
			defaultMode: "background",
			onBackgroundComplete: "silent",
		});

		const invalid = createProject({
			"config.json": JSON.stringify({ defaultMode: "later", onBackgroundComplete: true }),
		});
		const bundled = loadSubagentConfig(null);
		expect(loadSubagentConfig(invalid.subagentsDir)).toMatchObject({
			defaultMode: bundled.defaultMode,
			onBackgroundComplete: bundled.onBackgroundComplete,
		});
	});

	it("reads maxConcurrent from the bundled config, lets a project override it, and ignores invalid values", () => {
		// Compare with the bundled file rather than fixed numbers, so tuning the shipped defaults keeps this passing.
		const bundled = JSON.parse(readFileSync(join(getSubagentAssetsDir(), "config.json"), "utf-8"));
		expect(loadSubagentConfig(null)).toEqual(bundled);

		const override = bundled.maxConcurrent + 3;
		const { subagentsDir } = createProject({ "config.json": JSON.stringify({ maxConcurrent: override }) });
		expect(loadSubagentConfig(subagentsDir)).toEqual({ ...bundled, maxConcurrent: override });

		for (const invalid of [0, -1, 1.5, "3"]) {
			const project = createProject({ "config.json": JSON.stringify({ maxConcurrent: invalid }) });
			expect(loadSubagentConfig(project.subagentsDir).maxConcurrent).toBe(bundled.maxConcurrent);
		}
	});
});

describe("subagent child arguments", () => {
	const options: SubagentOptions = {
		id: "diff-review",
		agentName: "reviewer",
		agentSource: "bundled",
		description: "Review the diff",
		task: "Review the diff in src/ and report problems",
		cwd: "/work",
		systemPrompt: "prompt",
		tools: ["read", "skill_search", "load_skill"],
		skillGroups: ["review", "php"],
		model: "anthropic/claude-sonnet-4-5",
		thinkingLevel: "high",
		sessionDir: "/sessions/subagents/parent",
		projectTrusted: false,
	};

	it("starts a new named session with its own prompt, tools, and skill groups", () => {
		expect(buildChildArgs(options, undefined, "/tmp/prompt.md")).toEqual([
			"--system-prompt",
			"/tmp/prompt.md",
			"--no-skills",
			"--no-approve",
			"--tools",
			"read,skill_search,load_skill",
			"--subagent-skill-groups",
			"review,php",
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--thinking",
			"high",
			"--session-dir",
			"/sessions/subagents/parent",
			"--name",
			"diff-review: Review the diff",
		]);
	});

	it("continues an existing session file, and keeps no session without a session directory", () => {
		const continued = buildChildArgs({ ...options, projectTrusted: true }, "/sessions/s.jsonl", "/tmp/p.md");
		expect(continued).toContain("--approve");
		expect(continued.slice(-2)).toEqual(["--session", "/sessions/s.jsonl"]);

		const ephemeral = buildChildArgs(
			{ ...options, sessionDir: undefined, tools: [], skillGroups: [] },
			undefined,
			"p",
		);
		expect(ephemeral).toContain("--no-session");
		expect(ephemeral).toContain("--no-tools");
		expect(ephemeral).not.toContain("--subagent-skill-groups");
	});
});

describe("subagent names", () => {
	it("turns the caller's name into a unique one-word id", () => {
		const registry = new SubagentRegistry();
		expect(registry.createId("Auth Scout!")).toBe("auth-scout");
		expect(registry.createId("  ")).toBe("subagent");

		const common: Omit<SubagentOptions, "id"> = {
			agentName: "scout",
			agentSource: "bundled",
			description: "d",
			task: "t",
			cwd: "/",
			systemPrompt: "",
			tools: [],
			skillGroups: [],
			projectTrusted: false,
		};
		registry.add(new Subagent({ ...common, id: registry.createId("auth-scout") }));
		registry.add(new Subagent({ ...common, id: registry.createId("auth-scout") }));

		expect(registry.list().map((subagent) => subagent.id)).toEqual(["auth-scout", "auth-scout-2"]);
		expect(registry.find("auth-scout-2")).toBe(registry.list()[1]);
	});

	it("passes the caller's name and description, or a fallback from the task, into the tool result", async () => {
		const harness = await createHarness({ extensionFactories: [{ name: "subagent", factory: subagentExtension }] });
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [
							{
								agent: "missing",
								task: "Map the auth flow end to end",
								name: "Auth Scout",
								description: "Map auth flow",
							},
							{ agent: "missing", task: "Check every migration file for drift" },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("Delegate");

			const result = getToolResult(harness, "subagent");
			const runs = (result.details as unknown as SubagentToolDetails).results;
			expect(runs.map((run) => [run.id, run.description])).toEqual([
				["auth-scout", "Map auth flow"],
				["missing", "Check every migration file..."],
			]);
			expect(getMessageText(result)).toContain('Unknown agent "missing"');
		} finally {
			harness.cleanup();
		}
	});
});
