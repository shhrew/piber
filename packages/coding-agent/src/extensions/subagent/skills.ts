/**
 * Skill groups for subagents.
 *
 * A group is a directory of skills. Groups come from two layers:
 * - bundled: `skills/<group>/` inside this extension directory
 * - project: `.pi/subagents/skills/<group>/`, only when the project is trusted
 *
 * Skills use the usual SKILL.md frontmatter plus `tags`, which `skill_search` matches:
 *
 *     name: symfony
 *     description: Symfony 7 controllers, services, DI config and console commands.
 *     tags: [php, symfony]
 *
 * `metadata.tags` (a comma-separated string, as the Agent Skills spec allows) is merged with `tags`.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ResourceDiagnostic } from "../../core/diagnostics.ts";
import { loadSkillsFromDir, type Skill } from "../../core/skills.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { Bm25Ranker } from "../tool-search/tool.ts";
import { getSubagentAssetsDir, parseNameList } from "./paths.ts";

export interface SubagentSkill extends Skill {
	/** Lowercase tags from `tags` and `metadata.tags`. */
	tags: string[];
	/** Groups the skill was found in. A skill symlinked into two groups appears once with both. */
	groups: string[];
}

export interface SkillCatalog {
	skills: SubagentSkill[];
	diagnostics: ResourceDiagnostic[];
}

export interface SkillSearchMatch {
	name: string;
	description: string;
	tags: string[];
}

export const DEFAULT_SKILL_SEARCH_LIMIT = 10;

/** Group names are directory names; anything else could escape the skills root. */
const GROUP_NAME = /^[a-z0-9][a-z0-9_-]*$/i;

type TagFrontmatter = { tags?: unknown; metadata?: unknown };

function readTags(filePath: string): string[] {
	let frontmatter: TagFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<TagFrontmatter>(readFileSync(filePath, "utf-8")));
	} catch {
		return [];
	}
	const metadata = frontmatter.metadata;
	const metadataTags =
		metadata && typeof metadata === "object" && "tags" in metadata ? (metadata as { tags: unknown }).tags : undefined;
	const tags = [...parseNameList(frontmatter.tags), ...parseNameList(metadataTags)].map((tag) => tag.toLowerCase());
	return [...new Set(tags)];
}

/**
 * Load the skills of `groups`. Within a group, a project skill replaces a bundled skill with the same name.
 */
export function loadSkillGroups(groups: readonly string[], projectDir: string | null): SkillCatalog {
	const diagnostics: ResourceDiagnostic[] = [];
	const byName = new Map<string, SubagentSkill>();
	const roots: Array<{ dir: string; source: string }> = [
		{ dir: path.join(getSubagentAssetsDir(), "skills"), source: "bundled" },
	];
	if (projectDir) roots.push({ dir: path.join(projectDir, "skills"), source: "project" });

	for (const group of new Set(groups)) {
		if (!GROUP_NAME.test(group)) {
			diagnostics.push({ type: "warning", message: `invalid skill group name "${group}"` });
			continue;
		}
		const groupSkills = new Map<string, Skill>();
		for (const root of roots) {
			const result = loadSkillsFromDir({ dir: path.join(root.dir, group), source: root.source });
			diagnostics.push(...result.diagnostics);
			for (const skill of result.skills) groupSkills.set(skill.name, skill);
		}
		for (const skill of groupSkills.values()) {
			const existing = byName.get(skill.name);
			if (existing && existing.filePath === skill.filePath) {
				existing.groups.push(group);
				continue;
			}
			const tags = readTags(skill.filePath);
			if (tags.length === 0) {
				diagnostics.push({
					type: "warning",
					message: `skill "${skill.name}" has no tags; skill_search can only find it by name and description`,
					path: skill.filePath,
				});
			}
			if (existing) {
				diagnostics.push({
					type: "warning",
					message: `skill "${skill.name}" in group "${group}" replaces the one from group "${existing.groups.join(", ")}"`,
					path: skill.filePath,
				});
			}
			byName.set(skill.name, { ...skill, tags, groups: [group] });
		}
	}

	return { skills: [...byName.values()], diagnostics };
}

/** All tags in `skills`, sorted. */
export function listSkillTags(skills: readonly SubagentSkill[]): string[] {
	return [...new Set(skills.flatMap((skill) => skill.tags))].sort();
}

/**
 * Rank `skills` for a query and optional tags.
 *
 * Order: number of matching tags, then whether a query term appears in the name, then BM25 over the name,
 * description, and tags. Skills that match nothing are left out. With no query and no tags, every skill is
 * returned in name order.
 */
export function searchSkills(
	skills: readonly SubagentSkill[],
	query: string | undefined,
	tags: readonly string[] | undefined,
	limit = DEFAULT_SKILL_SEARCH_LIMIT,
): SkillSearchMatch[] {
	const terms = new Set(
		[...(query ?? "").split(/[\s,]+/), ...(tags ?? [])].map((term) => term.trim().toLowerCase()).filter(Boolean),
	);
	const toMatch = (skill: SubagentSkill): SkillSearchMatch => ({
		name: skill.name,
		description: skill.description,
		tags: skill.tags,
	});

	if (terms.size === 0) {
		return [...skills]
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, limit)
			.map(toMatch);
	}

	const bm25 = new Map(
		new Bm25Ranker()
			.rank(
				[...terms].join(" "),
				skills.map((skill) => ({
					name: skill.name,
					text: [skill.name, skill.name.replaceAll("-", " "), skill.description, ...skill.tags].join(" "),
				})),
				skills.length,
			)
			.map((match) => [match.name, match.score]),
	);

	return skills
		.map((skill) => ({
			skill,
			tagHits: skill.tags.filter((tag) => terms.has(tag)).length,
			nameHit: [...terms].some((term) => skill.name.includes(term)) ? 1 : 0,
			score: bm25.get(skill.name) ?? 0,
		}))
		.filter((entry) => entry.tagHits > 0 || entry.nameHit > 0 || entry.score > 0)
		.sort((a, b) => b.tagHits - a.tagHits || b.nameHit - a.nameHit || b.score - a.score)
		.slice(0, limit)
		.map((entry) => toMatch(entry.skill));
}
