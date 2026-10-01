/**
 * Audit probe InkOverlay-4-3 (1.4.21, tag 1a05f62c).
 *
 * Claim: under Infinite Canvas with Readable line length on, the column margin
 * falls from Obsidian's centring (~341 local px in a 1400 px pane) at 100% to 0
 * at 200%. The zoom buttons anchor about the pane centre with anchoredScroll,
 * which clamps at 0, and the only correction for the margin move is the
 * column-margin debt (InkOverlay.ts:7468-7498). The debt has no baseline on
 * the first commit (restingColumnMargin starts null, :7644) and is netted
 * AFTER the anchored target was clamped at 0, so "+" then "100%" leaves the
 * page scrolled right by the margin difference.
 *
 * Rig: the ZoomFloorLock.test.ts prototype rig. REAL: zoomNoteBy,
 * resetNoteZoom, zoomAroundCenter, anchoredScroll, commitCameraScale,
 * applyViewportBox (it writes the two CSS variables the sizer margin is
 * clamped from), restColumnAgainstCurrentGrant, appliedColumnMargin,
 * columnRestCentred, ownLinesPageBoxScrollLeft, columnMarginDebtScrollLeft,
 * columnFitsPane, setViewportScroll, reanchorPan, and the commit's follow-up
 * measure and microtask. STUBBED: measurement (prepareViewportLayout returns
 * the layout takeover measures on Obsidian's default theme: 1400 px pane,
 * 17 px scrollbar, 700 px line, column at 341.5), the extent/band/raster
 * sinks, and the browser's layout itself, modelled from styles.css:3062-3066:
 *   sizer margin = clamp(0, --handwriting-column-auto-left, --handwriting-column-margin-left)
 *   screen x of a column-relative local x c = (margin + c - scrollLeft) * k
 * The canvas grant is modelled as a fixed sideways range of one pane past the
 * content (ScrollExpansionDemand.reserve's first grant, SurfaceExtent.ts:108).
 *
 * Asserts the CORRECT behaviour: the text under the pane centre stays under
 * the pane centre through each zoom-button commit, and "+" then "100%" brings
 * the page back to scrollLeft 0 where it started.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "../inline/InkOverlay";
import { MIN_PINCH_SCALE } from "../inline/PinchScale";

type Fields = Record<string, any>;

const PANE = 1400;       // pane width, screen px (external scale 1)
const HEIGHT = 900;
const SCROLLBAR = 17;    // painted scrollbar, screen px
const LINE = 700;        // --file-line-width
const COLUMN_LOCAL = (PANE - SCROLLBAR - LINE) / 2; // 341.5: Obsidian's own centring at 100%
const GRANT = PANE - SCROLLBAR; // canvas grant: one pane of sideways room past the content

function makeRig() {
	const styles: Record<string, string> = {};
	const win: Fields = {
		requestAnimationFrame: vi.fn(() => 1),
		cancelAnimationFrame: vi.fn(),
		setTimeout: vi.fn(() => 0),
		clearTimeout: vi.fn(),
		CSS: { supports: () => true },
		getComputedStyle: (el: unknown) => (el === host
			? { zoom: styles.zoom ?? "1", transform: "none", width: `${PANE}px`, height: `${HEIGHT}px`, borderLeftWidth: "0", borderRightWidth: "0" }
			: { borderLeftWidth: "0", borderRightWidth: "0" }),
	};
	const classes = new Set<string>();
	const classList = (set: Set<string>) => ({
		contains: (c: string) => set.has(c),
		add: (c: string) => { set.add(c); },
		remove: (c: string) => { set.delete(c); },
		toggle: (c: string, on?: boolean) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c); },
	});
	const parent: Fields = { clientWidth: PANE, clientHeight: HEIGHT, scrollLeft: 0, scrollTop: 0, classList: classList(new Set()) };
	const host: Fields = {
		clientWidth: PANE, clientHeight: HEIGHT, isConnected: true, parentElement: parent,
		ownerDocument: { defaultView: win },
		classList: classList(classes),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: PANE, height: HEIGHT }),
		style: {
			getPropertyValue: (n: string) => styles[n] ?? "",
			getPropertyPriority: () => "",
			setProperty: (n: string, v: string) => { styles[n] = v; },
			removeProperty: (n: string) => { delete styles[n]; },
		},
		setCssStyles: (s: Record<string, string>) => { Object.assign(styles, s); },
	};

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	const k = (): number => overlay.pinchScaleNow as number;
	// The scroller, in host-local px (the units anchoredScroll and the debt use).
	let scrollLeft = 0, scrollTop = 0;
	const clientWidth = (): number => (PANE - SCROLLBAR) / k();
	const scroller: Fields = {
		get scrollLeft() { return scrollLeft; },
		set scrollLeft(v: number) { scrollLeft = Math.max(0, Math.min(v, this.scrollWidth - this.clientWidth)); },
		get scrollTop() { return scrollTop; },
		set scrollTop(v: number) { scrollTop = Math.max(0, v); },
		get clientWidth() { return clientWidth(); },
		get offsetWidth() { return PANE / k(); },
		get scrollWidth() { return Math.max(clientWidth(), PANE - SCROLLBAR) + GRANT; },
		scrollHeight: 48000, clientHeight: HEIGHT,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: PANE, height: HEIGHT }),
	};

	const measures: Array<{ read: () => unknown; write: (v: unknown) => void }> = [];
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] }, requestMeasure: (m: any) => { measures.push(m); }, measure: vi.fn(), viewport: { from: 0, to: 0 } };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	overlay.canvasMode = true;
	overlay.cssScale = 1; overlay.fontZoom = 1; overlay.scale = 1;
	overlay.pinchScaleNow = 1;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRefScale = null;
	overlay.pinchPreview = false;
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.hostZoomSupport = null;
	// The class-field initial values (InkOverlay.ts:7644, :7651 and the rest-margin field above them):
	// Object.create runs no initialisers, so they are set exactly as the class declares them.
	overlay.columnRestMargin = null;
	overlay.restingColumnMargin = null;
	overlay.columnMarginDebt = 0;
	overlay.viewportLayout = null;
	overlay.getNoteViewportState = () => ({ zoom: overlay.pinchScaleNow, busy: false, fitAvailable: true });
	// TAKEOVER'S MEASUREMENT on Obsidian's default theme, Readable line length on: a sizer column at
	// its engine centring, the auto term's inputs as measureColumnAuto returns them.
	overlay.prepareViewportLayout = () => {
		if (!overlay.viewportLayout) overlay.viewportLayout = {
			parent, paneWidth: PANE, paneHeight: HEIGHT, externalScale: 1, baseTransform: "none", baseZoom: 1,
			width: PANE, height: HEIGHT, column: LINE, columnBox: LINE, gutterX: SCROLLBAR, gutterScreen: SCROLLBAR,
			sizerColumn: true, columnInset: true, ownLines: false, left: "0px", right: "0px",
			columnLocal: COLUMN_LOCAL, columnAuto: { lineWidth: LINE, fixed: 0, scrollbar: SCROLLBAR },
			styles: new Map([["zoom", { value: "", priority: "" }]]),
		};
		return true;
	};
	overlay.filePath = () => "note.md";
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "scheduleRepaint", "handleResize", "endPreviewPaper", "placeCanvasLayers"]) overlay[name] = vi.fn();
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;

	/** The browser's layout: the sizer margin the stylesheet resolves from what production wrote. */
	const margin = (): number => {
		if (!classes.has("handwriting-note-viewport")) return COLUMN_LOCAL; // unowned: Obsidian's own centring
		const auto = Number.parseFloat(styles["--handwriting-column-auto-left"] ?? "NaN");
		const frozen = Number.parseFloat(styles["--handwriting-column-margin-left"] ?? "NaN");
		return Math.max(0, Math.min(auto, frozen));
	};
	/** Screen x (from the scroller's left) of column-relative local x `c`. */
	const screenX = (c: number): number => (margin() + c - scrollLeft) * k();
	/** Column-relative local x under screen x `x`. */
	const columnAt = (x: number): number => x / k() + scrollLeft - margin();

	/** Run what CodeMirror would: the commit's measure (read, write), then the microtask follow-up. */
	const flush = async (): Promise<void> => {
		while (measures.length) { const m = measures.shift()!; m.write(m.read()); }
		await Promise.resolve(); await Promise.resolve();
	};
	const plus = async (): Promise<boolean> => { const r = (InkOverlayPlugin.prototype as any).zoomNoteBy.call(overlay, 2); await flush(); return r; };
	const reset = async (): Promise<boolean> => { const r = (InkOverlayPlugin.prototype as any).resetNoteZoom.call(overlay); await flush(); return r; };
	return { overlay, k, margin, screenX, columnAt, plus, reset, scroll: () => scrollLeft, room: () => scroller.scrollWidth - scroller.clientWidth };
}

const CENTRE = PANE / 2; // zoomAroundCenter anchors at rect.width / 2

describe("InkOverlay-4-3: zoom buttons keep the page anchored across the column-margin change", () => {
	it("fresh editor: '+' holds the text under the pane centre, and '+' then '100%' returns the page to where it started", async () => {
		const rig = makeRig();
		expect(rig.scroll()).toBe(0);
		const c0 = rig.columnAt(CENTRE); // the text at the pane centre before any zoom
		expect(c0).toBeCloseTo(CENTRE - COLUMN_LOCAL, 6);

		expect(await rig.plus()).toBe(true);
		// Precondition: the commit landed at 200%, and the margin really moved under it.
		expect(rig.k()).toBe(2);
		expect(rig.margin(), "precondition: at 200% the auto term wins and the margin drops to 0").toBe(0);
		expect(COLUMN_LOCAL - rig.margin()).toBeGreaterThan(300);
		expect(rig.room(), "precondition: the canvas grant leaves sideways room").toBeGreaterThan(COLUMN_LOCAL);
		const afterPlus = rig.screenX(c0);

		expect(await rig.reset()).toBe(true);
		expect(rig.k()).toBe(1);
		const afterReset = rig.screenX(c0);
		const endScroll = rig.scroll();

		// Report every value before the assertions so a red names the whole round trip.
		const report = `'+': text from the centre at ${afterPlus.toFixed(2)} (want ${CENTRE}); '100%': at ${afterReset.toFixed(2)} (want ${CENTRE}), scrollLeft ${endScroll.toFixed(2)} (want 0)`;
		expect(afterPlus, `first '+' left the anchor: ${report}`).toBeCloseTo(CENTRE, 0);
		expect(endScroll, `round trip left the page shifted: ${report}`).toBeCloseTo(0, 0);
		expect(afterReset, `round trip left the page shifted: ${report}`).toBeCloseTo(CENTRE, 0);
	});

	it("with a baseline ('100%' pressed at 100% first): '+' is compensated, but '100%' nets the debt after anchoredScroll clamped to 0", async () => {
		const rig = makeRig();
		const c0 = rig.columnAt(CENTRE);
		expect(await rig.reset()).toBe(true); // at 100% already: a same-scale commit, which records the resting margin
		expect(rig.k()).toBe(1);
		expect(rig.scroll()).toBeCloseTo(0, 6);
		expect(rig.screenX(c0)).toBeCloseTo(CENTRE, 6);

		expect(await rig.plus()).toBe(true);
		expect(rig.k()).toBe(2);
		expect(rig.margin()).toBe(0);
		// Precondition that the debt mechanism is live: with a baseline, '+' IS anchored.
		expect(rig.screenX(c0), "precondition: with a baseline the debt keeps '+' anchored").toBeCloseTo(CENTRE, 6);
		const scrollAt200 = rig.scroll();
		// Precondition for the clamp: the unclamped anchored target of the way back is negative.
		expect(scrollAt200 + CENTRE * (1 / 2 - 1), "precondition: the true anchored target is below 0").toBeLessThan(-300);

		expect(await rig.reset()).toBe(true);
		expect(rig.k()).toBe(1);
		const report = `scrollLeft at 200% ${scrollAt200.toFixed(2)}; after '100%' scrollLeft ${rig.scroll().toFixed(2)} (want 0), text from the centre at ${rig.screenX(c0).toFixed(2)} (want ${CENTRE})`;
		expect(rig.scroll(), `round trip left the page shifted: ${report}`).toBeCloseTo(0, 0);
		expect(rig.screenX(c0), `round trip left the page shifted: ${report}`).toBeCloseTo(CENTRE, 0);
	});
});
