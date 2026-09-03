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
	penToolsListenerCountForTest,
	resetPenToolsForTest,
	setPenToolsMode,
} from "../inline/PenToolsMode";

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

type Pen = { penDown(s: PenSample): void; showCursor(s: PenSample, kind?: string): void };

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
