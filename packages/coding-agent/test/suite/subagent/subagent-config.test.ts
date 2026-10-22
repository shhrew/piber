import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../../../src/extensions/subagent/agents.ts";
import { buildChildArgs, type SubagentOptions } from "../../../src/extensions/subagent/child.ts";
import { planSubagentRun } from "../../../src/extensions/subagent/index.ts";
import { loadSkillGroups, searchSkills } from "../../../src/extensions/subagent/skills.ts";

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
});

describe("subagent child arguments", () => {
	const options: SubagentOptions = {
		id: "sa1",
		agentName: "reviewer",
		agentSource: "bundled",
		task: "Review the diff",
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
			"reviewer: Review the diff",
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
