/**
 * Subagent credentials: a store of secrets an agent found and what they are for, shared by the whole session.
 *
 * An agent adds a credential with a label, a purpose, and the secret value, and gets back an integer id. Unlike a
 * finding, every credential is announced to the orchestrator AND every other subagent at once, value included, so a
 * swarm that discovers a token can all use it without asking. The store lives in the parent; subagents reach it over
 * the chat hub's socket, whose token tells the hub who is adding, so a credential's `from` cannot be forged.
 *
 * Credentials are immutable: to change one, add a new one. They persist as plaintext JSONL next to the session's
 * subagent sessions. Secrets therefore sit on disk and in every agent's context; that is the point of the feature,
 * but it means a session directory with credentials should be treated as secret.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialsConfig } from "./paths.ts";

export const ADD_CREDENTIAL_TOOL_NAME = "add_credential";
export const GET_CREDENTIAL_TOOL_NAME = "get_credential";
export const LIST_CREDENTIALS_TOOL_NAME = "list_credentials";
export const CREDENTIAL_TOOL_NAMES: readonly string[] = [
	ADD_CREDENTIAL_TOOL_NAME,
	GET_CREDENTIAL_TOOL_NAME,
	LIST_CREDENTIALS_TOOL_NAME,
];
/** Custom message type of the notice announcing a new credential to the orchestrator and subagents. */
export const CREDENTIAL_NOTICE_TYPE = "subagent-credential";
/** File name of a session's credentials, in its subagent session directory. */
export const CREDENTIALS_FILE = "credentials.jsonl";
export const DEFAULT_CREDENTIALS_LIST_LIMIT = 50;
const MAX_LABEL_LENGTH = 64;

export interface Credential {
	/** 1, 2, ... in the order credentials were added in this session. */
	id: number;
	/** The agent that added it: a subagent's name, or `orchestrator`. */
	from: string;
	/** A short slug naming the credential, such as `github-ci-token`. */
	label: string;
	/** What the credential is for, so another agent knows when to use it. */
	purpose: string;
	/** The secret itself. Broadcast to every agent and written to disk in plaintext. */
	value: string;
	createdAt: number;
}

/** What `list_credentials` filters by. */
export interface CredentialFilter {
	from?: string;
	limit?: number;
}

/** One call of a credential tool, as a subagent sends it to the hub. */
export type CredentialRequest =
	| { action: "add"; label: string; purpose: string; value: string }
	| { action: "get"; ids: number[] }
	| ({ action: "list" } & CredentialFilter);

export interface CredentialResult {
	ok: boolean;
	/** For the caller's model. */
	text: string;
	/** The credential added, the ones read, or the ones listed. */
	credentials: Credential[];
}

const refuse = (text: string): CredentialResult => ({ ok: false, text, credentials: [] });

/** Lowercased, spaces turned into hyphens, characters other than letters, digits, `.`, `_`, and `-` dropped. */
export function normalizeCredentialLabel(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9._-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, MAX_LABEL_LENGTH);
}

function oneLine(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length)}...` : line;
}

/** `- 3 github-ci-token (scout-a): push to the CI repo`, without the value. */
export function formatCredentialLine(credential: Credential): string {
	return `- ${credential.id} ${credential.label} (${credential.from}): ${oneLine(credential.purpose, 80)}`;
}

/** A credential in full, value included, for `get_credential`. */
export function formatCredential(credential: Credential): string {
	return [
		`Credential ${credential.id}: ${credential.label}`,
		`From ${credential.from}, for: ${credential.purpose}`,
		`Value: ${credential.value}`,
	].join("\n");
}

/** `3 github-ci-token, 5 npm-token` for a subagent that added any. */
export function summarizeCredentials(credentials: readonly Credential[]): string {
	return credentials.map((credential) => `${credential.id} ${credential.label}`).join(", ");
}

/**
 * The notice the orchestrator and subagents read, in the user role. It carries the secret value, as the feature
 * requires: every agent should be able to use a credential as soon as it is found.
 */
export function frameCredentialNotice(credentials: readonly Credential[]): string {
	return [
		"<agent_credentials>",
		"A subagent stored these credentials for the whole session; the user did not write this. Use them where they apply, and read any later with " +
			`${GET_CREDENTIAL_TOOL_NAME}.`,
		...credentials.flatMap((credential) => [
			`- #${credential.id} ${credential.label} (from ${credential.from}) for: ${credential.purpose}`,
			`  value: ${credential.value}`,
		]),
		"</agent_credentials>",
	].join("\n");
}

/** Every credential of the session, in memory and, with a file, on disk. */
export class CredentialStore {
	private readonly items = new Map<number, Credential>();
	private readonly listeners = new Set<() => void>();
	private nextId = 1;
	private file: string | undefined;

	/** Forget every credential, then load `file` and append later ones to it. Without a file, they stay in memory. */
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
				let credential: Credential | undefined;
				try {
					credential = JSON.parse(line) as Credential;
				} catch {
					continue;
				}
				if (!Number.isInteger(credential?.id) || typeof credential?.from !== "string") continue;
				this.items.set(credential.id, credential);
				this.nextId = Math.max(this.nextId, credential.id + 1);
			}
		}
		this.notify();
	}

	/** Every credential, in id order. */
	list(): Credential[] {
		return [...this.items.values()].sort((a, b) => a.id - b.id);
	}

	get(id: number): Credential | undefined {
		return this.items.get(id);
	}

	/** The credentials `from` added. */
	byCreator(from: string): Credential[] {
		return this.list().filter((credential) => credential.from === from);
	}

	/** Store a new credential with the next id. */
	create(fields: Omit<Credential, "id">): Credential {
		const credential = { id: this.nextId++, ...fields };
		this.items.set(credential.id, credential);
		if (this.file) {
			// A full disk or a removed directory must not fail the tool call: the credential is still in memory.
			try {
				mkdirSync(dirname(this.file), { recursive: true });
				appendFileSync(this.file, `${JSON.stringify(credential)}\n`);
			} catch {}
		}
		this.notify();
		return credential;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

export interface CredentialBoardOptions {
	store: CredentialStore;
	/** Read on every request, so config edits apply at once. */
	config: () => CredentialsConfig;
	/** Called after a credential is added, to announce it to the orchestrator and every other subagent. */
	announce: (credential: Credential, from: string) => void;
}

/** The three credential tools as the parent serves them, for subagents over the hub and for the orchestrator. */
export class CredentialBoard {
	private readonly options: CredentialBoardOptions;

	constructor(options: CredentialBoardOptions) {
		this.options = options;
	}

	get store(): CredentialStore {
		return this.options.store;
	}

	/** Serve one request from `from`, a subagent name or `orchestrator`. */
	handle(from: string, request: CredentialRequest): CredentialResult {
		if (!this.options.config().enabled) return refuse("Credentials are turned off.");
		switch (request?.action) {
			case "add":
				return this.add(from, request);
			case "get":
				return this.get(request.ids);
			case "list":
				return this.list(request);
			default:
				return refuse("Unknown credentials request.");
		}
	}

	private add(from: string, request: Extract<CredentialRequest, { action: "add" }>): CredentialResult {
		const label = normalizeCredentialLabel(typeof request.label === "string" ? request.label : "");
		if (!label) return refuse("The label is empty. Use a short slug, such as github-ci-token.");
		const purpose = typeof request.purpose === "string" ? request.purpose.trim() : "";
		if (!purpose) return refuse("Say what the credential is for in purpose.");
		const value = typeof request.value === "string" ? request.value : "";
		if (!value) return refuse("The value is empty.");

		const credential = this.store.create({ from, label, purpose, value, createdAt: Date.now() });
		this.options.announce(credential, from);
		return {
			ok: true,
			text: `Stored credential ${credential.id} (${credential.label}). The orchestrator and every subagent were told.`,
			credentials: [credential],
		};
	}

	private get(ids: unknown): CredentialResult {
		const wanted = Array.isArray(ids) ? [...new Set(ids.filter((id): id is number => Number.isInteger(id)))] : [];
		if (wanted.length === 0) {
			return refuse(`Pass the ids of the credentials to read, such as [3]. See ${LIST_CREDENTIALS_TOOL_NAME}.`);
		}
		const credentials: Credential[] = [];
		const sections = wanted.map((id) => {
			const credential = this.store.get(id);
			if (!credential) return `There is no credential ${id}.`;
			credentials.push(credential);
			return formatCredential(credential);
		});
		return { ok: credentials.length > 0, text: sections.join("\n\n"), credentials };
	}

	private list(filter: CredentialFilter): CredentialResult {
		const all = this.store.list().filter((credential) => !filter.from || credential.from === filter.from);
		const limit =
			typeof filter.limit === "number" && Number.isInteger(filter.limit) && filter.limit > 0
				? filter.limit
				: DEFAULT_CREDENTIALS_LIST_LIMIT;
		const shown = all.slice(0, limit);
		if (shown.length === 0) {
			return { ok: true, text: "No credentials in this session yet.", credentials: [] };
		}
		const more = shown.length < all.length ? `, showing the first ${shown.length}` : "";
		const text = [
			`${all.length} credential${all.length === 1 ? "" : "s"}${more}:`,
			...shown.map(formatCredentialLine),
			`Read one's value with ${GET_CREDENTIAL_TOOL_NAME}.`,
		].join("\n");
		return { ok: true, text, credentials: shown };
	}
}
