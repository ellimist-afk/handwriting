import { describe, expect, it } from "vitest";
import { FakeDoc, FakeEl } from "./fakeDom";

describe("FakeEl: unknown-member throws", () => {
	it("names the member on first access, rather than reading undefined silently", () => {
		const doc = new FakeDoc();
		const el = new FakeEl("div", doc) as unknown as Record<string, unknown>;
		expect(() => el.scrollIntoView).toThrowError("FakeEl: unsupported member scrollIntoView");
	});

	it("does not throw for an implemented member", () => {
		const doc = new FakeDoc();
		const el = new FakeEl("div", doc);
		expect(() => el.addClass("x")).not.toThrow();
		expect(el.classList.contains("x")).toBe(true);
	});

	it("a failing object comparison on a FakeEl reports the mismatch, not an unsupported member", () => {
		const doc = new FakeDoc();
		const a = new FakeEl("div", doc);
		const b = new FakeEl("div", doc);
		a.textContent = "a";
		b.textContent = "b";
		let message = "";
		try {
			expect(a).toEqual(b);
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message, "the comparison must actually fail, or this cell tests nothing").not.toBe("");
		expect(message).toContain("to deeply equal");
		expect(message).not.toContain("FakeEl: unsupported member");
	});
});

describe("FakeEl: querySelector", () => {
	it("answers a tag or .class selector from children, recursively", () => {
		const doc = new FakeDoc();
		const root = new FakeEl("div", doc);
		const mid = root.createDiv({ cls: "mid" });
		const svg = mid.createEl("svg");
		expect(root.querySelector("svg")).toBe(svg);
		expect(root.querySelector(".mid")).toBe(mid);
		expect(root.querySelector(".missing")).toBeNull();
	});

	it("throws on an unsupported selector rather than answering null", () => {
		const doc = new FakeDoc();
		const root = new FakeEl("div", doc);
		root.createDiv({ attr: { id: "x" } });
		expect(() => root.querySelector("#id")).toThrowError("FakeEl: unsupported selector #id");
	});
});

describe("FakeEl and FakeDoc: listeners are tracked like the DOM's", () => {
	it("a removal that names the same callback and capture flag takes the listener out", () => {
		const doc = new FakeDoc();
		const el = new FakeEl("div", doc);
		const fn = () => {};
		el.addEventListener("click", fn);
		expect(el.listenerCount("click")).toBe(1);
		el.removeEventListener("click", fn);
		expect(el.listenerCount("click")).toBe(0);
		expect(el.listenerCount()).toBe(0);
	});

	it("a removal with the wrong capture flag removes nothing, as in the DOM", () => {
		const doc = new FakeDoc();
		const fn = () => {};
		doc.addEventListener("keydown", fn, { capture: true });
		doc.removeEventListener("keydown", fn);
		expect(doc.documentListenerCount("keydown"), "capture true, removed with capture false").toBe(1);
		doc.removeEventListener("keydown", fn, { capture: true });
		expect(doc.documentListenerCount("keydown")).toBe(0);
		doc.addEventListener("keydown", fn, true);
		doc.removeEventListener("keydown", fn, { capture: true });
		expect(doc.documentListenerCount(), "a boolean and an options object name the same flag").toBe(0);
	});

	it("passive does not take part in matching", () => {
		const doc = new FakeDoc();
		const fn = () => {};
		doc.addEventListener("scroll", fn, { passive: true } as AddEventListenerOptions);
		doc.removeEventListener("scroll", fn);
		expect(doc.documentListenerCount("scroll")).toBe(0);
	});

	it("adding the same callback twice with the same flag keeps one listener, and it fires once", () => {
		const doc = new FakeDoc();
		const el = new FakeEl("div", doc);
		let calls = 0;
		const fn = () => { calls++; };
		el.addEventListener("click", fn);
		el.addEventListener("click", fn);
		el.fire("click");
		expect(el.listenerCount("click")).toBe(1);
		expect(calls).toBe(1);
	});

	it("a removed listener no longer fires", () => {
		const doc = new FakeDoc();
		const el = new FakeEl("div", doc);
		let calls = 0;
		const fn = () => { calls++; };
		el.addEventListener("click", fn);
		el.removeEventListener("click", fn);
		el.fire("click");
		doc.addEventListener("pointerup", fn);
		doc.removeEventListener("pointerup", fn);
		doc.fire("pointerup");
		expect(calls).toBe(0);
	});

	it("window listeners are counted apart from document listeners", () => {
		const doc = new FakeDoc();
		const fn = () => {};
		doc.defaultView.addEventListener("resize", fn);
		expect(doc.windowListenerCount("resize")).toBe(1);
		expect(doc.documentListenerCount()).toBe(0);
		doc.defaultView.removeEventListener("resize", fn);
		expect(doc.windowListenerCount()).toBe(0);
	});
});

describe("FakeEl: insertBefore moves a node, like the DOM", () => {
	it("a node taken from another parent leaves that parent and takes the new one", () => {
		const doc = new FakeDoc();
		const strip = new FakeEl("div", doc);
		const more = new FakeEl("div", doc);
		const anchor = strip.createEl("button");
		const moved = more.createEl("button");
		strip.insertBefore(moved, anchor);
		expect(more.children).not.toContain(moved);
		expect(strip.children).toEqual([moved, anchor]);
		expect(moved.parentElement).toBe(strip);
	});

	it("a node moved within its own parent is not duplicated", () => {
		const doc = new FakeDoc();
		const row = new FakeEl("div", doc);
		const a = row.createEl("button");
		const b = row.createEl("button");
		row.insertBefore(b, a);
		expect(row.children).toEqual([b, a]);
	});

	it("a reference that is not a child is refused before anything moves", () => {
		const doc = new FakeDoc();
		const row = new FakeEl("div", doc);
		const other = new FakeEl("div", doc);
		const stray = other.createEl("button");
		const node = row.createEl("button");
		expect(() => row.insertBefore(node, stray)).toThrowError("reference node is not a child");
		expect(row.children).toEqual([node]);
	});

	it("a null reference appends and sets the parent", () => {
		const doc = new FakeDoc();
		const row = new FakeEl("div", doc);
		const loose = new FakeEl("span", doc);
		row.insertBefore(loose, null);
		expect(row.children).toEqual([loose]);
		expect(loose.parentElement).toBe(row);
	});
});
