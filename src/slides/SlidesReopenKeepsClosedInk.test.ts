/**
 * A presentation closed and opened again while its Slides ink file is still being read keeps the ink drawn before
 * the close.
 *
 * The closed deck parks its stroke behind its first read and writes it once the read lands (a teardown drain). The
 * reopened deck read the file before that write, so its lists never held that stroke, and its next save wrote over
 * it. The reopened deck must take the closed deck's ink into its own lists and save it with its own.
 *
 * Rig: the real controller (setSlidesInk, the body observer's scan, the one live deck), a real PageStore over
 * FakeAdapter with one "slides" writer for every deck, as the plugin makes it, and a note with an id whose stored
 * page holds one stroke X. A held read asks the store at the call, as a slow disk read starts at the call, and hands
 * the answer to the deck only when the test lets it go. Close and reopen: the old container leaves the body and a
 * new one arrives, then the body observer scans.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore, newPageWriter, type LoadResult } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import {
	activeSlidesActions,
	reloadSlidesExternal,
	sectionHash,
	setSlidesInk,
	settleSlidesInk,
	slidesSidecarId,
	type SlidesDeck,
	type SlidesInkHost,
} from "./SlidesInkSurface";
import { pageOfSlide } from "./SlidesSections";

const NOW = 5_000_000;
const DECK = "Deck.md";
const OTHER = "Other.md";
const ID = slidesSidecarId("note-1");
const OTHER_ID = slidesSidecarId("note-2");
const fileOf = (id: string): string => `.handwriting/${id}.json`;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

/**
 * A stored stroke on slide 0, at slide-logical 40..120 x 40..100 (screen 40..80 x 45..75): away from the pen's path,
 * under the eraser's. `dx` moves it right in slide-logical units: 600 puts it at screen 340..380, away from both.
 */
function storedStroke(id: string, dx = 0): InkStroke {
	const points = [{ x: 40 + dx, y: 40, pressure: 0.5, t: 0 }, { x: 80 + dx, y: 70, pressure: 0.5, t: 10 },
		{ x: 120 + dx, y: 100, pressure: 0.5, t: 20 }];
	return { id, page: pageOfSlide(0), tool: "pen", color: "#123456", width: 2, points, bbox: computeBBox(points, 2),
		createdAt: 1000, widthMode: "uniform", pressureProfile: "exp7", pressureSensitivity: "on" };
}

function storedPage(id: string, strokes: InkStroke[], slides = ["slide 0"]): PageData {
	return { ...emptyPage(id), surface: "slides", coordSpace: "slide-logical", deck: { width: 960, height: 700 },
		slides: slides.map((text, index) => ({ index, hash: sectionHash(text) })), strokes };
}

type Read = { id: string; answer: Promise<LoadResult | null>; gate: ReturnType<typeof deferred<void>> };
type Opened = { deck: SlidesDeck; reveal: FakeEl; container: FakeEl };

function makeRig(options: { noteIds?: Record<string, string | null>; files?: Record<string, PageData> } = {}) {
	const fake = new FakeAdapter();
	fake.dirs.add(".handwriting");
	const files = options.files ?? { [ID]: storedPage(ID, [storedStroke("x")]) };
	for (const [id, page] of Object.entries(files)) fake.externalWrite(fileOf(id), serializePage(page));
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => NOW);
	const writer = newPageWriter("slides");
	const doc = new FakeDoc();
	const scans: Array<() => void> = [];
	vi.stubGlobal("MutationObserver", class {
		constructor(cb: () => void) { scans.push(cb); }
		observe(): void {}
		disconnect(): void {}
	});
	vi.stubGlobal("activeDocument", doc);
	const noteIds: Record<string, string | null> = { [DECK]: "note-1", [OTHER]: "note-2", ...(options.noteIds ?? {}) };
	const state = {
		path: DECK,
		hold: true,
		reads: [] as Read[],
		loads: 0,
		scheduled: [] as PageData[],
		immediate: [] as PageData[],
		queuedAsks: 0,
		claims: 0,
		claimGates: [] as Array<ReturnType<typeof deferred<void>>>,
		claimedIds: {} as Record<string, string>,
		mints: ["note-a", "note-b", "note-c"],
		/** The note's text: its sections, split on `---`, are matched against the deck's. */
		source: "slide 0",
		/** saveSidecarNow calls still to refuse, each before the store sees the page. */
		refuseImmediate: 0,
		conflicts: [] as string[],
	};
	store.onConflict = (_pageId, keptAs) => { state.conflicts.push(keptAs); };
	let claimChain: Promise<void> = Promise.resolve();
	const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const host: SlidesInkHost = {
		documents: () => [doc as unknown as Document],
		activeFilePath: () => state.path,
		readSource: async () => state.source,
		readPageId: (path) => noteIds[path] ?? null,
		// vault.process runs one claim on a note after another; claimMarkdown keeps an id already in the text.
		claimId: async (path, proposed) => {
			const gate = deferred<void>();
			state.claimGates.push(gate);
			state.claims++;
			const before = claimChain;
			let done!: () => void;
			claimChain = new Promise<void>((r) => { done = r; });
			await before;
			await gate.promise;
			state.claimedIds[path] ??= proposed;
			done();
			return { pageId: state.claimedIds[path]! };
		},
		newPageId: () => state.mints.shift() ?? "note-z",
		loadSidecar: (id) => {
			state.loads++;
			const answer = store.load(id);
			if (!state.hold) return answer;
			const gate = deferred<void>();
			state.reads.push({ id, answer, gate });
			return gate.promise.then(() => answer);
		},
		scheduleSidecar: (id, page) => { state.scheduled.push(copy(page)); store.schedule(id, page, writer); },
		hasQueuedSidecar: (id) => { state.queuedAsks++; return store.hasQueuedWrite(id); },
		saveSidecarNow: async (id, page) => {
			state.immediate.push(copy(page));
			if (state.refuseImmediate > 0) {
				state.refuseImmediate--;
				throw new Error("the write was refused");
			}
			await store.saveNow(id, page, writer);
		},
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "slides-reopen-keeps-closed-ink",
	};
	setSlidesInk(true, host);
	let current: Opened | null = null;
	let time = 0;
	const pointer = (reveal: FakeEl, type: string, x: number, y: number, buttons: number): void => {
		reveal.dispatch({ type, pointerId: 1, pointerType: "pen", isPrimary: true, buttons, button: 0,
			clientX: x, clientY: y, pressure: 0.5, timeStamp: (time += 20),
			preventDefault: () => undefined, stopPropagation: () => undefined });
	};
	const rig = {
		fake, store, doc, state,
		/**
		 * Close the open presentation, if any, and open it again: the body observer's scan disposes and builds. The deck
		 * shows `sections` (the note's text must match them, `state.source`) with `present` on screen.
		 */
		async open(o: { sections?: string[]; present?: number } = {}): Promise<Opened> {
			if (current) (current.container as unknown as { isConnected: boolean }).isConnected = false;
			const container = new FakeEl("div", doc);
			const reveal = new FakeEl("div", doc);
			const slides = new FakeEl("div", doc);
			reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
			reveal.clientWidth = 1000; reveal.clientHeight = 800;
			slides.rect = { left: 20, top: 25, width: 480, height: 350 };
			slides.clientWidth = 960; slides.clientHeight = 700;
			(o.sections ?? ["slide 0"]).forEach((text, i) => {
				const section = new FakeEl("section", doc);
				section.textContent = text;
				if (i === (o.present ?? 0)) section.classes.add("present");
				slides.children.push(section);
			});
			(container as unknown as { querySelector: (s: string) => FakeEl | null }).querySelector = (s) => s === ".reveal" ? reveal : null;
			(reveal as unknown as { querySelector: (s: string) => FakeEl | null }).querySelector = (s) => s === ".slides" ? slides : null;
			doc.container = container;
			for (const scan of scans) scan();
			const deck = activeSlidesActions(doc as unknown as Document) as unknown as SlidesDeck | null;
			expect(deck, "the scan built a live deck").not.toBeNull();
			current = { deck: deck!, reveal, container };
			await rig.settle();
			doc.flushFrames();
			return current;
		},
		/** One whole pen stroke, down to up, on the given deck; returns the new stroke's id. */
		draw(o: Opened, offset = 0): string {
			const before = new Set(rig.ids(o.deck));
			rig.down(o, offset);
			rig.up(o, offset);
			const added = rig.ids(o.deck).filter((id) => !before.has(id));
			expect(added, "the stroke committed on the deck").toHaveLength(1);
			return added[0]!;
		},
		down(o: Opened, offset = 0): void {
			pointer(o.reveal, "pointerdown", 200 + offset, 200 + offset, 1);
			pointer(o.reveal, "pointermove", 250 + offset, 250 + offset, 1);
			pointer(o.reveal, "pointermove", 300 + offset, 300 + offset, 1);
			doc.flushFrames();
		},
		/** One more sample of the pen already down. */
		move(o: Opened, x: number, y: number): void {
			pointer(o.reveal, "pointermove", x, y, 1);
			doc.flushFrames();
		},
		up(o: Opened, offset = 0): void {
			pointer(o.reveal, "pointerup", 300 + offset, 300 + offset, 0);
			doc.flushFrames();
			expect(o.deck.status().pendingGesture, "the stroke ended").toBe(false);
		},
		/** The eraser end dragged across the stored stroke's screen box. */
		erase(o: Opened): void {
			rig.eraseDown(o);
			rig.eraseUp(o);
		},
		/** The eraser end down and moving on the stored stroke's screen box; not yet lifted. */
		eraseDown(o: Opened): void {
			pointer(o.reveal, "pointerdown", 40, 45, 32);
			pointer(o.reveal, "pointermove", 60, 60, 32);
			doc.flushFrames();
		},
		eraseUp(o: Opened): void {
			pointer(o.reveal, "pointermove", 80, 75, 32);
			pointer(o.reveal, "pointerup", 80, 75, 0);
			doc.flushFrames();
		},
		ids(deck: SlidesDeck): string[] {
			return [...deck.strokes.values()].flat().map((s) => s.id);
		},
		strokes(deck: SlidesDeck): InkStroke[] {
			return [...deck.strokes.values()].flat();
		},
		/** Let the read the deck made n-th (0 first) answer. */
		async release(n: number): Promise<void> {
			const read = state.reads[n];
			expect(read, `read ${n} was made`).toBeDefined();
			read!.gate.resolve();
			await rig.settle();
		},
		async settle(): Promise<void> {
			for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
		},
		/** The page on disk after every queued save has been written. */
		async file(id = ID): Promise<PageData> {
			await rig.settle();
			await store.flush();
			const bytes = fake.files.get(fileOf(id));
			expect(bytes, `${fileOf(id)} exists`).toBeDefined();
			return parsePage(bytes!, id).data;
		},
		fileIds: async (id = ID): Promise<string[]> => (await rig.file(id)).strokes.map((s) => s.id),
	};
	return rig;
}
type Rig = ReturnType<typeof makeRig>;

/**
 * Deck 1 opens on the note, its first read held; stroke A is drawn and parks behind that read; the presentation is
 * closed and opened again at once. Deck 2's own first read is held too. Each step's precondition is its own assert.
 */
async function closeAndReopenInsideTheRead(r: Rig): Promise<{ d1: Opened; d2: Opened; a: string }> {
	const d1 = await r.open();
	expect(r.state.reads.map((x) => x.id), "deck 1's first read is held").toEqual([ID]);
	const a = r.draw(d1);
	expect(d1.deck.saveAfterLoad, "A waits behind deck 1's read").toBe(true);
	const d2 = await r.open();
	expect(d1.deck.disposed, "deck 1 is closed").toBe(true);
	expect(d1.deck.teardownDrain, "deck 1's write is parked in a drain").not.toBeNull();
	expect(d2.deck).not.toBe(d1.deck);
	expect(r.state.reads.map((x) => x.id), "deck 2's first read is held too").toEqual([ID, ID]);
	const seen = (await r.state.reads[1]!.answer)?.data.strokes.map((s) => s.id);
	expect(seen, "deck 2's read was made before deck 1's write: it holds X only").toEqual(["x"]);
	return { d1, d2, a };
}

/**
 * Deck 1's held read (the n-th read made) lands and its drain writes. The drain itself is awaited, not
 * settleSlidesInk: that also waits on the live deck's own read, which a cell may still hold.
 */
async function drainLands(r: Rig, d1: Opened, wrote: string[], n = 0): Promise<void> {
	const drain = d1.deck.teardownDrain;
	expect(drain, "deck 1's drain is alive").not.toBeNull();
	await r.release(n);
	await drain;
	await r.settle();
	expect(d1.deck.teardownDrain, "deck 1's drain is over").toBeNull();
	const last = r.state.immediate.at(-1);
	expect(last?.strokes.map((s) => s.id), `the drain wrote ${wrote.join(", ")}`).toEqual(expect.arrayContaining(wrote));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubGlobal("window", globalThis);
	vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(async () => {
	setSlidesInk(false);
	for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
	expect(await settleSlidesInk(), "no drain survives the cell").toBe(true);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("a deck reopened during a slow ink read keeps the closed deck's ink", () => {
	it("S1 deck 2's read lands first, then deck 1's: deck 2's next save keeps A, and its lists hold A", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		expect(d2.deck.loaded, "deck 2 loaded").toBe(true);
		await drainLands(r, d1, ["x", a]);
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b]));
		expect(r.ids(d2.deck), "deck 2's own lists hold A").toContain(a);
	});

	it("S2 deck 1's read and its write land before deck 2's read: deck 2's next save keeps A", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await drainLands(r, d1, ["x", a]);
		expect(d2.deck.loaded, "deck 2 still reading").toBe(false);
		await r.release(1);
		expect(d2.deck.loaded, "deck 2 loaded").toBe(true);
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		const copies = [...r.fake.files.keys()].filter((path) => path.startsWith(`.handwriting/${ID}.conflict-`));
		expect(copies, "no conflict copy: deck 2's read was stamped before the drain's write").toEqual([]);
		expect(r.state.conflicts, "no conflict notice").toEqual([]);
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b]));
		expect(r.ids(d2.deck)).toContain(a);
	});

	it("S2b deck 2's file read is stuck past deck 1's write: the store keeps a conflict copy, and deck 2's next save keeps A", async () => {
		const r = makeRig();
		const d1 = await r.open();
		expect(r.state.reads.map((x) => x.id), "deck 1's first read is held").toEqual([ID]);
		const a = r.draw(d1);
		expect(d1.deck.saveAfterLoad, "A waits behind deck 1's read").toBe(true);
		// The next read of the file is stuck: it reads the bytes at the call and answers only when let go.
		const stuck = deferred<void>();
		let armed = true;
		const read = r.fake.read.bind(r.fake);
		r.fake.read = async (path: string): Promise<string> => {
			if (!armed || path !== fileOf(ID)) return read(path);
			armed = false;
			const bytes = await read(path);
			await stuck.promise;
			return bytes;
		};
		const d2 = await r.open();
		expect(d1.deck.disposed, "deck 1 is closed").toBe(true);
		expect(d1.deck.teardownDrain, "deck 1's write is parked in a drain").not.toBeNull();
		expect(r.state.reads.map((x) => x.id), "deck 2's first read is held").toEqual([ID, ID]);
		expect(armed, "deck 2's read is stuck inside the file read").toBe(false);
		await drainLands(r, d1, ["x", a]);
		expect(parsePage(r.fake.files.get(fileOf(ID))!, ID).data.strokes.map((s) => s.id).sort(), "the drain wrote X and A").toEqual(["x", a].sort());
		stuck.resolve();
		await r.settle();
		await r.release(1);
		expect(d2.deck.loaded, "deck 2 loaded").toBe(true);
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		const copies = [...r.fake.files.keys()].filter((path) => path.startsWith(`.handwriting/${ID}.conflict-`));
		expect(copies.map((path) => parsePage(r.fake.files.get(path)!, ID).data.strokes.map((s) => s.id)), "the store guard set the drain's page aside: one conflict copy, holding X and A").toEqual([expect.arrayContaining(["x", a])]);
		expect(r.state.conflicts, "the conflict copy was announced").toEqual(copies);
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b]));
		expect(r.ids(d2.deck), "deck 2's own lists hold A").toContain(a);
	});

	it("S3 a stroke B0 on deck 2 while its own read is held: the last page holds X, A, B0 and B", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		const b0 = r.draw(d2, 40);
		expect(d2.deck.saveAfterLoad, "B0 waits behind deck 2's read").toBe(true);
		await r.release(1);
		expect(r.state.scheduled.at(-1)?.strokes.map((s) => s.id), "deck 2's flush wrote B0").toContain(b0);
		await drainLands(r, d1, ["x", a]);
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b0, b]));
	});

	it("S4 deck 1's read held past any wait; deck 2 draws B first: after deck 2's next save the page holds X, A and B", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		const b = r.draw(d2, 20);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await r.fileIds(), "B saved before deck 1's read lands").toEqual(["x", b]);
		await drainLands(r, d1, ["x", a]);
		const c = r.draw(d2, 60);
		const saved = await r.fileIds();
		expect(saved, "the page after deck 2's next save holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b, c]));
	});

	it("S4b a hand-over to a deck with a save of its own saves at once: the file holds X, A and B", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		const b = r.draw(d2, 20);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await r.fileIds(), "B saved before deck 1's read lands").toEqual(["x", b]);
		await drainLands(r, d1, ["x", a]);
		const saved = await r.fileIds();
		expect(saved, "deck 2's B is still in the file").toContain(b);
		expect(saved).toEqual(expect.arrayContaining(["x", a]));
	});

	it("S5 deck 2 erases X before the drain's write reaches it: the erase stands", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		expect(r.ids(d2.deck), "deck 2 shows X").toEqual(["x"]);
		r.erase(d2);
		expect(r.ids(d2.deck), "the eraser took X").toEqual([]);
		await drainLands(r, d1, ["x", a]);
		const c = r.draw(d2, 20);
		const saved = await r.fileIds();
		expect(saved, "the erase stands").not.toContain("x");
		expect(r.ids(d2.deck), "the erase stands on screen").not.toContain("x");
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toContain(c);
	});

	it("S6 a stroke in progress on deck 2 when the drain lands ends whole, saves with A, and its undo keeps A", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		const before = new Set(r.ids(d2.deck));
		r.down(d2, 20);
		expect(d2.deck.status().pendingGesture, "the pen is down on deck 2").toBe(true);
		await drainLands(r, d1, ["x", a]);
		// One more sample after the drain landed, past every earlier one (screen 380 is slide-logical 720).
		r.move(d2, 380, 380);
		r.up(d2, 20);
		const made = r.strokes(d2.deck).filter((s) => !before.has(s.id) && s.id !== a);
		expect(made, "the stroke in progress committed once").toHaveLength(1);
		const s = made[0]!;
		const xs = s.points.map((p) => p.x);
		expect(Math.min(...xs), "the stroke starts where the pen went down (slide-logical 400)").toBeLessThanOrEqual(410);
		expect(Math.max(...xs), "the sample after the drain landed is in the same stroke").toBeGreaterThanOrEqual(710);
		const saved = await r.fileIds();
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", s.id]));
		expect(d2.deck.run("undo"), "undo ran").toBe(true);
		expect(r.ids(d2.deck), "undo of that stroke keeps A").toEqual(expect.arrayContaining(["x", a]));
		const after = await r.fileIds();
		expect(after).toContain(a);
		expect(after).not.toContain(s.id);
	});

	it("S7 with no drain alive, open, a stroke, its save and the close make today's calls; another note's drain reaches no deck", async () => {
		const r = makeRig();
		r.state.hold = false;
		const d = await r.open();
		expect(d.deck.loaded).toBe(true);
		const a = r.draw(d);
		await r.file();
		r.state.path = OTHER;
		await r.open();
		await r.settle();
		expect({ loads: r.state.loads, scheduled: r.state.scheduled.length, immediate: r.state.immediate.length,
			queuedAsks: r.state.queuedAsks }, "one deck's whole life, counted").toEqual({ loads: 2, scheduled: 1, immediate: 1, queuedAsks: 0 });
		expect(r.state.immediate[0]!.strokes.map((s) => s.id)).toEqual(["x", a]);
		setSlidesInk(false);
		await r.settle();

		const o = makeRig({ files: { [ID]: storedPage(ID, [storedStroke("x")]), [OTHER_ID]: storedPage(OTHER_ID, [storedStroke("y")]) } });
		const d1 = await o.open();
		const a1 = o.draw(d1);
		o.state.path = OTHER;
		const d2 = await o.open();
		expect(d1.deck.teardownDrain, "deck 1's drain is alive").not.toBeNull();
		await o.release(1);
		expect(d2.deck.sidecarId, "deck 2 is on the other note").toBe(OTHER_ID);
		const counts = { loads: o.state.loads, scheduled: o.state.scheduled.length };
		await drainLands(o, d1, ["x", a1]);
		expect(o.ids(d2.deck), "the drain for note-1 reached no deck on note-2").toEqual(["y"]);
		expect({ loads: o.state.loads, scheduled: o.state.scheduled.length }).toEqual(counts);
		expect(await o.fileIds(OTHER_ID), "note-2's file is unchanged").toEqual(["y"]);
	});

	it("S8 controls: a dirty deck with nothing parked, closed and reopened, shows X and A", async () => {
		const r = makeRig();
		const d1 = await r.open();
		await r.release(0);
		const a = r.draw(d1);
		const d2 = await r.open();
		expect(d1.deck.teardownDrain, "nothing parked at the close").toBeNull();
		await r.release(1);
		expect(r.ids(d2.deck)).toEqual(expect.arrayContaining(["x", a]));
		expect(await r.fileIds()).toEqual(expect.arrayContaining(["x", a]));
	});

	it("S8 controls: one deck, no reopen, saves X and A", async () => {
		const r = makeRig();
		const d = await r.open();
		await r.release(0);
		const a = r.draw(d);
		expect(await r.fileIds()).toEqual(["x", a]);
	});

	it("S8 controls: a clean deck's close writes nothing", async () => {
		const r = makeRig();
		const bytes = r.fake.files.get(fileOf(ID));
		const d = await r.open();
		await r.release(0);
		r.state.path = OTHER;
		await r.open();
		expect(d.deck.disposed).toBe(true);
		await r.settle();
		await r.store.flush();
		expect(r.state.scheduled).toEqual([]);
		expect(r.state.immediate).toEqual([]);
		expect(r.fake.files.get(fileOf(ID))).toBe(bytes);
	});

	it("S9 control: deck 1's first-stroke claim is open at the close; deck 2 claims after it and keeps A", async () => {
		const r = makeRig({ noteIds: { [DECK]: null }, files: {} });
		r.state.hold = false;
		const d1 = await r.open();
		const a = r.draw(d1);
		expect(d1.deck.claimInFlight, "deck 1's claim is open").not.toBeNull();
		const d2 = await r.open();
		expect(d1.deck.teardownDrain, "deck 1's write is parked behind its claim").not.toBeNull();
		expect(d2.deck.loaded, "deck 2 loaded with no id").toBe(true);
		const b = r.draw(d2, 20);
		expect(r.state.claims, "deck 2's claim waits behind deck 1's").toBe(2);
		// The note's writes run one after another, and deck 2's claim reads and writes the note after deck 1's claim
		// has answered: deck 1's drain, a few promise steps behind its claim, has queued its write by then.
		r.state.claimGates[0]!.resolve();
		await r.settle();
		expect(r.state.immediate.at(-1)?.strokes.map((s) => s.id), "deck 1's drain wrote A").toEqual([a]);
		expect(d2.deck.claimInFlight, "deck 2's claim is still open").not.toBeNull();
		r.state.claimGates[1]!.resolve();
		await r.settle();
		expect(await settleSlidesInk()).toBe(true);
		const id = slidesSidecarId("note-a");
		expect(d2.deck.sidecarId, "deck 2's claim answered deck 1's id").toBe(id);
		const c = r.draw(d2, 40);
		const saved = await r.fileIds(id);
		expect(saved).toEqual(expect.arrayContaining([a, b, c]));
	});

	it("S9b both claims answer in one step, deck 2's read before deck 1's write: deck 2 still keeps A", async () => {
		const r = makeRig({ noteIds: { [DECK]: null }, files: {} });
		r.state.hold = false;
		const d1 = await r.open();
		const a = r.draw(d1);
		const d2 = await r.open();
		expect(d1.deck.teardownDrain, "deck 1's write is parked behind its claim").not.toBeNull();
		const b = r.draw(d2, 20);
		expect(r.state.claims, "deck 2's claim waits behind deck 1's").toBe(2);
		const id = slidesSidecarId("note-a");
		// Deck 2's claim reads the id's file before it publishes the id: that read is held while deck 1's drain writes.
		r.state.hold = true;
		r.state.claimGates[0]!.resolve();
		r.state.claimGates[1]!.resolve();
		await r.settle();
		expect(r.state.reads.map((x) => x.id), "deck 2's claim read is held").toEqual([id]);
		expect((await r.state.reads[0]!.answer)?.data.strokes.map((s) => s.id) ?? [], "deck 2's read was made before deck 1's write").toEqual([]);
		expect(r.state.immediate.at(-1)?.strokes.map((s) => s.id), "deck 1's drain wrote A meanwhile").toEqual([a]);
		expect(d2.deck.sidecarId, "deck 2 has not published the id yet").toBeNull();
		r.state.hold = false;
		await r.release(0);
		expect(await settleSlidesInk()).toBe(true);
		expect(d2.deck.sidecarId, "deck 2's claim answered deck 1's id").toBe(id);
		const c = r.draw(d2, 40);
		const saved = await r.fileIds(id);
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining([b, c]));
		expect(r.ids(d2.deck), "deck 2's own lists hold A").toContain(a);
	});

	it("S10 deck 2 drew B0 before the hand-over; undo of B0 keeps A in its lists and in the next save", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		const b0 = r.draw(d2, 20);
		await drainLands(r, d1, ["x", a]);
		expect(d2.deck.run("undo"), "undo ran").toBe(true);
		expect(r.ids(d2.deck), "undo of B0 keeps A").toEqual(expect.arrayContaining(["x", a]));
		const saved = await r.fileIds();
		expect(saved).toContain(a);
		expect(saved).not.toContain(b0);
	});

	it("S11 deck 1 erased x and drew A inside a live reload's read, then closed: deck 2 keeps the erase and A", async () => {
		const r = makeRig({ files: { [ID]: storedPage(ID, [storedStroke("x"), storedStroke("y", 600)]) } });
		const d1 = await r.open();
		await r.release(0);
		expect(r.ids(d1.deck), "deck 1 shows x and y").toEqual(["x", "y"]);
		const reloading = reloadSlidesExternal(ID);
		await r.settle();
		expect(r.state.reads.map((x) => x.id), "deck 1's live reload read is held").toEqual([ID, ID]);
		expect(d1.deck.loadInFlight, "the reload is open").not.toBeNull();
		r.erase(d1);
		expect(r.ids(d1.deck), "the eraser took x").toEqual(["y"]);
		const a = r.draw(d1);
		expect(d1.deck.saveAfterLoad, "the erase and A wait behind the reload").toBe(true);
		const d2 = await r.open();
		expect(d1.deck.disposed, "deck 1 is closed").toBe(true);
		expect(r.state.reads.length, "deck 2's first read is held").toBe(3);
		const seen = (await r.state.reads[2]!.answer)?.data.strokes.map((s) => s.id);
		expect(seen, "deck 2's read was made before deck 1's write: x and y").toEqual(["x", "y"]);
		await r.release(2);
		expect(d2.deck.loaded, "deck 2 loaded").toBe(true);
		expect(r.ids(d2.deck), "deck 2 shows x and y").toEqual(["x", "y"]);
		r.draw(d2, 40);
		await drainLands(r, d1, ["y", a], 1);
		expect(r.state.immediate.at(-1)!.strokes.map((s) => s.id), "the drain wrote the erase: no x").not.toContain("x");
		await reloading;
		// B0's undo snapshot was taken while deck 2 still showed x.
		d2.deck.run("undo");
		expect(r.ids(d2.deck), "an undo after the hand-over does not bring x back").not.toContain("x");
		expect(r.ids(d2.deck), "and keeps A").toContain(a);
		expect(r.ids(d2.deck)).toContain("y");
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		expect(saved, "the erase deck 1 wrote stands in the file").not.toContain("x");
		expect(r.ids(d2.deck), "deck 2 no longer shows x").not.toContain("x");
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["y", b]));
	});

	it("S12 a drain with nothing new lands after deck 2 queued B: the file holds B with no further stroke", async () => {
		const r = makeRig();
		const d1 = await r.open();
		await r.release(0);
		const a0 = r.draw(d1);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await r.fileIds(), "A0's save landed").toEqual(["x", a0]);
		const reloading = reloadSlidesExternal(ID);
		await r.settle();
		expect(d1.deck.loadInFlight, "deck 1's live reload read is held").not.toBeNull();
		const d2 = await r.open();
		expect(d1.deck.teardownDrain, "deck 1 is dirty from its last save, so its close parks a drain").not.toBeNull();
		await r.release(2);
		expect(r.ids(d2.deck), "deck 2 shows x and A0").toEqual(["x", a0]);
		const b = r.draw(d2, 20);
		expect(r.store.hasQueuedWrite(ID), "B is queued, not yet written").toBe(true);
		await drainLands(r, d1, ["x", a0], 1);
		await reloading;
		const saved = await r.fileIds();
		expect(saved, "deck 2's queued B reached the file with no further stroke").toContain(b);
		expect(saved).toEqual(expect.arrayContaining(["x", a0]));
	});

	it("S13 a slide's words change between the two opens: A keeps the page the drain wrote and shows on its slide", async () => {
		const r = makeRig({ files: { [ID]: storedPage(ID, [storedStroke("x")], ["slide 0", "slide 1"]) } });
		r.state.source = "slide 0\n\n---\n\nslide 1";
		const d1 = await r.open({ sections: ["slide 0", "slide 1"], present: 1 });
		const a = r.draw(d1);
		expect(r.strokes(d1.deck).find((s) => s.id === a)?.page, "A is drawn on slide 2 (page 2)").toBe(2);
		r.state.source = "slide 0\n\n---\n\nslide 1 changed";
		const d2 = await r.open({ sections: ["slide 0", "slide 1 changed"], present: 0 });
		expect(d1.deck.teardownDrain, "deck 1's write is parked in a drain").not.toBeNull();
		await r.release(1);
		expect(d2.deck.loaded, "deck 2 loaded").toBe(true);
		expect(d2.deck.visualSlots.get(1), "deck 2 saves slide 2's new words at a new slot (page 3)").toBe(2);
		await drainLands(r, d1, ["x", a]);
		expect(r.state.immediate.at(-1)!.strokes.find((s) => s.id === a)?.page, "the drain wrote A at page 2").toBe(2);
		const b = r.draw(d2, 20);
		const file = await r.file();
		const saved = file.strokes.find((s) => s.id === a);
		expect(saved, "the last page saved holds A").toBeDefined();
		expect(saved!.page, "A keeps the page the drain wrote").toBe(2);
		expect(d2.deck.strokes.get(1)?.map((s) => s.id), "A shows on slide 2, as page 2's file ink does").toContain(a);
		expect(file.strokes.map((s) => s.id)).toEqual(expect.arrayContaining(["x", b]));
	});

	it("S14 deck 1's drain write is refused: deck 2's next save keeps A", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		r.state.refuseImmediate = 1;
		await drainLands(r, d1, ["x", a]);
		expect(r.state.refuseImmediate, "the drain's write was refused").toBe(0);
		expect(parsePage(r.fake.files.get(fileOf(ID))!, ID).data.strokes.map((s) => s.id), "the file still holds x only: the drain wrote nothing").toEqual(["x"]);
		const b = r.draw(d2, 20);
		const saved = await r.fileIds();
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toEqual(expect.arrayContaining(["x", b]));
		expect(r.ids(d2.deck), "deck 2's own lists hold A").toContain(a);
	});

	it("S15 the eraser is down on deck 2 when the drain lands: after the lift and an undo, A stays", async () => {
		const r = makeRig();
		const { d1, d2, a } = await closeAndReopenInsideTheRead(r);
		await r.release(1);
		r.eraseDown(d2);
		expect(d2.deck.erasing, "the eraser is down on deck 2").toBe(true);
		await drainLands(r, d1, ["x", a]);
		r.eraseUp(d2);
		expect(r.ids(d2.deck), "the eraser took x").not.toContain("x");
		expect(r.ids(d2.deck), "A, handed over mid-erase, is in deck 2's lists").toContain(a);
		expect(d2.deck.run("undo"), "undo ran").toBe(true);
		expect(r.ids(d2.deck), "undo of the erase brings x back and keeps A").toEqual(expect.arrayContaining(["x", a]));
		const saved = await r.fileIds();
		expect(saved, "the last page saved holds A").toContain(a);
		expect(saved).toContain("x");
	});

	it("S16 control: an erase saved before the read hands over no removal, so deck 2's undo of B0 still runs", async () => {
		const r = makeRig({ files: { [ID]: storedPage(ID, [storedStroke("w"), storedStroke("x", 600)]) } });
		const d1 = await r.open();
		await r.release(0);
		expect(r.ids(d1.deck), "deck 1 shows w and x").toEqual(["w", "x"]);
		r.erase(d1);
		expect(r.ids(d1.deck), "the eraser took w").toEqual(["x"]);
		await vi.advanceTimersByTimeAsync(2500);
		expect(await r.fileIds(), "the erase's save landed").toEqual(["x"]);
		const reloading = reloadSlidesExternal(ID);
		await r.settle();
		expect(r.state.reads.map((x) => x.id), "deck 1's live reload read is held").toEqual([ID, ID]);
		const a = r.draw(d1);
		expect(d1.deck.saveAfterLoad, "A waits behind the reload").toBe(true);
		expect(d1.deck.adoptedIds.has("w"), "deck 1 still counts w as file ink, so w is missing from its lists").toBe(true);
		const d2 = await r.open();
		expect(d1.deck.disposed, "deck 1 is closed").toBe(true);
		expect(d1.deck.teardownDrain, "deck 1's write is parked in a drain").not.toBeNull();
		expect(r.state.reads.length, "deck 2's first read is held").toBe(3);
		await r.release(2);
		expect(r.ids(d2.deck), "deck 2 read the file without w").toEqual(["x"]);
		const b0 = r.draw(d2, 40);
		await drainLands(r, d1, ["x", a], 1);
		await reloading;
		expect(r.state.immediate.at(-1)!.strokes.map((s) => s.id), "the drain wrote no w").not.toContain("w");
		expect(d2.deck.run("undo"), "undo of B0 ran: deck 2's history was not cleared").toBe(true);
		expect(r.ids(d2.deck), "undo took B0").not.toContain(b0);
		expect(r.ids(d2.deck), "and kept x").toContain("x");
		expect(r.ids(d2.deck), "w did not come back").not.toContain("w");
	});
});
