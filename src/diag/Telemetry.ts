/**
 * Production-path telemetry (v0.1.3).
 *
 * v0.1.2 reported down/up/recorded = 0 while ink was visibly drawing, which is
 * impossible if the counters and the ink share a code path. So the counters are
 * no longer view state read at stroke boundaries: this is a module-level
 * singleton written to from inside the exact functions that produce ink, and
 * rendered by an independent timer that cannot go stale.
 *
 * It survives view instances on purpose. If a second HandwritingView is ever created,
 * counts keep climbing while `viewInstances` goes above 1, which distinguishes
 * "the instrumentation is disconnected" from "you were reading a stale panel of
 * a different view".
 */

export class Telemetry {
	private counters = new Map<string, number>();
	/** Number of HandwritingView instances constructed this session. */
	viewInstances = 0;
	/** Most recent thrown error from any instrumented handler. */
	lastError = "";
	lastErrorAt = 0;
	errors = 0;

	bump(key: string, n = 1): void {
		this.counters.set(key, (this.counters.get(key) ?? 0) + n);
	}

	get(key: string): number {
		return this.counters.get(key) ?? 0;
	}

	fail(where: string, err: unknown): void {
		this.errors++;
		this.lastError = `${where}: ${String(err)}`;
		this.lastErrorAt = performance.now();
		console.error(`[handwriting] ${where}`, err);
	}

	/** Run fn, recording any throw instead of letting it kill the handler. */
	guard<T>(where: string, fn: () => T): T | undefined {
		try {
			return fn();
		} catch (err) {
			this.fail(where, err);
			return undefined;
		}
	}

	reset(): void {
		this.counters.clear();
		this.errors = 0;
		this.lastError = "";
	}

	/** Two compact lines for the on-canvas panel. */
	panelText(): string {
		const g = (k: string) => this.get(k);
		const lines = [
			`evt  down ${g("router.penDown")}  up ${g("router.penUp")}` +
				` (backstop ${g("router.penUp.backstop")})  raw ${g("router.rawUpdate")}` +
				`  move ${g("router.penMove")}`,
			`ink  strokesBegun ${g("view.strokeBegin")}  strokesEnded ${g("view.strokeEnd")}` +
				`  batches ${g("view.inkBatch")}  segments ${g("view.segment")}` +
				`  views ${this.viewInstances}`,
		];
		if (this.errors > 0) lines.push(`ERR ${this.errors}: ${this.lastError.slice(0, 90)}`);
		return lines.join("\n");
	}

	dump(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const [k, v] of [...this.counters.entries()].sort()) out[k] = v;
		return out;
	}
}

export const telemetry = new Telemetry();
