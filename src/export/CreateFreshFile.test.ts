import { describe, expect, it } from "vitest";
import { createFreshFile } from "./CreateFreshFile";

describe("createFreshFile", () => {
	it("creates on the first try", async () => {
		const choices = ["a.svg"];
		let created: string | null = null;
		const { path, result } = await createFreshFile(
			async () => choices.shift()!,
			async (p) => {
				created = p;
				return 42;
			}
		);
		expect(path).toBe("a.svg");
		expect(result).toBe(42);
		expect(created).toBe("a.svg");
	});

	it("retries once when the first create throws and lands on the next chosen name", async () => {
		const choices = ["a.svg", "a-2.svg"];
		const attempts: string[] = [];
		const { path, result } = await createFreshFile(
			async () => choices.shift()!,
			async (p) => {
				attempts.push(p);
				if (p === "a.svg") throw new Error("File already exists.");
				return `made:${p}`;
			}
		);
		expect(attempts).toEqual(["a.svg", "a-2.svg"]);
		expect(path).toBe("a-2.svg");
		expect(result).toBe("made:a-2.svg");
	});

	it("gives up after the bound and rethrows", async () => {
		let n = 0;
		const chosen: string[] = [];
		const failure = new Error("File already exists.");
		await expect(
			createFreshFile(
				async () => {
					n++;
					const p = `f-${n}.svg`;
					chosen.push(p);
					return p;
				},
				async () => {
					throw failure;
				},
				3
			)
		).rejects.toBe(failure);
		// Exactly `attempts` creates were tried, no more, no fewer.
		expect(chosen).toEqual(["f-1.svg", "f-2.svg", "f-3.svg"]);
	});

	it("re-chooses on every attempt rather than reusing the first name", async () => {
		const choices = ["one", "two", "three"];
		const seen: string[] = [];
		await expect(
			createFreshFile(
				async () => choices.shift()!,
				async (p) => {
					seen.push(p);
					throw new Error("nope");
				},
				3
			)
		).rejects.toThrow("nope");
		expect(seen).toEqual(["one", "two", "three"]);
	});

	it("retries on any create failure, not only an already-exists message", async () => {
		const choices = ["x", "y"];
		const { result } = await createFreshFile(
			async () => choices.shift()!,
			async (p) => {
				if (p === "x") throw new Error("EBUSY: resource locked");
				return p;
			}
		);
		expect(result).toBe("y");
	});
});
