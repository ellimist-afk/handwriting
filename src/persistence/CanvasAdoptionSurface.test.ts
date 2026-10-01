import { describe, expect, it } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { emptyPage, serializePage } from "../model/PageData";

describe("explicit canvas adoption authority", () => {
	it("observes an arriving sidecar without acknowledging a previously absent baseline", async () => {
		const adapter = new FakeAdapter(), store = new PageStore({ vault: { adapter } } as never, ".handwriting");
		expect(await store.load("p1")).toBeNull();
		await adapter.write(".handwriting/p1.json", serializePage(emptyPage("p1")));
		// A completed missing load is already a tracked release-line baseline.
		expect(await store.externallyChanged("p1")).toBe(true);
		expect(await store.externallyChanged("p1", true)).toBe(true);
		expect(await store.externallyChanged("p1", true)).toBe(true);
	});
	it("requires explicit authority for a page with no observed baseline", async () => {
		const adapter = new FakeAdapter(), store = new PageStore({ vault: { adapter } } as never, ".handwriting");
		await adapter.write(".handwriting/p1.json", serializePage(emptyPage("p1")));
		expect(await store.externallyChanged("p1")).toBe(false);
		expect(await store.externallyChanged("p1", true)).toBe(true);
		expect(await store.externallyChanged("p1", true)).toBe(true);
	});
	it("a sidecar with no surface field is not adopted as inline or as PDF", async () => {
		const adapter = new FakeAdapter(), store = new PageStore({ vault: { adapter } } as never, ".handwriting");
		const page = emptyPage("p1"), raw = JSON.parse(serializePage(page));
		delete raw.surface;
		await adapter.write(".handwriting/p1.json", JSON.stringify(raw));
		expect((await store.prepareExternalAdoption("p1", page)).kind).toBe("unavailable");
		expect((await store.prepareExternalAdoption("p1", page, "pdf")).kind).toBe("unavailable");
	});
});
