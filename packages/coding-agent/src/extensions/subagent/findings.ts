/**
 * Subagent findings: a board of structured discoveries, shared by every agent in the session.
 *
 * An agent adds a finding with a slug key, a description, a priority, and key/value metadata, and gets back an
 * integer id. The board lives in the parent. Subagents reach it over the chat hub's socket, whose token tells the hub
 * who is calling, so a finding's `from` cannot be forged and only its creator can update it. Every agent can read
 * every finding.
 *
 * Priority alone decides whether the orchestrator is told (see `FindingsConfig.delivery`). The notice names only the
 * id, key, priority, and sender; the orchestrator reads the rest with `get_finding`. An update is delivered only when
 * it raises the priority to a stronger delivery, so refining a finding does not wake the orchestrator again.
 *
 * Findings persist as JSONL next to the session's subagent sessions: every add and update appends the whole finding,
 * and on load the last line for each id wins.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ORCHESTRATOR } from "./chat.ts";
import { type BackgroundCompletion, FINDING_PRIORITIES, type FindingPriority, type FindingsConfig } from "./paths.ts";

export const ADD_FINDING_TOOL_NAME = "add_finding";
export const UPDATE_FINDING_TOOL_NAME = "update_finding";
export const GET_FINDING_TOOL_NAME = "get_finding";
export const LIST_FINDINGS_TOOL_NAME = "list_findings";
export const FINDING_TOOL_NAMES: readonly string[] = [
	ADD_FINDING_TOOL_NAME,
	UPDATE_FINDING_TOOL_NAME,
	GET_FINDING_TOOL_NAME,
	LIST_FINDINGS_TOOL_NAME,
];
/** Custom message type of the notice that tells the orchestrator about findings. */
export const FINDING_NOTICE_TYPE = "subagent-finding";
/** File name of a session's findings, in its subagent session directory. */
export const FINDINGS_FILE = "findings.jsonl";
export const DEFAULT_FINDINGS_LIST_LIMIT = 50;
const MAX_KEY_LENGTH = 64;
const PREVIEW_LENGTH = 100;

export type FindingMetadataValue = string | number | boolean;
export type FindingMetadata = Record<string, FindingMetadataValue>;

export interface Finding {
	/** 1, 2, ... in the order findings were added in this session. */
	id: number;
	/** The agent that added it, and the only one that may update it: a subagent's name, or `orchestrator`. */
	from: string;
	/** A slug such as `auth.token-cache`. */
	key: string;
	description: string;
	priority: FindingPriority;
	metadata: FindingMetadata;
	createdAt: number;
	updatedAt: number;
	/** 1 when added, one more with each update. */
	revision: number;
}

/** What `findings_list` filters by. */
export interface FindingFilter {
	from?: string;
	/** A key prefix, such as `auth`. */
	key?: string;
	minPriority?: FindingPriority;
	/** Only findings with a higher id. */
	after?: number;
	limit?: number;
}

/** One call of a finding tool, as a subagent sends it to the hub. */
export type FindingRequest =
	| { action: "add"; key: string; description: string; priority: FindingPriority; metadata?: FindingMetadata }
	| {
			action: "update";
			id: number;
			key?: string;
			description?: string;
			priority?: FindingPriority;
			/** Merged into the finding's metadata; a value of null removes that entry. */
			metadata?: Record<string, FindingMetadataValue | null>;
	  }
	| { action: "get"; ids: number[] }
	| ({ action: "list" } & FindingFilter);

export interface FindingResult {
	ok: boolean;
	/** For the caller's model. */
	text: string;
	/** The finding added or updated, the ones read, or the ones listed. */
	findings: Finding[];
	/** How an add or update reached the orchestrator. */
	delivery?: BackgroundCompletion;
	/** For a list: how many findings matched before the limit. */
	total?: number;
}

const refuse = (text: string): FindingResult => ({ ok: false, text, findings: [] });

const DELIVERY_STRENGTH: Record<BackgroundCompletion, number> = { silent: 0, notify: 1, wake: 2 };

export function priorityRank(priority: FindingPriority): number {
	return FINDING_PRIORITIES.indexOf(priority);
}

function isPriority(value: unknown): value is FindingPriority {
	return FINDING_PRIORITIES.includes(value as FindingPriority);
}

function isMetadataValue(value: unknown): value is FindingMetadataValue {
	return (
		typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
	);
}

/** Lowercased, spaces turned into hyphens, characters other than letters, digits, `.`, `_`, and `-` dropped. */
export function normalizeFindingKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9._-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, MAX_KEY_LENGTH);
}

/** `base` with `changes` applied, or why `changes` is not valid metadata. Null removes an entry when allowed. */
function mergeMetadata(base: FindingMetadata, changes: unknown, allowRemove: boolean): FindingMetadata | string {
	if (changes === undefined) return { ...base };
	if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
		return "Metadata must be an object of key/value pairs.";
	}
	const merged = new Map(Object.entries(base));
	for (const [name, value] of Object.entries(changes)) {
		if (value === null && allowRemove) {
			merged.delete(name);
			continue;
		}
		if (!isMetadataValue(value)) {
			return `Metadata "${name}" must be a string, number, or boolean${allowRemove ? ", or null to remove it" : ""}.`;
		}
		merged.set(name, value);
	}
	return Object.fromEntries(merged);
}

function oneLine(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length)}...` : line;
}

/** Highest priority first, then in the order they were added. */
export function compareFindings(a: Finding, b: Finding): number {
	return priorityRank(b.priority) - priorityRank(a.priority) || a.id - b.id;
}

/** `- 7 [critical] auth.token-cache (scout-a): Session tokens are never invalidated...` */
export function formatFindingLine(finding: Finding): string {
	return `- ${finding.id} [${finding.priority}] ${finding.key} (${finding.from}): ${oneLine(finding.description, PREVIEW_LENGTH)}`;
}

/** A finding in full, for `get_finding`. */
export function formatFinding(finding: Finding): string {
	const lines = [
		`Finding ${finding.id} [${finding.priority}] ${finding.key}`,
		`From ${finding.from}, revision ${finding.revision}`,
		finding.description,
	];
	const metadata = Object.entries(finding.metadata);
	if (metadata.length > 0) lines.push("Metadata:", ...metadata.map(([name, value]) => `- ${name}: ${String(value)}`));
	return lines.join("\n");
}

/** `7 critical auth.token-cache, 9 low docs.typo`, highest priority first. */
export function summarizeFindings(findings: readonly Finding[]): string {
	return [...findings]
		.sort(compareFindings)
		.map((finding) => `${finding.id} ${finding.priority} ${finding.key}`)
		.join(", ");
}

/** `2 findings (1 critical)`: the count, and how many have the highest priority among them. */
export function countFindings(findings: readonly Finding[]): string {
	if (findings.length === 0) return "";
	const top = [...findings].sort(compareFindings)[0].priority;
	const atTop = findings.filter((finding) => finding.priority === top).length;
	return `${findings.length} finding${findings.length === 1 ? "" : "s"} (${atTop} ${top})`;
}

/**
 * The notice the orchestrator reads, in the user role: one tag per finding with its id, sender, priority, and key,
 * never its description or metadata, so a notice stays small however large the finding is.
 */
export function frameFindingNotice(findings: readonly Finding[]): string {
	const ids = findings.map((finding) => finding.id).join(", ");
	return [
		"<agent_findings>",
		...findings.map(
			(finding) =>
				`<finding id="${finding.id}" from="${finding.from}" priority="${finding.priority}" key="${finding.key}"${finding.revision > 1 ? ` revision="${finding.revision}"` : ""}/>`,
		),
		"</agent_findings>",
		`Subagents added these findings, or raised their priority; the user did not write this. Read them with ${GET_FINDING_TOOL_NAME} (ids: ${ids}) if they matter to your work.`,
	].join("\n");
}

/** Every finding of the session, in memory and, with a file, on disk. */
export class FindingStore {
	private readonly items = new Map<number, Finding>();
	private readonly listeners = new Set<() => void>();
	private nextId = 1;
	private file: string | undefined;

	/** Forget every finding, then load `file` and append later changes to it. Without a file, findings stay in memory. */
	open(file: string | undefined): void {
		this.items.clear();
		this.nextId = 1;
		this.file = file;
		if (file && existsSync(file)) {
			let text = "";
			try {
				text = readFileSync(file, "utf-8");
			} catch {}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				let finding: Finding | undefined;
				try {
					finding = JSON.parse(line) as Finding;
				} catch {
					continue;
				}
				if (!Number.isInteger(finding?.id) || typeof finding?.from !== "string") continue;
				this.items.set(finding.id, finding);
				this.nextId = Math.max(this.nextId, finding.id + 1);
			}
		}
		this.notify();
	}

	/** Every finding, in id order. */
	list(): Finding[] {
		return [...this.items.values()].sort((a, b) => a.id - b.id);
	}

	get(id: number): Finding | undefined {
		return this.items.get(id);
	}

	/** The findings `from` added. */
	byCreator(from: string): Finding[] {
		return this.list().filter((finding) => finding.from === from);
	}

	/** Store a new finding with the next id. */
	create(fields: Omit<Finding, "id">): Finding {
		const finding = { id: this.nextId++, ...fields };
		this.save(finding);
		return finding;
	}

	/** Store a new revision of an existing finding. */
	replace(finding: Finding): void {
		this.save(finding);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private save(finding: Finding): void {
		this.items.set(finding.id, finding);
		if (this.file) {
			// A full disk or a removed directory must not fail the tool call: the finding is still in memory.
			try {
				mkdirSync(dirname(this.file), { recursive: true });
				appendFileSync(this.file, `${JSON.stringify(finding)}\n`);
			} catch {}
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

export interface FindingBoardOptions {
	store: FindingStore;
	/** Read on every request, so config edits apply at once. */
	config: () => FindingsConfig;
	/** Called when an add or update by a subagent should reach the orchestrator. */
	deliver: (finding: Finding, delivery: "wake" | "notify") => void;
}

/** The four finding tools as the parent serves them, for subagents over the hub and for the orchestrator directly. */
export class FindingBoard {
	private readonly options: FindingBoardOptions;
	constructor(options: FindingBoardOptions) {
		this.options = options;
	}

	get store(): FindingStore {
		return this.options.store;
	}

	/** Serve one request from `from`, a subagent name or `orchestrator`, checking ownership and the size limits. */
	handle(from: string, request: FindingRequest): FindingResult {
		const config = this.options.config();
		if (!config.enabled) return refuse("Findings are turned off.");
		switch (request?.action) {
			case "add":
				return this.add(from, request, config);
			case "update":
				return this.update(from, request, config);
			case "get":
				return this.get(request.ids);
			case "list":
				return this.list(request);
			default:
				return refuse("Unknown findings request.");
		}
	}

	private add(
		from: string,
		request: Extract<FindingRequest, { action: "add" }>,
		config: FindingsConfig,
	): FindingResult {
		const key = this.checkKey(request.key);
		if (typeof key !== "string") return key;
		const description = this.checkDescription(request.description, config);
		if (typeof description !== "string") return description;
		if (!isPriority(request.priority)) return refuse(`Priority must be one of: ${FINDING_PRIORITIES.join(", ")}.`);
		const metadata = this.checkMetadata({}, request.metadata, false, config);
		if ("ok" in metadata) return metadata;

		const now = Date.now();
		const finding = this.store.create({
			from,
			key,
			description,
			priority: request.priority,
			metadata: metadata.value,
			createdAt: now,
			updatedAt: now,
			revision: 1,
		});
		const delivery = from === ORCHESTRATOR ? "silent" : config.delivery[finding.priority];
		if (delivery !== "silent") this.options.deliver(finding, delivery);
		const told = from === ORCHESTRATOR ? "" : ` ${deliveryText(delivery)}`;
		return {
			ok: true,
			text: `Added finding ${finding.id} (${finding.priority}).${told}`,
			findings: [finding],
			delivery,
		};
	}

	private update(
		from: string,
		request: Extract<FindingRequest, { action: "update" }>,
		config: FindingsConfig,
	): FindingResult {
		const existing = this.store.get(request.id);
		if (!existing) return refuse(`There is no finding ${request.id}.`);
		if (existing.from !== from) {
			return refuse(
				`Finding ${existing.id} belongs to ${existing.from}; only it can update it. Add your own finding instead.`,
			);
		}
		const { key: rawKey, description: rawDescription, priority, metadata: rawMetadata } = request;
		if (rawKey === undefined && rawDescription === undefined && priority === undefined && rawMetadata === undefined) {
			return refuse("Nothing to update: set key, description, priority, or metadata.");
		}
		const key = rawKey === undefined ? existing.key : this.checkKey(rawKey);
		if (typeof key !== "string") return key;
		const description =
			rawDescription === undefined ? existing.description : this.checkDescription(rawDescription, config);
		if (typeof description !== "string") return description;
		if (priority !== undefined && !isPriority(priority)) {
			return refuse(`Priority must be one of: ${FINDING_PRIORITIES.join(", ")}.`);
		}
		const metadata = this.checkMetadata(existing.metadata, rawMetadata, true, config);
		if ("ok" in metadata) return metadata;

		const finding: Finding = {
			...existing,
			key,
			description,
			priority: priority ?? existing.priority,
			metadata: metadata.value,
			updatedAt: Date.now(),
			revision: existing.revision + 1,
		};
		this.store.replace(finding);
		// Only a rise to a stronger delivery is news: refining a finding must not wake the orchestrator again.
		const before = config.delivery[existing.priority];
		const after = config.delivery[finding.priority];
		const delivery = from !== ORCHESTRATOR && DELIVERY_STRENGTH[after] > DELIVERY_STRENGTH[before] ? after : "silent";
		if (delivery !== "silent") this.options.deliver(finding, delivery);
		const told = delivery === "silent" ? "" : ` ${deliveryText(delivery)}`;
		return {
			ok: true,
			text: `Updated finding ${finding.id} (revision ${finding.revision}, ${finding.priority}).${told}`,
			findings: [finding],
			delivery,
		};
	}

	private get(ids: unknown): FindingResult {
		const wanted = Array.isArray(ids) ? [...new Set(ids.filter((id): id is number => Number.isInteger(id)))] : [];
		if (wanted.length === 0)
			return refuse(`Pass the ids of the findings to read, such as [7]. See ${LIST_FINDINGS_TOOL_NAME}.`);
		const findings: Finding[] = [];
		const sections = wanted.map((id) => {
			const finding = this.store.get(id);
			if (!finding) return `There is no finding ${id}.`;
			findings.push(finding);
			return formatFinding(finding);
		});
		return { ok: findings.length > 0, text: sections.join("\n\n"), findings };
	}

	private list(filter: FindingFilter): FindingResult {
		const all = this.store.list();
		const minRank = isPriority(filter.minPriority) ? priorityRank(filter.minPriority) : 0;
		const prefix = typeof filter.key === "string" ? normalizeFindingKey(filter.key) : "";
		const matches = all
			.filter(
				(finding) =>
					(!filter.from || finding.from === filter.from) &&
					(!prefix || finding.key.startsWith(prefix)) &&
					priorityRank(finding.priority) >= minRank &&
					(typeof filter.after !== "number" || finding.id > filter.after),
			)
			.sort(compareFindings);
		const limit =
			typeof filter.limit === "number" && Number.isInteger(filter.limit) && filter.limit > 0
				? filter.limit
				: DEFAULT_FINDINGS_LIST_LIMIT;
		const shown = matches.slice(0, limit);
		if (shown.length === 0) {
			const text = all.length === 0 ? "No findings in this session yet." : "No findings match.";
			return { ok: true, text, findings: [], total: 0 };
		}
		const more = shown.length < matches.length ? `, showing the first ${shown.length}` : "";
		const text = [
			`${matches.length} finding${matches.length === 1 ? "" : "s"}${more}:`,
			...shown.map(formatFindingLine),
			`Read one in full with ${GET_FINDING_TOOL_NAME}.`,
		].join("\n");
		return { ok: true, text, findings: shown, total: matches.length };
	}

	private checkKey(value: unknown): string | FindingResult {
		const key = typeof value === "string" ? normalizeFindingKey(value) : "";
		return key || refuse("The key is empty. Use a short dotted slug, such as auth.token-cache.");
	}

	private checkDescription(value: unknown, config: FindingsConfig): string | FindingResult {
		const description = typeof value === "string" ? value.trim() : "";
		if (!description) return refuse("The description is empty.");
		if (description.length > config.maxDescriptionLength) {
			return refuse(
				`The description is ${description.length} characters; the limit is ${config.maxDescriptionLength}. Shorten it and put details in metadata.`,
			);
		}
		return description;
	}

	private checkMetadata(
		base: FindingMetadata,
		changes: unknown,
		allowRemove: boolean,
		config: FindingsConfig,
	): { value: FindingMetadata } | FindingResult {
		const metadata = mergeMetadata(base, changes, allowRemove);
		if (typeof metadata === "string") return refuse(metadata);
		const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
		if (bytes > config.maxMetadataBytes) {
			return refuse(`The metadata is ${bytes} bytes as JSON; the limit is ${config.maxMetadataBytes}. Shorten it.`);
		}
		return { value: metadata };
	}
}

function deliveryText(delivery: BackgroundCompletion): string {
	switch (delivery) {
		case "wake":
			return "The orchestrator was told.";
		case "notify":
			return "The orchestrator sees it on its next turn.";
		case "silent":
			return "It is stored; the orchestrator was not told, but can list it.";
	}
}
