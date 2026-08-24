import { describe, expect, it } from "vitest";

import { handoffFinishedStroke } from "./StrokeHandoff";

describe("finished-stroke presentation handoff", () => {
	it("draws committed ink before clearing the low-latency wet layer", () => {
		const order: string[] = [];
		const visibility: Array<{ wet: boolean; committed: boolean }> = [];
		let wet = true;
		let committed = false;
		const record = () => visibility.push({ wet, committed });

		handoffFinishedStroke({
			store: () => {
				order.push("store");
				record();
			},
			drawCommitted: () => {
				order.push("draw-committed");
				committed = true;
				record();
			},
			clearTransient: () => {
				order.push("clear-wet");
				wet = false;
				record();
			},
			publishHistory: () => {
				order.push("publish-history");
				record();
			},
		});

		expect(order).toEqual(["store", "draw-committed", "clear-wet", "publish-history"]);
		expect(visibility.every((frame) => frame.wet || frame.committed)).toBe(true);
	});
});
