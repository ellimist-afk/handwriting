import { describe, expect, it, vi, type Mock } from "vitest";
import type { App } from "obsidian";
import type { InkStroke } from "./ink/Stroke";
import { emptyPage, serializePage } from "./model/PageData";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { FakeAdapter, gate } from "./persistence/FakeAdapter";
import { PageStore } from "./persistence/PageStore";
import { installLiveReloadPoll } from "./testUtils/LiveReloadTestHarness";

function stroke(x: number, id = "stroke-a"): InkStroke {
	return { id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: .5, t: 0 }, { x: x + 10, y: 20, pressure: .5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 } };
}
type Root = { isConnected: boolean };
type Pane = { idle: boolean; painted: number[]; refresh: Mock<() => void> };

async function harness() {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as unknown as App);
	const pdfStore = new PdfInkStore();
	const schedule = vi.fn(() => { throw new Error("poll must never save"); });
	pdfStore.attachHost({
		load: id => store.load(id),
		schedule,
		notice: vi.fn(),
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: prepared => store.acceptExternalAdoption(prepared),
	});
	const external = (id: string, strokes: InkStroke[]) => adapter.externalWrite(
		`.handwriting/${id}.json`, serializePage({ ...emptyPage(id), surface: "pdf", strokes }));
	for (const id of ["shared", "other"]) {
		external(id, [stroke(10)]);
		await pdfStore.ensureLoaded(id);
	}
	const events: string[] = [];
	const errors: unknown[][] = [];
	const detachedErrors: unknown[] = [];
	const surfaces = { changed: false };
	const document = { hidden: false };
	let callback!: () => void;
	let pending = Promise.resolve();
	const originalCheck = store.externallyChanged.bind(store);
	const check = vi.spyOn(store, "externallyChanged").mockImplementation(id => {
		events.push(`check:${id}`);
		return id === "note" || id === "deck.slides" ? Promise.resolve(surfaces.changed) : originalCheck(id);
	});
	const reload = vi.fn<(id: string) => void>();
	const realAdopt = pdfStore.adoptExternal.bind(pdfStore);
	vi.spyOn(pdfStore, "adoptExternal").mockImplementation((id, stillEligible) => {
		reload(id);
		return realAdopt(id, stillEligible);
	});
	const reads = vi.spyOn(adapter, "read");
	const queued = vi.spyOn(store, "hasQueuedWrite");
	const host = {
		store, pdfStore, pdfInk: new Map<Root, Pane>(), pdfIds: new Map<Root, string>(),
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval(handle: number) { expect(handle).toBe(17); },
	};
	function pane(id: string, root: Root = { isConnected: true }) {
		const controller: Pane = { idle: true, painted: pdfStore.strokes(id).map(s => s.points[0]!.x),
			refresh: vi.fn(() => { events.push(`paint:${id}`); controller.painted = pdfStore.strokes(id).map(s => s.points[0]!.x); }) };
		host.pdfInk.set(root, controller);
		host.pdfIds.set(root, id);
		return { root, controller };
	}
	const a = pane("shared");
	const b = pane("shared");
	const other = pane("other");
	installLiveReloadPoll.call(host,
		{ setInterval(fn: () => void, delay: number) { expect(delay).toBe(1000); callback = fn; return 17; } },
		document, (promise: Promise<void>) => { pending = promise.catch(error => { detachedErrors.push(error); }); },
		() => ["note.md"], {
			pageIdOf: () => "note",
			adoptExternal: async () => ({
				outcome: "adopted" as const,
				changed: true,
				outgoingPath: ".handwriting/note.conflict-external-test-outgoing.json",
				incomingPath: ".handwriting/note.conflict-external-test-incoming.json",
			}),
		},
		() => events.push("paint:note"), () => events.push("notify:note"),
		() => "deck.slides", async () => { events.push("paint:slides"); return true; },
		{ error: (...args: unknown[]) => errors.push(args) }, () => () => true);
	return { adapter, store, pdfStore, external, events, errors, detachedErrors, surfaces, document,
		check, originalCheck, reload, reads, queued, schedule, host, pane, a, b, other,
		fire: () => callback(), settle: () => pending,
		async tick() { callback(); await pending; } };
}
type Harness = Awaited<ReturnType<typeof harness>>;
function holdStat(h: Harness) {
	const held = gate();
	// Resolve an observed change after the gate so the poll must recheck its own guards.
	h.check.mockImplementationOnce(async () => { await held.promise; return true; });
	return held;
}
async function heldReload(h: Harness) {
	const held = gate();
	const entered = gate();
	const originalPrepare = h.store.prepareExternalAdoption.bind(h.store);
	vi.spyOn(h.store, "prepareExternalAdoption").mockImplementationOnce(async (...args) => {
		entered.release(); await held.promise; return originalPrepare(...args);
	});
	h.external("shared", [stroke(400)]);
	h.fire();
	await entered.promise;
	return held;
}

describe("PDF document-coordinated external reload", () => {
	it.each([
		["add", [stroke(10), stroke(30, "stroke-b")], [10, 30]],
		["erase to empty", [], []],
		["same-count move", [stroke(400)], [400]],
	] as const)("fans out a real external %s once per document without saves or quiet repaints", async (_name, strokes, expected) => {
		const h = await harness();
		h.external("shared", [...strokes]);
		h.external("other", [stroke(900)]);
		await h.tick();
		expect(h.a.controller.painted).toEqual(expected);
		expect(h.b.controller.painted).toEqual(expected);
		expect(h.other.controller.painted).toEqual([900]);
		expect(h.reload.mock.calls).toEqual([["shared"], ["other"]]);
		expect(h.check.mock.calls.map(([id]) => id)).toEqual(["shared", "other", "note", "deck.slides"]);
		// Each live revision is read for hashing, preparation and final
		// revalidation; both independently recoverable artifacts are read back.
		const readPaths = h.reads.mock.calls.map(([path]) => path);
		expect(readPaths.filter(path => path === ".handwriting/shared.json")).toHaveLength(3);
		expect(readPaths.filter(path => path === ".handwriting/other.json")).toHaveLength(3);
		// A pair is written, and read back, only for a revision that would lose
		// something: "add" only adds to the shared document, so only the other
		// document's changed stroke earns one.
		expect(readPaths.filter(path => path.includes(".conflict-external-"))).toHaveLength(_name === "add" ? 2 : 4);
		expect(await h.originalCheck("shared")).toBe(false);
		await h.tick();
		for (const pane of [h.a, h.b, h.other]) expect(pane.controller.refresh).toHaveBeenCalledTimes(1);
		expect(h.schedule).not.toHaveBeenCalled();
		expect(h.adapter.log).toHaveLength(_name === "add" ? 2 : 4);
		expect(h.adapter.log.every(entry =>
			entry.startsWith("write ") && entry.includes(".conflict-external-")
		)).toBe(true);
		expect(h.detachedErrors).toEqual([]);
	});

	it("waits for every sibling before stat while an unrelated PDF and other surfaces proceed", async () => {
		const h = await harness();
		h.b.controller.idle = false;
		h.external("shared", [stroke(400)]); h.external("other", [stroke(900)]);
		h.surfaces.changed = true;
		await h.tick();
		expect(h.pdfStore.strokes("shared")[0]!.points[0]!.x).toBe(10);
		expect(h.check.mock.calls.map(([id]) => id)).not.toContain("shared");
		expect(h.other.controller.painted).toEqual([900]);
		expect(h.events).toContain("paint:note"); expect(h.events).toContain("paint:slides");
		h.b.controller.idle = true; await h.tick();
		expect(h.a.controller.painted).toEqual([400]); expect(h.b.controller.painted).toEqual([400]);
	});

	it.each(["busy sibling", "queued write"])("rechecks %s after stat before shared adoption", async guard => {
		const h = await harness(); const held = holdStat(h);
		h.external("shared", [stroke(400)]); h.fire();
		if (guard === "busy sibling") h.b.controller.idle = false;
		else h.queued.mockImplementation(id => id === "shared");
		held.release(); await h.settle();
		expect(h.reload).not.toHaveBeenCalled();
		expect(h.pdfStore.strokes("shared")[0]!.points[0]!.x).toBe(10);
		h.b.controller.idle = true; h.queued.mockRestore(); await h.tick();
		expect(h.b.controller.painted).toEqual([400]);
	});

	it.each(["close", "disconnect", "rebind"])("does not adopt an orphan after all panes %s during stat", async action => {
		const h = await harness(); const held = holdStat(h);
		h.external("shared", [stroke(400)]); h.fire();
		for (const pane of [h.a, h.b]) {
			if (action === "close") h.host.pdfInk.delete(pane.root);
			else if (action === "disconnect") pane.root.isConnected = false;
			else h.host.pdfIds.set(pane.root, "other");
		}
		held.release(); await h.settle();
		expect(h.reload).not.toHaveBeenCalled();
		expect(h.a.controller.refresh).not.toHaveBeenCalled(); expect(h.b.controller.refresh).not.toHaveBeenCalled();
	});

	it.each(["close", "rebind", "replace"])("refreshes current bindings when a sibling is subject to %s during stat", async action => {
		const h = await harness(); const held = holdStat(h);
		h.external("shared", [stroke(400)]); h.fire();
		let replacement: ReturnType<Harness["pane"]> | undefined;
		if (action === "close") h.host.pdfInk.delete(h.a.root);
		else if (action === "rebind") h.host.pdfIds.set(h.a.root, "other");
		else replacement = h.pane("shared", h.a.root);
		held.release(); await h.settle();
		expect(h.a.controller.refresh).not.toHaveBeenCalled();
		expect(h.b.controller.painted).toEqual([400]);
		if (replacement) expect(replacement.controller.painted).toEqual([400]);
		expect(h.reload.mock.calls).toEqual([["shared"]]);
	});

	it.each(["stat", "reload"])("requalifies a matching pane that joins during awaited %s", async phase => {
		const h = await harness();
		let held;
		if (phase === "stat") { held = holdStat(h); h.external("shared", [stroke(400)]); h.fire(); }
		else held = await heldReload(h);
		const joined = h.pane("shared");
		held.release(); await h.settle();
		if (phase === "stat") {
			expect(joined.controller.painted).toEqual([400]);
			expect(joined.controller.refresh).toHaveBeenCalledTimes(1);
			expect(h.reload.mock.calls).toEqual([["shared"]]);
		} else {
			// Joining after the adoption captured its controller set holds the
			// whole swap. The unchanged incoming revision retries next tick.
			expect(joined.controller.painted).toEqual([10]);
			expect(joined.controller.refresh).not.toHaveBeenCalled();
			await h.tick();
			expect(joined.controller.painted).toEqual([400]);
			expect(h.reload.mock.calls).toEqual([["shared"], ["shared"]]);
		}
	});

	it.each(["close", "disconnect", "rebind", "replace"])("holds when a pane undergoes %s during preservation", async action => {
		const h = await harness(); const held = await heldReload(h);
		let replacement: ReturnType<Harness["pane"]> | undefined;
		if (action === "close") h.host.pdfInk.delete(h.a.root);
		else if (action === "disconnect") h.a.root.isConnected = false;
		else if (action === "rebind") h.host.pdfIds.set(h.a.root, "other");
		else replacement = h.pane("shared", h.a.root);
		held.release(); await h.settle();
		expect(h.a.controller.refresh).not.toHaveBeenCalled();
		expect(h.b.controller.painted).toEqual([10]);
		if (replacement) expect(replacement.controller.painted).toEqual([10]);
		expect(h.pdfStore.strokes("shared")[0]!.points[0]!.x).toBe(10);
		await h.tick();
		expect(h.b.controller.painted).toEqual([400]);
		if (replacement) expect(replacement.controller.painted).toEqual([400]);
		expect(h.reload.mock.calls).toEqual([["shared"], ["shared"]]);
	});

	it("rechecks each sibling immediately before refresh and defers one made busy by the first repaint", async () => {
		const h = await harness();
		const repaint = h.a.controller.refresh.getMockImplementation()!;
		h.a.controller.refresh.mockImplementationOnce(() => { repaint(); h.b.controller.idle = false; });
		h.external("shared", [stroke(400)]); await h.tick();
		expect(h.a.controller.painted).toEqual([400]);
		expect(h.b.controller.refresh).not.toHaveBeenCalled();
		h.b.controller.idle = true; await h.tick();
		expect(h.b.controller.painted).toEqual([400]);
		expect(h.b.controller.refresh).toHaveBeenCalledTimes(1);
	});
	it("rechecks a busy new controller replacing the captured one during stat", async () => {
		const h = await harness(); const held = holdStat(h);
		h.external("shared", [stroke(400)]); h.fire();
		const replacement = h.pane("shared", h.a.root); replacement.controller.idle = false;
		held.release(); await h.settle();
		expect(h.reload).not.toHaveBeenCalled();
		replacement.controller.idle = true; await h.tick();
		expect(replacement.controller.painted).toEqual([400]);
		expect(h.a.controller.refresh).not.toHaveBeenCalled();
	});

	it("holds for a pane made busy during preservation, then retries the incoming revision", async () => {
		const h = await harness(); const held = await heldReload(h);
		h.b.controller.idle = false; held.release(); await h.settle();
		expect(h.pdfStore.strokes("shared")[0]!.points[0]!.x).toBe(10);
		expect(h.a.controller.painted).toEqual([10]);
		expect(h.b.controller.refresh).not.toHaveBeenCalled();
		expect(await h.originalCheck("shared")).toBe(true);
		await h.tick(); expect(h.b.controller.refresh).not.toHaveBeenCalled();
		h.b.controller.idle = true; await h.tick();
		expect(h.a.controller.painted).toEqual([400]);
		expect(h.b.controller.painted).toEqual([400]);
		expect(h.b.controller.refresh).toHaveBeenCalledTimes(1);
		expect(h.reload).toHaveBeenCalledTimes(2);
	});

	it.each(["close", "disconnect", "rebind", "replace"])("discards deferred work after %s without repainting the stale controller", async action => {
		const h = await harness(); const held = await heldReload(h);
		h.b.controller.idle = false; held.release(); await h.settle();
		if (action === "close") h.host.pdfInk.delete(h.b.root);
		else if (action === "disconnect") h.b.root.isConnected = false;
		else if (action === "rebind") h.host.pdfIds.set(h.b.root, "other");
		else h.pane("shared", h.b.root);
		h.b.controller.idle = true; await h.tick(); await h.tick();
		expect(h.b.controller.refresh).not.toHaveBeenCalled();
		expect(h.reload).toHaveBeenCalledTimes(2);
	});

	it("retains only a failed pane and preserves siblings, later documents and other surfaces", async () => {
		const h = await harness(); const error = new Error("paint failed");
		h.a.controller.refresh.mockImplementationOnce(() => { throw error; });
		h.external("shared", [stroke(400)]); h.external("other", [stroke(900)]); h.surfaces.changed = true;
		await h.tick();
		expect(h.b.controller.painted).toEqual([400]); expect(h.other.controller.painted).toEqual([900]);
		expect(h.events).toContain("paint:note"); expect(h.events).toContain("paint:slides");
		expect(h.errors).toHaveLength(1); expect(h.errors[0]![0]).toMatch(/PDF shared/); expect(h.errors[0]![1]).toBe(error);
		h.surfaces.changed = false; await h.tick(); await h.tick();
		expect(h.a.controller.painted).toEqual([400]); expect(h.a.controller.refresh).toHaveBeenCalledTimes(2);
		expect(h.b.controller.refresh).toHaveBeenCalledTimes(1);
	});

	it("keeps held adoption retryable across backoff and resets after acceptance", async () => {
		const h = await harness(); const held = await heldReload(h);
		h.b.controller.idle = false; held.release(); await h.settle();
		for (let i = 0; i < 5; i++) await h.tick();
		const checks = h.check.mock.calls.length;
		h.b.controller.idle = true;
		await h.tick(); // This tick can be spaced; no I/O is manufactured.
		expect(h.check.mock.calls.length).toBeGreaterThanOrEqual(checks);
		for (let i = 0; i < 8 && h.b.controller.painted[0] !== 400; i++) await h.tick();
		expect(h.b.controller.painted).toEqual([400]);
		expect(h.b.controller.refresh).toHaveBeenCalledTimes(1);
	});

	it("does not drain while hidden or while a poll is in flight", async () => {
		const h = await harness(); const held = await heldReload(h);
		h.b.controller.idle = false; held.release(); await h.settle();
		h.document.hidden = true; h.b.controller.idle = true; await h.tick();
		expect(h.b.controller.refresh).not.toHaveBeenCalled();
		h.document.hidden = false; h.b.controller.idle = false;
		const stat = holdStat(h); h.fire(); h.b.controller.idle = true; h.fire();
		expect(h.b.controller.refresh).not.toHaveBeenCalled();
		stat.release(); await h.settle(); await h.tick();
		expect(h.b.controller.refresh).toHaveBeenCalledTimes(1);
	});

	it("contains a deferred pane's throwing idle getter once per tick and keeps later surfaces moving", async () => {
		const h = await harness();
		h.a.controller.refresh.mockImplementationOnce(() => { throw new Error("initial paint failure"); });
		h.external("shared", [stroke(400)]); await h.tick();
		const error = new Error("idle getter failed");
		const idle = vi.fn(() => { throw error; });
		Object.defineProperty(h.a.controller, "idle", { configurable: true, get: idle });
		h.surfaces.changed = true;
		for (let tick = 0; tick < 2; tick++) {
			h.external("other", [stroke(900 + tick)]);
			h.events.length = 0;
			expect(() => h.fire()).not.toThrow(); await h.settle();
			expect(h.other.controller.painted).toEqual([900 + tick]);
			expect(h.events).toContain("paint:note"); expect(h.events).toContain("paint:slides");
			expect(idle).toHaveBeenCalledTimes(tick + 1);
		}
		expect(h.errors).toHaveLength(3);
		expect(h.errors.slice(1).every(report => report[1] === error)).toBe(true);
		expect(h.detachedErrors).toEqual([]);
		Object.defineProperty(h.a.controller, "idle", { configurable: true, value: true, writable: true });
		await h.tick();
		expect(h.a.controller.painted).toEqual([400]);
		expect(h.a.controller.refresh).toHaveBeenCalledTimes(2);
	});
	it("repaints a successful debt retry again when the same tick adopts a newer revision", async () => {
		const h = await harness();
		h.a.controller.refresh.mockImplementationOnce(() => { throw new Error("one failure"); });
		h.external("shared", [stroke(400)]); await h.tick();
		h.external("shared", [stroke(500)]); await h.tick();
		expect(h.a.controller.painted).toEqual([500]);
		expect(h.a.controller.refresh).toHaveBeenCalledTimes(3);
		expect(h.b.controller.painted).toEqual([500]);
		expect(h.errors).toHaveLength(1);
	});
	it("attempts a persistently failing pane at most once per visible tick, including fresh adoption", async () => {
		const h = await harness(); h.a.controller.refresh.mockImplementation(() => { throw new Error("persistent"); });
		h.external("shared", [stroke(400)]); await h.tick();
		h.external("shared", [stroke(500)]); await h.tick();
		expect(h.a.controller.refresh).toHaveBeenCalledTimes(2);
		expect(h.b.controller.painted).toEqual([500]);
		expect(h.errors).toHaveLength(2);
	});
});
