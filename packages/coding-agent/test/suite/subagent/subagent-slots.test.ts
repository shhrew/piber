import { describe, expect, it } from "vitest";
import { SlotPool } from "../../../src/extensions/subagent/slots.ts";

/** Resolve pending promise callbacks so granted slots are observed. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("subagent slot pool", () => {
	it("runs up to the limit and starts queued runs in order as slots free up", async () => {
		const pool = new SlotPool(2);
		const started: string[] = [];
		const releases = new Map<string, () => void>();
		for (const name of ["a", "b", "c", "d"]) {
			void pool.acquire().then((release) => {
				started.push(name);
				releases.set(name, release);
			});
		}
		await flush();
		expect(started).toEqual(["a", "b"]);
		expect([pool.running, pool.queued]).toEqual([2, 2]);

		releases.get("b")!();
		releases.get("b")!();
		await flush();
		expect(started).toEqual(["a", "b", "c"]);
		expect([pool.running, pool.queued]).toEqual([2, 1]);

		releases.get("a")!();
		await flush();
		expect(started).toEqual(["a", "b", "c", "d"]);
	});

	it("removes an aborted run from the queue without taking a slot", async () => {
		const pool = new SlotPool(1);
		const first = await pool.acquire();
		const controller = new AbortController();
		const waiting = pool.acquire(controller.signal);
		const after = pool.acquire();

		controller.abort();
		await expect(waiting).rejects.toThrow("aborted");
		expect(pool.queued).toBe(1);

		first();
		await expect(after).resolves.toBeTypeOf("function");
		expect(pool.running).toBe(1);
	});

	it("starts waiting runs when the limit is raised", async () => {
		const pool = new SlotPool(1);
		await pool.acquire();
		let started = false;
		void pool.acquire().then(() => {
			started = true;
		});
		await flush();
		expect(started).toBe(false);

		pool.setLimit(2);
		await flush();
		expect(started).toBe(true);
	});
});
