/**
 * Subagent chat: short messages between the orchestrator and its subagents.
 *
 * The RPC protocol between the parent and a subagent process has no channel for this: the parent can only send
 * user-role text, and a subagent can only send UI requests. So chat runs over its own local socket:
 *
 * - `ChatHub` lives in the parent. It listens on a Unix socket (a named pipe on Windows), knows every subagent by
 *   a secret token, and routes every message, checking permissions and limits itself, so a subagent can neither
 *   impersonate another nor go past its `canMessage`.
 * - `ChatClient` lives in a subagent process. It connects with the token it got through `CHAT_TOKEN_ENV` and the
 *   socket path from the `--subagent-chat` flag.
 *
 * The protocol is JSON lines. Client to hub: `hello {token}`, `send {id, to, text, waitForReply?, timeoutSeconds?}`,
 * `cancel {id}`, `peers {id}`. Hub to client: `welcome {name}`, `reply {id, ok, text}`, `deliver {delivery}`.
 *
 * Delivery: a running, connected subagent gets a message at once (its extension steers it in after the current
 * tool call); a queued or still-connecting one gets it when it connects; a finished one cannot get it. The
 * orchestrator's messages go through `deliverToOrchestrator`.
 *
 * Waiting for a reply: `waitForReply` blocks the sender until the recipient messages it back. A waiting agent's
 * current tool call is the wait itself, so it could not see a message delivered the normal way; any message to a
 * waiting agent therefore ends its wait and comes back in the tool result instead. That also resolves two agents
 * waiting on each other.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachJsonlLineReader, serializeJsonLine } from "../../modes/rpc/jsonl.ts";
import type { ChatConfig, ChatPermission } from "./paths.ts";

export const ORCHESTRATOR = "orchestrator";
export const BROADCAST = "all";
/** Names a subagent cannot take, because they address the orchestrator or everyone. */
export const RESERVED_NAMES: readonly string[] = [ORCHESTRATOR, BROADCAST];
export const CHAT_MESSAGE_TYPE = "subagent-chat";
/** Extension flag carrying the hub's socket path to a subagent process. */
export const CHAT_FLAG = "subagent-chat";
/** Environment variable carrying a subagent's chat token; not a CLI argument, so `ps` does not show it. */
export const CHAT_TOKEN_ENV = "PI_SUBAGENT_CHAT_TOKEN";
export const CHAT_SEND_TOOL_NAME = "chat_send";
export const CHAT_PEERS_TOOL_NAME = "chat_peers";

export interface ChatRights {
	orchestrator: boolean;
	subagents: boolean;
	broadcast: boolean;
}

/** What `canMessage` allows. `all` implies the other two. */
export function resolvePermissions(words: readonly ChatPermission[]): ChatRights {
	const all = words.includes("all");
	return {
		orchestrator: all || words.includes("orchestrator"),
		subagents: all || words.includes("subagents"),
		broadcast: all,
	};
}

export function canMessageAnyone(rights: ChatRights): boolean {
	return rights.orchestrator || rights.subagents || rights.broadcast;
}

/** One message as delivered. `to` is the recipient's name, or `all` for a broadcast. */
export interface ChatDelivery {
	/** Unique per send, so a display can ask whether the sender is still waiting on this message. */
	id: string;
	from: string;
	to: string;
	text: string;
	/** The sender is blocked in `waitForReply` until the recipient answers. */
	awaitingReply: boolean;
}

/** The line asking a recipient to answer a sender blocked in `waitForReply`. */
function replyRequest(from: string): string {
	return `${from} is blocked waiting for your reply: answer now with ${CHAT_SEND_TOOL_NAME} to "${from}", even if only to say you got it.`;
}

/**
 * The text a recipient's model reads. Chat messages reach the model in the user role, so the first line says who
 * sent it and that the user did not.
 */
export function frameMessage(delivery: ChatDelivery, recipientIsOrchestrator: boolean): string {
	const sender =
		delivery.from === ORCHESTRATOR
			? "the orchestrator"
			: `${delivery.from} (${recipientIsOrchestrator ? "one of your subagents" : "a subagent"})`;
	const audience = delivery.to === BROADCAST ? "to everyone" : "to you";
	const reply = delivery.awaitingReply
		? replyRequest(delivery.from)
		: `Reply with ${CHAT_SEND_TOOL_NAME} only if it is needed.`;
	return [`[Chat message from ${sender} ${audience}, not from the user]`, delivery.text, reply].join("\n");
}

export interface SendRequest {
	to: string;
	text: string;
	waitForReply?: boolean;
	timeoutSeconds?: number;
}

/**
 * How a send ended: `delivered` or `held` (for a recipient that has not started), `broadcast`, `refused`; and, with
 * `waitForReply`, `reply` (the recipient answered), `interrupted` (someone else messaged the sender first),
 * `timeout`, or `stopped` (aborted, or chat closed).
 */
export type SendOutcome =
	| "delivered"
	| "held"
	| "broadcast"
	| "refused"
	| "reply"
	| "interrupted"
	| "timeout"
	| "stopped";

/** What a send returns to the sender's tool call. */
export interface SendResult {
	ok: boolean;
	/** For the sender's model. */
	text: string;
	outcome: SendOutcome;
	/** The reply, or the message that interrupted the wait. */
	message?: ChatDelivery;
}

/** A subagent as the hub needs to know it. */
export interface ChatPeer {
	name: string;
	description: string;
	agent: string;
	state: "running" | "queued" | "finished";
}

/** The session's subagents, read live: the hub never caches their state. */
export interface ChatDirectory {
	find(name: string): ChatPeer | undefined;
	list(): ChatPeer[];
}

/** One send as the chat log shows it, refused ones included. */
export interface ChatLogEntry {
	/** The delivery id, or "" for a refused send. */
	id: string;
	at: number;
	from: string;
	to: string;
	text: string;
	awaitingReply: boolean;
	/** Recipients still holding the message until they start. */
	held: number;
	/** Why the hub refused the send. */
	refused?: string;
}

/** Entries kept in the chat log; older ones are dropped. */
export const CHAT_LOG_LIMIT = 500;

/** Every send in the session, oldest first, for the agent view's chat tab. */
export class ChatLog {
	private readonly items: ChatLogEntry[] = [];
	private readonly listeners = new Set<() => void>();

	entries(): readonly ChatLogEntry[] {
		return this.items;
	}

	add(entry: ChatLogEntry): void {
		this.items.push(entry);
		if (this.items.length > CHAT_LOG_LIMIT) this.items.splice(0, this.items.length - CHAT_LOG_LIMIT);
		this.notify();
	}

	/** A recipient holding message `id` has started and received it. */
	markDelivered(id: string): void {
		const entry = this.items.find((item) => item.id === id);
		if (!entry || entry.held === 0) return;
		entry.held--;
		this.notify();
	}

	clear(): void {
		if (this.items.length === 0) return;
		this.items.length = 0;
		this.notify();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

export interface ChatHubOptions {
	directory: ChatDirectory;
	/** Read on every send, so config edits apply at once. */
	config: () => ChatConfig;
	deliverToOrchestrator: (delivery: ChatDelivery) => void;
	/** Records every send, refused ones included. */
	log?: ChatLog;
}

interface Waiter {
	target: string;
	/** The message whose reply is awaited. */
	messageId: string;
	resolve: (incoming: ChatDelivery) => void;
}

type ClientFrame =
	| { type: "hello"; token: string }
	| ({ type: "send"; id: string } & SendRequest)
	| { type: "cancel"; id: string }
	| { type: "peers"; id: string };

type HubFrame =
	| { type: "welcome"; name: string }
	| ({ type: "reply"; id: string } & SendResult)
	| { type: "deliver"; delivery: ChatDelivery };

function write(socket: net.Socket, frame: ClientFrame | HubFrame): void {
	if (!socket.destroyed && socket.writable) socket.write(serializeJsonLine(frame));
}

const refuse = (text: string): SendResult => ({ ok: false, text, outcome: "refused" });

export class ChatHub {
	private readonly options: ChatHubOptions;
	/** Token to member, and name to rights, for subagents registered with `register`. */
	private readonly members = new Map<string, { name: string; rights: ChatRights }>();
	private readonly rights = new Map<string, ChatRights>();
	private readonly sockets = new Map<string, net.Socket>();
	/** Messages for subagents that are queued or not connected yet. */
	private readonly held = new Map<string, ChatDelivery[]>();
	/** Agents blocked in `waitForReply`, by name. */
	private readonly waiters = new Map<string, Waiter>();
	/** Send times per sender, for the rate limit. */
	private readonly sendTimes = new Map<string, number[]>();
	private server: net.Server | undefined;
	private socketDir: string | undefined;
	private socketPath: string | undefined;

	constructor(options: ChatHubOptions) {
		this.options = options;
	}

	/** Register a subagent and return the token its process connects with. */
	register(name: string, rights: ChatRights): string {
		const token = randomUUID();
		this.members.set(token, { name, rights });
		this.rights.set(name, rights);
		return token;
	}

	/** The socket path, starting the server on first use. */
	address(): string {
		if (this.socketPath) return this.socketPath;
		let socketPath: string;
		if (process.platform === "win32") {
			socketPath = `\\\\.\\pipe\\pi-subagent-chat-${randomUUID()}`;
		} else {
			// mkdtemp creates the directory with mode 0700, so only this user can reach the socket.
			this.socketDir = mkdtempSync(join(tmpdir(), "pi-chat-"));
			socketPath = join(this.socketDir, "hub.sock");
		}
		const server = net.createServer((socket) => this.accept(socket));
		server.on("error", () => {});
		server.listen(socketPath);
		server.unref();
		this.server = server;
		this.socketPath = socketPath;
		return socketPath;
	}

	close(): void {
		for (const waiter of [...this.waiters.values()]) {
			waiter.resolve({ id: "", from: "", to: "", text: "", awaitingReply: false });
		}
		this.waiters.clear();
		for (const socket of this.sockets.values()) socket.destroy();
		this.sockets.clear();
		this.held.clear();
		this.server?.close();
		this.server = undefined;
		this.socketPath = undefined;
		if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
		this.socketDir = undefined;
	}

	/** Send a message from `from` (a subagent name, or `orchestrator`), checking its permissions and the limits. */
	async send(from: string, request: SendRequest, signal?: AbortSignal): Promise<SendResult> {
		const config = this.options.config();
		const text = request.text.trim();
		const to = request.to.trim();
		const awaitingReply = request.waitForReply === true;
		const record = (id: string, held: number, refused?: string) =>
			this.options.log?.add({ id, at: Date.now(), from, to, text, awaitingReply, held, refused });
		const decline = (reason: string): SendResult => {
			record("", 0, reason);
			return refuse(reason);
		};
		const rights = from === ORCHESTRATOR ? resolvePermissions(config.orchestratorCanMessage) : this.rights.get(from);
		if (!rights) return decline(`${from} is not part of this chat.`);
		if (!text) return decline("The message is empty.");
		if (text.length > config.maxMessageLength) {
			return decline(
				`The message is ${text.length} characters; the limit is ${config.maxMessageLength}. Shorten it.`,
			);
		}
		if (to === from) return decline("You cannot message yourself.");

		if (to === BROADCAST) {
			if (!rights.broadcast) return decline("You are not allowed to message everyone.");
			if (request.waitForReply) return decline(`waitForReply cannot be used with to: "${BROADCAST}".`);
		} else if (to === ORCHESTRATOR) {
			if (!rights.orchestrator) return decline("You are not allowed to message the orchestrator.");
		} else {
			if (!rights.subagents) return decline("You are not allowed to message other subagents.");
			const peer = this.options.directory.find(to);
			if (!peer) {
				const names = this.options.directory
					.list()
					.map((candidate) => candidate.name)
					.filter((name) => name !== from);
				return decline(`There is no subagent named "${to}". Subagents: ${names.join(", ") || "none"}.`);
			}
			if (peer.state === "finished") return decline(`${to} has finished and cannot receive messages.`);
		}
		if (request.waitForReply && this.waiters.has(from)) return decline("You are already waiting for a reply.");
		if (!this.withinRate(from, config.maxMessagesPerMinute)) {
			return decline(
				`You have sent ${config.maxMessagesPerMinute} messages in the last minute; wait before sending more.`,
			);
		}

		const delivery: ChatDelivery = { id: randomUUID(), from, to, text, awaitingReply };
		if (to === BROADCAST) {
			const recipients = [
				...(from === ORCHESTRATOR ? [] : [ORCHESTRATOR]),
				...this.options.directory
					.list()
					.filter((peer) => peer.state !== "finished" && peer.name !== from)
					.map((peer) => peer.name),
			];
			if (recipients.length === 0) return decline("No one else is running.");
			const outcomes = recipients.map((recipient) => this.route(recipient, delivery));
			const held = outcomes.filter((outcome) => outcome === "held").length;
			const delivered = outcomes.length - held;
			record(delivery.id, held);
			return {
				ok: true,
				text: `Sent to everyone: ${delivered} delivered${held > 0 ? `, ${held} held until they start` : ""}.`,
				outcome: "broadcast",
			};
		}

		const outcome = this.route(to, delivery);
		record(delivery.id, outcome === "held" ? 1 : 0);
		const sent =
			outcome === "held"
				? `Held for ${to}, which has not started yet; it gets the message when it starts.`
				: `Delivered to ${to}.`;
		if (!request.waitForReply) return { ok: true, text: sent, outcome };
		const timeout = Math.min(request.timeoutSeconds ?? config.replyTimeoutSeconds, config.maxReplyTimeoutSeconds);
		return this.waitForReply(from, delivery, Math.max(1, timeout), signal);
	}

	/** Whether the sender of message `id` is still blocked waiting for its reply. */
	isAwaitingReply(id: string): boolean {
		for (const waiter of this.waiters.values()) if (waiter.messageId === id) return true;
		return false;
	}

	/** The agents `from` may message and their state, for `chat_peers`. */
	peers(from: string): string {
		const config = this.options.config();
		const rights = from === ORCHESTRATOR ? resolvePermissions(config.orchestratorCanMessage) : this.rights.get(from);
		if (!rights || !canMessageAnyone(rights)) return "You cannot send chat messages.";
		const lines = [
			from === ORCHESTRATOR ? "You are the orchestrator. You can message:" : `You are ${from}. You can message:`,
		];
		if (rights.orchestrator && from !== ORCHESTRATOR) lines.push(`- ${ORCHESTRATOR}`);
		if (rights.subagents) {
			const peers = this.options.directory.list().filter((peer) => peer.name !== from);
			if (peers.length === 0) lines.push("- no other subagents yet");
			for (const peer of peers) {
				const state =
					peer.state === "running"
						? "running"
						: peer.state === "queued"
							? "queued, gets messages when it starts"
							: "finished, cannot receive messages";
				lines.push(`- ${peer.name} (${peer.description}; ${peer.agent}): ${state}`);
			}
		}
		if (rights.broadcast) lines.push(`- ${BROADCAST}: everyone still running, at once`);
		return lines.join("\n");
	}

	/** Hand `delivery` to one recipient: end its wait, deliver it now, or hold it until it connects. */
	private route(recipient: string, delivery: ChatDelivery): "delivered" | "held" {
		const waiter = this.waiters.get(recipient);
		if (waiter) {
			waiter.resolve(delivery);
			return "delivered";
		}
		if (recipient === ORCHESTRATOR) {
			this.options.deliverToOrchestrator(delivery);
			return "delivered";
		}
		const socket = this.sockets.get(recipient);
		if (socket && this.options.directory.find(recipient)?.state === "running") {
			write(socket, { type: "deliver", delivery });
			return "delivered";
		}
		const queue = this.held.get(recipient) ?? [];
		queue.push(delivery);
		this.held.set(recipient, queue);
		return "held";
	}

	private waitForReply(
		from: string,
		sent: ChatDelivery,
		timeoutSeconds: number,
		signal?: AbortSignal,
	): Promise<SendResult> {
		const to = sent.to;
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const finish = (result: SendResult) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (this.waiters.get(from) === waiter) this.waiters.delete(from);
				resolve(result);
			};
			const waiter: Waiter = {
				target: to,
				messageId: sent.id,
				resolve: (incoming) => {
					if (!incoming.from) {
						finish({ ok: false, text: "Chat closed while waiting for a reply.", outcome: "stopped" });
					} else if (incoming.from === to) {
						finish({ ok: true, text: `${to} replied:\n${incoming.text}`, outcome: "reply", message: incoming });
					} else {
						const lines = [
							`While you waited for ${to}, ${incoming.from} messaged you${incoming.to === BROADCAST ? " (to everyone)" : ""}:`,
							incoming.text,
						];
						if (incoming.awaitingReply) lines.push(replyRequest(incoming.from));
						lines.push(`You stopped waiting for ${to}; its reply will arrive as a chat message.`);
						finish({ ok: true, text: lines.join("\n"), outcome: "interrupted", message: incoming });
					}
				},
			};
			const onAbort = () => finish({ ok: false, text: "Stopped waiting for a reply.", outcome: "stopped" });
			this.waiters.set(from, waiter);
			timer = setTimeout(
				() =>
					finish({
						ok: true,
						text: `Sent to ${to}. No reply within ${timeoutSeconds} s; a later reply will arrive as a chat message.`,
						outcome: "timeout",
					}),
				timeoutSeconds * 1000,
			);
			timer.unref();
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private withinRate(from: string, perMinute: number): boolean {
		const now = Date.now();
		const recent = (this.sendTimes.get(from) ?? []).filter((time) => now - time < 60_000);
		if (recent.length >= perMinute) {
			this.sendTimes.set(from, recent);
			return false;
		}
		recent.push(now);
		this.sendTimes.set(from, recent);
		return true;
	}

	private accept(socket: net.Socket): void {
		let member: { name: string; rights: ChatRights } | undefined;
		const pending = new Map<string, AbortController>();
		socket.on("error", () => {});
		const stopReading = attachJsonlLineReader(socket, (line) => {
			let frame: ClientFrame;
			try {
				frame = JSON.parse(line) as ClientFrame;
			} catch {
				return;
			}
			if (frame.type === "hello") {
				member = this.members.get(frame.token);
				if (!member) {
					socket.destroy();
					return;
				}
				this.sockets.get(member.name)?.destroy();
				this.sockets.set(member.name, socket);
				write(socket, { type: "welcome", name: member.name });
				for (const delivery of this.held.get(member.name) ?? []) {
					write(socket, { type: "deliver", delivery });
					this.options.log?.markDelivered(delivery.id);
				}
				this.held.delete(member.name);
				return;
			}
			// Nothing but hello is accepted before the token is known.
			if (!member) {
				socket.destroy();
				return;
			}
			if (frame.type === "send") {
				const controller = new AbortController();
				pending.set(frame.id, controller);
				const { id, type: _type, ...request } = frame;
				void this.send(member.name, request, controller.signal).then((result) => {
					pending.delete(id);
					write(socket, { type: "reply", id, ...result });
				});
			} else if (frame.type === "cancel") {
				pending.get(frame.id)?.abort();
			} else if (frame.type === "peers") {
				write(socket, {
					type: "reply",
					id: frame.id,
					ok: true,
					text: this.peers(member.name),
					outcome: "delivered",
				});
			}
		});
		socket.on("close", () => {
			stopReading();
			for (const controller of pending.values()) controller.abort();
			if (member && this.sockets.get(member.name) === socket) this.sockets.delete(member.name);
		});
	}
}

/** The chat side of a subagent process. */
export class ChatClient {
	private readonly socketPath: string;
	private readonly token: string;
	private readonly onDeliver: (delivery: ChatDelivery) => void;
	private socket: net.Socket | undefined;
	private readonly pending = new Map<string, (result: SendResult) => void>();
	private nextId = 1;
	name: string | undefined;

	constructor(socketPath: string, token: string, onDeliver: (delivery: ChatDelivery) => void) {
		this.socketPath = socketPath;
		this.token = token;
		this.onDeliver = onDeliver;
	}

	/** Connect and authenticate, retrying briefly in case the hub is still starting. Resolves with this agent's name. */
	async connect(timeoutMs = 3000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			try {
				return await this.attempt();
			} catch (error) {
				if (Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	send(request: SendRequest, signal?: AbortSignal): Promise<SendResult> {
		const id = String(this.nextId++);
		const socket = this.socket;
		if (!socket || socket.destroyed) return Promise.resolve(refuse("Chat is not connected."));
		return new Promise((resolve) => {
			const onAbort = () => write(socket, { type: "cancel", id });
			this.pending.set(id, (result) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			write(socket, { type: "send", id, ...request });
		});
	}

	async peers(): Promise<string> {
		const id = String(this.nextId++);
		const socket = this.socket;
		if (!socket || socket.destroyed) return "Chat is not connected.";
		return new Promise((resolve) => {
			this.pending.set(id, (result) => resolve(result.text));
			write(socket, { type: "peers", id });
		});
	}

	close(): void {
		this.socket?.destroy();
		this.socket = undefined;
	}

	private attempt(): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(this.socketPath);
			let welcomed = false;
			const stopReading = attachJsonlLineReader(socket, (line) => {
				let frame: HubFrame;
				try {
					frame = JSON.parse(line) as HubFrame;
				} catch {
					return;
				}
				if (frame.type === "welcome") {
					welcomed = true;
					this.name = frame.name;
					this.socket = socket;
					resolve(frame.name);
				} else if (frame.type === "reply") {
					const settle = this.pending.get(frame.id);
					this.pending.delete(frame.id);
					settle?.({ ok: frame.ok, text: frame.text, outcome: frame.outcome, message: frame.message });
				} else if (frame.type === "deliver") {
					this.onDeliver(frame.delivery);
				}
			});
			socket.on("connect", () => write(socket, { type: "hello", token: this.token }));
			socket.on("error", (error) => {
				if (!welcomed) reject(error);
			});
			socket.on("close", () => {
				stopReading();
				if (!welcomed) {
					reject(new Error("Chat hub refused the connection"));
					return;
				}
				if (this.socket === socket) this.socket = undefined;
				for (const settle of this.pending.values()) settle(refuse("Chat connection closed."));
				this.pending.clear();
			});
		});
	}
}
