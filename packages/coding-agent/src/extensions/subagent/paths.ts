/**
 * Locations and configuration of the subagent extension's bundled assets.
 *
 * Bundled assets live next to this file: `agents/`, `skills/<group>/`, and `config.json`. The build copies
 * them to `dist/extensions/subagent/` and, for standalone binaries, to `subagent/` next to the executable.
 *
 * `config.json` holds `{ "coreTools": [...] }`, the tools every subagent gets. A trusted project can
 * replace it with `.pi/subagents/config.json`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, isBunBinary } from "../../config.ts";

/**
 * Normalize a frontmatter list. Both `tools: read, bash` and `tools: [read, bash]` are valid YAML and
 * both are accepted. Any other value yields an empty list rather than throwing, so one bad file does
 * not stop discovery of the other agents.
 */
export function parseNameList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

export interface SubagentConfig {
	coreTools: string[];
}

const DEFAULT_CONFIG: SubagentConfig = { coreTools: ["read", "grep", "find", "ls"] };

/** Directory holding the bundled `agents/`, `skills/`, and `config.json`. */
export function getSubagentAssetsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "subagent");
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "extensions", "subagent");
}

function readConfig(filePath: string): Partial<SubagentConfig> | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const coreTools = (raw as { coreTools?: unknown }).coreTools;
	return Array.isArray(coreTools) ? { coreTools: parseNameList(coreTools) } : {};
}

/** The bundled config, with a trusted project's `.pi/subagents/config.json` applied on top. */
export function loadSubagentConfig(projectDir: string | null): SubagentConfig {
	const bundled = readConfig(join(getSubagentAssetsDir(), "config.json"));
	const project = projectDir ? readConfig(join(projectDir, "config.json")) : undefined;
	return { ...DEFAULT_CONFIG, ...bundled, ...project };
}
