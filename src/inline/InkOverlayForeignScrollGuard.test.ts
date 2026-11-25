/** GitHub issue 66: a scroll request the overlay did not issue, with an ink contact down or just lifted through the real router. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inkOverlayExtension, viewportScrollLifetime } from "./InkOverlay";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "./InlinePenRouterTrace";
import { type MountedOverlay, RigEl, mountOverlay } from "./mountRig.test.util";
import { penEvent } from "../../test/routerHarness";
import { resetPenInkForTest, setPenInk } from "./PenInk";
import { resetTipModeForTest } from "./TipMode";
import { setMouseInk } from "./MouseInk";
import { noteCameras } from "./NoteCamera";

/** The film note's top before and after the caret reveal on body line 1. */
const FILM_TOP = 1150;
const REVEALED_TOP = 8.3;
/** A left that is not 0. */
const HELD_LEFT = 1000;
/** Stand-in left for the editor's own reveal of a caret at the column start. */
const REVEALED_LEFT = 35;
/** The caret on body line 1 of the film note. */
const CARET = 73;

type Handler = Parameters<typeof EditorView.scrollHandler.of>[0];
type Target = Parameters<Handler>[2] & { range: SelectionRange };
type Listener = { el: unknown; type: string; fn: (ev: unknown) => void };

interface Router {
	activePenId: number | null;
	activeIsFinger: boolean;
	ownershipTailUntil: number;
	penOff(): boolean;
	cb: { fingerInk?: () => boolean };
}

let m: MountedOverlay;
let others: MountedOverlay[];
let seen: Listener[];
let chain: readonly Handler[];
let thrown: unknown[];
let retired: string[];

/** A fake editor whose overlay plugin is `mm`'s. */
const viewOf = (mm: MountedOverlay) => ({ plugin: () => mm.o }) as unknown as EditorView;
const views = new WeakMap<MountedOverlay, EditorView>();
const view = (mm: MountedOverlay = m): EditorView => {
	let v = views.get(mm);
	if (!v) views.set(mm, (v = viewOf(mm)));
	return v;
};

/** The real chain our extension puts on an editor, highest first; with the lifetime appended, our handler is listed twice. */
function scrollChain(withLifetime = false): readonly Handler[] {
	const extensions = withLifetime ? [inkOverlayExtension(), viewportScrollLifetime(view()).extension] : [inkOverlayExtension()];
	return EditorState.create({ doc: "a\nb\nc", extensions }).facet(EditorView.scrollHandler);
}

/** A request as the editor holds it from the dispatch on (ScrollTarget, @codemirror/view 6.38.6). */
const target = (range: SelectionRange): Target => ({ range, x: "nearest", y: "nearest", xMargin: 5, yMargin: 5 });

/**
 * The editor's own request path (DocView.scrollIntoView, @codemirror/view 6.38.6): each handler in its own try/catch, a throw
 * logged and the next handler run; the first to answer true takes it; none, and the default scroll moves the page.
 */
function run(t: Target, mm: MountedOverlay = m): boolean {
	for (const h of chain) {
		try {
			if (h(view(mm), t.range, t)) return true;
		} catch (e) {
			thrown.push(e);
		}
	}
	mm.scrollDOM.scrollTop = REVEALED_TOP;
	mm.scrollDOM.scrollLeft = REVEALED_LEFT;
	return false;
}
const request = (range: SelectionRange, mm: MountedOverlay = m) => run(target(range), mm);

/** The router's listener on a scroller for one event type. */
function fire(type: string, ev: unknown, mm: MountedOverlay = m): void {
	const l = seen.find((x) => x.el === mm.scrollDOM && x.type === type);
	if (!l) throw new Error(`the router put no ${type} listener on the scroller`);
	l.fn(ev);
}

const now = () => performance.now();
const kind = (pointerType = "pen") => ({ pointerType, pointerId: pointerType === "pen" ? 7 : pointerType === "mouse" ? 1 : 11, x: 40, y: 40 });
const hover = (mm?: MountedOverlay) => fire("pointermove", penEvent("pointermove", now(), { ...kind(), buttons: 0, pressure: 0 }), mm);
const down = (mm?: MountedOverlay, type?: string) => fire("pointerdown", penEvent("pointerdown", now(), { ...kind(type), pressure: 0.5 }), mm);
const lift = (mm?: MountedOverlay, type?: string) => fire("pointerup", penEvent("pointerup", now(), { ...kind(type), buttons: 0, pressure: 0 }), mm);
const router = (mm: MountedOverlay = m) => mm.o.router as unknown as Router;
const place = (mm: MountedOverlay = m) => ({ top: mm.scrollDOM.scrollTop, left: mm.scrollDOM.scrollLeft });
const park = (mm: MountedOverlay) => {
	mm.scrollDOM.scrollHeight = 48000;
	mm.scrollDOM.scrollWidth = 4000;
	mm.scrollDOM.scrollTop = FILM_TOP;
	mm.scrollDOM.scrollLeft = HELD_LEFT;
};
const rows = () =>
	formatInlinePenTrace()
		.split("\n")
		.filter((line) => /ms {2}scroll-request-foreign /.test(line));

/** A second note in its own pane, its own overlay and router. */
function otherPane(path: string): MountedOverlay {
	const o = mountOverlay(path);
	for (const name of ["penDown", "penRaw", "penUp"]) o.o[name] = () => {};
	park(o);
	others.push(o);
	return o;
}

/** The pane opens another note: the overlay's own update() on an editor whose file changed (Obsidian reuses the editor). */
function openInPane(path: string): void {
	const v = m.o.view as { state: { field(): { file: { path: string } } } };
	v.state.field().file = { path };
	(m.o.update as (u: unknown) => void)({
		transactions: [],
		docChanged: false,
		geometryChanged: false,
		viewportChanged: false,
		heightChanged: false,
		focusChanged: false,
		selectionSet: false,
		state: v.state,
		startState: v.state,
		view: v,
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	resetPenInkForTest();
	resetTipModeForTest();
	setMouseInk(false);
	noteCameras.clear();
	seen = [];
	others = [];
	thrown = [];
	vi.spyOn(RigEl.prototype, "addEventListener").mockImplementation(function (this: RigEl, ...a: unknown[]) {
		seen.push({ el: this, type: String(a[0]), fn: a[1] as (ev: unknown) => void });
	});
	m = mountOverlay("pen66/film.md");
	// The overlay's own stroke (camera, tail, extent) needs a laid-out page the rig has none of; the router that claims it is real.
	for (const name of ["penDown", "penRaw", "penUp"]) m.o[name] = () => {};
	retired = [];
	const retire = m.o.retirePanSettle as (reason: string) => void;
	m.o.retirePanSettle = function (this: unknown, reason: string) {
		retired.push(reason);
		return retire.call(this, reason);
	};
	chain = scrollChain();
	park(m);
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
	vi.advanceTimersByTime(10_000);
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	for (const o of others) o.destroy();
	m.destroy();
	noteCameras.clear();
	resetPenInkForTest();
	resetTipModeForTest();
	setMouseInk(false);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("issue 66: a reveal the overlay did not issue, with an ink contact at the page", () => {
	it("precondition: our handler is first in the chain, and the pen is lit and in reach", () => {
		expect(chain.length, "the extension's scroll handlers").toBeGreaterThanOrEqual(1);
		expect(router().penOff(), "a tool is lit").toBe(false);
		down();
		expect(router().activePenId, "the contact was claimed by the real router").not.toBe(null);
		lift();
		expect(router().activePenId, "the lift ended it").toBe(null);
		expect(router().penOff(), "still lit after the lift").toBe(false);
	});

	it("pen down: top and left stay where they are, and one row says why", () => {
		down();
		expect(router().activePenId, "precondition: the pen is down").not.toBe(null);
		vi.advanceTimersByTime(16);
		expect(request(EditorSelection.cursor(CARET)), "the request was taken").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toContain("kept, contact");
		expect(rows()[0]).toContain(`scrollTop ${FILM_TOP} scrollLeft ${HELD_LEFT}`);
		lift();
	});

	it("349 ms after the lift: kept; 351 ms: moves as before; each has its row with the ms since the lift", () => {
		down();
		lift();
		vi.advanceTimersByTime(349);
		expect(request(EditorSelection.cursor(CARET)), "inside the lift tail").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		vi.advanceTimersByTime(2);
		expect(request(EditorSelection.cursor(CARET)), "past the tail").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("kept, 349 ms since lift"), expect.stringContaining("passed, 351 ms since lift")]);
	});

	it("a pen hovering with no contact does not hold the page: a hover stream for 600 ms, then a request, moves as before", () => {
		for (let t = 0; t < 600; t += 16) {
			hover();
			vi.advanceTimersByTime(16);
		}
		hover();
		expect(request(EditorSelection.cursor(CARET))).toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("passed, no lift")]);
	});

	it("a tool lit and no contact yet: moves as before, and the row says passed", () => {
		expect(request(EditorSelection.cursor(CARET))).toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("passed, no lift")]);
	});

	it("tools off (keyboard mode) 50 ms after a lift: moves as before, no row", () => {
		down();
		lift();
		expect(router().penOff(), "precondition: lit through the contact").toBe(false);
		setPenInk(false);
		expect(router().penOff(), "precondition: the pen is off").toBe(true);
		vi.advanceTimersByTime(50);
		expect(request(EditorSelection.cursor(CARET))).toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([]);
	});

	it("every request in the window is its own row; diagnostics off, still kept and no row", () => {
		down();
		vi.advanceTimersByTime(20);
		request(EditorSelection.cursor(CARET));
		request(EditorSelection.range(0, 4));
		expect(rows()).toHaveLength(2);
		clearInlinePenTrace();
		setDiagnosticsEnabled(false);
		expect(request(EditorSelection.cursor(CARET))).toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		setDiagnosticsEnabled(true);
		expect(rows(), "nothing written while off").toHaveLength(0);
		lift();
	});

	it("a kept request changes nothing else: no dispatch, no scroller style or class", () => {
		down();
		const style = { ...m.scrollDOM.style };
		const classes = [...m.scrollDOM.classes];
		const dispatched = m.dispatched.length;
		expect(request(EditorSelection.cursor(CARET))).toBe(true);
		expect(m.dispatched.length).toBe(dispatched);
		expect({ ...m.scrollDOM.style }).toEqual(style);
		expect([...m.scrollDOM.classes]).toEqual(classes);
		lift();
	});
});

describe("issue 66: what opens and closes the window", () => {
	it("only this note's router: a stroke in another pane, down or just lifted, does not hold this note's page", () => {
		const b = otherPane("pen66/beside.md");
		expect(router(b), "precondition: the other pane has its own router").not.toBe(router());
		down(b);
		expect(router(b).activePenId, "precondition: a contact is down in the other pane").not.toBe(null);
		expect(request(EditorSelection.cursor(CARET)), "this note, the other pane's pen down").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(request(EditorSelection.cursor(CARET), b), "the other pane's own request, its pen down").toBe(true);
		expect(place(b)).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		lift(b);
		park(m);
		vi.advanceTimersByTime(100);
		expect(request(EditorSelection.cursor(CARET)), "this note, 100 ms after the other pane's lift").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
	});

	it("a file change in the pane closes it: a lift on one note, the pane opens another, a request 100 ms on moves as before", () => {
		down();
		lift();
		vi.advanceTimersByTime(50);
		openInPane("pen66/next.md");
		expect((m.o.filePath as () => string | null)(), "precondition: the pane shows the other note").toBe("pen66/next.md");
		park(m);
		vi.advanceTimersByTime(50);
		expect(request(EditorSelection.cursor(CARET)), "100 ms after the lift, on the note just opened").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("passed")]);
	});

	it("a mouse ink stroke opens it as the pen does: down and its lift tail", () => {
		setMouseInk(true);
		down(m, "mouse");
		expect(router().activePenId, "precondition: the router claimed the mouse").not.toBe(null);
		expect(request(EditorSelection.cursor(CARET)), "mouse down").toBe(true);
		lift(m, "mouse");
		vi.advanceTimersByTime(100);
		expect(request(EditorSelection.cursor(CARET)), "100 ms after the mouse lift").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
	});

	it("a finger ink stroke opens it while down; the router sets no lift tail for a finger, so 100 ms after it moves as before", () => {
		router().cb.fingerInk = () => true;
		down(m, "touch");
		expect(router().activePenId, "precondition: the router claimed the finger").not.toBe(null);
		expect(router().activeIsFinger, "precondition: as finger ink").toBe(true);
		expect(request(EditorSelection.cursor(CARET)), "finger down").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		lift(m, "touch");
		expect(router().ownershipTailUntil, "precondition: no tail after a finger lift").toBeLessThanOrEqual(now());
		vi.advanceTimersByTime(100);
		expect(request(EditorSelection.cursor(CARET)), "100 ms after the finger lift").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
	});

	it("judged when the handler runs: made at lift+340 and run at +356 moves; made before a pen-down and run after it is kept", () => {
		down();
		lift();
		vi.advanceTimersByTime(340);
		const late = target(EditorSelection.cursor(CARET));
		vi.advanceTimersByTime(16);
		expect(run(late), "run at +356").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("passed, 356 ms since lift")]);
		park(m);
		vi.advanceTimersByTime(1000);
		const early = target(EditorSelection.cursor(CARET));
		down();
		vi.advanceTimersByTime(16);
		expect(run(early), "made before the pen-down, run after it").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		lift();
	});
});

describe("issue 66: one row per request, and the row cannot change the answer", () => {
	it("with our handler listed twice (the lifetime appended): one request, one row, kept or passed", () => {
		chain = scrollChain(true);
		expect(chain.length, "precondition: two of our handlers").toBeGreaterThanOrEqual(2);
		down();
		expect(request(EditorSelection.cursor(CARET)), "in the window").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		lift();
		vi.advanceTimersByTime(400);
		expect(request(EditorSelection.cursor(CARET)), "out of it, a tool lit").toBe(false);
		expect(place()).toEqual({ top: REVEALED_TOP, left: REVEALED_LEFT });
		expect(rows()).toEqual([expect.stringContaining("kept, contact"), expect.stringContaining("passed, 400 ms since lift")]);
		expect(thrown).toEqual([]);
	});

	it("a row that throws: the request is still kept, nothing reaches the editor's catch, no second row", () => {
		chain = scrollChain(true);
		const range = EditorSelection.cursor(CARET);
		Object.defineProperty(range, "head", { get: () => { throw new Error("row read"); } });
		down();
		expect(request(range), "in the window").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		expect(thrown, "a throw in our handler would be logged by the editor and the next handler run").toEqual([]);
		expect(rows().length).toBeLessThanOrEqual(1);
		lift();
	});
});

describe("as before: our own request, the settle retire, the pending receipt", () => {
	// A pen-down retires a settle itself ("viewport input"), so each request's retires are read from just before it.
	it("a request the overlay did not issue still retires a pending settle, kept or let through", () => {
		const foreign = "a scroll request the overlay did not issue";
		down();
		retired.length = 0;
		expect(request(EditorSelection.cursor(CARET)), "kept").toBe(true);
		expect(retired).toEqual([foreign]);
		lift();
		vi.advanceTimersByTime(400);
		retired.length = 0;
		expect(request(EditorSelection.cursor(CARET)), "let through").toBe(false);
		expect(retired).toEqual([foreign]);
	});

	it("our own request is taken in and out of the window, writes no row, and settles its hold as before", () => {
		const v = m.o.view as { state: Record<string, unknown> };
		v.state.doc = { length: 77 };
		const own = (m.o.ownScrollRange as (r: SelectionRange, owner: object) => SelectionRange)(EditorSelection.cursor(CARET), {});
		down();
		retired.length = 0;
		expect(request(own), "in the window").toBe(true);
		expect(retired).toEqual([]);
		lift();
		vi.advanceTimersByTime(400);
		retired.length = 0;
		expect(request(own), "out of it").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		expect(rows()).toEqual([]);
		expect(retired).toEqual([]);

		down();
		retired.length = 0;
		const hold = { left: HELD_LEFT, top: FILM_TOP + 1, ready: true, outcome: undefined as string | undefined };
		m.o.panAnchorHold = hold;
		const held = (m.o.ownScrollRange as (r: SelectionRange, owner: object) => SelectionRange)(EditorSelection.cursor(CARET), hold);
		expect(request(held)).toBe(true);
		expect(hold.outcome, "the scroller is not where the hold left it").toBe("cancelled");
		expect(retired).toEqual(["consumed"]);
		lift();
	});

	it("the pending receipt is let go on a request we did not issue, kept or let through", () => {
		const lifetime = viewportScrollLifetime(view());
		lifetime.pending = {} as never;
		down();
		request(EditorSelection.cursor(CARET));
		expect(lifetime.pending).toBe(null);
		lift();
		lifetime.pending = {} as never;
		vi.advanceTimersByTime(400);
		request(EditorSelection.cursor(CARET));
		expect(lifetime.pending).toBe(null);
	});
});

describe("a request shaped as the page id write's, not its own", () => {
	it("made here with the write's look (a character, side 1, its top at a margin) 36 ms after the lift: kept, with its row", () => {
		down();
		lift();
		vi.advanceTimersByTime(36);
		const like = EditorView.scrollIntoView(EditorSelection.cursor(CARET, 1), { y: "start", yMargin: -4.5 }).value as Target;
		expect(run(like), "a request not ours in the lift tail").toBe(true);
		expect(place()).toEqual({ top: FILM_TOP, left: HELD_LEFT });
		expect(rows()).toEqual([expect.stringContaining("kept, 36 ms since lift")]);
		expect(thrown).toEqual([]);
	});
});
