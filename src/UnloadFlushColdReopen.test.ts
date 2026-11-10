/**
 * UNLOAD FLUSH AND COLD REOPEN, EXECUTED - every ink surface (1.4.20 durability).
 *
 * Two claims, each driven through production code rather than read from it:
 *
 * 1. THE UNLOAD FLUSH LANDS. `onunload()` ends by starting `finishPersistence()`
 *    detached (Obsidian's `onunload` is void; README Limitations: a process
 *    killed mid-I/O can still lose ink - this file does not claim otherwise).
 *    What it does claim: once that promise resolves, every write that was
 *    pending when unload began is in storage. "Pending" means each surface's
 *    own waiting states - a debounced batch inside the 700 ms quiet period, a
 *    first-stroke identity claim still running, a sidecar read still running -
 *    because a flush that runs before one of those lands writes nothing.
 *
 * 2. THE BYTES REOPEN AS THE SAME INK. The files those flushes left are copied
 *    into a brand-new adapter, read by a brand-new `PageStore`, and adopted by a
 *    brand-new surface store (a second process, not the same singleton re-read
 *    through `reloadExternal`). Ids, order, point count, every x/y/pressure/t,
 *    and the surface fields (PDF page, slide association) must match.
 *
 * WHAT RUNS FOR REAL. `HandwritingPlugin.prototype.onunload` and
 * `.finishPersistence` on an `Object.create` instance (both are prototype
 * methods; every class field they read is assigned below, listed from a read
 * of both bodies and of `flushSettings`). `startSlidesInk` is the real host
 * wiring for Slides. The inline and PDF host objects are built INSIDE `onload`,
 * which cannot run here, so those two `attachHost({...})` blocks are sliced out
 * of `main.ts` and executed (LiveReloadTestHarness idiom: CRLF normalised, both
 * markers asserted unique, shape asserted).
 * Real `PageStore`, `InlineInkStore` (the `inlineInk` singleton main.ts
 * settles), `PdfInkStore` and `SlidesDeck` over `FakeAdapter`.
 *
 * WHAT IS FAKED. Transport (FakeAdapter), Obsidian metadata (a path -> id map),
 * the Markdown claim write (`claimNotePageId`, a gated stand-in: it is the
 * frontmatter write, not ink storage), and the presentation DOM (testUtils/
 * fakeDom.ts's FakeEl/FakeDoc, built from MobileTools.test.ts's own fake).
 * Timers are fake and
 * NEVER advanced in a flush assertion: a debounce that fired on its own would
 * make every flush look drained.
 *
 * GEOMETRY. Synthetic, no user ink. The shape mirrors a short pen-written word
 * as the stroke builder records one: 3 strokes x 24 samples at 8 ms, pressure
 * ramping 0.137 -> 0.436, plus a highlighter mark. One word sits at negative
 * coordinates (above/left of the content origin, where Insert Space and margin
 * notes put ink) and one at far extent (98 765, 123 456 px, the long-note band).
 * Values are pre-rounded to the sidecar's precision (x/y 0.01, pressure 0.001,
 * t 1 ms) so exact equality is the right comparison, not a tolerance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";
import pluginSettingsSource from "./settings/PluginSettings.ts?raw";
import onloadSource from "./PluginOnload.ts?raw";
import HandwritingPlugin from "./main";
import { inlineInk } from "./inline/InkOverlay";
import { InlineInkStore } from "./inline/InlineInkStore";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter, gate } from "./persistence/FakeAdapter";
import {
	SlidesDeck,
	SlidesInkHost,
	pageOfSlide,
	setSlidesInk,
	slidesReloadCandidate,
	slidesSidecarId,
} from "./slides/SlidesInkSurface";
import { InkPoint, InkStroke, InkTool, computeBBox } from "./ink/Stroke";
import { PageData, parsePage, serializePage, emptyPage } from "./model/PageData";
import { FakeDoc, FakeEl } from "./testUtils/fakeDom";
import { InlinePenRouter } from "./inline/InlinePenRouter";
import { harness, installFakeWindow, penEvent } from "../test/routerHarness";

// ---- the two host blocks: main.ts builds the inline one inside onload; the PDF
// ---- one is built in loadSettings, which moved to settings/PluginSettings.ts;
// ---- the onload phases live in PluginOnload.ts, read here with main.ts

const main = [mainSource, onloadSource].join("\n").replace(/\r\n/g, "\n");
const pluginSettings = pluginSettingsSource.replace(/\r\n/g, "\n");

function sliceBlock(text: string, start: string, end: string): string {
	const occurrences = text.split(start).length - 1;
	if (occurrences !== 1) throw new Error(`wiring marker found ${occurrences} times: ${start}`);
	const at = text.indexOf(start);
	const stop = text.indexOf(end, at);
	if (stop <= at) throw new Error(`wiring end marker not found after: ${start}`);
	return text.slice(at, stop + end.length);
}

const INLINE_WIRING = sliceBlock(main, "\t\tinlineInk.attachHost({", "\n\t\t});");
const PDF_WIRING = sliceBlock(pluginSettings, "\t\tthis.pdfStore.attachHost({", "\n\t\t});");

/** `this` is the plugin; the parameters are the free names the block closes over. */
const attachInlineHost = new Function(
	"inlineInk",
	"blockNotice",
	transformSync(INLINE_WIRING, { loader: "ts", target: "es2022" }).code
) as (this: unknown, ink: typeof inlineInk, blockNotice: (m: string) => void) => void;
const attachPdfHost = new Function(
	"Notice",
	transformSync(PDF_WIRING, { loader: "ts", target: "es2022" }).code
) as (this: unknown, notice: unknown) => void;

// ---- synthetic ink ---------------------------------------------------------------

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

let createdAt = 1_757_700_000_000;

function word(prefix: string, x0: number, y0: number, extra: Partial<InkStroke> = {}): InkStroke[] {
	return [0, 1, 2].map((k) => stroke(`${prefix}-${k}`, x0 + k * 41.5, y0, "pen", extra));
}

function stroke(
	id: string,
	x0: number,
	y0: number,
	tool: InkTool = "pen",
	extra: Partial<InkStroke> = {}
): InkStroke {
	const points: InkPoint[] = Array.from({ length: 24 }, (_, i) => ({
		x: r2(x0 + i * 1.37),
		y: r2(y0 + Math.sin(i / 3) * 12.5),
		pressure: r3(0.137 + i * 0.013),
		t: i * 8,
	}));
	const width = tool === "highlighter" ? 14 : 2.2;
	return {
		id,
		tool,
		color: tool === "highlighter" ? "#f7d154" : "#1e2a3b",
		width,
		points,
		// What parsePage recomputes on read (`computeBBox(points, width * 2)`).
		bbox: computeBBox(points, width * 2),
		createdAt: createdAt++,
		...extra,
	};
}

/** The fields a reopen must reproduce, in a shape whose diff reads as a sentence. */
function model(strokes: readonly InkStroke[]): Array<Record<string, unknown>> {
	return strokes.map((s) => ({
		id: s.id,
		tool: s.tool,
		page: s.page,
		points: s.points.length,
		pressure: s.points.map((p) => p.pressure),
		xy: s.points.map((p) => [p.x, p.y, p.t]),
	}));
}

function anyNegative(strokes: readonly InkStroke[]): boolean {
	return strokes.some((s) => s.points.some((p) => p.x < 0 && p.y < 0));
}

// ---- storage helpers ---------------------------------------------------------------

const sidecarPath = (id: string): string => `.handwriting/${id}.json`;

function onDisk(adapter: FakeAdapter, id: string): InkStroke[] | null {
	const text = adapter.files.get(sidecarPath(id));
	if (text === undefined) return null;
	const parsed = parsePage(text, id);
	expect(parsed.damaged, `sidecar ${id} did not parse`).toBeFalsy();
	return parsed.data.strokes;
}

function idsOnDisk(adapter: FakeAdapter, id: string): string[] {
	return (onDisk(adapter, id) ?? []).map((s) => s.id);
}

/** A second machine: the same bytes, none of the first session's objects. */
function coldCopy(adapter: FakeAdapter): { adapter: FakeAdapter; store: PageStore } {
	const next = new FakeAdapter();
	for (const [path, bytes] of adapter.files) next.files.set(path, bytes);
	for (const [path, mtime] of adapter.mtimes) next.mtimes.set(path, mtime);
	for (const dir of adapter.dirs) next.dirs.add(dir);
	return { adapter: next, store: new PageStore({ vault: { adapter: next } } as never) };
}

/** Resolve every promise chain the fake I/O started, without touching a timer. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 400; i++) await Promise.resolve();
}

// ---- a minimal presentation DOM (shared fake, see src/testUtils/fakeDom.ts) -------

interface Presentation {
	doc: FakeDoc;
	reveal: FakeEl;
	slides: FakeEl;
	container: FakeEl;
	/** One whole pen stroke, screen px, with a pressure per sample. */
	draw(points: Array<[number, number, number]>): void;
	advance(to: number): void;
}

let clock = 0;

function presentation(sections = 3): Presentation {
	const doc = new FakeDoc();
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	// A 960x700 deck drawn at half scale (k = 0.5), inset 20/25 px: the rig
	// SlidesInkSurface.test.ts uses, so screen -> slide maths is the known one.
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < sections; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	container.querySelector = ((sel: string) => (sel === ".reveal" ? reveal : null)) as never;
	reveal.querySelector = ((sel: string) => (sel === ".slides" ? slides : null)) as never;
	doc.container = container;
	const ev = (type: string, x: number, y: number, pressure: number, buttons = 1) => ({
		type,
		pointerId: 7,
		pointerType: "pen",
		isPrimary: true,
		buttons,
		button: 0,
		clientX: x,
		clientY: y,
		pressure,
		timeStamp: (clock += 16),
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
	});
	return {
		doc,
		reveal,
		slides,
		container,
		draw(points) {
			const [first, ...rest] = points;
			reveal.dispatch(ev("pointerdown", first![0], first![1], first![2]));
			for (const [x, y, p] of rest) reveal.dispatch(ev("pointermove", x, y, p));
			const last = points[points.length - 1]!;
			reveal.dispatch(ev("pointerup", last[0], last[1], 0, 0));
		},
		advance(to) {
			for (const s of slides.children) s.classes.delete("present");
			slides.children[to]!.classes.add("present");
			reveal.dispatch({ type: "slidechanged" });
		},
	};
}

const DECK_SOURCE = "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2";

/** The committed per-slide lists the painter reads (the deck's own model). */
function deckModel(deck: SlidesDeck): Map<number, InkStroke[]> {
	const map = (deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes;
	return new Map([...map].map(([k, v]) => [k, [...v]]));
}

/**
 * A pen word in screen px, drawn up and to the left: started at (30, 40) it runs
 * off the slide's top-left corner (slide inset 20/25 px) into negative
 * slide-logical x AND y, the margin a presenter annotates beside a slide.
 */
function slideWord(x0: number, y0: number): Array<[number, number, number]> {
	return Array.from({ length: 12 }, (_, i) => [x0 - i * 4, y0 - i * 3 + (i % 2) * 2, r3(0.137 + i * 0.061)]);
}

// ---- the device ------------------------------------------------------------------

interface Device {
	adapter: FakeAdapter;
	store: PageStore;
	pdf: PdfInkStore;
	plugin: Record<string, unknown> & {
		finishPersistence(): Promise<void>;
		flushOnHide(): void;
		onunload(): void;
		startSlidesInk(): void;
	};
	/** Note path -> page id: what the metadata cache would report. */
	ids: Map<string, string>;
	/** Claims the plugin made, in order. */
	claims: string[];
	/** Held open by a test to model a Markdown write that has not landed. */
	claimGate: { promise: Promise<void>; release: () => void } | null;
	activeFile: string | null;
}

function device(): Device {
	const adapter = new FakeAdapter();
	const store = new PageStore({ vault: { adapter } } as never);
	const pdf = new PdfInkStore();
	const d = {} as Device;
	const plugin = Object.create(HandwritingPlugin.prototype) as Device["plugin"];
	Object.assign(d, { adapter, store, pdf, plugin, ids: new Map(), claims: [], claimGate: null, activeFile: null });
	Object.assign(plugin, {
		// finishPersistence
		store,
		// flushSettings (called by finishPersistence)
		settingsTimer: null,
		settingsDirty: false,
		settingsWriting: null,
		settingsWriteAgain: false,
		// onunload
		unloaded: false,
		notePaper: null,
		pendingRecycle: new Map<string, number>(),
		declaimTimers: new Map<string, number>(),
		// the PDF host block
		pdfStore: pdf,
		// startSlidesInk
		manifest: { version: "durability-reopen-test" },
		app: {
			vault: {
				adapter,
				getFileByPath: (path: string) => ({ path }),
				cachedRead: async () => DECK_SOURCE,
			},
			metadataCache: {
				getFileCache: (file: { path: string }) => ({
					frontmatter: d.ids.has(file.path) ? { "handwriting-page-id": d.ids.get(file.path) } : {},
				}),
			},
			workspace: {
				getActiveFile: () => (d.activeFile ? { path: d.activeFile } : null),
				iterateAllLeaves: () => undefined,
			},
		},
		// The Markdown half of a claim, not ink storage: gated so a test can hold
		// it open the way a slow vault write does.
		claimNotePageId: async (path: string, proposed: string) => {
			d.claims.push(path);
			if (d.claimGate) await d.claimGate.promise;
			const id = d.ids.get(path) ?? proposed;
			d.ids.set(path, id);
			return { pageId: id };
		},
	});
	attachInlineHost.call(plugin, inlineInk, () => undefined);
	attachPdfHost.call(plugin, class {});
	return d;
}

let unique = 0;
const fresh = (stem: string): string => `${stem}-${++unique}`;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
		observe(): void {}
		disconnect(): void {}
	};
});

afterEach(async () => {
	setSlidesInk(false);
	await drainMicrotasks();
	delete (globalThis as { document?: unknown }).document;
	delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	vi.useRealTimers();
});

// ---- the extraction is the shipped code ----------------------------------------------

describe("the host wiring executed here is main.ts's own", () => {
	it("slices exactly one inline and one PDF attachHost block, each with its write members", () => {
		expect(INLINE_WIRING.match(/scheduleSidecar: /g)).toHaveLength(1);
		expect(INLINE_WIRING.match(/scheduleSidecarNow: /g)).toHaveLength(1);
		expect(INLINE_WIRING.trimEnd().endsWith("});")).toBe(true);
		expect(PDF_WIRING.match(/schedule: /g)).toHaveLength(1);
		expect(PDF_WIRING.trimEnd().endsWith("});")).toBe(true);
		// And they bind to THIS device's store: a scheduled write reaches its queue.
		const d = device();
		const id = fresh("wiring-pdf");
		d.pdf.commit(id, stroke(`${id}-s`, 1, 1, "pen", { page: 1 }));
		expect((d.store as unknown as { pending: Map<string, PageData> }).pending.has(id)).toBe(true);
	});
});

// ---- inline --------------------------------------------------------------------------

/** A claimed, loaded note with three words pending in the 700 ms quiet period. */
async function inlineDebounced(d: Device): Promise<{ path: string; id: string; ink: InkStroke[] }> {
	const path = `${fresh("Inline")}.md`;
	const id = fresh("inline-page");
	d.ids.set(path, id);
	await inlineInk.ensureLoaded(path);
	const ink = [
		...word(`${id}-neg`, -1234.56, -78.9),
		...word(`${id}-far`, 98765.43, 123456.78),
		stroke(`${id}-hl`, 40, 60, "highlighter"),
	];
	for (const s of ink) inlineInk.commit(path, s);
	return { path, id, ink };
}

describe("inline: finishPersistence drains every pending write", () => {
	it("a debounced batch inside the quiet period is on disk when the flush resolves", async () => {
		const d = device();
		const { id, ink } = await inlineDebounced(d);
		expect(onDisk(d.adapter, id), "not pending: the batch was already written").toBeNull();

		await d.plugin.finishPersistence();

		expect(model(onDisk(d.adapter, id) ?? [])).toEqual(model(ink));
	});

	it("a first stroke whose page-id claim is still running is on disk when the flush resolves", async () => {
		const d = device();
		const path = `${fresh("Unclaimed")}.md`;
		await inlineInk.ensureLoaded(path);
		d.claimGate = gate();
		const ink = word(fresh("claimed"), -310.25, -12.5);
		inlineInk.commitGesture(path, ink);
		expect(d.claims).toEqual([path]);

		const done = d.plugin.finishPersistence();
		let resolved = false;
		void done.then(() => (resolved = true));
		await drainMicrotasks();
		const waited = !resolved;
		d.claimGate.release();
		await done;

		const id = d.ids.get(path)!;
		expect(waited, "finishPersistence resolved before the claim it should wait for").toBe(true);
		expect(model(onDisk(d.adapter, id) ?? [])).toEqual(model(ink));
	});

	it("a stroke drawn while the sidecar is still being read is on disk, merged under the saved ink", async () => {
		const d = device();
		const path = `${fresh("Loading")}.md`;
		const id = fresh("inline-loading");
		d.ids.set(path, id);
		const saved = word(`${id}-saved`, 12.5, 30);
		d.adapter.dirs.add(".handwriting");
		d.adapter.externalWrite(sidecarPath(id), serializePage({ ...emptyPage(id), surface: "inline", strokes: saved }));
		const read = gate();
		d.adapter.readGate = read.promise;
		const loading = inlineInk.ensureLoaded(path);
		const late = word(`${id}-late`, -800.75, -20.25);
		inlineInk.commitGesture(path, late);

		const done = d.plugin.finishPersistence();
		await drainMicrotasks();
		d.adapter.readGate = null;
		read.release();
		await loading;
		await done;

		expect(model(onDisk(d.adapter, id) ?? [])).toEqual(model([...saved, ...late]));
	});
});

describe("inline: the flushed bytes reopen as the same ink", () => {
	it("a brand-new store over a cold copy of the bytes has every stroke, in order, with pressure", async () => {
		const d = device();
		const { path, id, ink } = await inlineDebounced(d);
		await d.plugin.finishPersistence();

		const cold = coldCopy(d.adapter);
		const reopened = new InlineInkStore();
		reopened.attachHost({
			readPageId: (p) => (p === path ? id : null),
			claimId: async () => {
				throw new Error("a reopen must not claim");
			},
			loadSidecar: (pageId) => cold.store.load(pageId),
			scheduleSidecar: () => {
				throw new Error("a reopen must not write");
			},
			notify: () => undefined,
		});
		await reopened.ensureLoaded(path);

		expect(anyNegative(ink)).toBe(true);
		expect(model(reopened.strokes(path))).toEqual(model(ink));
		expect(reopened.strokes(path)).toEqual(ink);
	});
});

// ---- pdf -------------------------------------------------------------------------------

async function pdfDebounced(d: Device): Promise<{ id: string; ink: InkStroke[] }> {
	const id = fresh("pdf-doc");
	await d.pdf.ensureLoaded(id);
	const ink = [
		...word(`${id}-p1`, -40.5, -15.25, { page: 1 }),
		stroke(`${id}-p17`, 98765.43, 123456.78, "pen", { page: 17 }),
		stroke(`${id}-p3hl`, 200, 300, "highlighter", { page: 3 }),
		stroke(`${id}-p1b`, 60, 90, "pen", { page: 1 }),
	];
	for (const s of ink) d.pdf.commit(id, s);
	return { id, ink };
}

describe("pdf: finishPersistence drains every pending write", () => {
	it("a debounced batch inside the quiet period is on disk when the flush resolves", async () => {
		const d = device();
		const { id, ink } = await pdfDebounced(d);
		expect(onDisk(d.adapter, id)).toBeNull();

		await d.plugin.finishPersistence();

		expect(model(onDisk(d.adapter, id) ?? [])).toEqual(model(ink));
	});

	it("a stroke drawn while the sidecar is still being read is on disk when the flush resolves", async () => {
		const d = device();
		const id = fresh("pdf-loading");
		const saved = [stroke(`${id}-saved`, 10, 10, "pen", { page: 2 })];
		d.adapter.dirs.add(".handwriting");
		d.adapter.externalWrite(sidecarPath(id), serializePage({ ...emptyPage(id), surface: "pdf", strokes: saved }));
		const read = gate();
		d.adapter.readGate = read.promise;
		const loading = d.pdf.ensureLoaded(id);
		const late = stroke(`${id}-late`, -33.33, -44.44, "pen", { page: 4 });
		d.pdf.commit(id, late);

		const done = d.plugin.finishPersistence();
		let resolved = false;
		void done.then(() => (resolved = true));
		await drainMicrotasks();
		const waited = !resolved;
		d.adapter.readGate = null;
		read.release();
		await loading;
		await done;
		const landed = idsOnDisk(d.adapter, id);

		expect(
			{ waited, landed },
			"the PDF read had not landed when unload flushed, and nothing waited for it"
		).toEqual({ waited: true, landed: [saved[0]!.id, late.id] });
	});
});

describe("pdf: the flushed bytes reopen as the same ink", () => {
	it("a brand-new PdfInkStore over a cold copy has every stroke, in order, on its page", async () => {
		const d = device();
		const { id, ink } = await pdfDebounced(d);
		await d.plugin.finishPersistence();

		const cold = coldCopy(d.adapter);
		const reopened = new PdfInkStore();
		reopened.attachHost({
			load: (pageId) => cold.store.load(pageId),
			schedule: () => {
				throw new Error("a reopen must not write");
			},
			notice: () => undefined,
		});
		await reopened.ensureLoaded(id);

		expect(model(reopened.strokes(id))).toEqual(model(ink));
		expect(reopened.strokes(id)).toEqual(ink);
		expect(reopened.strokesOnPage(id, 1).map((s) => s.id)).toEqual(
			ink.filter((s) => s.page === 1).map((s) => s.id)
		);
		expect(reopened.strokesOnPage(id, 17).map((s) => s.id)).toEqual([`${id}-p17`]);
		expect(reopened.strokesOnPage(id, 3).map((s) => s.id)).toEqual([`${id}-p3hl`]);
	});
});

// ---- slides ------------------------------------------------------------------------------

/** Mount a presentation through the plugin's own `startSlidesInk`. */
function present(d: Device, note: string, sections = 3): { deck: SlidesDeck; show: Presentation } {
	const show = presentation(sections);
	(globalThis as { document?: unknown }).document = show.doc;
	d.activeFile = note;
	d.plugin.startSlidesInk();
	return { deck: liveDeck(), show };
}

/** The module's live deck: `slidesReloadCandidate` asks its `deck` binding, the spy names it. */
function liveDeck(): SlidesDeck {
	let found: SlidesDeck | null = null;
	const spy = vi
		.spyOn(SlidesDeck.prototype, "reloadCandidateSidecarId")
		.mockImplementation(function (this: SlidesDeck) {
			found = this;
			return null;
		});
	slidesReloadCandidate();
	spy.mockRestore();
	if (!found) throw new Error("no live deck mounted: startSlidesInk found no presentation");
	return found;
}

async function slidesDebounced(
	d: Device
): Promise<{ note: string; sidecar: string; deck: SlidesDeck; show: Presentation; before: Map<number, InkStroke[]> }> {
	const note = `${fresh("Deck")}.md`;
	const pageId = fresh("deck-page");
	d.ids.set(note, pageId);
	const { deck, show } = present(d, note);
	await drainMicrotasks();
	// Slide 0: a word that runs off the slide's top-left corner into negative
	// slide-logical space. Slide 2: a stroke out past the right edge.
	show.draw(slideWord(24, 40));
	show.draw(slideWord(120, 200));
	show.advance(2);
	show.draw(slideWord(900, 700));
	const before = deckModel(deck);
	return { note, sidecar: slidesSidecarId(pageId), deck, show, before };
}

describe("slides: finishPersistence drains every pending write", () => {
	it("a debounced batch from a live deck is on disk when the flush resolves", async () => {
		const d = device();
		const { sidecar, before } = await slidesDebounced(d);
		const drawn = [...before.values()].flat();
		expect(drawn.length, "the synthetic strokes were not committed by the deck").toBe(3);
		expect(onDisk(d.adapter, sidecar)).toBeNull();

		await d.plugin.finishPersistence();

		expect(model(onDisk(d.adapter, sidecar) ?? [])).toEqual(model(drawn));
	});

	it("a first stroke whose claim is still running is on disk, live deck or torn down", async () => {
		for (const teardownFirst of [false, true]) {
			const d = device();
			const note = `${fresh("UnclaimedDeck")}.md`;
			const { deck, show } = present(d, note);
			await drainMicrotasks();
			d.claimGate = gate();
			show.draw(slideWord(300, 300));
			const drawn = [...deckModel(deck).values()].flat();
			expect(drawn).toHaveLength(1);
			expect(d.claims).toEqual([note]);
			// Obsidian's registered callbacks may run before onunload: then
			// `setSlidesInk(false)` has disposed the deck and its write is a drain.
			if (teardownFirst) setSlidesInk(false);

			const done = d.plugin.finishPersistence();
			let resolved = false;
			void done.then(() => (resolved = true));
			await drainMicrotasks();
			const waited = !resolved;
			d.claimGate.release();
			await done;

			const sidecar = slidesSidecarId(d.ids.get(note)!);
			expect({ teardownFirst, waited }).toEqual({ teardownFirst, waited: true });
			expect(model(onDisk(d.adapter, sidecar) ?? [])).toEqual(model(drawn));
			setSlidesInk(false);
		}
	});
});

describe("slides: the flushed bytes reopen as the same ink on the same slides", () => {
	it("a brand-new deck over a cold copy has every stroke on its slide, in order, with pressure", async () => {
		const d = device();
		const { note, sidecar, before } = await slidesDebounced(d);
		await d.plugin.finishPersistence();
		setSlidesInk(false);

		const cold = coldCopy(d.adapter);
		const show = presentation(3);
		const host: SlidesInkHost = {
			activeFilePath: () => note,
			readSource: async () => DECK_SOURCE,
			readPageId: () => d.ids.get(note)!,
			claimId: async () => {
				throw new Error("a reopen must not claim");
			},
			newPageId: () => "unused",
			loadSidecar: (id) => cold.store.load(id),
			scheduleSidecar: () => {
				throw new Error("a reopen must not write");
			},
			saveSidecarNow: async () => {
				throw new Error("a reopen must not write");
			},
			nib: () => ({ tool: "pen", color: "#1e2a3b", width: 2.2 }),
			eraserRadiusPx: () => 12,
			eraseWholeStrokes: () => true,
			notify: () => undefined,
			buildId: "durability-reopen-test",
		};
		const reopened = new SlidesDeck(
			show.container as unknown as HTMLElement,
			show.reveal as unknown as HTMLElement,
			show.slides as unknown as HTMLElement,
			host
		);
		await drainMicrotasks();
		const after = deckModel(reopened);

		expect(cold.adapter.files.has(sidecarPath(sidecar))).toBe(true);
		expect(anyNegative([...before.values()].flat()), "no stroke reached negative slide space").toBe(true);
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [slide, strokes] of before) {
			expect(model(after.get(slide) ?? []), `slide ${slide}`).toEqual(model(strokes));
			for (const s of after.get(slide) ?? []) expect(s.page).toBe(pageOfSlide(slide));
		}
		reopened.dispose();
	});
});

// ---- onunload itself --------------------------------------------------------------------

describe("onunload starts the flush, and every surface's pending write lands", () => {
	it("executing onunload writes inline, PDF and Slides batches that were all pending", async () => {
		const d = device();
		const inline = await inlineDebounced(d);
		const pdf = await pdfDebounced(d);
		const slides = await slidesDebounced(d);
		for (const id of [inline.id, pdf.id, slides.sidecar]) {
			expect(onDisk(d.adapter, id), `${id} was not pending`).toBeNull();
		}
		const real = HandwritingPlugin.prototype as unknown as { finishPersistence(): Promise<void> };
		const started: Promise<void>[] = [];
		d.plugin.finishPersistence = function (this: unknown) {
			const p = real.finishPersistence.call(this);
			started.push(p);
			return p;
		};

		d.plugin.onunload();

		expect(started, "onunload did not start finishPersistence").toHaveLength(1);
		await started[0];
		expect(model(onDisk(d.adapter, inline.id) ?? [])).toEqual(model(inline.ink));
		expect(model(onDisk(d.adapter, pdf.id) ?? [])).toEqual(model(pdf.ink));
		expect(model(onDisk(d.adapter, slides.sidecar) ?? [])).toEqual(model([...slides.before.values()].flat()));
	});
});

/**
 * THE HIDE FLUSH, for ink parked behind a read or a claim. A hide is the last
 * moment a phone gives JS before it may freeze or kill the app. `flushOnHide`
 * dispatches the page store at once, but a stroke parked behind a sidecar read
 * or a first-stroke claim reaches the page store only when that lands, and
 * then waits out the 700 ms quiet period like any other write. A kill inside
 * that window lost it. Timers are never advanced here, so a write on disk is
 * one the hide path dispatched, not the debounce.
 */
describe("a hide writes ink parked behind a read or a claim as soon as it lands", () => {
	async function settleAll(): Promise<void> {
		for (let i = 0; i < 4; i++) await drainMicrotasks();
	}

	it("pdf: a stroke drawn while the sidecar is still being read", async () => {
		const d = device();
		const id = fresh("pdf-hidden-loading");
		const saved = [stroke(`${id}-saved`, 10, 10, "pen", { page: 2 })];
		d.adapter.dirs.add(".handwriting");
		d.adapter.externalWrite(sidecarPath(id), serializePage({ ...emptyPage(id), surface: "pdf", strokes: saved }));
		const read = gate();
		d.adapter.readGate = read.promise;
		const loading = d.pdf.ensureLoaded(id);
		const late = stroke(`${id}-late`, 33.33, 44.44, "pen", { page: 4 });
		d.pdf.commit(id, late);

		d.plugin.flushOnHide();
		d.adapter.readGate = null;
		read.release();
		await loading;
		await settleAll();

		expect(idsOnDisk(d.adapter, id), "the parked PDF stroke waited for the quiet period after a hide").toEqual([
			saved[0]!.id,
			late.id,
		]);
	});

	it("slides: a first stroke whose claim is still running", async () => {
		const d = device();
		const note = `${fresh("HiddenDeck")}.md`;
		const { deck, show } = present(d, note);
		await drainMicrotasks();
		d.claimGate = gate();
		show.draw(slideWord(300, 300));
		const drawn = [...deckModel(deck).values()].flat();
		expect(drawn).toHaveLength(1);

		d.plugin.flushOnHide();
		d.claimGate.release();
		await settleAll();

		const sidecar = slidesSidecarId(d.ids.get(note)!);
		expect(model(onDisk(d.adapter, sidecar) ?? []), "the parked Slides stroke waited for the quiet period after a hide").toEqual(
			model(drawn)
		);
	});

	it("slides: a stroke drawn while the deck's sidecar is still being read", async () => {
		const d = device();
		const note = `${fresh("HiddenLoadingDeck")}.md`;
		const pageId = fresh("hidden-deck-page");
		d.ids.set(note, pageId);
		const sidecar = slidesSidecarId(pageId);
		d.adapter.dirs.add(".handwriting");
		d.adapter.externalWrite(sidecarPath(sidecar), serializePage({ ...emptyPage(sidecar), surface: "slides" } as PageData));
		const read = gate();
		d.adapter.readGate = read.promise;
		const { deck, show } = present(d, note);
		await drainMicrotasks();
		show.draw(slideWord(300, 300));
		const drawn = [...deckModel(deck).values()].flat();
		expect(drawn).toHaveLength(1);

		d.plugin.flushOnHide();
		d.adapter.readGate = null;
		read.release();
		await settleAll();

		expect(model(onDisk(d.adapter, sidecar) ?? []), "the Slides stroke drawn while loading waited for the quiet period after a hide").toEqual(
			model(drawn)
		);
	});

	it("inline: a stroke drawn while the sidecar is still being read", async () => {
		const d = device();
		const path = `${fresh("HiddenLoading")}.md`;
		const id = fresh("inline-hidden-loading");
		d.ids.set(path, id);
		const saved = word(`${id}-saved`, 12.5, 30);
		d.adapter.dirs.add(".handwriting");
		d.adapter.externalWrite(sidecarPath(id), serializePage({ ...emptyPage(id), surface: "inline", strokes: saved }));
		const read = gate();
		d.adapter.readGate = read.promise;
		const loading = inlineInk.ensureLoaded(path);
		const late = word(`${id}-late`, 800.75, 20.25);
		inlineInk.commitGesture(path, late);

		d.plugin.flushOnHide();
		d.adapter.readGate = null;
		read.release();
		await loading;
		await settleAll();

		expect(model(onDisk(d.adapter, id) ?? []), "the note stroke drawn while loading waited for the quiet period after a hide").toEqual(
			model([...saved, ...late])
		);
	});

	it("inline: a first stroke whose page-id claim is still running", async () => {
		const d = device();
		const path = `${fresh("HiddenUnclaimed")}.md`;
		await inlineInk.ensureLoaded(path);
		d.claimGate = gate();
		const ink = word(fresh("hidden-claimed"), 310.25, 12.5);
		inlineInk.commitGesture(path, ink);
		expect(d.claims).toEqual([path]);

		d.plugin.flushOnHide();
		d.claimGate.release();
		await settleAll();

		const id = d.ids.get(path)!;
		expect(model(onDisk(d.adapter, id) ?? []), "the parked note stroke waited for the quiet period after a hide").toEqual(
			model(ink)
		);
	});
});

/**
 * THE HIDE ENDS A STROKE STILL ON THE GLASS. A hide on a phone or tablet can
 * come with no window blur first (iOS sends visibilitychange alone), so a stroke
 * the pen is still drawing when the app goes to the background never reached
 * its commit, and the hide's dispatch wrote the page without it. The hide now
 * ends every live stroke the way a blur does, before it dispatches.
 *
 * Notes and PDFs share InlinePenRouter: a REAL router here (test/routerHarness),
 * fed scroller pointer events with no lift. Its penUp callback stands in for the
 * surface's own penUp, which commits the drawn ink to that surface's store; the
 * commit goes to the REAL inlineInk / PdfInkStore over this device's PageStore.
 * Slides is the real deck mounted through startSlidesInk, its pen left down.
 * Timers are never advanced: a write on disk is one the hide dispatched.
 */
describe("a hide ends a stroke still on the glass, and the hide's write carries it", () => {
	let undoWindow: () => void = () => undefined;
	let pen = 5000;
	const routers: InlinePenRouter[] = [];

	beforeEach(() => {
		// The router binds its blur and capture listeners on `window`; the outer
		// stand-in (globalThis) has none, so these cells use the router harness's.
		delete (globalThis as { window?: unknown }).window;
		undoWindow = installFakeWindow();
	});

	afterEach(() => {
		for (const r of routers.splice(0)) r.dispose();
		undoWindow();
		(globalThis as { window?: unknown }).window = globalThis;
	});

	async function settleAll(): Promise<void> {
		for (let i = 0; i < 4; i++) await drainMicrotasks();
	}

	/** A real router whose lift commits `commit()`'s ink, the way the surface's penUp does. */
	function liveRouter(commit: () => void): ReturnType<typeof harness> {
		const h = harness();
		routers.push(h.router);
		const up = h.rec.cb.onPenUp;
		h.rec.cb.onPenUp = (event) => {
			up(event);
			commit();
		};
		return h;
	}

	/** The pen lands and draws; nothing lifts, cancels, loses capture or blurs. */
	function penStillDown(h: ReturnType<typeof harness>): void {
		const opts = { pointerId: 9, pointerType: "pen", pressure: 0.5, buttons: 1 };
		h.fire(penEvent("pointerdown", (pen += 16), { ...opts, x: 200, y: 200 }));
		h.fire(penEvent("pointermove", (pen += 16), { ...opts, x: 220, y: 210 }));
		h.fire(penEvent("pointermove", (pen += 16), { ...opts, x: 240, y: 222 }));
		expect(h.rec.downs, "premise: the pen is writing").toBe(1);
		expect(h.rec.ups, "premise: the stroke is still open").toBe(0);
	}

	/**
	 * The stroke is in a file the hide's own synchronous dispatch wrote (the
	 * page's flush carrier, written with no await in front of it). Read before
	 * any await: a commit made after the dispatch reaches disk only through a
	 * later write, and is not here yet.
	 */
	const carriedNow = (d: Device, strokeId: string): boolean =>
		[...(d.adapter as unknown as { files: Map<string, string> }).files.values()].some((text) => text.includes(`"${strokeId}"`));

	it("inline: a stroke the pen is still drawing is in the write the hide dispatches", async () => {
		const d = device();
		const path = `${fresh("HiddenLive")}.md`;
		const id = fresh("inline-hidden-live");
		d.ids.set(path, id);
		await inlineInk.ensureLoaded(path);
		const ink = word(`${id}-live`, 410.5, 22.25);
		const h = liveRouter(() => inlineInk.commitGesture(path, ink));
		penStillDown(h);

		d.plugin.flushOnHide();

		expect(h.rec.ups, "the hide did not end the stroke on the glass").toBe(1);
		expect(h.rec.abandons, "the hide dropped the stroke instead of committing it").toBe(0);
		expect(carriedNow(d, ink[0]!.id), "the stroke was committed after the hide's dispatch").toBe(true);
		await settleAll();
		expect(model(onDisk(d.adapter, id) ?? []), "the note stroke on the glass was not written by the hide").toEqual(model(ink));
	});

	it("pdf: a stroke the pen is still drawing is in the write the hide dispatches", async () => {
		const d = device();
		const id = fresh("pdf-hidden-live");
		await d.pdf.ensureLoaded(id);
		const ink = stroke(`${id}-live`, 120.5, 340.25, "pen", { page: 3 });
		const h = liveRouter(() => d.pdf.commit(id, ink));
		penStillDown(h);

		d.plugin.flushOnHide();

		expect(h.rec.ups, "the hide did not end the stroke on the glass").toBe(1);
		expect(h.rec.abandons, "the hide dropped the stroke instead of committing it").toBe(0);
		expect(carriedNow(d, ink.id), "the stroke was committed after the hide's dispatch").toBe(true);
		await settleAll();
		expect(idsOnDisk(d.adapter, id), "the PDF stroke on the glass was not written by the hide").toEqual([ink.id]);
	});

	it("slides: a stroke the pen is still drawing is in the write the hide dispatches", async () => {
		const d = device();
		const note = `${fresh("HiddenLiveDeck")}.md`;
		const pageId = fresh("hidden-live-deck");
		d.ids.set(note, pageId);
		const { deck, show } = present(d, note);
		await drainMicrotasks();
		const points = slideWord(300, 300);
		const [first, ...rest] = points;
		const ev = (type: string, [x, y, pressure]: [number, number, number]) => ({
			type, pointerId: 7, pointerType: "pen", isPrimary: true, buttons: 1, button: 0, clientX: x, clientY: y, pressure,
			timeStamp: (clock += 16), preventDefault: () => undefined, stopPropagation: () => undefined,
		});
		show.reveal.dispatch(ev("pointerdown", first!));
		for (const p of rest) show.reveal.dispatch(ev("pointermove", p));
		expect([...deckModel(deck).values()].flat(), "premise: nothing is committed while the pen is down").toHaveLength(0);

		d.plugin.flushOnHide();

		const drawn = [...deckModel(deck).values()].flat();
		expect(drawn, "the hide did not end the Slides stroke on the glass").toHaveLength(1);
		const sidecar = slidesSidecarId(pageId);
		expect(carriedNow(d, drawn[0]!.id), "the stroke was committed after the hide's dispatch").toBe(true);
		await settleAll();
		expect(model(onDisk(d.adapter, sidecar) ?? []), "the Slides stroke on the glass was not written by the hide").toEqual(model(drawn));
	});

	it("control: a blur, then a hide, commits the stroke once", async () => {
		const d = device();
		const path = `${fresh("BlurThenHide")}.md`;
		const id = fresh("inline-blur-hide");
		d.ids.set(path, id);
		await inlineInk.ensureLoaded(path);
		const ink = word(`${id}-live`, 90.5, 18.75);
		const h = liveRouter(() => inlineInk.commitGesture(path, ink));
		penStillDown(h);
		h.fireWin({ type: "blur" } as unknown as PointerEvent);
		expect(h.rec.ups, "premise: the blur committed the stroke").toBe(1);

		d.plugin.flushOnHide();

		expect(h.rec.ups, "the hide committed the blurred stroke a second time").toBe(1);
		expect(h.rec.abandons).toBe(0);
		await settleAll();
		expect(model(onDisk(d.adapter, id) ?? [])).toEqual(model(ink));
	});

	it("control: a lifted Slides stroke, then a hide, is written once", async () => {
		const d = device();
		const note = `${fresh("LiftThenHideDeck")}.md`;
		const pageId = fresh("lift-hide-deck");
		d.ids.set(note, pageId);
		const { deck, show } = present(d, note);
		await drainMicrotasks();
		show.draw(slideWord(300, 300));
		const drawn = [...deckModel(deck).values()].flat();
		expect(drawn).toHaveLength(1);

		d.plugin.flushOnHide();

		expect([...deckModel(deck).values()].flat(), "the hide committed a second Slides stroke").toHaveLength(1);
		await settleAll();
		expect(model(onDisk(d.adapter, slidesSidecarId(pageId)) ?? [])).toEqual(model(drawn));
	});
});
