/**
 * A note moved to another window keeps its pen working there.
 *
 * "Move to new window", a tab dragged out to a pop-out, or dragged back, keeps the note's editor and moves its
 * elements into the other window's document. The pen router binds five listeners on the window when it is built: the
 * blur that commits a stroke when the window loses focus, and the four capture touch listeners that eat the pen's
 * synthesized touches and a resting palm. The overlay puts the hover dot on the body of the document it was built in.
 * Until this fix all six stayed with the first window. In the new window the dot never showed; alt-tab mid-stroke left
 * the stroke open, so the next stroke was refused; the palm guard did not run; a blur in the old window ended a stroke
 * drawn in the new one; and a note closed after the move left its listeners on the first window for the session.
 * A PDF's router is the same class and had the same leak. A pane whose router is rebuilt at a move (a PDF rebound, a
 * note's overlay mounted again) left one dead router per move on the window it left, and back there the dead router
 * ate each palm a second time.
 *
 * THE MOVE, AS THE HOST MAKES IT. The elements report the new document, then the host's window-move call runs.
 * Obsidian 1.15.0 puts that call (`onWindowMigrated`) on HTMLElement's prototype, runs it from its node-inserted
 * animation, and calls back with the new window only when the window differs; `hostWatch` below does that and nothing
 * more. The overlay answers the call: the router follows (`followWindow`) and the dot moves. The call can fail to come
 * (the pop-out closed before the next frame, animations turned off), so teardown takes each listener off the window it
 * was added to, whether or not the router followed.
 *
 * Called through an optional member, so before the fix the call does nothing and each claim fails at its own line,
 * not at a missing method. Each precondition is asserted on its own line before the claim.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { InlinePenRouter } from "./InlinePenRouter";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";
import { makePopoutWindow, type PopoutWindow } from "../../test/popoutWindow";
import { mountOverlay, RigDocument, RigEl, type MountedOverlay } from "./mountRig.test.util";

const TOUCH_TYPES = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
const WINDOW_TYPES = ["blur", ...TOUCH_TYPES] as const;

let undoWindow: () => void = () => undefined;
beforeAll(() => {
	undoWindow = installFakeWindow();
});
afterAll(() => undoWindow());

// ---- the router on a scroller that can change window -------------------------------------------------------------

type Scroller = ReturnType<typeof fakeEl> & { ownerDocument: unknown };

interface Note {
	el: Scroller;
	router: InlinePenRouter;
	rec: ReturnType<typeof recorder>;
}

const built: InlinePenRouter[] = [];
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
});

/** A note's router, built in the window whose document is `doc` (the scroller's ownerDocument). */
function noteIn(doc: unknown): Note {
	const el = Object.assign(fakeEl(), { ownerDocument: doc }) as Scroller;
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, rec.cb);
	built.push(router);
	return { el, router, rec };
}

/** The note closes: its router is disposed, once. */
function closeNote(n: Note): void {
	built.splice(built.indexOf(n.router), 1);
	n.router.dispose();
}

/** The note's elements now report `doc`: the host has moved the pane. Nothing has told the router yet. */
function moveTo(n: Note, doc: unknown): void {
	n.el.ownerDocument = doc;
}

/** The host's call reached the overlay, which tells its router. Does nothing before the fix. */
function follow(n: Note): void {
	(n.router as unknown as { followWindow?: () => void }).followWindow?.();
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

/** This router's window listeners on `w`: blur and the four touch types, each 0 or 1. */
function counts(w: PopoutWindow): Record<string, number> {
	return Object.fromEntries(WINDOW_TYPES.map((t) => [t, w.listeners(t)]));
}
const NONE = Object.fromEntries(WINDOW_TYPES.map((t) => [t, 0]));
const ONE_EACH = Object.fromEntries(WINDOW_TYPES.map((t) => [t, 1]));

/** A touch made only of the pen's synthesized stylus touches, landing in the note. */
function stylusTouch(target: unknown): { prevented: () => number; extra: Record<string, unknown> } {
	let prevented = 0;
	const touches = [{ identifier: 31, touchType: "stylus", radiusX: 1, radiusY: 1 }];
	return {
		prevented: () => prevented,
		extra: {
			target,
			changedTouches: touches,
			touches,
			preventDefault: () => void prevented++,
			stopPropagation: () => undefined,
		},
	};
}

describe("a note moved to another window: the router's window listeners follow it", () => {
	it("a blur on the new window commits the stroke drawn there", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		follow(n);
		pen(n, "pointerdown");
		expect(n.rec.downs, "the pen down in the new window was claimed").toBe(1);
		expect(activePenId(n), "the stroke is live").toBe(7);

		B.dispatch("blur");

		expect(n.rec.ups, "the new window's blur did not commit the stroke").toBe(1);
		expect(activePenId(n), "the stroke is still open after the new window's blur").toBeNull();
	});

	for (const [label, second] of [
		["the same pen id", 7],
		["a new pen id", 8],
	] as const) {
		it(`after an alt-tab mid-stroke in the new window, the next stroke (${label}) is drawn`, () => {
			const A = makePopoutWindow();
			const B = makePopoutWindow();
			const n = noteIn(A.document);
			moveTo(n, B.document);
			follow(n);
			pen(n, "pointerdown", 7);
			expect(n.rec.downs, "stroke 1 claimed").toBe(1);

			B.dispatch("blur");
			pen(n, "pointerdown", second);

			expect(n.rec.downs, "stroke 2 was refused: stroke 1 was still open after the alt-tab").toBe(2);
			expect(activePenId(n), "stroke 2 is the live one").toBe(second);
			pen(n, "pointermove", second);
			pen(n, "pointerup", second);
			expect(n.rec.ups, "stroke 1 committed by the blur, stroke 2 by its lift").toBe(2);
			expect(activePenId(n), "nothing left open").toBeNull();
		});
	}

	it("a blur on the old window leaves a stroke in the new window alone", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		follow(n);
		pen(n, "pointerdown");
		expect(activePenId(n), "the stroke is live").toBe(7);

		A.dispatch("blur");

		expect(n.rec.ups, "the old window's blur ended a stroke drawn in the new one").toBe(0);
		expect(activePenId(n), "the stroke was cut short by the old window's blur").toBe(7);
	});

	it("the palm guard runs on the new window: a stylus touch in the note is eaten there, none listens on the old", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		expect(A.listeners("touchstart"), "built in the first window, the guard listens there").toBe(1);
		moveTo(n, B.document);
		follow(n);

		const touch = stylusTouch(n.el);
		B.dispatch("touchstart", touch.extra);

		expect(touch.prevented(), "the stylus touch in the moved note was not eaten").toBe(1);
		for (const t of TOUCH_TYPES) expect(A.listeners(t), `${t} still on the old window`).toBe(0);
	});

	it("out and back: on the way out the listeners are on the new window only; back home, on the first only", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		expect(counts(A), "built in the first window").toEqual(ONE_EACH);
		moveTo(n, B.document);
		follow(n);
		expect(counts(B), "moved out: the new window").toEqual(ONE_EACH);
		expect(counts(A), "moved out: the first window").toEqual(NONE);

		moveTo(n, A.document);
		follow(n);

		expect(counts(A), "back home: the first window").toEqual(ONE_EACH);
		expect(counts(B), "back home: the pop-out").toEqual(NONE);
		B.close();
		pen(n, "pointerdown");
		A.dispatch("blur");
		expect(n.rec.ups, "a blur at home commits after the round trip").toBe(1);
	});

	it("a stroke live at the move is committed once, and a stroke in the new window is then claimed", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		pen(n, "pointerdown", 7);
		expect(activePenId(n), "a stroke is live when the pane moves").toBe(7);
		moveTo(n, B.document);
		follow(n);

		B.dispatch("blur");
		expect(n.rec.ups, "the stroke live at the move was never committed").toBe(1);
		A.dispatch("blur");
		expect(n.rec.ups, "the stroke was committed twice").toBe(1);
		pen(n, "pointerdown", 8);
		expect(n.rec.downs, "the first stroke in the new window was refused").toBe(2);
		expect(activePenId(n), "the new stroke is the live one").toBe(8);
	});

	it("a note that never moves: blur commits on its own window, and closing it leaves nothing there", () => {
		const A = makePopoutWindow();
		const n = noteIn(A.document);
		expect(counts(A), "built: one of each").toEqual(ONE_EACH);
		follow(n);
		expect(counts(A), "a call with no move changes nothing").toEqual(ONE_EACH);
		pen(n, "pointerdown");
		A.dispatch("blur");
		expect(n.rec.ups, "blur commits").toBe(1);

		closeNote(n);

		expect(counts(A), "closed").toEqual(NONE);
	});
});

describe("a note moved to another window: nothing stays listening once it closes", () => {
	it("moved and followed, then closed: none of its listeners on either window", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		follow(n);

		closeNote(n);

		expect(counts(A), "left on the first window").toEqual(NONE);
		expect(counts(B), "left on the new window").toEqual(NONE);
	});

	it("moved with no call from the host, then closed: none left on the first window", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		expect(counts(A), "no call, so the listeners are still where they were added").toEqual(ONE_EACH);

		closeNote(n);

		expect(counts(A), "left on the first window").toEqual(NONE);
	});

	it("moved and followed, then the pop-out closed before the note: none left on the pop-out", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		follow(n);
		B.close();
		// A closed window's document has no window: the router's own window read falls back to the main one.
		moveTo(n, { defaultView: null });

		closeNote(n);

		expect(counts(B), "left on the closed pop-out").toEqual(NONE);
		expect(counts(A), "left on the first window").toEqual(NONE);
	});

	it("moved with no call, then the pop-out closed before the note: none left on the first window", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		moveTo(n, B.document);
		B.close();
		moveTo(n, { defaultView: null });

		closeNote(n);

		expect(counts(A), "left on the first window").toEqual(NONE);
	});

	it("a late call after the note closed adds nothing anywhere", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const n = noteIn(A.document);
		closeNote(n);
		const before = B.calls.length;
		moveTo(n, B.document);

		follow(n);

		expect(B.calls.slice(before).filter((c) => c.op === "add"), "a closed note added listeners").toEqual([]);
		expect(counts(A), "the first window").toEqual(NONE);
	});
});

// ---- a pane whose router is rebuilt at a move: a PDF rebound, or a note's overlay mounted again -----------------
//
// A PDF's router is the same class, built with PdfInkBind's arguments. A PDF is rebound at a move (its router
// disposed after the pane is in the new window, a new one built there), and a note's overlay mounted again after a
// move builds a new router the same way. Each dispose took the listeners off the window the pane was in by then, not
// the one they were added to, so every move left a dead router listening on the window the pane left. Back in that
// window the scroller is the same element, so the dead router's touch listeners matched the pane again and each palm
// was eaten by two routers.

type Kind = "note" | "PDF";

/** The router a pane of this kind builds on `el`: a note's as the cells above build it, a PDF's as PdfInkBind does. */
function routerOn(kind: Kind, el: Scroller, rec: ReturnType<typeof recorder>): InlinePenRouter {
	const s = el as unknown as HTMLElement;
	const router =
		kind === "note"
			? new InlinePenRouter(s, s, rec.cb)
			: new InlinePenRouter(s, s, rec.cb, () => 1, "pinch-zoom", undefined, false);
	built.push(router);
	return router;
}

function paneIn(kind: Kind, doc: unknown): Note {
	const el = Object.assign(fakeEl(), { ownerDocument: doc }) as Scroller;
	const rec = recorder();
	return { el, rec, router: routerOn(kind, el, rec) };
}

/** The pane's router is disposed in the window the pane is in now, and a new one is built on the same scroller. */
function rebuild(n: Note, kind: Kind): void {
	closeNote(n);
	n.router = routerOn(kind, n.el, n.rec);
}

/** A palm resting on the pane: one palm-sized touch. Counts the router handlers that ate it. */
function palmTouch(target: unknown): { eaten: () => number; extra: Record<string, unknown> } {
	let eaten = 0;
	const touches = [{ identifier: 41, touchType: "direct", radiusX: 60, radiusY: 60 }];
	return {
		eaten: () => eaten,
		extra: {
			target,
			changedTouches: touches,
			touches,
			preventDefault: () => void eaten++,
			stopPropagation: () => undefined,
		},
	};
}

describe("a pane whose router is rebuilt at a move: no old router stays listening on the window it left", () => {
	it("a PDF opened in the first window, moved to a pop-out and closed there: none of its listeners left on the first window", () => {
		const A = makePopoutWindow();
		const B = makePopoutWindow();
		const p = paneIn("PDF", A.document);
		expect(counts(A), "built in the first window, its listeners are there").toEqual(ONE_EACH);
		moveTo(p, B.document);

		closeNote(p);

		expect(counts(A), "left on the first window").toEqual(NONE);
	});

	for (const kind of ["note", "PDF"] as const) {
		it(`a ${kind} rebuilt at each move, out to a pop-out and back: a palm on it is eaten by one router, and none stays on the pop-out`, () => {
			const A = makePopoutWindow();
			const B = makePopoutWindow();
			const p = paneIn(kind, A.document);
			moveTo(p, B.document);
			rebuild(p, kind);
			expect(B.listeners("touchstart"), "rebuilt in the pop-out, the new router listens there").toBe(1);
			moveTo(p, A.document);
			rebuild(p, kind);
			expect(A.listeners("touchstart"), "rebuilt back home, the new router listens there").toBeGreaterThan(0);

			const palm = palmTouch(p.el);
			A.dispatch("touchstart", palm.extra);

			expect(palm.eaten(), "the palm was eaten by more than one router: a dead one still listens here").toBe(1);
			expect(counts(B), "left on the pop-out").toEqual(NONE);
		});
	}
});

// ---- the overlay: the host's call reaches it, the dot moves, the router follows ---------------------------------

interface Watch {
	node: RigEl;
	win: unknown;
	listener: (win: Window) => unknown;
	live: boolean;
}
let watches: Watch[] = [];

/** The host's `onWindowMigrated`: remembers the window, hands back the call that ends the watch. */
function hostWatch(this: RigEl, listener: (win: Window) => unknown): () => void {
	const watch: Watch = { node: this, win: this.ownerDocument.defaultView, listener, live: true };
	watches.push(watch);
	return () => {
		watch.live = false;
	};
}

/** The host's side of a move: each live watch whose node now reports another window is called back with it. */
function hostCallsMoved(): void {
	for (const watch of [...watches]) {
		if (!watch.live) continue;
		const win = watch.node.ownerDocument.defaultView;
		if (win === watch.win) continue;
		watch.win = win;
		watch.listener(win as unknown as Window);
	}
}

type HostProto = { onWindowMigrated?: typeof hostWatch };
function giveHostCall(): void {
	(RigEl.prototype as unknown as HostProto).onWindowMigrated = hostWatch;
}
afterEach(() => {
	delete (RigEl.prototype as unknown as HostProto).onWindowMigrated;
	watches = [];
});

/** What a move to another window does to the editor's elements: every one now reports that document. */
function reportDocument(el: RigEl, doc: RigDocument): void {
	(el as unknown as { ownerDocument: RigDocument }).ownerDocument = doc;
	for (const kid of el.children) reportDocument(kid, doc);
}

/** A second window for the overlay: a counted pop-out whose document is a rig document the overlay can build in. */
function rigPopout(): { B: PopoutWindow; docB: RigDocument } {
	const B = makePopoutWindow();
	const docB = new RigDocument();
	(docB as unknown as { defaultView: unknown }).defaultView = B.window;
	(B.window as unknown as { document: unknown }).document = docB;
	// The rig body knows createDiv and remove; a real body also takes an element in.
	const body = docB.body as RigEl & { appendChild(el: RigEl): RigEl; append(...els: RigEl[]): void };
	body.appendChild = (el: RigEl) => {
		el.remove();
		el.parentElement = body;
		el.isConnected = true;
		body.children.push(el);
		(el as unknown as { ownerDocument: RigDocument }).ownerDocument = docB;
		return el;
	};
	body.append = (...els: RigEl[]) => {
		for (const el of els) body.appendChild(el);
	};
	return { B, docB };
}

const dots = (doc: RigDocument): RigEl[] => doc.body.children.filter((c) => c.classes.has("handwriting-pen-cursor"));

const mounted: MountedOverlay[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.destroy();
});
function mount(path: string): MountedOverlay {
	const m = mountOverlay(path);
	mounted.push(m);
	return m;
}

describe("a note moved to another window: the overlay follows the host's call", () => {
	it("the overlay's move takes the hover dot to the new window's body, and none stays in the old", () => {
		const m = mount("NoteWindowMove/dot.md");
		const { B, docB } = rigPopout();
		const dot = m.o.penCursorEl as RigEl;
		expect(dots(m.doc), "built: the dot is on the first window's body").toEqual([dot]);
		reportDocument(m.root, docB);

		(m.o as { windowMoved?: (win: Window) => void }).windowMoved?.(B.window);

		expect(dots(docB), "the dot is not on the new window's body").toEqual([m.o.penCursorEl]);
		expect(dots(m.doc), "a dot stayed on the old window's body").toEqual([]);
	});

	it("the host's call reaches the overlay: the dot moves and the router's listeners are on the new window", () => {
		giveHostCall();
		const m = mount("NoteWindowMove/wired.md");
		const { B, docB } = rigPopout();
		expect(watches.some((w) => w.live), "mounted: the overlay watches for a window move").toBe(true);
		expect(counts(B), "before the move: nothing on the pop-out").toEqual(NONE);

		reportDocument(m.root, docB);
		hostCallsMoved();

		expect(dots(docB).length, "the dot is not on the new window's body").toBe(1);
		expect(dots(m.doc), "a dot stayed on the old window's body").toEqual([]);
		expect(counts(B), "the router's listeners did not follow to the new window").toEqual(ONE_EACH);
	});

	it("closed after the move: none of its router's listeners stay on the new window", () => {
		giveHostCall();
		const m = mount("NoteWindowMove/closed.md");
		const { B, docB } = rigPopout();
		reportDocument(m.root, docB);
		hostCallsMoved();
		expect(counts(B), "the router followed").toEqual(ONE_EACH);

		mounted.splice(mounted.indexOf(m), 1);
		m.destroy();

		expect(counts(B), "left on the new window").toEqual(NONE);
		expect(dots(docB), "the dot outlived the note").toEqual([]);
	});

	it("the watch ends with the overlay: a late call after it closed adds nothing", () => {
		giveHostCall();
		const m = mount("NoteWindowMove/late.md");
		const { B, docB } = rigPopout();
		expect(watches.some((w) => w.live), "premise: the open overlay watches for a window move").toBe(true);
		mounted.splice(mounted.indexOf(m), 1);
		m.destroy();
		expect(watches.some((w) => w.live), "the closed overlay still watches for a window move").toBe(false);
		const before = B.calls.length;

		reportDocument(m.root, docB);
		hostCallsMoved();

		expect(B.calls.slice(before).filter((c) => c.op === "add"), "a closed note added listeners").toEqual([]);
		expect(dots(docB), "a closed note put a dot on the new window").toEqual([]);
	});

	it("an editor with no host call (a bare element) mounts and binds as before", () => {
		const m = mount("NoteWindowMove/bare.md");
		expect("onWindowMigrated" in m.scrollDOM, "premise: this scroller has no host call").toBe(false);
		expect(m.o.router, "the router was not built").toBeTruthy();
		expect(dots(m.doc), "the dot is on its own window's body").toEqual([m.o.penCursorEl]);
	});
});
