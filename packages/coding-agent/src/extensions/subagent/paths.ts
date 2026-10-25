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
 * - `chat`: subagent chat (see `chat.ts`): whether it is enabled, the default `canMessage` for agents without
 *   one, what the orchestrator may message, message limits, and reply-wait timeouts
 *
 * A trusted project's `.pi/subagents/config.json` overrides any of these fields; within `chat`, any sub-field.
 *
 * `system-prompt.md` is the global prompt every subagent gets before its own; a trusted project's
 * `.pi/subagents/system-prompt.md` is appended to it.
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

/**
 * Who an agent may message: `orchestrator`; `subagents`, any other subagent by name; `all`, everything including a
 * broadcast to everyone at once.
 */
export type ChatPermission = "orchestrator" | "subagents" | "all";
export const CHAT_PERMISSIONS: readonly ChatPermission[] = ["orchestrator", "subagents", "all"];

export interface ChatConfig {
	enabled: boolean;
	/** `canMessage` for agents whose definition has none. */
	defaultCanMessage: ChatPermission[];
	/** What the orchestrator may message. Empty turns chat off for it. */
	orchestratorCanMessage: ChatPermission[];
	maxMessageLength: number;
	maxMessagesPerMinute: number;
	/** How long `chat_send` with `waitForReply` waits by default, and at most. */
	replyTimeoutSeconds: number;
	maxReplyTimeoutSeconds: number;
}

export interface SubagentConfig {
	coreTools: string[];
	maxConcurrent: number;
	defaultMode: SubagentMode;
	onBackgroundComplete: BackgroundCompletion;
	chat: ChatConfig;
}

const DEFAULT_CONFIG: SubagentConfig = {
	coreTools: ["read", "grep", "find", "ls"],
	maxConcurrent: 4,
	defaultMode: "foreground",
	onBackgroundComplete: "wake",
	chat: {
		enabled: true,
		defaultCanMessage: ["orchestrator"],
		orchestratorCanMessage: ["subagents", "all"],
		maxMessageLength: 4000,
		maxMessagesPerMinute: 10,
		replyTimeoutSeconds: 120,
		maxReplyTimeoutSeconds: 600,
	},
};

/** The known permission words in a frontmatter or config list; unknown words are dropped. */
export function parseChatPermissions(value: unknown): ChatPermission[] {
	return parseNameList(value).filter((word): word is ChatPermission =>
		CHAT_PERMISSIONS.includes(word as ChatPermission),
	);
}

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

function readChatConfig(value: unknown): Partial<ChatConfig> {
	if (!value || typeof value !== "object") return {};
	const fields = value as Record<string, unknown>;
	const chat: Partial<ChatConfig> = {};
	if (typeof fields.enabled === "boolean") chat.enabled = fields.enabled;
	if (Array.isArray(fields.defaultCanMessage)) chat.defaultCanMessage = parseChatPermissions(fields.defaultCanMessage);
	if (Array.isArray(fields.orchestratorCanMessage)) {
		chat.orchestratorCanMessage = parseChatPermissions(fields.orchestratorCanMessage);
	}
	for (const key of [
		"maxMessageLength",
		"maxMessagesPerMinute",
		"replyTimeoutSeconds",
		"maxReplyTimeoutSeconds",
	] as const) {
		if (isPositiveInteger(fields[key])) chat[key] = fields[key];
	}
	return chat;
}

const MODES: readonly SubagentMode[] = ["foreground", "background"];
const COMPLETIONS: readonly BackgroundCompletion[] = ["wake", "notify", "silent"];

/** Directory holding the bundled `agents/`, `skills/`, and `config.json`. */
export function getSubagentAssetsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "subagent");
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "extensions", "subagent");
}

type PartialConfig = Partial<Omit<SubagentConfig, "chat">> & { chat?: Partial<ChatConfig> };

function readConfig(filePath: string): PartialConfig | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const fields = raw as Record<string, unknown>;
	const config: PartialConfig = {};
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
	if (fields.chat !== undefined) config.chat = readChatConfig(fields.chat);
	return config;
}

/** The bundled config, with a trusted project's `.pi/subagents/config.json` applied on top. */
export function loadSubagentConfig(projectDir: string | null): SubagentConfig {
	const bundled = readConfig(join(getSubagentAssetsDir(), "config.json"));
	const project = projectDir ? readConfig(join(projectDir, "config.json")) : undefined;
	return {
		...DEFAULT_CONFIG,
		...bundled,
		...project,
		chat: { ...DEFAULT_CONFIG.chat, ...bundled?.chat, ...project?.chat },
	};
}

function readText(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf-8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The bundled `system-prompt.md`, with a trusted project's `.pi/subagents/system-prompt.md` appended. */
export function loadGlobalSystemPrompt(projectDir: string | null): string {
	const bundled = readText(join(getSubagentAssetsDir(), "system-prompt.md"));
	const project = projectDir ? readText(join(projectDir, "system-prompt.md")) : undefined;
	return [bundled, project].filter((part) => part !== undefined).join("\n\n");
}
