/**
 * The subagents started by this session, for the agent view and for `session` continuations.
 */

import type { Subagent } from "./child.ts";

export class SubagentRegistry {
	private subagents: Subagent[] = [];
	private listeners = new Set<() => void>();
	private unsubscribers: Array<() => void> = [];
	private nextId = 1;

	createId(): string {
		return `sa${this.nextId++}`;
	}

	add(subagent: Subagent): void {
		this.subagents.push(subagent);
		this.unsubscribers.push(subagent.onChange(() => this.emit()));
		this.emit();
	}

	list(): readonly Subagent[] {
		return this.subagents;
	}

	/** Find a subagent by registry id or session file path. */
	find(idOrSessionFile: string): Subagent | undefined {
		return this.subagents.find(
			(subagent) => subagent.id === idOrSessionFile || subagent.sessionFile === idOrSessionFile,
		);
	}

	/** Forget every subagent, aborting those still running. */
	clear(): void {
		for (const subagent of this.subagents) void subagent.abort();
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.subagents = [];
		this.unsubscribers = [];
		this.emit();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
