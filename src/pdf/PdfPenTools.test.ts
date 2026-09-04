/**
 * "Pen toolbar" on a PDF: the setting decides, the same way it does on a note.
 *
 * The sixth surface divergence (StripPenChrome.test.ts's header lists the
 * first five). `penToolsVisible` (PenToolsMode.ts) is the whole visibility
 * rule and it is pure and already factored, but until 1.4.8 it had exactly
 * one caller in the tree - `ensurePenToolsInner` on the note surface.
 * `PdfInkController.ensureTools` built a MobileTools on the first pen contact
 * and consulted nothing, so Settings → Appearance → Pen toolbar → Hide hid
 * the strip on notes and left it floating over every PDF (alan, 2026-09-02).
 *
 * Driven through the controller, not through the rule: `penToolsVisible` was
 * already tested and already correct, and testing it again would have passed
 * on every build that had this bug. What was missing was the CALL, so these
 * mount a controller and count strips.
 *
 * Three things are stubbed and nothing else. The viewer probe, as every PDF
 * suite here stubs it. `Platform`, so the mobile branch of "auto" can be
 * asked for on a desktop test runner. And MobileTools, because a strip builds
 * real DOM and this file is about WHETHER one exists, not what it looks like
 * - a counting stand-in makes "no strip", "one strip" and "the strip that was
 * there is gone" three assertions instead of three DOM queries.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

/** The desktop/mobile answer, flipped per test. */
const platform = vi.hoisted(() => ({ isMobileApp: false }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		// Spread first, getter second: every other flag keeps the suite-wide
		// stub's value and only this one is answered live.
		Platform: {
			...(actual.Platform as Record<string, unknown>),
			get isMobileApp(): boolean {
				return platform.isMobileApp;
			},
		},
	};
});

/** How many strips have been built, destroyed, and are alive right now. */
const strips = vi.hoisted(() => ({ built: 0, destroyed: 0, live: 0 }));
vi.mock("../inline/MobileTools", () => {
	class MobileTools {
		constructor() {
			strips.built++;
			strips.live++;
		}
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		destroy(): void {
			strips.destroyed++;
			strips.live--;
		}
	}
	return { MobileTools };
});

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "./PdfInkController";
import { PenSample } from "../input/PointerRouter";
import {
	markPenSeen,
	penHardwareSeen,
	penSeenThisSession,
	penToolsListenerCountForTest,
	resetPenToolsForTest,
	setPenToolsMode,
} from "../inline/PenToolsMode";
import { setMouseInk } from "../inline/MouseInk";

/** The gesture path rebinds, which constructs observers Node does not have. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

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

type Pen = {
	// `ev` is the router's PointerEvent in production; the only fields this
	// surface reads off it at contact are `pointerType`, `buttons` and
	// `button`, and `recordDown` - the one place that reads more - is already
	// wrapped in a try/catch for exactly this harness. So a two-field literal
	// is the honest fake rather than a corner cut.
	penDown(s: PenSample, ev?: { pointerType?: string; buttons?: number }): void;
	showCursor(s: PenSample, kind?: string): void;
};

function makeController() {
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
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [
			{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
		],
	};
	// mount() binds a keydown listener to the root and observes it; a bare
	// object is enough for every other PDF suite here but not for mount.
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
	const controller = new PdfInkController(
		root,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		// Both sources answer empty, and that is an answer rather than an
		// omission: this fixture's document has no ink at all, so the page
		// list and the document list agree by being genuinely empty. Two
		// separate callbacks returning separate lists, never one list passed
		// twice - nothing here should be able to read a page's ink as the
		// document's, and passing the same array to both would type-check
		// while reproducing the exact blindness `allStrokes` was made
		// required to close.
		() => []
	);
	return { controller, pen: controller as unknown as Pen };
}

describe("the pdf pen strip obeys the Pen toolbar setting", () => {
	let open: PdfInkController[] = [];

	beforeEach(() => {
		// Before any mount: this clears the subscriber registry too, so a
		// controller mounted here is the only thing listening.
		resetPenToolsForTest();
		platform.isMobileApp = false;
		strips.built = 0;
		strips.destroyed = 0;
		strips.live = 0;
		open = [];
	});

	afterEach(() => {
		for (const c of open) c.unmount();
	});

	/** A mounted controller, plus the private gesture entry points. */
	function mounted(): { controller: PdfInkController; pen: Pen } {
		const made = makeController();
		made.controller.mount();
		open.push(made.controller);
		return made;
	}

	it("hide leaves no strip on a pdf, pen on the glass or not", () => {
		// The reported bug, exactly: the setting is Hide, a pen touches a PDF,
		// and the floating strip appears anyway.
		setPenToolsMode("hide");
		const { pen } = mounted();
		expect(strips.live).toBe(0);
		pen.penDown(sample(200, 200));
		expect(strips.built).toBe(0);
		expect(strips.live).toBe(0);
	});

	it("show gives a pdf pane a strip at mount, with no pen anywhere", () => {
		// The note surface builds its strip in `ensurePenTools` at mount, so a
		// desktop user who sets Show has one before touching anything. The pdf
		// built one only on pen contact, so Show did nothing at all on a pane
		// nobody had inked yet.
		setPenToolsMode("show");
		mounted();
		expect(strips.live).toBe(1);
	});

	it("auto on a desktop with no pen seen raises no strip for a hovering mouse", () => {
		// `showCursor` marks a pen seen only for a real pen (audit 5m/AF5), and
		// then called `ensureTools` unconditionally anyway - so a mouse merely
		// hovering over a PDF with mouse ink armed raised the toolbar for a
		// pointer that was never a pen. Auto on a desktop with no pen seen is
		// false, and the strip follows that now.
		// auto is the default mode; nothing is set here on purpose.
		const { pen } = mounted();
		pen.showCursor(sample(200, 200), "mouse");
		expect(strips.built).toBe(0);
		expect(strips.live).toBe(0);
	});

	it("auto on mobile has a strip from the moment the pane mounts", () => {
		// Mobile hides the palette behind the keyboard, so the strip is the
		// only path to the tools - which is why `penToolsVisible` answers true
		// for auto on mobile with no pen seen. The pdf pane waited for pen
		// contact instead.
		platform.isMobileApp = true;
		mounted();
		expect(strips.live).toBe(1);
	});

	it("auto on a desktop grows one the moment a pen is actually seen", () => {
		mounted();
		expect(strips.live).toBe(0);
		markPenSeen();
		expect(strips.live).toBe(1);
	});

	it("switching show to hide takes away the strip a pdf already has", () => {
		// The live half. A setting changed while a PDF is open reaches notes
		// through `refreshPenToolsAll`, which walks InkOverlay's own set of
		// open editors and has never known a PDF pane existed.
		setPenToolsMode("show");
		mounted();
		expect(strips.live).toBe(1);
		setPenToolsMode("hide");
		expect(strips.live).toBe(0);
		expect(strips.destroyed).toBe(1);
	});

	it("switching show to auto takes it away too, on a desktop with no pen", () => {
		setPenToolsMode("show");
		mounted();
		expect(strips.live).toBe(1);
		setPenToolsMode("auto");
		expect(strips.live).toBe(0);
	});

	it("two open pdf panes both hear the change", () => {
		setPenToolsMode("show");
		mounted();
		mounted();
		expect(strips.live).toBe(2);
		setPenToolsMode("hide");
		expect(strips.live).toBe(0);
	});

	it("unmount drops the subscription rather than leaking one per pane", () => {
		// The teardown that matters: a pdf viewer is rebuilt inside a leaf
		// that outlives it, and main.ts unmounts and rebuilds a controller
		// whenever the leaf's file changes. One listener per pane, and none
		// after it closes.
		expect(penToolsListenerCountForTest()).toBe(0);
		const a = mounted().controller;
		const b = mounted().controller;
		expect(penToolsListenerCountForTest()).toBe(2);
		a.unmount();
		expect(penToolsListenerCountForTest()).toBe(1);
		b.unmount();
		expect(penToolsListenerCountForTest()).toBe(0);
	});

	it("a mode change after unmount builds nothing on the closed pane", () => {
		setPenToolsMode("hide");
		const c = mounted().controller;
		c.unmount();
		setPenToolsMode("show");
		expect(strips.built).toBe(0);
	});
});

/**
 * The nib light on a PDF, and the strip's visibility beside it.
 *
 * THE EIGHTH surface divergence of the cycle, and it happened inside the
 * seventh's fix. `cff850d` split one flag into two - `penSeen` still means
 * "show the strip" and is set by every tool command, `penHardware` means "a
 * real pen fired a real event" and is what `nibIsLit` (MobileTools.ts) reads -
 * and it taught both of InkOverlay's call sites the difference. This file's
 * surface was left calling the visibility function at both of its own, while
 * `buildTools` here hands MobileTools the same `isLit: (h) => nibIsLit(h,
 * "pen")` spec the note surface does. So a user who only ever writes on PDFs,
 * with a real pen, never set `penHardware` and their pen and highlighter
 * buttons stayed dark unless mouse ink was on.
 *
 * TWO questions per contact, and they have different answers. These tests
 * assert BOTH on every path, because the failure mode of fixing the second is
 * silently moving the first: gating the visibility claim is the tempting
 * one-line version of this fix and it would take the toolbar away from every
 * mouse-ink user on a PDF. `penSeenThisSession()` here is the pin.
 */
describe("a pdf tells a real pen from a mouse, without moving the strip", () => {
	let open: PdfInkController[] = [];

	beforeEach(() => {
		resetPenToolsForTest();
		// Module state like the pen flags, and it decides whether a hovering
		// mouse may raise the strip - a test that armed it and did not put it
		// back would hand the next one a different answer.
		setMouseInk(false);
		platform.isMobileApp = false;
		strips.built = 0;
		strips.destroyed = 0;
		strips.live = 0;
		open = [];
	});

	afterEach(() => {
		setMouseInk(false);
		for (const c of open) c.unmount();
	});

	function mounted(): { controller: PdfInkController; pen: Pen } {
		const made = makeController();
		made.controller.mount();
		open.push(made.controller);
		return made;
	}

	it("a real pen on the glass claims the hardware, and raises the strip", () => {
		// The regression, stated as the thing a user does. Alan's pass
		// signature for this is "open a PDF, write one stroke with the pen,
		// the pen button is lit".
		const { pen } = mounted();
		expect(penHardwareSeen()).toBe(false);
		pen.penDown(sample(200, 200), { pointerType: "pen", buttons: 1 });
		expect(penHardwareSeen()).toBe(true);
		expect(penSeenThisSession()).toBe(true);
		expect(strips.live).toBe(1);
	});

	it("a mouse stroke raises the strip and claims no hardware", () => {
		// Both halves matter and they pull opposite ways. The strip MUST
		// still appear - a mouse only reaches penDown with mouse ink already
		// armed, and taking its toolbar away is the behaviour change this
		// whole split exists to avoid. The hardware flag MUST NOT be set, or
		// the nib light goes back to being a constant and `cff850d` is
		// undone on this surface.
		const { pen } = mounted();
		pen.penDown(sample(200, 200), { pointerType: "mouse", buttons: 1 });
		expect(penSeenThisSession()).toBe(true);
		expect(strips.live).toBe(1);
		expect(penHardwareSeen()).toBe(false);
	});

	it("a contact with no event at all still raises the strip", () => {
		// This surface's own teardown paths call penDown without an event
		// (see the `ev?.buttons ?? 0` comment at the contact site). Undefined
		// is not a pen, so it takes the visibility branch - which is exactly
		// what the unconditional `markPenSeen()` did before this change.
		const { pen } = mounted();
		pen.penDown(sample(200, 200));
		expect(penSeenThisSession()).toBe(true);
		expect(strips.live).toBe(1);
		expect(penHardwareSeen()).toBe(false);
	});

	it("a pen hover claims the hardware without touching the glass", () => {
		// An Apple Pencil with hover, or a Surface pen held above the page.
		// The strip rides along, as it did before: `markPenHardwareSeen`
		// calls `markPenSeen` itself.
		const { pen } = mounted();
		pen.showCursor(sample(200, 200), "pen");
		expect(penHardwareSeen()).toBe(true);
		expect(penSeenThisSession()).toBe(true);
		expect(strips.live).toBe(1);
	});

	it("a hovering mouse still claims nothing at all", () => {
		// A mouse with ink OFF, which is the half of 1.4.6-design.md 5m/AF5
		// that survives Alan's 2026-09-03 reversal: it cannot ink, so it is
		// not asking for the tools and it raises nothing. `setMouseInk` is
		// left at its false default here rather than being set, and the
		// beforeEach turns it off again after every test that armed it.
		const { pen } = mounted();
		pen.showCursor(sample(200, 200), "mouse");
		expect(penSeenThisSession()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
		expect(strips.live).toBe(0);
	});

	it("a mouse with ink ARMED raises the toolbar, and claims no hardware", () => {
		// ALAN'S REVERSAL, 2026-09-03: "with mouse ink armed, yes a hovering
		// mouse should bring toolbar out". Before this, a mouse-ink user
		// hovering a PDF in auto mode got nothing until they touched the page
		// with a real pen, while the same hover over a note raised the strip.
		//
		// The second assertion is the one that keeps the fix honest. Marking
		// hardware here would ALSO make this pass and would rebuild the
		// 1.4.6-to-1.4.8 nib-light bug from the far end; the light already
		// covers this user through nibIsLit's own `|| h.mouseInkOn()`.
		setMouseInk(true);
		const { pen } = mounted();
		pen.showCursor(sample(200, 200), "mouse");
		expect(penSeenThisSession()).toBe(true);
		expect(strips.live).toBe(1);
		expect(penHardwareSeen()).toBe(false);
	});

	it("touch raises nothing on either flag", () => {
		// Not reachable through the router - its hover path returns on any
		// pointer that is neither a pen nor an armed mouse - but the
		// predicate is asked directly here so the third pointer type has an
		// answer on the record rather than an assumption.
		setMouseInk(true);
		const { pen } = mounted();
		pen.showCursor(sample(200, 200), "touch");
		expect(penSeenThisSession()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
		expect(strips.live).toBe(0);
	});
});
