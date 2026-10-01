/**
 * AUDIT PROBE Geometry-1 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: Infinite Canvas turned on for ONE note grants sideways scroll room on its first extent pass
 * (ScrollExpansionDemand.sample sets pendingX on the mode change, reserve() grants about two panes).
 * Turning it off again for that note (menu/command -> CanvasNoteOverride.saveForPath, or a frontmatter
 * edit -> metadataChanged) reaches applyCanvasMode (InkOverlay.ts:8951), which never owes a sideways
 * shrink; shrinkSideways (:11392-11398) returns the grant unchanged when shrinkDue is undefined. Only
 * the global setter (:936 oweShrinkXEverywhere) takes the room back.
 *
 * Correct behaviour (product rule): with Infinite Canvas off the note is stock Obsidian, and the
 * SurfaceExtent header (:16-18) says the sideways room goes when Infinite Canvas is turned off. An
 * ink-free note must end with no x grant and no `handwriting-hscroll` class. The cells assert that, so
 * they go red only if the room survives the per-note off. Preconditions (the on step really granted x
 * room, the override really resolves off) are asserted first; a control cell runs the same rig through
 * the GLOBAL setter and must shrink, so the rig's shrink machinery is shown to work.
 *
 * Rig: the real InkOverlayPlugin built off its prototype (the pattern of InkOverlay-3-1.test.ts), the
 * real applyCanvasMode(), updateExtent(), shrinkSideways(), ensureScrollableAxis(), measureReach(),
 * deferPinchRaster(), endWheelZoomRun(); the real module singleton `surfaceExtents`, the real
 * ScrollExpansionDemand (created by updateExtent itself), FrontierCache and ScrollAxisGuard; the real
 * CanvasNoteOverride driven through saveForPath and its own metadataCache "changed" handler; the real
 * setScrollExpansionEnabled for the control. The subscription is mount's own line :2590 verbatim.
 * Stubbed: pure layout readers with fixed values (columnLeft 100, documentTopUnpanned 0, panY 0),
 * capturePaperOrigin / syncGridPaperBox (paper painting) and scheduleRepaint (the repaint's last act is
 * `this.updateExtent()`, :10998, which the rig then calls for real). The scroller is a fake whose
 * scrollWidth follows the spacer the real code places, like a browser's would.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { type App, type CachedMetadata, type Plugin, TFile } from "obsidian";
import { InkOverlayPlugin, setScrollExpansionEnabled } from "../inline/InkOverlay";
import {
	CanvasNoteOverride,
	NOTE_CANVAS_KEY,
	canvasForNote,
	onCanvasOverrideChanged,
	setCanvasNoteOverrideForTest,
} from "../inline/CanvasNoteOverride";
import { ScrollAxisGuard, surfaceExtents } from "../inline/SurfaceExtent";
import { FrontierCache } from "../inline/FrontierCache";
import { WheelZoomRun } from "../inline/WheelZoom";

type Fields = Record<string, unknown>;

const P_MENU = "geo1-menu.md"; // per-note on, then off through saveForPath (menu item / command)
const P_FM = "geo1-frontmatter.md"; // per-note on through saveForPath, off through a frontmatter edit
const P_GLOBAL = "geo1-global.md"; // control: the global setter

const frontmatter = new Map<string, Record<string, unknown>>();
const files = new Map<string, TFile>();
let changedHandler: ((file: TFile, data: string, cache: CachedMetadata) => void) | null = null;

function installOverride(): CanvasNoteOverride {
	for (const path of [P_MENU, P_FM, P_GLOBAL]) {
		files.set(path, Object.assign(new TFile(), { path, extension: "md" }));
		frontmatter.set(path, { title: path });
	}
	const fmOf = (file: TFile) => frontmatter.get((file as unknown as { path: string }).path)!;
	const app = {
		metadataCache: {
			getFileCache: (file: TFile) => ({ frontmatter: fmOf(file) }),
			on: (_name: string, cb: typeof changedHandler) => { changedHandler = cb; return {}; },
		},
		fileManager: {
			processFrontMatter: async (file: TFile, fn: (fm: Record<string, unknown>) => void) => { fn(fmOf(file)); },
		},
		vault: {
			read: async () => "",
			getAbstractFileByPath: (path: string) => files.get(path) ?? null,
		},
	} as unknown as App;
	const override = new CanvasNoteOverride(app);
	override.start({ registerEvent: () => {}, register: () => {} } as unknown as Plugin);
	return override;
}

function makeScroller() {
	const classes = new Set<string>();
	let spacerLeft = -1;
	let spacerTop = -1;
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 600,
		// Like a browser: the absolutely positioned 1x1 spacer extends the scroll range.
		get scrollWidth() { return Math.max(800, spacerLeft + 1); },
		get scrollHeight() { return Math.max(1000, spacerTop + 1); },
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
		classList: {
			add: (c: string) => { classes.add(c); },
			remove: (c: string) => { classes.delete(c); },
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
		},
		setCssStyles: () => undefined,
		createDiv: () => ({
			parentElement: scroller,
			setCssStyles: (st: { left?: string; top?: string }) => {
				if (st.left !== undefined) spacerLeft = Number.parseFloat(st.left);
				if (st.top !== undefined) spacerTop = Number.parseFloat(st.top);
			},
		}),
	};
	return { scroller, classes, spacerLeft: () => spacerLeft };
}

function makeOverlay(path: string) {
	const { scroller, classes, spacerLeft } = makeScroller();
	const win = {
		setTimeout: () => 1,
		clearTimeout: () => undefined,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => undefined,
		// Obsidian's .cm-scroller ships overflow-x hidden; the axis guard's class flips it to auto.
		getComputedStyle: (el: unknown) => ({
			position: "relative",
			overflowX: el === scroller && classes.has("handwriting-hscroll-axis") ? "auto" : "hidden",
			overflowY: "auto",
			getPropertyValue: () => "",
		}),
	};
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		state: { field: () => ({ file: { path } }) },
		dom: { ownerDocument: { defaultView: win } },
		scrollDOM: scroller,
		contentDOM: {
			parentElement: null,
			getBoundingClientRect: () => ({ left: 100, top: 0, right: 800, bottom: 1000, width: 700, height: 1000 }),
		},
	};
	// Field initialisers updateExtent/applyCanvasMode read (InkOverlay.ts :1424-:2002), global off.
	o.canvasMode = false;
	o.router = { setCanvasMomentumDisabled: () => undefined };
	o.container = {};
	o.frame = { locked: false };
	o.builder = null;
	o.band = null;
	o.pinchPreview = false;
	o.pinchScrollAt = 0;
	o.pinchScaleNow = 1;
	o.wheelZoomRun = new WheelZoomRun();
	o.wheelZoomTimer = 0;
	o.camera = { snapshot: { x: 0, y: 0, zoom: 1 } };
	o.frontierCache = new FrontierCache();
	o.fontZoom = 1;
	o.cssScale = 1;
	o.cssWidth = 800;
	o.cssHeight = 600;
	o.viewportLayout = null;
	o.lastExtentInputs = null;
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.axisGuard = new ScrollAxisGuard();
	o.axisChecked = false;
	o.scrollPositionPatched = false;
	o.lastReach = null;
	o.extentFrontierSeen = new Map<string, number>();
	o.shrinkStepped = new Map<string, number>();
	o.shrinksSeen = new Map<string, number>();
	o.sidewaysView = null;
	o.bandMarginReleasePending = false;
	o.scrollExpansion = null;
	// Layout readers and paper painting: fixed values / no-ops (none touches the grant).
	o.columnLeft = () => 100;
	o.documentTopUnpanned = () => 0;
	o.panY = () => 0;
	o.capturePaperOrigin = () => undefined;
	o.syncGridPaperBox = () => undefined;
	const repaints: string[] = [];
	o.scheduleRepaint = (why: string) => { repaints.push(why); };

	const filePath = () => (o.filePath as () => string | null).call(o);
	// Mount's own lines :2588-2590.
	o.canvasMode = canvasForNote(filePath(), false);
	const off = onCanvasOverrideChanged((p) => { if (p === filePath()) (o.applyCanvasMode as () => void).call(o); });

	return {
		o,
		scroller,
		classes,
		repaints,
		unsubscribe: off,
		spacerLeft,
		/** A repaint's last act (:10998), then a forced pass (a gesture settle) for good measure. */
		repaint() {
			(o.updateExtent as (force?: boolean) => void).call(o);
			(o.updateExtent as (force?: boolean) => void).call(o, true);
		},
		modeOn: () => (o.canvasModeOn as () => boolean).call(o),
		hscroll: () => classes.has("handwriting-hscroll"),
		roomPastView: () => scroller.scrollWidth - scroller.clientWidth,
	};
}

let override: CanvasNoteOverride;
beforeAll(() => {
	override = installOverride();
	setCanvasNoteOverrideForTest(override);
});
afterAll(() => {
	setScrollExpansionEnabled(false);
	override.destroy();
});

describe("Geometry-1: per-note Infinite Canvas off keeps the sideways room it granted", () => {
	it("menu/command path: on for this note, then off for this note -> no sideways room left", async () => {
		expect(canvasForNote(P_MENU, false)).toBe(false); // global off, no override
		const r = makeOverlay(P_MENU);
		r.repaint();
		expect(r.modeOn()).toBe(false);
		expect(surfaceExtents.get(P_MENU).x).toBe(0); // stock note: no room before
		expect(r.hscroll()).toBe(false);

		// 'Infinite canvas' on for this note (main.ts:1948 applyCanvasChoice -> saveForPath).
		expect(await override.saveForPath(P_MENU, true)).toBe(true);
		expect(r.modeOn()).toBe(true);
		expect(r.repaints).toContain("canvas-mode");
		r.repaint();
		// PRECONDITION: Infinite Canvas granted sideways room on its first pass.
		const granted = surfaceExtents.get(P_MENU).x;
		expect(granted).toBeGreaterThan(0);
		expect(r.hscroll()).toBe(true);
		expect(r.roomPastView()).toBeGreaterThan(r.scroller.clientWidth);
		console.log(`[Geometry-1 menu] on: x grant ${granted}, spacer left ${r.spacerLeft()}, scrollWidth ${r.scroller.scrollWidth}, room past view ${r.roomPastView()}`);

		// Off again for this note, same route.
		expect(await override.saveForPath(P_MENU, false)).toBe(true);
		expect(canvasForNote(P_MENU, false)).toBe(false);
		expect(r.modeOn()).toBe(false);
		r.repaint();
		console.log(`[Geometry-1 menu] off: x grant ${surfaceExtents.get(P_MENU).x}, owed ${surfaceExtents.owesShrinkX(P_MENU)}, hscroll ${r.hscroll()}, room past view ${r.roomPastView()}`);

		// CORRECT: an ink-free stock note holds no sideways room once Infinite Canvas is off.
		expect.soft(surfaceExtents.get(P_MENU).x, "x grant survives per-note Infinite Canvas off").toBe(0);
		expect.soft(r.hscroll(), "handwriting-hscroll still on after per-note off").toBe(false);
		expect.soft(r.roomPastView(), "sideways scroll room past the view after per-note off").toBe(0);
		r.unsubscribe();
	});

	it("frontmatter path: on, then handwriting-canvas: false typed into the frontmatter -> no sideways room left", async () => {
		const r = makeOverlay(P_FM);
		r.repaint();
		expect(await override.saveForPath(P_FM, true)).toBe(true);
		expect(r.modeOn()).toBe(true);
		r.repaint();
		expect(surfaceExtents.get(P_FM).x).toBeGreaterThan(0); // PRECONDITION
		expect(r.hscroll()).toBe(true);

		// The user edits the frontmatter; Obsidian's metadataCache fires "changed".
		frontmatter.get(P_FM)![NOTE_CANVAS_KEY] = false;
		expect(changedHandler).not.toBeNull();
		changedHandler!(files.get(P_FM)!, "---\nhandwriting-canvas: false\n---\n", { frontmatter: frontmatter.get(P_FM) } as CachedMetadata);
		await Promise.resolve();
		await Promise.resolve();
		expect(canvasForNote(P_FM, false)).toBe(false);
		expect(r.modeOn()).toBe(false);
		r.repaint();
		console.log(`[Geometry-1 frontmatter] off: x grant ${surfaceExtents.get(P_FM).x}, hscroll ${r.hscroll()}, room past view ${r.roomPastView()}`);

		expect.soft(surfaceExtents.get(P_FM).x, "x grant survives frontmatter Infinite Canvas off").toBe(0);
		expect.soft(r.hscroll(), "handwriting-hscroll still on after frontmatter off").toBe(false);
		r.unsubscribe();
	});

	it("reopen: a fresh editor on the menu note (canvas off) must not come up with sideways room", () => {
		expect(canvasForNote(P_MENU, false)).toBe(false);
		const r = makeOverlay(P_MENU);
		expect(r.modeOn()).toBe(false);
		r.repaint();
		console.log(`[Geometry-1 reopen] x grant ${surfaceExtents.get(P_MENU).x}, spacer ${r.o.spacer ? "placed" : "none"}, hscroll ${r.hscroll()}, room past view ${r.roomPastView()}`);
		expect.soft(r.hscroll(), "reopened canvas-off note comes up with handwriting-hscroll").toBe(false);
		expect.soft(r.roomPastView(), "reopened canvas-off note has sideways room").toBe(0);
		r.unsubscribe();
	});

	it("CONTROL: the same rig through the GLOBAL setter shrinks the room back (machinery works)", () => {
		expect(canvasForNote(P_GLOBAL, false)).toBe(false);
		const r = makeOverlay(P_GLOBAL);
		r.repaint();
		setScrollExpansionEnabled(true);
		// setScrollExpansionEnabled's loop (:945-948) runs this for every mounted overlay; the rig is not in
		// the module's private `instances`, so it runs the loop body itself.
		(r.o.applyCanvasMode as () => void).call(r.o);
		expect(r.modeOn()).toBe(true);
		r.repaint();
		expect(surfaceExtents.get(P_GLOBAL).x).toBeGreaterThan(0);
		expect(r.hscroll()).toBe(true);

		setScrollExpansionEnabled(false);
		(r.o.applyCanvasMode as () => void).call(r.o);
		expect(r.modeOn()).toBe(false);
		r.repaint();
		console.log(`[Geometry-1 control] global off: x grant ${surfaceExtents.get(P_GLOBAL).x}, hscroll ${r.hscroll()}, room past view ${r.roomPastView()}`);
		expect(surfaceExtents.get(P_GLOBAL).x).toBe(0);
		expect(r.hscroll()).toBe(false);
		expect(r.roomPastView()).toBe(0);
		r.unsubscribe();
	});
});
