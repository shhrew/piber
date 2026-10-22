/**
 * One subagent: a `pi --mode rpc` child process with its own system prompt, tools, skill groups, and session.
 *
 * The process runs only while the subagent works. When it settles the process stops, and the next message
 * (a follow-up from the agent view, or a `session` continuation from the parent) starts a new process on the
 * same session file.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import type { RpcExtensionUIRequest } from "../../modes/rpc/rpc-types.ts";
import type { AgentSource } from "./agents.ts";
import { type ChildEvent, ChildRpc } from "./rpc.ts";
import type { SlotPool } from "./slots.ts";

/** Extension flag that tells a child which skill groups `skill_search` and `load_skill` serve. */
export const SKILL_GROUPS_FLAG = "subagent-skill-groups";

/** `queued`: waiting for a free slot in the parent's `SlotPool` before its process starts. */
export type SubagentStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentOptions {
	/** One-word name given by the caller, unique within the parent session. Also the handle for `session`. */
	id: string;
	agentName: string;
	agentSource: AgentSource;
	/** Short summary of what this subagent is doing, given by the caller. Shown with the id. */
	description: string;
	task: string;
	cwd: string;
	systemPrompt: string;
	tools: string[];
	skillGroups: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** Directory for a new session file. Without it and without `sessionFile`, the child keeps no session. */
	sessionDir?: string;
	/** Existing session file to continue. */
	sessionFile?: string;
	projectTrusted: boolean;
	/** Parent UI that answers the child's extension dialogs. Without it, dialogs are cancelled. */
	ui?: ExtensionUIContext;
	/** Command that starts pi. Default: the command that started this process. */
	command?: { executable: string; args: string[] };
	/** Limits concurrent subagent processes. Each run waits for a slot here before its process starts. */
	slots?: SlotPool;
}

export function emptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** The command that starts this pi installation: a source checkout, `dist/cli.js`, or a standalone binary. */
function getPiCommand(): { executable: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		// Keep loader flags such as the source resolver's --import, but not debugger flags whose ports would clash.
		const execArgs = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
		return { executable: process.execPath, args: [...execArgs, script] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { executable: process.execPath, args: [] };
	return { executable: "pi", args: [] };
}

function isTranscriptMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function preview(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length)}...` : line;
}

/** Arguments for the child, apart from `--mode rpc`. `sessionFile` continues a session; otherwise one is created. */
export function buildChildArgs(
	options: SubagentOptions,
	sessionFile: string | undefined,
	promptFile: string,
): string[] {
	const args = ["--system-prompt", promptFile, "--no-skills", options.projectTrusted ? "--approve" : "--no-approve"];
	args.push(...(options.tools.length > 0 ? ["--tools", options.tools.join(",")] : ["--no-tools"]));
	if (options.skillGroups.length > 0) args.push(`--${SKILL_GROUPS_FLAG}`, options.skillGroups.join(","));
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (sessionFile) {
		args.push("--session", sessionFile);
	} else if (options.sessionDir) {
		args.push("--session-dir", options.sessionDir, "--name", `${options.id}: ${preview(options.description, 60)}`);
	} else {
		args.push("--no-session");
	}
	return args;
}

export class Subagent {
	readonly options: SubagentOptions;
	/** Unique per instance, unlike `id`, which a later pi process may reuse for a different subagent. */
	readonly key = randomUUID();
	status: SubagentStatus = "running";
	/** Completed user, assistant, and tool result messages. */
	messages: Message[] = [];
	/** The assistant message being streamed, rebuilt from deltas. */
	streaming: AssistantMessage | undefined;
	usage: SubagentUsage = emptyUsage();
	model: string | undefined;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	sessionFile: string | undefined;
	/** When the latest run's process started, and when the latest run ended (also when cancelled while queued). */
	startedAt: number | undefined;
	finishedAt: number | undefined;
	stderr = "";
	private client: ChildRpc | null = null;
	/** Set for the whole of a run, queued or not. `abort()` uses it, so an abort is never lost between steps. */
	private cancel: AbortController | undefined;
	private listeners = new Set<() => void>();

	constructor(options: SubagentOptions) {
		this.options = options;
		this.sessionFile = options.sessionFile;
		this.model = options.model;
	}

	get id(): string {
		return this.options.id;
	}

	/** Between taking a slot and settling, including while its process starts. */
	get isRunning(): boolean {
		return this.cancel !== undefined && this.status !== "queued";
	}

	/** Subscribe to any change: status, messages, streaming text, or usage. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Text of the last assistant message that has text. */
	getFinalOutput(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type === "text") return part.text;
			}
		}
		return "";
	}

	get isQueued(): boolean {
		return this.cancel !== undefined && this.status === "queued";
	}

	/**
	 * Send `message` and wait until the subagent settles. Waits for a free slot first when the parent limits
	 * concurrency, then starts the child process, continuing the session file when there is one, and stops it
	 * afterwards. Aborting `signal`, or `abort()`, cancels the wait or aborts the subagent.
	 */
	async run(message: string, signal?: AbortSignal): Promise<void> {
		if (this.cancel) throw new Error(`Subagent ${this.id} is already running`);
		const cancel = new AbortController();
		this.cancel = cancel;
		const runSignal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
		this.stopReason = undefined;
		this.errorMessage = undefined;
		this.finishedAt = undefined;

		let release: (() => void) | undefined;
		try {
			if (this.options.slots) {
				this.status = "queued";
				this.emit();
				try {
					release = await this.options.slots.acquire(runSignal);
				} catch {
					this.status = "aborted";
					return;
				}
			}
			await this.runProcess(message, runSignal);
		} finally {
			release?.();
			this.cancel = undefined;
			this.finishedAt = Date.now();
			this.emit();
		}
	}

	private async runProcess(message: string, signal: AbortSignal): Promise<void> {
		this.status = "running";
		this.startedAt = Date.now();
		this.emit();
		if (signal.aborted) {
			this.status = "aborted";
			return;
		}

		const promptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(promptDir, "system-prompt.md");
		await fs.promises.writeFile(promptFile, this.options.systemPrompt, { encoding: "utf-8", mode: 0o600 });

		let rejectExit: (error: Error) => void = () => {};
		const exited = new Promise<never>((_resolve, reject) => {
			rejectExit = reject;
		});
		exited.catch(() => {});
		let resolveSettled: (result: { aborted: boolean }) => void = () => {};
		const settled = new Promise<{ aborted: boolean }>((resolve) => {
			resolveSettled = resolve;
		});
		const command = this.options.command ?? getPiCommand();
		const client: ChildRpc = new ChildRpc({
			executable: command.executable,
			args: [...command.args, ...buildChildArgs(this.options, this.sessionFile, promptFile)],
			cwd: this.options.cwd,
			onEvent: (event) => {
				if (event.type === "agent_settled") resolveSettled({ aborted: event.aborted });
				else this.handleEvent(event, client);
			},
			onStderr: (chunk) => {
				this.stderr += chunk;
			},
			onExit: (error) =>
				rejectExit(this.stderr.trim() ? new Error(`${error.message}: ${this.stderr.trim()}`) : error),
		});
		this.client = client;
		const onAbort = () => {
			client.abort().catch(() => {
				// The process may already be gone; the exit is reported below.
			});
		};

		try {
			client.start();
			if (signal.aborted) throw new Error("Subagent was aborted");
			signal.addEventListener("abort", onAbort, { once: true });
			const state = await Promise.race([client.getState(), exited]);
			this.sessionFile = state.sessionFile ?? this.sessionFile;
			if (state.model) this.model = `${state.model.provider}/${state.model.id}`;
			if (this.messages.length === 0 && this.options.sessionFile) {
				this.messages = (await Promise.race([client.getMessages(), exited])).filter(isTranscriptMessage);
			}
			this.emit();

			await Promise.race([client.prompt(message), exited]);
			const { aborted } = await Promise.race([settled, exited]);
			this.status = aborted ? "aborted" : this.stopReason === "error" ? "failed" : "done";
		} catch (error) {
			this.status = signal.aborted ? "aborted" : "failed";
			if (!this.errorMessage && this.status === "failed") {
				this.errorMessage = error instanceof Error ? error.message : String(error);
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			this.client = null;
			this.streaming = undefined;
			await client.stop();
			await fs.promises.rm(promptDir, { recursive: true, force: true });
			this.emit();
		}
	}

	/** Steer the running subagent, or start a follow-up run when it is idle. */
	async send(message: string): Promise<void> {
		if (this.isQueued) throw new Error("This subagent is queued and has not started yet");
		if (this.isRunning) {
			if (!this.client) throw new Error("This subagent is still starting");
			await this.client.steer(message);
			return;
		}
		if (!this.sessionFile) throw new Error("This subagent has no session file to continue");
		await this.run(message);
	}

	/** Cancel the current run: leave the queue, or abort the running subagent. */
	async abort(): Promise<void> {
		this.cancel?.abort();
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private handleEvent(event: ChildEvent, client: ChildRpc): void {
		if (event.type === "extension_ui_request") {
			void this.answerUiRequest(event, client);
			return;
		}
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.streaming = { ...event.message, content: [] };
				break;
			case "message_update":
				this.applyDelta(event.assistantMessageEvent);
				break;
			case "message_end": {
				const message = event.message;
				if (!isTranscriptMessage(message)) break;
				this.messages.push(message);
				if (message.role === "assistant") {
					this.streaming = undefined;
					this.usage.turns++;
					this.usage.input += message.usage.input || 0;
					this.usage.output += message.usage.output || 0;
					this.usage.cacheRead += message.usage.cacheRead || 0;
					this.usage.cacheWrite += message.usage.cacheWrite || 0;
					this.usage.cost += message.usage.cost?.total || 0;
					this.usage.contextTokens = message.usage.totalTokens || 0;
					this.model = `${message.provider}/${message.model}`;
					this.stopReason = message.stopReason;
					if (message.errorMessage) this.errorMessage = message.errorMessage;
				}
				break;
			}
			default:
				return;
		}
		this.emit();
	}

	private applyDelta(
		update: Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): void {
		const message = this.streaming;
		if (!message) return;
		switch (update.type) {
			case "text_start":
				message.content[update.contentIndex] = { type: "text", text: "" };
				break;
			case "thinking_start":
				message.content[update.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "toolcall_start":
				message.content[update.contentIndex] = {
					type: "toolCall",
					id: update.id,
					name: update.toolName,
					arguments: {},
				};
				break;
			case "text_delta": {
				const part = message.content[update.contentIndex];
				if (part?.type === "text") part.text += update.delta;
				break;
			}
			case "thinking_delta": {
				const part = message.content[update.contentIndex];
				if (part?.type === "thinking") part.thinking += update.delta;
				break;
			}
			case "toolcall_end":
				message.content[update.contentIndex] = update.toolCall;
				break;
		}
	}

	private async answerUiRequest(request: RpcExtensionUIRequest, client: ChildRpc): Promise<void> {
		const ui = this.options.ui;
		const label = (text: string) => `[${this.options.agentName}] ${text}`;
		const dialog = { timeout: "timeout" in request ? request.timeout : undefined };
		switch (request.method) {
			case "select": {
				const value = ui ? await ui.select(label(request.title), request.options, dialog) : undefined;
				client.respond(
					value === undefined
						? { type: "extension_ui_response", id: request.id, cancelled: true }
						: { type: "extension_ui_response", id: request.id, value },
				);
				return;
			}
			case "confirm": {
				const confirmed = ui ? await ui.confirm(label(request.title), request.message, dialog) : false;
				client.respond({ type: "extension_ui_response", id: request.id, confirmed });
				return;
			}
			case "input":
			case "editor": {
				const value = !ui
					? undefined
					: request.method === "input"
						? await ui.input(label(request.title), request.placeholder, dialog)
						: await ui.editor(label(request.title), request.prefill);
				client.respond(
					value === undefined
						? { type: "extension_ui_response", id: request.id, cancelled: true }
						: { type: "extension_ui_response", id: request.id, value },
				);
				return;
			}
			case "notify":
				// Info notices (such as per-run token stats) are noise in the parent; warnings and errors still matter.
				if (request.notifyType === "warning" || request.notifyType === "error") {
					ui?.notify(label(request.message), request.notifyType);
				}
				return;
			default:
				// Status, widget, title, and editor-text requests have no meaning outside the child's own UI.
				return;
		}
	}
}
