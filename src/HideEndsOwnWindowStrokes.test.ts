/**
 * Hiding one window ends the strokes in that window only.
 *
 * The app's hide (the main document going hidden, or pagehide) commits every live stroke before it writes, because a
 * hide can come with no blur, and a stroke still on the glass would otherwise never reach its commit before the page
 * is frozen. It ended every live stroke in every window: a stroke in a pop-out was cut short when the main window was
 * minimized or covered, on notes, Canvas (the same overlay and router), PDFs (the same router class) and Slides. Now
 * the main window's hide ends the main window's strokes and its deck's gesture; a pop-out's stroke and deck stay live,
 * and the stroke's next move still inks. Quit still ends every stroke in every window: every window is going.
 *
 * The finisher called with no window still means every router (quit, and the tests that call it bare). Called with
 * the window that hid, it ends only the routers whose note is in that window now, not the window it was built in.
 * It is called through a wider signature, so before the fix the window is ignored and every stroke ends.
 *
 * The main hide runs here as the freeze tests run it: on a node with no global `document`, and with one for Slides.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "./main";
import { InlinePenRouter, finishLiveStrokesOnHide } from "./inline/InlinePenRouter";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../test/routerHarness";
import { makePopoutWindow } from "../test/popoutWindow";
import { SlidesDeck, activeSlidesActions, setSlidesInk, type SlidesInkHost } from "./slides/SlidesInkSurface";
import { FakeDoc, FakeEl } from "./testUtils/fakeDom";

let undoWindow: () => void = () => undefined;
beforeAll(() => {
	undoWindow = installFakeWindow();
});
afterAll(() => undoWindow());

// ---- routers in two windows ---------------------------------------------------------------------------------------

type Scroller = ReturnType<typeof fakeEl> & { ownerDocument?: unknown };

interface Note {
	el: Scroller;
	router: InlinePenRouter;
	rec: ReturnType<typeof recorder>;
}

const built: InlinePenRouter[] = [];
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
});

/** A note's router. `doc` is the scroller's ownerDocument; none at all reads as the main window, as a bare rig does. */
function noteIn(doc?: unknown): Note {
	const el = (doc === undefined ? fakeEl() : Object.assign(fakeEl(), { ownerDocument: doc })) as Scroller;
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, rec.cb);
	built.push(router);
	return { el, router, rec };
}

/** A PDF's router, built with the arguments PdfInkBind passes: the viewer's own pinch, no native touch window. */
function pdfIn(doc: unknown): Note {
	const el = Object.assign(fakeEl(), { ownerDocument: doc }) as Scroller;
	const rec = recorder();
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		rec.cb,
		() => 1,
		"pinch-zoom",
		undefined,
		false
	);
	built.push(router);
	return { el, router, rec };
}

let clock = 1000;
function pen(n: Note, type: "pointerdown" | "pointermove" | "pointerup", pointerId = 7): void {
	const h = n.el.handlers.get(type);
	if (!h) throw new Error(`the router registered no ${type} on the scroller`);
	const lift = type === "pointerup";
	h(penEvent(type, (clock += 16), { pointerId, buttons: lift ? 0 : 1, pressure: lift ? 0 : 0.4 }));
}

function activePenId(n: Note): number | null {
	return (n.router as unknown as { activePenId: number | null }).activePenId;
}

/** The finisher, given the window that hid (or none: every window). */
function finishIn(win?: Window): void {
	(finishLiveStrokesOnHide as (win?: Window) => void)(win);
}

/** A stroke left live by a hide: still open, nothing committed, and its next move and lift still land. */
function expectStillDrawing(n: Note, what: string): void {
	expect(n.rec.ups, `${what}: the hide ended it`).toBe(0);
	expect(activePenId(n), `${what}: the stroke is no longer open`).toBe(7);
	const moves = n.rec.moveCounts.length;
	pen(n, "pointermove");
	expect(n.rec.moveCounts.length, `${what}: its next move did not ink`).toBe(moves + 1);
	pen(n, "pointerup");
	expect(n.rec.ups, `${what}: its lift did not commit it`).toBe(1);
}

// One pen, so one live stroke at a time: a pen down in one pane ends a stroke still open in another. Each check below
// has a pane open in each window and the stroke in one of them.
describe("the finisher, given the window that hid", () => {
	it("the main window's hide ends the main window's stroke", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const main = noteIn(A.document);
		noteIn(B.document);
		pen(main, "pointerdown");
		expect(activePenId(main), "the main window's stroke is live").toBe(7);

		finishIn(A.window);

		expect(main.rec.ups, "the main window's stroke was not committed").toBe(1);
		expect(activePenId(main), "the main window's stroke is still open").toBeNull();
	});

	it("the main window's hide leaves a pop-out's stroke drawing", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		noteIn(A.document);
		const popout = noteIn(B.document);
		pen(popout, "pointerdown");
		expect(activePenId(popout), "the pop-out's stroke is live").toBe(7);

		finishIn(A.window);

		expectStillDrawing(popout, "the pop-out's stroke");
	});

	it("the pop-out's hide ends its own stroke and leaves the main window's drawing", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const main = noteIn(A.document);
		const popout = noteIn(B.document);
		pen(popout, "pointerdown");
		finishIn(B.window);
		expect(popout.rec.ups, "the pop-out's stroke was not committed").toBe(1);

		pen(main, "pointerdown");
		expect(activePenId(main), "the main window's stroke is live").toBe(7);
		finishIn(B.window);
		expectStillDrawing(main, "the main window's stroke");
	});

	it("a note built in the main window and moved to the pop-out goes with the window it is in now", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const moved = noteIn(A.document);
		moved.el.ownerDocument = B.document;
		pen(moved, "pointerdown");
		expect(activePenId(moved), "the stroke in the moved note is live").toBe(7);

		finishIn(A.window);
		expect(moved.rec.ups, "the main window's hide ended a stroke in a note that moved out of it").toBe(0);
		expect(activePenId(moved), "the moved note's stroke is no longer open after the main hide").toBe(7);

		finishIn(B.window);
		expect(moved.rec.ups, "the pop-out's hide did not end the stroke in the note it now holds").toBe(1);
	});

	it("a PDF stroke in a pop-out survives the main window's hide; a PDF stroke in the main window is ended", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const mainPdf = pdfIn(A.document);
		const popoutPdf = pdfIn(B.document);
		pen(popoutPdf, "pointerdown");
		expect(activePenId(popoutPdf), "the pop-out's PDF stroke is live").toBe(7);
		finishIn(A.window);
		expectStillDrawing(popoutPdf, "the pop-out's PDF stroke");

		pen(mainPdf, "pointerdown");
		expect(activePenId(mainPdf), "the main window's PDF stroke is live").toBe(7);
		finishIn(A.window);
		expect(mainPdf.rec.ups, "the main window's PDF stroke was not committed").toBe(1);
	});

	it("with no window it still ends the stroke in any window, as quit needs", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const panes = [noteIn(A.document), noteIn(B.document), noteIn(), pdfIn(B.document)];
		for (const n of panes) {
			pen(n, "pointerdown");
			finishIn();
		}

		expect(panes.map((n) => n.rec.ups), "a stroke survived the bare finisher").toEqual([1, 1, 1, 1]);
		expect(panes.map(activePenId), "a stroke is still open").toEqual([null, null, null, null]);
	});
});

// ---- the plugin's hide and quit ------------------------------------------------------------------------------------

interface StubPlugin {
	flushOnHide(): void;
	flushOnQuit(tasks: { add(fn: () => Promise<void>): void }): void;
}

/** The plugin's own hide and quit, on a plugin with nothing pending: a store that only counts, settings that save. */
function stubPlugin(): { plugin: StubPlugin; dispatches: () => number } {
	let dispatches = 0;
	const plugin = Object.create(HandwritingPlugin.prototype) as StubPlugin & Record<string, unknown>;
	Object.assign(plugin, {
		store: { flushDispatch: () => void dispatches++, hasAnyQueuedWrite: () => false },
		flushSettings: async () => undefined,
		pdfStore: { settle: async () => undefined, parkedInk: () => false },
	});
	return { plugin, dispatches: () => dispatches };
}

describe("the plugin's main-window hide, notes and Canvas", () => {
	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	it("leaves a pop-out note's stroke drawing", () => {
		expect(typeof (globalThis as { document?: unknown }).document, "premise: no global document").toBe("undefined");
		const B = makePopoutWindow();
		noteIn();
		const popout = noteIn(B.document);
		pen(popout, "pointerdown");
		const { plugin, dispatches } = stubPlugin();

		plugin.flushOnHide();

		expect(dispatches(), "the hide still dispatches the writes").toBeGreaterThan(0);
		expectStillDrawing(popout, "the pop-out note's stroke");
	});

	it("ends the main window's stroke", () => {
		expect(typeof (globalThis as { document?: unknown }).document, "premise: no global document").toBe("undefined");
		const B = makePopoutWindow();
		const main = noteIn();
		noteIn(B.document);
		pen(main, "pointerdown");
		const { plugin, dispatches } = stubPlugin();

		plugin.flushOnHide();

		expect(main.rec.ups, "the main window's stroke was not committed by the hide").toBe(1);
		expect(dispatches(), "the hide still dispatches the writes").toBeGreaterThan(0);
	});

	it("quit still ends the stroke in any window, the pop-out's included", () => {
		const B = makePopoutWindow();
		const main = noteIn();
		const popout = noteIn(B.document);
		const { plugin } = stubPlugin();
		for (const n of [popout, main]) {
			pen(n, "pointerdown");
			plugin.flushOnQuit({ add: () => undefined });
		}

		expect([popout.rec.ups, main.rec.ups], "a stroke survived quit").toEqual([1, 1]);
		expect([activePenId(popout), activePenId(main)], "a stroke is still open after quit").toEqual([null, null]);
	});
});

// ---- Slides --------------------------------------------------------------------------------------------------------

/** A window's document holding a presentation, the same fake the freeze tests present on. */
function deckDocument(withDeck: boolean): FakeDoc {
	const doc = new FakeDoc();
	if (!withDeck) return doc;
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	for (let i = 0; i < 3; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	container.querySelector = ((sel: string) => (sel === ".reveal" ? reveal : null)) as never;
	reveal.querySelector = ((sel: string) => (sel === ".slides" ? slides : null)) as never;
	doc.container = container;
	return doc;
}

function slidesHost(documents: FakeDoc[]): SlidesInkHost {
	return {
		activeFilePath: () => "Deck.md",
		documents: () => documents as unknown as Document[],
		readSource: async () => "slide 0\n\n---\n\nslide 1\n\n---\n\nslide 2",
		readPageId: () => null,
		claimId: async (_path, proposed) => ({ pageId: proposed }),
		newPageId: () => "hide-own-window-deck",
		loadSidecar: async () => null,
		scheduleSidecar: () => undefined,
		saveSidecarNow: async () => undefined,
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => true,
		notify: () => undefined,
		buildId: "hide-own-window-test",
	};
}

describe("the plugin's main-window hide, Slides", () => {
	const g = globalThis as unknown as { document?: unknown; MutationObserver?: unknown; window: { document?: unknown } };
	beforeEach(() => {
		g.MutationObserver = class {
			observe(): void {}
			disconnect(): void {}
		};
	});
	afterEach(() => {
		setSlidesInk(false);
		vi.restoreAllMocks();
		delete g.document;
		delete g.MutationObserver;
		delete g.window.document;
	});

	/** The main window's document is `main`, as in the app: the global one, and the main window's. */
	function present(main: FakeDoc, popout: FakeDoc, liveIn: FakeDoc) {
		g.document = main;
		g.window.document = main;
		setSlidesInk(true, slidesHost([main, popout]));
		expect(activeSlidesActions(liveIn as unknown as Document), "premise: the deck is live where it was put").not.toBeNull();
		return vi.spyOn(SlidesDeck.prototype, "finishGesture");
	}

	it("a deck presenting in a pop-out keeps its gesture through the main window's hide", () => {
		const main = deckDocument(false);
		const popout = deckDocument(true);
		const finish = present(main, popout, popout);
		const { plugin } = stubPlugin();

		plugin.flushOnHide();

		expect(finish, "the main window's hide ended the gesture of a deck in a pop-out").not.toHaveBeenCalled();
	});

	it("a deck presenting in the main window has its gesture ended by the main window's hide", () => {
		const main = deckDocument(true);
		const popout = deckDocument(false);
		const finish = present(main, popout, main);
		const { plugin } = stubPlugin();

		plugin.flushOnHide();

		expect(finish, "the main window's hide did not end the main deck's gesture").toHaveBeenCalledTimes(1);
	});
});
