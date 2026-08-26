import { describe, expect, it } from "vitest";
import { notifyInkChanged, onInkChanged } from "./InkEvents";

describe("InkEvents", () => {
	it("delivers the path to every listener", () => {
		const got: string[] = [];
		const offA = onInkChanged((p) => got.push(`a:${p}`));
		const offB = onInkChanged((p) => got.push(`b:${p}`));
		notifyInkChanged("note.md");
		expect(got).toEqual(["a:note.md", "b:note.md"]);
		offA();
		offB();
	});

	it("unsubscribing stops delivery and never skips a neighbor", () => {
		const got: string[] = [];
		const offA = onInkChanged(() => {
			got.push("a");
			offA();
		});
		const offB = onInkChanged(() => got.push("b"));
		notifyInkChanged("x.md");
		notifyInkChanged("x.md");
		expect(got).toEqual(["a", "b", "b"]);
		offB();
	});
});
