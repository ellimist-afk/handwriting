/**
 * Audit 46, overlay half: the overlay reads a note's ink in the frame of the font size stored
 * with that note, not the size the editor happened to be at when the overlay first measured it.
 *
 * Every stored coordinate is in the frame of the reference font size (fontZoom = current / reference). The data
 * half stores the reference with the note (InlineInkStore.fontRefPx / setFontRefPx, PageData.fontRefPx). These
 * cells drive the real handleResize (the overlay measuring the editor, as mount does) and the real loadInk (which
 * mount runs after it, and which the note-switch branch runs for the note that takes over), over the real
 * `inlineInk` store with a sidecar host stand-in, and read the overlay's reference and fontZoom.
 *
 * Asserted:
 * - a note stored at 16 and opened at 20 reads at reference 16, fontZoom 1.25, once its sidecar has loaded;
 * - a note with no stored reference latches the size it opens at, as before, and the store takes that size once,
 *   to ride the note's next ordinary save;
 * - two notes opened in turn in the same editor at two different stored sizes each read at their own;
 * - a note with nothing stored, opened after one stored at another size, latches and stores its own size;
 * - a note whose sidecar is already in the store reads at its stored reference the moment it opens, before the
 *   ink read resolves, so its first frame is never drawn at the editor's size and then shifted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { WheelZoomRun } from "./WheelZoom";
import { emptyPage } from "../model/PageData";
import type { PageData } from "../model/PageData";
import type { InlineInkHost } from "./InlineInkStore";

type Fields = Record<string, unknown>;

/** Sidecars on "disk", by path: the stored font reference, or none. */
const disk = new Map<string, number | null>();

function sidecar(path: string): PageData | null {
	if (!disk.has(path)) return null;
	const page = emptyPage(`pg-${path}`);
	page.surface = "inline";
	const ref = disk.get(path);
	if (ref !== null && ref !== undefined) page.fontRefPx = ref;
	return page;
}

const host: InlineInkHost = {
	readPageId: (path) => `pg-${path}`,
	claimId: async (_p, id) => ({ pageId: id }),
	loadSidecar: async (id) => {
		const path = id.replace(/^pg-/, "");
		const data = sidecar(path);
		return data ? { data, recovered: false } : null;
	},
	scheduleSidecar: () => undefined,
	notify: () => undefined,
};

beforeAll(() => inlineInk.attachHost(host));
afterAll(() => (inlineInk as unknown as { host: unknown }).host = null);

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined },
		style: { removeProperty: () => undefined },
		...extra,
	};
}

interface Rig {
	/** The editor's font moves to `fontPx` and the real handleResize measures it. */
	resize(fontPx: number): void;
	/** The real loadInk for `path`, with `path` the open note, awaited through the sidecar read. */
	open(path: string): Promise<void>;
	/** The real loadInk for `path`, NOT awaited: what the overlay holds before the ink read resolves. */
	openNow(path: string): void;
	refFontPx(): number;
	fontZoom(): number;
}

/** The Object.create overlay of RemountFontRef.test.ts, with a note path and loadInk's collaborators. */
function makeRig(): Rig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const contentHost = { fontSize: "16px" };
	let openPath: string | null = null;

	const canvas = (): Fields => el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];
	const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
	const container = el({ getBoundingClientRect: () => rect, offsetWidth: 800, offsetHeight: 600 });
	const scrollDOM = el({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 600,
		scrollWidth: 800,
		scrollHeight: 600,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({
			get fontSize() {
				return contentHost.fontSize;
			},
		}),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};
	o.view = {
		state: { field: () => undefined },
		dom: el({ ownerDocument: { defaultView: win }, parentElement: null }),
		scrollDOM,
		contentDOM: el({
			children: [] as unknown[],
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
		}),
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
	};
	o.container = container;
	o.committedCanvas = canvases[0];
	o.wetCanvas = canvases[1];
	o.tailCanvas = canvases[2];
	o.highlightCanvas = canvases[3];
	o.highlightWetCanvas = canvases[4];
	o.committedCtx = { setTransform: () => undefined };
	o.highlightCtx = { setTransform: () => undefined };
	const renderer = { applyDpr: () => undefined, clear: () => undefined };
	o.wet = renderer;
	o.highlightWet = renderer;
	o.tail = {
		applyDpr: () => undefined, clearAll: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	o.contentStyle = null;
	o.refFontPx = 0;
	o.lastFontStr = "";
	o.lastSyncFontStr = "";
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;
	o.frame = { locked: false, cancel: () => undefined };
	o.wheelZoomRun = new WheelZoomRun();
	o.paperKindWatch = [];
	o.paperKindFrame = null;
	o.band = null;
	o.router = null;
	o.axisChecked = false;
	o.lastReach = null;
	o.indexDirty = true;
	o.lastPaintCam = null;
	o.damage = { addAll: () => undefined };
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.pinchScaleNow = 1;
	o.pinchRasterScale = 1;
	o.mobileTools = null;
	o.noteZoomControls = null;
	o.repaint = () => undefined;
	o.scheduleRepaint = () => undefined;
	o.updateHandwritingPageClass = () => undefined;
	o.filePath = () => openPath;

	const proto = InkOverlayPlugin.prototype as unknown as {
		handleResize: () => void;
		loadInk: (path: string | null) => void;
	};
	return {
		resize(fontPx: number) {
			contentHost.fontSize = `${fontPx}px`;
			proto.handleResize.call(o);
		},
		async open(path: string) {
			openPath = path;
			proto.loadInk.call(o, path);
			await inlineInk.ensureLoaded(path);
			// loadInk's own continuation is queued behind the same read.
			for (let i = 0; i < 5; i++) await Promise.resolve();
		},
		openNow(path: string) {
			openPath = path;
			proto.loadInk.call(o, path);
		},
		refFontPx: () => o.refFontPx as number,
		fontZoom: () => o.fontZoom as number,
	};
}

describe("audit 46: the overlay reads each note at its stored font reference", () => {
	it("a note stored at 16 and opened at 20 reads at reference 16, fontZoom 1.25", async () => {
		disk.set("stored16.md", 16);
		const rig = makeRig();
		rig.resize(20); // mount measures the editor first
		await rig.open("stored16.md");
		expect(rig.refFontPx(), "the reference is the note's stored size").toBe(16);
		expect(rig.fontZoom(), "ink stored at 16 is drawn 1.25x at 20").toBeCloseTo(1.25, 10);
	});

	it("a note with no stored reference latches the size it opens at, and the store takes it once", async () => {
		disk.set("nofield.md", null);
		const rig = makeRig();
		rig.resize(20);
		await rig.open("nofield.md");
		expect(rig.refFontPx(), "no stored reference: the size it opens at, as before").toBe(20);
		expect(rig.fontZoom()).toBe(1);
		expect(inlineInk.fontRefPx("nofield.md"), "the store holds it for the next ordinary save").toBe(20);
		rig.resize(24);
		expect(inlineInk.fontRefPx("nofield.md"), "a later size change does not replace it").toBe(20);
	});

	it("two notes opened in turn in one editor at two stored sizes each read at their own", async () => {
		disk.set("first16.md", 16);
		disk.set("second20.md", 20);
		const rig = makeRig();
		rig.resize(20);
		await rig.open("first16.md");
		expect(rig.refFontPx(), "first note").toBe(16);
		expect(rig.fontZoom()).toBeCloseTo(1.25, 10);
		await rig.open("second20.md"); // the note-switch branch runs loadInk for the note that takes over
		expect(rig.refFontPx(), "second note, same editor").toBe(20);
		expect(rig.fontZoom(), "second note").toBe(1);
		await rig.open("first16.md");
		expect(rig.refFontPx(), "back to the first note").toBe(16);
		expect(rig.fontZoom()).toBeCloseTo(1.25, 10);
	});
	it("a note with nothing stored, opened after one stored at another size, takes its own size, never the other's", async () => {
		disk.set("storedA16.md", 16);
		disk.set("plainB.md", null);
		const rig = makeRig();
		rig.resize(20);
		await rig.open("storedA16.md");
		expect(rig.refFontPx(), "note A at its stored 16").toBe(16);
		await rig.open("plainB.md"); // same editor, still at 20
		expect(rig.refFontPx(), "note B latches its own size").toBe(20);
		expect(rig.fontZoom(), "note B").toBe(1);
		expect(inlineInk.fontRefPx("plainB.md"), "note B's file stores 20, not note A's 16").toBe(20);
	});

	it("a note already in the store reads at its stored reference at open, before its ink read resolves", async () => {
		disk.set("cached16.md", 16);
		await inlineInk.ensureLoaded("cached16.md"); // read once already, as by another pane or an earlier open
		const rig = makeRig();
		rig.resize(20);
		rig.openNow("cached16.md");
		expect(rig.refFontPx(), "the stored reference is taken at open, not after the read").toBe(16);
		expect(rig.fontZoom(), "the first frame is drawn in the stored frame").toBeCloseTo(1.25, 10);
		await rig.open("cached16.md"); // let the read's continuation run out
		expect(rig.refFontPx()).toBe(16);
	});
});
