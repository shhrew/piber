/**
 * A minimal client for a `pi --mode rpc` child process.
 *
 * The exported `RpcClient` spawns `node <cliPath>` and forwards stderr to this process. A subagent needs
 * the command that started this installation (source checkout, dist, or standalone binary), must keep
 * stderr away from the parent's TUI, must answer the child's extension dialogs, and must notice when the
 * child dies mid-run. This client covers only what subagents use.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "../../modes/rpc/rpc-types.ts";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type ChildEvent = JsonAgentSessionEvent | RpcExtensionUIRequest;

export interface ChildRpcOptions {
	executable: string;
	args: string[];
	cwd: string;
	onEvent: (event: ChildEvent) => void;
	onStderr: (chunk: string) => void;
	/** Called once when the process exits or fails, unless `stop()` ended it. */
	onExit: (error: Error) => void;
}

export class ChildRpc {
	private readonly options: ChildRpcOptions;
	private process: ChildProcess | null = null;
	private stopReading: (() => void) | null = null;
	private pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
	private requestId = 0;
	private exitError: Error | null = null;

	constructor(options: ChildRpcOptions) {
		this.options = options;
	}

	start(): void {
		const child = spawn(this.options.executable, [...this.options.args, "--mode", "rpc"], {
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stderr?.on("data", (data: Buffer) => this.options.onStderr(data.toString()));
		const fail = (error: Error) => {
			if (this.process !== child) return;
			this.process = null;
			this.exitError = error;
			for (const request of this.pending.values()) request.reject(error);
			this.pending.clear();
			this.options.onExit(error);
		};
		child.once("exit", (code, signal) => fail(new Error(`Subagent process exited (code=${code} signal=${signal})`)));
		child.once("error", (error) => fail(new Error(`Subagent process error: ${error.message}`)));
		child.stdin?.on("error", (error) => fail(new Error(`Subagent stdin error: ${error.message}`)));
		this.stopReading = attachJsonlLineReader(child.stdout!, (line) => this.handleLine(line));
	}

	/** Stop the process. Its exit is then not reported through `onExit`. */
	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.process = null;
		this.stopReading?.();
		this.stopReading = null;
		for (const request of this.pending.values()) request.reject(new Error("Subagent process stopped"));
		this.pending.clear();
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 2000);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	async prompt(message: string): Promise<void> {
		this.check(await this.send({ type: "prompt", message }));
	}

	async steer(message: string): Promise<void> {
		this.check(await this.send({ type: "steer", message }));
	}

	async abort(): Promise<void> {
		this.check(await this.send({ type: "abort" }));
	}

	async getState(): Promise<RpcSessionState> {
		return this.getData(await this.send({ type: "get_state" }));
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.getData<{ messages: AgentMessage[] }>(await this.send({ type: "get_messages" })).messages;
	}

	/** Answer an `extension_ui_request`. The child waits for it, so every dialog request needs an answer. */
	respond(response: RpcExtensionUIResponse): void {
		const stdin = this.process?.stdin;
		if (stdin && !stdin.destroyed && stdin.writable) stdin.write(serializeJsonLine(response));
	}

	private handleLine(line: string): void {
		let data: { type?: string; id?: string };
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}
		if (data.type === "response" && data.id && this.pending.has(data.id)) {
			const request = this.pending.get(data.id)!;
			this.pending.delete(data.id);
			request.resolve(data as RpcResponse);
			return;
		}
		this.options.onEvent(data as ChildEvent);
	}

	private send(command: DistributiveOmit<RpcCommand, "id">): Promise<RpcResponse> {
		const stdin = this.process?.stdin;
		if (this.exitError) return Promise.reject(this.exitError);
		if (!stdin || stdin.destroyed || !stdin.writable)
			return Promise.reject(new Error("Subagent process is not running"));
		const id = `req_${++this.requestId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			stdin.write(serializeJsonLine({ ...command, id }));
		});
	}

	private check(response: RpcResponse): void {
		if (!response.success) throw new Error((response as Extract<RpcResponse, { success: false }>).error);
	}

	private getData<T>(response: RpcResponse): T {
		this.check(response);
		return (response as Extract<RpcResponse, { success: true; data: unknown }>).data as T;
	}
}
