/**
 * A mouse-only user's way to the pen toolbar, and it is now a ruling.
 *
 * ALAN, 2026-09-03: "their way in is the command palette" - and, a minute
 * later, "or the settings menu". He was asked because the two rulings of that
 * evening close a loop around anyone with no pen and mouse ink off:
 *
 *   - `penToolsVisible("auto", isMobile=false, seen=false)` is false, so a
 *     desktop shows no strip until something marks a pen seen; and
 *   - `pointerRaisesPenTools` refuses an unarmed mouse, so hovering the page
 *     marks nothing (his checklist item 10, and it must stay that way); and
 *   - the control that arms mouse ink is a button ON the strip they cannot
 *     see.
 *
 * The way out is deliberately NOT a new gesture. A click that marked the strip
 * visible was proposed and REJECTED - it would have put the router's founding
 * "Mouse -> never touched" contract at risk to save a keystroke, and a plain
 * mouse must keep selecting text. Two existing controls answer it instead, and
 * because Alan has ruled them THE way in they carry weight they did not carry
 * as conveniences: if either ever stops working, a whole class of user is
 * stranded with no fallback at all. So they get a guard.
 *
 * BOTH SURFACES, and the pdf half is the one that matters. The note surface
 * hears about a mode change through `refreshPenToolsAll` (InkOverlay.ts),
 * which walks InkOverlay's own `instances`; the pdf surface is not in that set
 * and hears through `onPenToolsChanged` (PenToolsMode.ts) instead. Two
 * mechanisms, one ruling - which is this project's most expensive defect shape
 * and the reason a hatch proved on a note proves nothing about a pdf. The 1.5.0
 * line is the live demonstration: its `PdfInkController` imports `markPenSeen`
 * and nothing else, never calls `penToolsVisible`, and has no subscription to
 * be told with, so on that branch both hatches are dead on a pdf while working
 * on a note.
 *
 * The two hatches are spelled here exactly as their call sites spell them -
 * `pen-tools-cycle`'s callback and the settings tab's `case "penTools"`, both
 * in main.ts. They are three lines each and both are registered inside
 * `onload`, which a test cannot drive; a reconstruction is the honest second
 * best, so it is kept to the module calls and the ORDER, and the surface work
 * underneath it is all real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Desktop. The whole lockout is the desktop branch of "auto". */
const platform = vi.hoisted(() => ({ isMobileApp: false }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Platform: {
			...(actual.Platform as Record<string, unknown>),
			get isMobileApp(): boolean {
				return platform.isMobileApp;
			},
		},
	};
});

/**
 * A counting stand-in, the shape `PdfPenTools.test.ts` uses. This file asks
 * WHETHER a strip exists, never what it looks like, and both surfaces import
 * the same module - so one mock covers the note's `./MobileTools` and the
 * pdf's `../inline/MobileTools`, which resolve to the same file.
 */
const strips = vi.hoisted(() => ({ live: 0 }));
vi.mock("./MobileTools", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class MobileTools {
		constructor() {
			strips.live++;
		}
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		destroy(): void {
			strips.live--;
		}
	}
	return { ...actual, MobileTools };
});

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { InkOverlayPlugin, refreshPenToolsAll } from "./InkOverlay";
import { mouseInkEnabled, setMouseInk } from "./MouseInk";
import {
	getPenToolsMode,
	nextPenToolsMode,
	normalizePenToolsMode,
	penHardwareSeen,
	penSeenThisSession,
	resetPenToolsForTest,
	setPenToolsMode,
} from "./PenToolsMode";
import { PdfInkController } from "../pdf/PdfInkController";

/** The gesture path rebinds, which constructs observers Node does not have. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

// ---- the two hatches, as main.ts spells them --------------------------------

/**
 * "Toolbar: auto / show / hide" (`pen-tools-cycle`). One press.
 *
 * The order is the command's order and it is load-bearing in one direction:
 * `setPenToolsMode` announces to the pdf, `refreshPenToolsAll` walks the
 * notes, and a hatch that did only one of them would work on one surface.
 */
function pressToolbarCommand(): void {
	setPenToolsMode(nextPenToolsMode(getPenToolsMode()));
	refreshPenToolsAll();
}

/** Settings -> Appearance -> Pen toolbar, picking a value outright. */
function pickPenToolbarSetting(raw: string): void {
	setPenToolsMode(normalizePenToolsMode(raw));
	refreshPenToolsAll();
}

// ---- the note surface -------------------------------------------------------

type Overlay = { ensurePenTools(): void; destroy(): void };

/**
 * A real `InkOverlayPlugin`, registered in the real `instances` set.
 *
 * Constructed rather than `Object.create`d on purpose: `refreshPenToolsAll`
 * walks `instances`, and an overlay that never entered it would let the note
 * half of this file pass with the fan-out deleted. The constructor calls
 * `mount()`, which is far too heavy for a fixture - so `state.field` answers
 * `undefined` first, which is `mount`'s own "not a file-backed editor" exit,
 * and only then starts answering with the app that `ensurePenToolsInner`
 * needs. The two fields `mount` would have set are supplied by hand.
 */
function noteOverlay(): Overlay {
	let mounted = false;
	const noop = (): void => undefined;
	// Enough of an editor for `destroy()` to run to the end. It has to: the
	// only thing that takes an overlay back out of `instances` is
	// `instances.delete(this)` on `destroy`'s last line, so a teardown that
	// throws half way leaves this fixture in the fan-out for the rest of the
	// file - and the next test's one press then builds a strip on every
	// overlay any earlier test opened. That is not a hypothetical; it is what
	// this fixture did before the members below were added.
	const dom = {
		parentElement: { setCssStyles: noop },
		ownerDocument: {
			defaultView: { getComputedStyle: () => ({ position: "relative" }), cancelAnimationFrame: noop },
		},
		style: { removeProperty: noop },
		setCssStyles: noop,
	};
	const view = {
		dom,
		scrollDOM: {
			removeEventListener: noop,
			addEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
		},
		state: {
			field: () =>
				mounted ? { app: { commands: { executeCommandById: noop } } } : undefined,
		},
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	mounted = true;
	overlay.container = { nodeType: 1, remove: noop };
	overlay.mobileTools = null;
	overlay.applyToolbarCorner = noop;
	return overlay as unknown as Overlay;
}

// ---- the pdf surface --------------------------------------------------------

/** Enough element for the reticle to be created and styled, and no more. */
function fakeEl(): Record<string, unknown> {
	return {
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		setAttribute: () => {},
		setCssStyles: () => {},
		remove: () => {},
		parentElement: null as unknown,
	};
}

/** `PdfPenTools.test.ts`'s controller fixture, which already mounts one. */
function pdfController(): PdfInkController {
	const scroller: Record<string, unknown> = {
		scrollLeft: 0,
		scrollTop: 0,
		classList: { add: () => {}, remove: () => {} },
		querySelector: () => null,
		setCssStyles: () => {},
	};
	scroller.createDiv = (): Record<string, unknown> => {
		const el = fakeEl();
		el.parentElement = scroller;
		return el;
	};
	probe.current = {
		scroller,
		scaleFactor: 2,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
	};
	const root = {
		addEventListener: () => {},
		removeEventListener: () => {},
		setAttribute: () => {},
		hasAttribute: () => false,
	} as unknown as HTMLElement;
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { maxTouchPoints: 0, userAgent: "test" },
	};
	return new PdfInkController(
		root,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => []
	);
}

// ---- the tests --------------------------------------------------------------

describe("a mouse-only user reaches the pen toolbar, and only through the two ruled hatches", () => {
	let notes: Overlay[] = [];
	let pdfs: PdfInkController[] = [];

	beforeEach(() => {
		// Clears the mode, both pen flags AND the subscriber registry, so a
		// controller mounted below is the only thing listening.
		resetPenToolsForTest();
		setMouseInk(false);
		platform.isMobileApp = false;
		strips.live = 0;
		notes = [];
		pdfs = [];
	});

	afterEach(() => {
		// `destroy` is what takes a note overlay back out of `instances`;
		// leaking one would leave a dead fixture in the next test's fan-out.
		for (const n of notes) n.destroy();
		for (const c of pdfs) c.unmount();
	});

	function openNote(): Overlay {
		const n = noteOverlay();
		notes.push(n);
		n.ensurePenTools();
		return n;
	}

	function openPdf(): PdfInkController {
		const c = pdfController();
		pdfs.push(c);
		c.mount();
		return c;
	}

	it("starts locked out on both surfaces, which is the state the hatches exist for", () => {
		// Desktop, "auto", no pen seen, mouse ink off. This is also the
		// visibility half of Alan's checklist item 10: nothing appears, and
		// nothing about the hatches below may change that.
		openNote();
		openPdf();
		expect(penSeenThisSession()).toBe(false);
		expect(strips.live).toBe(0);
	});

	it("one press of the toolbar command puts a strip on a note", () => {
		openNote();
		pressToolbarCommand();
		expect(getPenToolsMode()).toBe("show");
		expect(strips.live).toBe(1);
	});

	it("one press of the toolbar command puts a strip on a pdf too", () => {
		// The half that is dead on the 1.5.0 line. The note fan-out cannot
		// reach this controller - it is not in InkOverlay's `instances` - so
		// the strip below exists only because `setPenToolsMode` announced and
		// the controller was subscribed to hear it.
		openPdf();
		pressToolbarCommand();
		expect(strips.live).toBe(1);
	});

	it("the toolbar command reaches a note and a pdf in the same press", () => {
		openNote();
		openPdf();
		pressToolbarCommand();
		expect(strips.live).toBe(2);
	});

	it("the settings menu reaches both surfaces the same way", () => {
		// Alan's second hatch. It differs from the command in one respect
		// only - it names the value instead of stepping to it - so it lands
		// on "show" from any starting mode rather than from "auto" alone.
		openNote();
		openPdf();
		pickPenToolbarSetting("show");
		expect(strips.live).toBe(2);
	});

	it("the settings menu rescues a user the cycle has left on hide", () => {
		openNote();
		openPdf();
		pickPenToolbarSetting("hide");
		expect(strips.live).toBe(0);
		pickPenToolbarSetting("show");
		expect(strips.live).toBe(2);
	});

	it("only one of the cycle's three positions shows this user a toolbar", () => {
		// Not a defect and not a fix - a fact about the hatch, pinned because
		// it is what makes the command LOOK broken to the one user who has
		// nothing else. "auto" and "hide" are the same picture on a desktop
		// with no pen, so two presses in three produce nothing on screen and
		// the toast is the only feedback there is. Anyone tempted to reorder
		// PEN_TOOLS_MODES so a locked-out press lands somewhere friendlier
		// will land here first.
		openNote();
		openPdf();
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			pressToolbarCommand();
			seen.push(`${getPenToolsMode()}:${strips.live}`);
		}
		expect(seen).toEqual(["show:2", "hide:0", "auto:0"]);
	});

	it("neither hatch claims a pen, and neither arms the mouse", () => {
		// The hatches change VISIBILITY and nothing else. If either ever
		// marked a pen seen, "auto" would latch true for the session and the
		// user could never get back to the mode they started in; if either
		// armed mouse ink, a command about a toolbar would have silently
		// taken text selection away. `armTipModeInput` (main.ts) is the one
		// place allowed to arm the mouse, and it is asking for a TOOL.
		openNote();
		openPdf();
		pressToolbarCommand();
		pickPenToolbarSetting("show");
		expect(penSeenThisSession()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
		expect(mouseInkEnabled()).toBe(false);
	});

	it("a hovering mouse with ink off still raises nothing, hatches or not", () => {
		// Checklist item 10, held against the file that exists to make the
		// toolbar reachable. The hatch is a control the user operates, never
		// a pointer the surface reacts to.
		const note = openNote();
		openPdf();
		pressToolbarCommand();
		pressToolbarCommand();
		pressToolbarCommand();
		note.ensurePenTools();
		expect(getPenToolsMode()).toBe("auto");
		expect(penSeenThisSession()).toBe(false);
		expect(strips.live).toBe(0);
	});
});
