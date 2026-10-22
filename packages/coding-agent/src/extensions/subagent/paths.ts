/**
 * Locations and configuration of the subagent extension's bundled assets.
 *
 * Bundled assets live next to this file: `agents/`, `skills/<group>/`, and `config.json`. The build copies
 * them to `dist/extensions/subagent/` and, for standalone binaries, to `subagent/` next to the executable.
 *
 * `config.json` holds:
 * - `coreTools`: the tools every subagent gets
 * - `maxConcurrent`: how many subagents may run at once; the rest wait in a queue for a free slot
 * - `defaultMode`: whether `subagent` calls run in the `foreground` (the call waits for its subagents) or the
 *   `background` (the call returns at once) when the call does not say
 * - `onBackgroundComplete`: what happens when a background subagent finishes and nothing waits for it: `wake`
 *   tells the orchestrator at once (starting a turn if it is idle), `notify` tells it on its next turn, `silent`
 *   leaves the result for `subagent_wait` and `subagent_result`
 *
 * A trusted project's `.pi/subagents/config.json` overrides any of these fields.
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

export type SubagentMode = "foreground" | "background";
export type BackgroundCompletion = "wake" | "notify" | "silent";

export interface SubagentConfig {
	coreTools: string[];
	maxConcurrent: number;
	defaultMode: SubagentMode;
	onBackgroundComplete: BackgroundCompletion;
}

const DEFAULT_CONFIG: SubagentConfig = {
	coreTools: ["read", "grep", "find", "ls"],
	maxConcurrent: 4,
	defaultMode: "foreground",
	onBackgroundComplete: "wake",
};

const MODES: readonly SubagentMode[] = ["foreground", "background"];
const COMPLETIONS: readonly BackgroundCompletion[] = ["wake", "notify", "silent"];

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
	const fields = raw as Record<string, unknown>;
	const config: Partial<SubagentConfig> = {};
	if (Array.isArray(fields.coreTools)) config.coreTools = parseNameList(fields.coreTools);
	// Invalid values are ignored rather than rejected, so a typo cannot stop subagents from running at all.
	const { maxConcurrent, defaultMode, onBackgroundComplete } = fields;
	if (typeof maxConcurrent === "number" && Number.isInteger(maxConcurrent) && maxConcurrent > 0) {
		config.maxConcurrent = maxConcurrent;
	}
	if (MODES.includes(defaultMode as SubagentMode)) config.defaultMode = defaultMode as SubagentMode;
	if (COMPLETIONS.includes(onBackgroundComplete as BackgroundCompletion)) {
		config.onBackgroundComplete = onBackgroundComplete as BackgroundCompletion;
	}
	return config;
}

/** The bundled config, with a trusted project's `.pi/subagents/config.json` applied on top. */
export function loadSubagentConfig(projectDir: string | null): SubagentConfig {
	const bundled = readConfig(join(getSubagentAssetsDir(), "config.json"));
	const project = projectDir ? readConfig(join(projectDir, "config.json")) : undefined;
	return { ...DEFAULT_CONFIG, ...bundled, ...project };
}
