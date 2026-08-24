import { afterEach, describe, expect, it, vi } from "vitest";
import { runDetached } from "./Detached";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("detached work", () => {
	it("reports a rejected operation and consumes the rejection", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const report = vi.fn();
		runDetached(Promise.reject(new Error("disk full")), "save ink", report);

		await Promise.resolve();

		expect(log).toHaveBeenCalledWith(
			"[handwriting] save ink",
			expect.objectContaining({ message: "disk full" })
		);
		expect(report).toHaveBeenCalledOnce();
	});

	it("does not report successful work", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const report = vi.fn();
		runDetached(Promise.resolve(), "save ink", report);

		await Promise.resolve();

		expect(log).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it("contains a failure thrown by the optional reporter", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		runDetached(Promise.reject(new Error("write failed")), "save ink", () => {
			throw new Error("notice failed");
		});

		await Promise.resolve();

		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[1]?.[0]).toBe(
			"[handwriting] save ink: failure reporter threw"
		);
	});
});
