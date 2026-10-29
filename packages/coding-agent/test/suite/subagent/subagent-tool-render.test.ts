import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	renderChatPeersResult,
	renderLoadSkillCall,
	renderLoadSkillResult,
	renderSkillSearchCall,
	renderSkillSearchResult,
	type SkillSearchDetails,
} from "../../../src/extensions/subagent/render.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function lines(component: Component, width = 100): string[] {
	return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

const done = { isPartial: false, isError: false, outputPad: 1 };
const collapsed = { expanded: false, isError: false, outputPad: 1 };
const expanded = { ...collapsed, expanded: true };

describe("subagent tool renderers", () => {
	// The format of ChatHub.peers.
	const peers = [
		"You are alpha. You can message:",
		"- orchestrator",
		"- bravo (Find ChatHub; worker): running",
		"- charlie (Map auth; scout): queued, gets messages when it starts",
		"- delta (Review a.ts; reviewer): finished, cannot receive messages",
		"- all: everyone still running, at once",
	].join("\n");

	it("lists chat peers with state icons, and one row each when expanded", () => {
		expect(lines(renderChatPeersResult(peers, collapsed, theme))).toEqual([
			"   ⎿  orchestrator · ● bravo · ◷ charlie · ○ delta · all",
		]);
		expect(lines(renderChatPeersResult(peers, expanded, theme))).toEqual([
			"   ⎿  orchestrator",
			"      ● bravo       Find ChatHub · worker · running",
			"      ◷ charlie     Map auth · scout · queued, gets messages when it starts",
			"      ○ delta       Review a.ts · reviewer · finished, cannot receive messages",
			"      all           everyone still running, at once",
		]);
		const alone = "You are the orchestrator. You can message:\n- no other subagents yet";
		expect(lines(renderChatPeersResult(alone, collapsed, theme))).toEqual(["   ⎿  No other subagents yet"]);
		expect(lines(renderChatPeersResult("Chat is turned off.", collapsed, theme))).toEqual([
			"   ⎿  Chat is turned off.",
		]);
	});

	it("shows a skill search's query and tags on the call line, and its matches below", () => {
		expect(
			lines(renderSkillSearchCall({ query: "path traversal", tags: ["security"], limit: 3 }, theme, done)),
		).toEqual([" ● Search skills(path traversal) #security · up to 3"]);
		expect(lines(renderSkillSearchCall({ tags: ["php", "symfony"] }, theme, done))).toEqual([
			" ● Search skills #php #symfony",
		]);
		expect(lines(renderSkillSearchCall({}, theme, done))).toEqual([" ● Search skills(all)"]);

		const details: SkillSearchDetails = {
			matches: [
				{ name: "security-review", description: "Path traversal and injection", tags: ["review", "security"] },
				{ name: "review-checklist", description: "Quality checklist", tags: [] },
			],
			available: 2,
			tags: ["review", "security"],
		};
		expect(lines(renderSkillSearchResult(details, "", collapsed, theme))).toEqual([
			"   ⎿  2 matches · security-review, review-checklist",
		]);
		expect(lines(renderSkillSearchResult(details, "", expanded, theme))).toEqual([
			"   ⎿  2 matches",
			"      security-review   Path traversal and injection #review #security",
			"      review-checklist  Quality checklist",
		]);
		expect(lines(renderSkillSearchResult({ ...details, matches: [] }, "", collapsed, theme))).toEqual([
			"   ⎿  No match · try #review #security",
		]);
		expect(lines(renderSkillSearchResult({ matches: [], available: 0, tags: [] }, "", collapsed, theme))).toEqual([
			"   ⎿  No skills available",
		]);
	});

	it("shows a loaded skill's size and description, and its directory and body when expanded", () => {
		expect(lines(renderLoadSkillCall({ name: "symfony" }, theme, done))).toEqual([" ● Load skill(symfony)"]);

		const details = { name: "symfony", description: "Symfony services", directory: "/skills/php/symfony", lines: 2 };
		const text =
			'<skill name="symfony" directory="/skills/php/symfony">\nResolve relative paths in this skill against its directory.\n\nUse autowiring.\nPrefer attributes.\n</skill>';
		expect(lines(renderLoadSkillResult(details, text, collapsed, theme))).toEqual([
			"   ⎿  2 lines · Symfony services",
		]);
		expect(lines(renderLoadSkillResult(details, text, expanded, theme))).toEqual([
			"   ⎿  2 lines · Symfony services",
			"      /skills/php/symfony",
			"",
			"      Use autowiring.",
			"      Prefer attributes.",
		]);
		const missing = 'Skill "kubernetes" is not available. Use skill_search.';
		expect(lines(renderLoadSkillResult(undefined, missing, { ...collapsed, isError: true }, theme))).toEqual([
			`   ⎿  ${missing}`,
		]);
	});
});
