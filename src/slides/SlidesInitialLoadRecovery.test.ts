import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { SlidesDeck, sectionHash, settleSlidesInk, slidesSidecarId, type SlidesInkHost } from "./SlidesInkSurface";

const ID = slidesSidecarId("note-1");
const LIVE = `.handwriting/${ID}.json`;
const SOURCE = "slide 0\n\n---\n\nslide 1";
const NOTICE = "Handwriting: this presentation's ink could not be saved.";
const NOW = 5_000_000;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = async (value: string): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
		byte => byte.toString(16).padStart(2, "0")).join("");

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function oldStroke(id: string, page: number): InkStroke {
	const points = [{ x: 10, y: 15, pressure: 0.4, t: 0 }, { x: 40, y: 35, pressure: 0.7, t: 12 }];
	return { id, page, tool: page === 1 ? "pen" : "highlighter", color: "#123456", width: 2,
		points, bbox: computeBBox(points, 4), createdAt: 1234, widthMode: "uniform",
		pressureProfile: "exp7", pressureSensitivity: "on" };
}

function seed(strokes = [oldStroke("old0", 1), oldStroke("old1", 2)]): PageData {
	return { ...emptyPage(ID), surface: "slides", coordSpace: "slide-logical",
		deck: { width: 960, height: 700 },
		slides: [0, 1].map(index => ({ index, hash: sectionHash(`slide ${index}`) })),
		unknownTop: { retained: { value: "keep", revision: 7 } }, strokes };
}

type Call = { name: string; args: unknown[] };
class RecordingEl extends FakeEl {
	readonly trace: Call[] = [];
	private context?: CanvasRenderingContext2D;
	createEl(tag: string, opts: Parameters<FakeEl["createEl"]>[1] = {}): FakeEl {
		// Slides mounts through Obsidian's element helper, not document.createElement.
		const element = new RecordingEl(tag, this.ownerDocument, opts);
		(this.ownerDocument as RecordingDoc).created.push(element);
		this.appendChild(element);
		return element;
	}
	getContext(): CanvasRenderingContext2D {
		if (!this.context) {
			const values: Record<string, unknown> = {};
			this.context = new Proxy(values, {
				get: (_target, key) => {
					if (key === "getContextAttributes") return () => ({ desynchronized: false });
					if (typeof key === "string" && key in values) return values[key];
					return (...args: unknown[]) => {
						this.trace.push({ name: String(key), args: args.map(v => v instanceof FakeEl ? "canvas" : v) });
					};
				},
				set: (_target, key, value) => {
					values[String(key)] = value;
					this.trace.push({ name: `set:${String(key)}`, args: [value] });
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		}
		return this.context;
	}
}
class RecordingDoc extends FakeDoc {
	readonly created: RecordingEl[] = [];
	createElement(tag: string): FakeEl {
		const element = new RecordingEl(tag, this);
		this.created.push(element);
		return element;
	}
}
class ReadAdapter extends FakeAdapter {
	failLiveReads = 0;
	async read(path: string): Promise<string> {
		if (path === LIVE && this.failLiveReads > 0) {
			this.failLiveReads--;
			throw new Error("D7 transient sidecar read");
		}
		return super.read(path);
	}
}

type Options = { bytes?: string | null; unclaimed?: boolean; rejectSidecar?: boolean; rejectSave?: boolean; transient?: boolean };
const rigs: Rig[] = [];
type Rig = ReturnType<typeof makeRig>;
function mount(options: Options = {}): Rig {
	const rig = makeRig(options);
	rigs.push(rig);
	return rig;
}
function makeRig(options: Options) {
	let uuid = 0;
	vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
		`00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` as ReturnType<Crypto["randomUUID"]>);
	const fake = new ReadAdapter();
	fake.dirs.add(".handwriting");
	const bytes = options.bytes === undefined ? serializePage(seed()) : options.bytes;
	if (bytes !== null) fake.externalWrite(LIVE, bytes);
	fake.failLiveReads = options.transient ? 1 : 0;
	fake.log.length = 0;
	const original = [...fake.files.entries()];
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => NOW);
	const doc = new RecordingDoc();
	const container = new RecordingEl("div", doc);
	const reveal = new RecordingEl("div", doc);
	const slides = new RecordingEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000; reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960; slides.clientHeight = 700;
	for (let i = 0; i < 2; i++) {
		const section = new RecordingEl("section", doc);
		section.textContent = `slide ${i}`;
		if (i === 0) section.classes.add("present");
		slides.children.push(section);
	}
	container.querySelector = sel => sel === ".reveal" ? reveal : null;
	reveal.querySelector = sel => sel === ".slides" ? slides : null;
	(container as unknown as { isConnected: boolean }).isConnected = true;
	doc.container = container;
	const first = deferred<string>();
	const state = { failIdentity: true, sourceReads: 0, identityReads: 0, loads: 0, claims: 0,
		sourceGate: null as Promise<string> | null, releaseRetry: null as (() => void) | null,
		notices: [] as string[], noticeStatus: [] as unknown[],
		scheduled: [] as PageData[], immediate: [] as PageData[] };
	let deck!: SlidesDeck;
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: () => { state.sourceReads++; return state.sourceReads === 1 ? first.promise : state.sourceGate ?? Promise.resolve(SOURCE); },
		readPageId: () => {
			state.identityReads++;
			if (state.failIdentity) throw new Error("D7 identity sentinel");
			return options.unclaimed ? null : "note-1";
		},
		claimId: async (_path, proposed) => { state.claims++; return { pageId: proposed }; },
		newPageId: () => "note-1",
		loadSidecar: id => { state.loads++; return options.rejectSidecar ? Promise.reject(new Error("D7 inner read")) : store.load(id); },
		scheduleSidecar: (id, page) => { state.scheduled.push(copy(page)); store.schedule(id, page); },
		saveSidecarNow: async (id, page) => { state.immediate.push(copy(page)); if (options.rejectSave) throw new Error("D7 final save"); await store.saveNow(id, page); },
		hasQueuedSidecar: id => store.hasQueuedWrite(id),
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: message => { state.notices.push(message); state.noticeStatus.push(deck?.status()); },
		buildId: "d7-initial-load-recovery",
	};
	deck = new SlidesDeck(container as unknown as HTMLElement, reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement, host);
	let time = 0;
	const draw = (offset = 0) => {
		for (const [type, x, y, buttons] of [
			["pointerdown", 200 + offset, 200 + offset, 1], ["pointermove", 260 + offset, 260 + offset, 1],
			["pointermove", 300 + offset, 300 + offset, 1], ["pointerup", 300 + offset, 300 + offset, 0],
		] as const) reveal.dispatch({ type, pointerId: 1, pointerType: "pen", isPrimary: true,
			buttons, button: 0, clientX: x, clientY: y, pressure: 0.5, timeStamp: time += 20,
			preventDefault: () => {}, stopPropagation: () => {} });
		doc.flushFrames();
		expect(deck.status().pendingGesture).toBe(false);
	};
	const result = { fake, original, store, doc, container, reveal, slides, state, deck, first, draw };
	return result;
}

async function work(rig: Rig): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await Promise.all(rig.deck.inFlightWork());
		await vi.advanceTimersByTimeAsync(0);
	}
}
function unchanged(r: Rig): void {
	expect([...r.fake.files.entries()], "complete original adapter byte map").toEqual(r.original);
	expect(r.fake.log).toEqual([]);
	expect(r.state.claims).toBe(0);
}
function repaint(r: Rig): Call[][] {
	for (const element of r.doc.created) element.trace.length = 0;
	r.deck.repaintSettings(); r.doc.flushFrames();
	const traces = r.doc.created.filter(e => e.parentElement !== null && e.trace.some(c => c.name === "fill" || c.name === "stroke")).map(e => copy(e.trace));
	expect(traces.length, "attached committed canvas has actual geometry commands").toBeGreaterThan(0);
	return traces;
}
async function reference(): Promise<InkStroke[]> {
	const r = mount({ bytes: serializePage(seed([])) });
	r.state.failIdentity = false; r.first.resolve(SOURCE); await work(r);
	for (const offset of [0, 20, 40]) r.draw(offset);
	await work(r); await r.store.flush();
	const result = parsePage(r.fake.files.get(LIVE)!, ID).data.strokes;
	expect(result).toHaveLength(3);
	r.deck.dispose(); await work(r);
	return copy(result);
}
function expected(local: InkStroke[], after?: InkStroke, base = seed()): PageData {
	return { ...base, strokes: [...local, ...base.strokes.filter(s => s.page === 1),
		...(after ? [after] : []), ...base.strokes.filter(s => s.page !== 1)] };
}
async function durable(r: Rig, page: PageData, label: string): Promise<void> {
	await work(r); await r.store.flush();
	const wanted = serializePage(page);
	const actual = r.fake.files.get(LIVE);
	console.info("D7_ORACLE", JSON.stringify({ label, expected: wanted, actual,
		expectedSha256: await hash(wanted), actualSha256: actual === undefined ? null : await hash(actual),
		carriers: await Promise.all([...r.fake.files.entries()].map(async ([path, bytes]) => ({ path, bytes, sha256: await hash(bytes) }))) }));
	expect(actual, `${label}: complete durable LIVE bytes`).toBe(wanted);
	expect(parsePage(actual!, ID).data).toEqual(parsePage(wanted, ID).data);
	expect([...r.fake.files.entries()], "complete carrier allowlist").toEqual([[LIVE, wanted]]);
	const fresh = new PageStore({ vault: { adapter: r.fake } } as never, ".handwriting", () => NOW);
	expect((await fresh.load(ID))?.data).toEqual(parsePage(wanted, ID).data);
}
async function failWithInk(): Promise<Rig> {
	const r = mount(); r.draw();
	expect(r.deck.status()).toMatchObject({ live: true, pendingGesture: false, currentCount: 1, totalCount: 1 });
	r.first.resolve(SOURCE); await work(r);
	return r;
}
beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(NOW);
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
});
afterEach(async () => {
	for (const r of rigs.splice(0)) {
		r.state.releaseRetry?.(); r.state.sourceGate = null; r.first.resolve(SOURCE); r.deck.dispose();
		await work(r); await r.store.flush();
		expect(r.deck.inFlightWork(), "disposed fixture has no pending public work").toEqual([]);
	}
	expect(await settleSlidesInk()).toBe(true);
	expect(vi.getTimerCount(), "no fixture timer survives teardown").toBe(0);
	vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("initial outer load rejection recovery", () => {
	it("D7-01 retains screen commands and original bytes; notices once with ink", async () => {
		const r = mount(); r.draw(); const before = repaint(r);
		r.first.resolve(SOURCE); await work(r);
		expect(r.state.identityReads).toBe(1); expect(r.state.loads).toBe(0);
		expect(r.deck.status()).toMatchObject({ live: true, pendingGesture: false, currentCount: 1, totalCount: 1 });
		const after = repaint(r); expect(after).toEqual(before); unchanged(r);
		console.info("D7_CANVAS", JSON.stringify({ before, after, original: r.original }));
		expect(r.state.notices.filter(n => n === NOTICE)).toEqual([NOTICE]);
	});
	it("D7-01 no-ink outer failure is silent", async () => {
		const r = mount(); r.first.resolve(SOURCE); await work(r); unchanged(r);
		expect(r.state.notices).toEqual([]); expect(r.state.sourceReads).toBe(1);
	});
	it("D7-02 next public save retries and writes complete old+A+B, then C", async () => {
		const [a, b, c] = await reference(); const r = await failWithInk(); unchanged(r);
		r.state.failIdentity = false; r.draw(20);
		await durable(r, expected([a!, b!]), "D7-02");
		expect(r.state.sourceReads).toBe(2); expect(r.state.claims).toBe(0);
		r.draw(40); await durable(r, expected([a!, b!], c!), "D7-02 next save");
	});
	it("D7-03 repeated failure remains closed, bounded, and a later save recovers", async () => {
		const [a, b, c] = await reference(); const r = await failWithInk(); r.draw(20); await work(r);
		unchanged(r); expect(r.deck.status().totalCount).toBe(2); repaint(r);
		expect(r.state.sourceReads).toBe(2); await work(r); expect(r.state.sourceReads).toBe(2);
		expect(r.state.notices.filter(n => n === NOTICE)).toEqual([NOTICE]);
		r.state.failIdentity = false; r.draw(40); await durable(r, expected([a!, b!, c!]), "D7-03");
	});
	it("D7-03 concurrent public saves share one pending retry", async () => {
		const [a, b, c] = await reference(); const r = await failWithInk();
		const gate = deferred<string>(); r.state.sourceGate = gate.promise;
		r.state.releaseRetry = () => gate.resolve(SOURCE); r.state.failIdentity = false;
		r.draw(20); r.draw(40); expect(r.state.sourceReads).toBe(2);
		expect(r.deck.inFlightWork()).toHaveLength(1);
		gate.resolve(SOURCE); await durable(r, expected([a!, b!, c!]), "D7-03 shared");
		expect(r.state.sourceReads).toBe(2);
	});
	it("D7-04 successful pending initial load remains a complete-byte control", async () => {
		const [a] = await reference(); const r = mount(); r.draw(); r.state.failIdentity = false;
		r.first.resolve(SOURCE); await durable(r, expected([a!]), "D7-04");
		expect(r.state.sourceReads).toBe(1); expect(r.state.claims).toBe(0); expect(r.state.notices).toEqual([]);
	});
	for (const action of ["clear-current", "clear-all"] as const) it(`D7-05 ${action} needs a trusted load`, async () => {
		const r = await failWithInk(); expect(r.deck.run(action)).toBe(false); unchanged(r);
		r.state.failIdentity = false; r.draw(20); await work(r); await r.store.flush();
		expect(r.deck.run(action)).toBe(true);
		await durable(r, seed(action === "clear-current" ? [oldStroke("old1", 2)] : []), `D7-05 ${action}`);
	});
	it("D7-06 dispose joins the pending initial read and writes once", async () => {
		const [a] = await reference(); const r = mount(); r.draw(); r.state.failIdentity = false;
		r.deck.dispose(); const pending = r.deck.inFlightWork(); r.first.resolve(SOURCE);
		await Promise.all(pending); expect(await settleSlidesInk()).toBe(true);
		await durable(r, expected([a!]), "D7-06");
		expect(r.state.immediate).toHaveLength(1); expect(r.state.sourceReads).toBe(1);
		expect(r.deck.status().live).toBe(false); expect(r.doc.documentListenerCount()).toBe(0);
		const writes = r.fake.writeAttempts; await work(r); expect(r.fake.writeAttempts).toBe(writes);
	});
	it("D7-07 dispose after a settled outer failure retries and saves complete old+A", async () => {
		const [a] = await reference(); const r = await failWithInk(); r.state.failIdentity = false;
		r.deck.dispose(); await Promise.all(r.deck.inFlightWork()); expect(await settleSlidesInk()).toBe(true);
		await durable(r, expected([a!]), "D7-07");
		expect(r.state.sourceReads).toBe(2); expect(r.state.immediate).toHaveLength(1);
		expect(r.deck.status().live).toBe(false);
	});
	for (const timing of ["pending", "settled"] as const) it(`D7-08 ${timing} failed teardown notices before ink clears`, async () => {
		const r = mount(); r.draw();
		if (timing === "settled") { r.first.resolve(SOURCE); await work(r); }
		r.deck.dispose(); const pending = r.deck.inFlightWork(); r.first.resolve(SOURCE);
		await Promise.all(pending); await work(r); expect(await settleSlidesInk()).toBe(true); unchanged(r);
		expect(r.state.sourceReads).toBe(timing === "pending" ? 1 : 2);
		expect(r.state.notices.filter(n => n === NOTICE)).toEqual([NOTICE]);
		const noticeIndex = r.state.notices.indexOf(NOTICE);
		expect(r.state.noticeStatus[noticeIndex]).toMatchObject({ totalCount: 1 });
		expect(r.deck.status().totalCount).toBe(0); expect(r.state.immediate).toEqual([]);
		await work(r); expect(r.state.sourceReads).toBe(timing === "pending" ? 1 : 2);
	});
	it("D7-08 final save failure notices before local ink clears", async () => {
		const r = mount({ rejectSave: true }); r.draw(); r.state.failIdentity = false;
		r.deck.dispose(); const pending = r.deck.inFlightWork(); r.first.resolve(SOURCE);
		await Promise.all(pending); await work(r); expect(await settleSlidesInk()).toBe(true);
		unchanged(r); expect(r.state.immediate).toHaveLength(1);
		expect(r.state.notices.filter(n => n === NOTICE)).toEqual([NOTICE]);
		expect(r.state.noticeStatus[r.state.notices.indexOf(NOTICE)]).toMatchObject({ totalCount: 3 });
		expect(r.deck.status().totalCount).toBe(0); expect(r.state.sourceReads).toBe(1);
	});
	it("D7-09 rejected readSource remains an inner by-index success control", async () => {
		const [a] = await reference(); const r = mount(); r.draw(); r.state.failIdentity = false;
		r.first.reject(new Error("D7 source read")); await durable(r, expected([a!]), "D7-09");
		expect(r.state.notices).not.toContain(NOTICE); expect(r.state.sourceReads).toBe(1);
	});
	it("D7-10 rejected sidecar host remains locked with original bytes", async () => {
		const r = mount({ rejectSidecar: true }); r.draw(); r.state.failIdentity = false;
		r.first.resolve(SOURCE); await work(r); r.draw(20); await work(r); unchanged(r);
		expect(r.state.sourceReads).toBe(1); expect(r.state.notices).not.toContain(NOTICE);
		expect(r.deck.status().mutable).toBe(false);
	});
	for (const unclaimed of [false, true]) it(`D7-11 valid empty base unclaimed=${unclaimed}`, async () => {
		const [a] = await reference(); const r = mount({ bytes: null, unclaimed }); r.draw();
		r.state.failIdentity = false; r.first.resolve(SOURCE);
		const blank = seed([]); blank.unknownTop = {};
		await durable(r, expected([a!], undefined, blank), `D7-11 ${unclaimed}`);
		expect(r.state.claims).toBe(unclaimed ? 1 : 0); expect(r.state.notices).not.toContain(NOTICE);
	});
	for (const mode of ["malformed", "future"] as const) it(`D7-12 ${mode} retains bytes and locks`, async () => {
		const bytes = mode === "malformed" ? "{broken" : JSON.stringify({ ...JSON.parse(serializePage(seed())), schemaVersion: 3 });
		const r = mount({ bytes }); r.draw(); r.state.failIdentity = false; r.first.resolve(SOURCE);
		await work(r); r.draw(20); await work(r); unchanged(r);
		expect(r.deck.status().mutable).toBe(false); expect(r.state.sourceReads).toBe(1);
		expect(r.state.notices.length).toBeGreaterThan(0); expect(r.state.notices).not.toContain(NOTICE);
		if (mode === "future") { expect(r.deck.status().totalCount).toBe(4); repaint(r); }
	});
	it("D7-13 transient sidecar read retains existing public poll recovery", async () => {
		const [a] = await reference(); const r = mount({ transient: true }); r.draw();
		r.state.failIdentity = false; r.first.resolve(SOURCE); await work(r); unchanged(r);
		const candidate = r.deck.reloadCandidateSidecarId(); expect(candidate).toBe(ID);
		expect(await r.store.externallyChanged(ID)).toBe(true);
		expect(r.deck.reloadCandidateSidecarId()).toBe(candidate); expect(r.store.hasQueuedWrite(ID)).toBe(false);
		await r.deck.reloadExternal(ID); await durable(r, expected([a!]), "D7-13");
		expect(r.state.sourceReads).toBe(1); expect(r.state.notices).not.toContain(NOTICE);
	});
	it("trusted-load guard retains the existing note-mismatch path", async () => {
		const r = mount(); r.draw(); r.state.failIdentity = false; r.first.resolve("another deck"); await work(r);
		r.draw(20); await work(r); unchanged(r); expect(r.deck.status().mutable).toBe(false);
		expect(r.state.identityReads).toBe(0); expect(r.state.sourceReads).toBe(1);
	});
});
