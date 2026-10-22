/**
 * Limits how many subagent processes run at once. Every run takes a slot before its process starts and
 * returns it when the process stops. Runs that find no free slot wait in first-come order.
 */

interface Waiter {
	grant: (release: () => void) => void;
}

export class SlotPool {
	private limit: number;
	private active = 0;
	private waiting: Waiter[] = [];

	constructor(limit: number) {
		this.limit = Math.max(1, limit);
	}

	get running(): number {
		return this.active;
	}

	get queued(): number {
		return this.waiting.length;
	}

	/** Change the limit. Raising it starts waiting runs at once; lowering it lets running ones finish. */
	setLimit(limit: number): void {
		this.limit = Math.max(1, limit);
		this.drain();
	}

	/**
	 * Wait for a free slot and resolve with the function that returns it. Rejects, and leaves the queue,
	 * when `signal` aborts first.
	 */
	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted"));
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				grant: (release) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(release);
				},
			};
			const onAbort = () => {
				const index = this.waiting.indexOf(waiter);
				if (index === -1) return;
				this.waiting.splice(index, 1);
				reject(new Error("Subagent was aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiting.push(waiter);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.limit && this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			this.active++;
			let released = false;
			waiter.grant(() => {
				if (released) return;
				released = true;
				this.active--;
				this.drain();
			});
		}
	}
}
