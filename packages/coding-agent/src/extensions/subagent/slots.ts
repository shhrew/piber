/**
 * Limits how many subagent processes run at once. Every run takes a slot before its process starts and
 * returns it when the process stops. Runs that find no free slot wait in first-come order, unless started ahead
 * of the queue with `acquireNow`.
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

	get capacity(): number {
		return this.limit;
	}

	/**
	 * Take a free slot at once and return the function that gives it back, or undefined when the run must queue.
	 * It never takes a slot ahead of runs already waiting.
	 */
	tryAcquire(): (() => void) | undefined {
		if (this.active >= this.limit || this.waiting.length > 0) return undefined;
		this.active++;
		return this.releaser();
	}

	/**
	 * Take a slot at once even when none is free, for a run started ahead of the queue. Until running runs drop
	 * below the limit again, no queued run starts.
	 */
	acquireNow(): () => void {
		this.active++;
		return this.releaser();
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
			waiter.grant(this.releaser());
		}
	}

	/** A function that returns one slot, once, however often it is called. */
	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.drain();
		};
	}
}
