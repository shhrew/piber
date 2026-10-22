import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import subagentExtension from "../../../src/extensions/subagent/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

/** A session as a subagent process sees it: the skill tools active and `--subagent-skill-groups` set. */
async function createSubagentSession(skillGroups: string): Promise<Harness> {
	const extensionsResult = await createTestExtensionsResult([{ name: "subagent", factory: subagentExtension }]);
	extensionsResult.runtime.flagValues.set("subagent-skill-groups", skillGroups);
	const created = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		initialActiveToolNames: ["skill_search", "load_skill"],
	});
	created.settingsManager.setProjectTrusted(true);
	await created.session.bindExtensions({ uiContext: createTestUiContext(), mode: "rpc" });

	const write = (relativePath: string, content: string) => {
		const filePath = join(created.tempDir, ".pi", "subagents", "skills", relativePath);
		mkdirSync(join(filePath, ".."), { recursive: true });
		writeFileSync(filePath, content);
	};
	write("php/symfony/SKILL.md", "---\nname: symfony\ndescription: Symfony services\ntags: [php, symfony]\n---\n\nUse autowiring.\n");
	write("ops/kubernetes/SKILL.md", "---\nname: kubernetes\ndescription: Cluster deploys\ntags: [k8s]\n---\n\nUse helm.\n");
	return created;
}

function toolResults(session: Harness): ToolResultMessage[] {
	return session.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("subagent skill tools", () => {
	it("searches and loads skills only from the groups the parent passed", async () => {
		harness = await createSubagentSession("php,review");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", { tags: ["symfony"] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("skill_search", { query: "kubernetes deploys" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("load_skill", { name: "symfony" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("load_skill", { name: "kubernetes" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Find the Symfony skill");

		const [search, outsideSearch, load, outsideLoad] = toolResults(harness);
		expect(getMessageText(search)).toContain("- symfony: Symfony services [tags: php, symfony]");
		expect(getMessageText(outsideSearch)).toContain("No skills matched.");
		expect(getMessageText(outsideSearch)).toContain("php");
		expect(getMessageText(load)).toContain("Use autowiring.");
		expect(getMessageText(load)).toContain(join(harness.tempDir, ".pi", "subagents", "skills", "php", "symfony"));
		expect(getMessageText(load)).not.toContain("tags:");
		expect(outsideLoad.isError).toBe(true);
		expect(getMessageText(outsideLoad)).toContain('Skill "kubernetes" is not available.');
	});

	it("reports that no skills are available when the flag names no groups", async () => {
		harness = await createSubagentSession("");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_search", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Search");

		expect(getMessageText(toolResults(harness)[0])).toBe("No skills are available to this agent.");
	});
});
