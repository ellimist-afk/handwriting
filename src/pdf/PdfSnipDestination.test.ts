/**
 * THE PDF SNIP PAINTS ITS INK FOR THE PAGE THE USER SAYS THEY WRITE ON.
 *
 * `Ink color when exporting` promises readable ink "in exports, prints, and
 * snips". The PDF snip (`PdfInkController.snipSelection`) used to paint its
 * committed ink with no destination declared, and `exportInkColor` returns the
 * stored colour for an undeclared destination whatever the setting says - so
 * on this one surface the promise was unreachable by construction.
 *
 * WHICH DESTINATION. The page under a PDF snip's ink is the viewer's own
 * rendered page, drawn into the crop - a dark slide as easily as paper - and
 * the controller reads no pixels. So the destination is the page colour the
 * user DECLARES with `Ink color on PDFs` (`inkPdfColorMode`,
 * default darken), the same answer the flatten takes from the same setting. It
 * is an assumption about the page, not a measurement of the crop: nothing here
 * claims local contrast over arbitrary photo pixels, and the "declared, not
 * detected" case below pins exactly that.
 *
 * HOW IT IS DRIVEN. Nothing in this file simulates a painter. The controller
 * is the one `HandwritingPlugin.syncPdfControllers` builds (the production
 * construction site, its arguments untouched), the settings object is the one
 * the real `loadSettings` builds from a data.json, and every change of setting
 * goes through the real settings tab's `setControlValue`. The viewer probe and
 * `viewerCanvasOf` are the real ones, reading a fake pdf.js DOM - a page div
 * holding the viewer's page canvas - so the snip crops a real "rendered page".
 * Only `mount` is stubbed: it binds a live DOM this node run does not have, and
 * the snip does not go through it. The same pattern as the snip cap test in
 * PdfInkController.test.ts (`createEl` swapped for a recording canvas) and as
 * SettingsUnknownKeys.test.ts (`Object.create(HandwritingPlugin.prototype)`).
 *
 * WHAT IS ASSERTED is the colour that reached the snip's canvas at each ink
 * fill, measured as WCAG contrast against the page colour the FIXTURE painted
 * (its own literals, not the module's PDF_PAGE_* constants), against
 * `EXPORT_MIN_CONTRAST`. The no-op branches ("keep", readability off) are
 * identity claims and are asserted as identity. Each readability case also
 * checks its own fixture starts below the bar, so it can fail the way the
 * defect fails.
 *
 * SCOPE HYGIENE. The destination is a module-wide flag and `drawCommitted` is
 * also the live overlay's painter, so the last two cases run the overlay's own
 * `paint` while the PNG is still encoding and after a snip whose paint threw,
 * and require the stored colour both times.
 *
 * REPLACES the characterisation that stood here at fed59a8c: two cases that
 * simulated the painters with local helpers (and would have stayed green after
 * the fix) and a source pin on the absence of `withInkDestination`. Replaced in
 * the commit that closed the gap, as that file said it would be.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin, { HandwritingSettingTab } from "../main";
import { PdfInkController } from "./PdfInkController";
import {
	EXPORT_MIN_CONTRAST,
	contrastRatio,
	relativeLuminance,
	resetInkTheme,
} from "../ink/InkTheme";
import { InkStroke, computeBBox } from "../ink/Stroke";

/** css px of the page div, and css px per PDF point (`--scale-factor`). */
const PAGE_W = 600;
const PAGE_H = 800;
const SCALE = 2;
/** The viewer's page canvas backing store: 4 backing px per point. */
const K = 4;

/** Paper, as a white scan renders it. */
const WHITE_PAGE = "#ffffff";
/** A dark slide. Deliberately not PDF_PAGE_DARK: the fixture's page is its own. */
const DARK_PAGE = "#202020";
/** The palette's white pen - the colour the export complaint was about. */
const FAINT = "#f4f4f2";
const BLACK = "#000000";

function lum(color: string): number {
	const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
	if (!m) throw new Error(`not a #rrggbb colour: ${color}`);
	const n = Number.parseInt(m[1]!, 16);
	return relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
const contrastOn = (ink: string, page: string): number => contrastRatio(lum(ink), lum(page));

function strokeOf(id: string, color: string): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 120 + i * 3, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color, width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
}

/** One call a canvas context received, with the style it was made under. */
interface Call {
	op: "fill" | "stroke" | "fillRect" | "drawImage" | "getImageData";
	color: string;
	args: unknown[];
}

/**
 * A 2D context that records the calls that put colour on the canvas and
 * absorbs the rest - the same Proxy the band suite uses, because the REAL
 * `drawStroke` runs against it and touches a long tail of canvas API.
 */
function recordingCtx(calls: Call[], failFill: () => boolean = () => false): CanvasRenderingContext2D {
	const state: Record<string, unknown> = { fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1 };
	const methods: Record<string, (...a: unknown[]) => unknown> = {
		fill: (...args) => {
			if (failFill()) throw new Error("paint failed mid-snip");
			calls.push({ op: "fill", color: String(state.fillStyle), args });
		},
		stroke: (...args) => void calls.push({ op: "stroke", color: String(state.strokeStyle), args }),
		fillRect: (...args) => void calls.push({ op: "fillRect", color: String(state.fillStyle), args }),
		drawImage: (...args) => void calls.push({ op: "drawImage", color: "", args }),
		getImageData: (...args) => {
			calls.push({ op: "getImageData", color: "", args });
			throw new Error("the snip read page pixels back");
		},
	};
	return new Proxy(state, {
		get: (t, p) => (typeof p === "string" && p in methods ? methods[p] : p in t ? t[p as string] : () => undefined),
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

/** The colours ink was painted with: every fill and stroke after the page went down. */
function inkColours(calls: readonly Call[]): string[] {
	const pageAt = calls.findIndex((c) => c.op === "drawImage");
	return calls.slice(pageAt + 1).filter((c) => c.op === "fill" || c.op === "stroke").map((c) => c.color);
}

const proto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
	syncPdfControllers(this: unknown): void;
};

interface SnipCanvas {
	width: number;
	height: number;
	calls: Call[];
}

interface Rig {
	controller: PdfInkController;
	tab: { setControlValue(key: string, value: unknown): void };
	settings: Record<string, unknown>;
	strokes: InkStroke[];
	viewerCanvas: object;
	/** Snip canvases made so far, newest last. */
	snips: SnipCanvas[];
	/** Store writes made so far. */
	writes: string[];
	/** Hold the next PNG encode until `releaseEncode` is called. */
	holdEncode(): void;
	releaseEncode(): void;
	encodePending(): boolean;
	/** Make the next snip's ink paint throw. */
	failNextPaint(): void;
	/** Select every stroke on page 1, the way a lasso leaves it. */
	selectAll(): void;
	/** Run the live overlay's own paint on page 1; the ink colours it used. */
	paintOverlay(): string[];
}

/**
 * The plugin, loaded from `raw` as data.json, with one pdf leaf open on a page
 * the viewer has rendered in `pageColour`, and the controller production built
 * for it.
 */
async function rig(raw: Record<string, unknown>, pageColour: string, strokes: InkStroke[]): Promise<Rig> {
	const g = globalThis as unknown as Record<string, unknown>;
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };

	const overlayCalls: Call[] = [];
	const viewerCanvas: Record<string, unknown> = {
		width: (PAGE_W / SCALE) * K,
		height: (PAGE_H / SCALE) * K,
		hidden: false,
		// What the fixture rendered. Nothing reads it but the assertions: the
		// controller has no business sampling it, and the fake has no context.
		pageColour,
		offsetLeft: 0,
		offsetTop: 0,
		clientWidth: PAGE_W,
		clientHeight: PAGE_H,
	};
	const page: Record<string, unknown> = {
		tagName: "DIV",
		className: "page",
		parentElement: null,
		clientWidth: PAGE_W,
		clientHeight: PAGE_H,
		offsetTop: 0,
		offsetLeft: 0,
		clientTop: 0,
		clientLeft: 0,
		getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
		querySelector: (sel: string) => (sel.startsWith("canvas") ? viewerCanvas : null),
		querySelectorAll: (sel: string) => (sel.startsWith("canvas") ? [viewerCanvas] : []),
		createEl: () => {
			const overlayCtx = recordingCtx(overlayCalls);
			const c: Record<string, unknown> = {
				width: 0,
				height: 0,
				parentElement: page,
				setAttribute: () => {},
				setCssStyles: () => {},
				getContext: () => overlayCtx,
				remove: () => {
					c.parentElement = null;
				},
			};
			return c;
		},
		appendChild: () => {},
		setCssStyles: () => {},
	};
	viewerCanvas.offsetParent = page;
	const scroller = {
		scrollTop: 0,
		scrollLeft: 0,
		querySelectorAll: (sel: string) => (sel === "div.page[data-page-number]" ? [page] : []),
		querySelector: (sel: string) => (sel === 'div.page[data-page-number="1"]' ? page : null),
	};
	const win = {
		devicePixelRatio: 2,
		// The setting change asks each open PDF for a repaint frame; this rig paints nothing, so the frame never runs.
		requestAnimationFrame: () => 0,
		getComputedStyle: (el: unknown) => ({
			position: "relative",
			getPropertyValue: (p: string) => (p === "--scale-factor" && el === page ? String(SCALE) : ""),
		}),
	};
	const root = {
		isConnected: true,
		ownerDocument: { defaultView: win },
		querySelector: (sel: string) => (sel === ".pdf-viewer-container" ? scroller : null),
	};

	const writes: string[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saveData = (): Promise<void> => Promise.resolve();
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.saveSettingsNow = (): void => {};
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.pdfStore = {
		attachHost: () => {},
		strokesOnPage: (_id: string, n: number) => strokes.filter((s) => s.page === n),
		strokes: () => strokes,
		replaceAll: () => void writes.push("replaceAll"),
		replaceAllLive: () => void writes.push("replaceAllLive"),
		save: () => void writes.push("save"),
	};
	plugin.app = {
		workspace: {
			onLayoutReady: () => {},
			getLeavesOfType: (type: string) =>
				type === "pdf" ? [{ view: { containerEl: root, file: { path: "slides.pdf" } } }] : [],
		},
	};
	plugin.pdfInk = new Map();
	plugin.pdfFiles = new Map();
	// Already identified, so the page source answers without the hash.
	plugin.pdfIds = new Map([[root, "doc-1"]]);
	plugin.pdfCalibration = false;
	plugin.resolvePdfId = (): Promise<void> => Promise.resolve();

	await proto.loadSettings.call(plugin);
	proto.syncPdfControllers.call(plugin);
	const controller = (plugin.pdfInk as Map<unknown, PdfInkController>).get(root);
	if (!controller) throw new Error("syncPdfControllers built no controller for the pdf leaf");

	const tab = Object.create(HandwritingSettingTab.prototype) as Rig["tab"] & Record<string, unknown>;
	tab.plugin = plugin;

	const snips: SnipCanvas[] = [];
	let hold = false;
	let pending: (() => void) | null = null;
	let failPaint = false;
	g.createEl = (): unknown => {
		const calls: Call[] = [];
		const ctx = recordingCtx(calls, () => failPaint);
		const c = {
			width: 0,
			height: 0,
			calls,
			getContext: () => ctx,
			toBlob: (cb: (b: Blob | null) => void) => {
				const done = () => cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
				if (hold) pending = done;
				else done();
			},
		};
		snips.push(c);
		return c;
	};

	const priv = controller as unknown as {
		selected: string[];
		selectionPage: number;
		paint(pageEl: unknown, box: unknown, scale: number, zoomed: boolean): void;
	};
	const box = { pageNumber: 1, leftPx: 0, topPx: 0, widthPx: PAGE_W, heightPx: PAGE_H };
	const paintOverlay = (): string[] => {
		const from = overlayCalls.length;
		priv.paint(page, box, SCALE, true);
		return overlayCalls.slice(from).filter((c) => c.op === "fill" || c.op === "stroke").map((c) => c.color);
	};
	// The overlay canvas is built BEFORE anything is selected: a first paint
	// with a selection held also rebuilds the lasso outline on the wet layer,
	// which is not what these cases are about.
	expect(paintOverlay().length, "the live overlay painted no ink").toBeGreaterThan(0);

	return {
		controller,
		tab,
		settings: plugin.settings as Record<string, unknown>,
		strokes,
		viewerCanvas,
		snips,
		writes,
		holdEncode: () => {
			hold = true;
		},
		releaseEncode: () => {
			hold = false;
			const p = pending;
			pending = null;
			p?.();
		},
		encodePending: () => pending !== null,
		failNextPaint: () => {
			failPaint = true;
		},
		selectAll: () => {
			priv.selected = strokes.map((s) => s.id);
			priv.selectionPage = 1;
		},
		paintOverlay,
	};
}

/** Snip, require success, and hand back the canvas it painted. */
async function snip(r: Rig): Promise<SnipCanvas> {
	const result = await r.controller.snipSelection();
	expect(result.ok, result.ok ? "" : `snip refused: ${result.reason}`).toBe(true);
	const c = r.snips[r.snips.length - 1];
	if (!c) throw new Error("the snip made no canvas");
	return c;
}

beforeEach(() => {
	resetInkTheme();
	vi.spyOn(PdfInkController.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetInkTheme();
	delete (globalThis as unknown as Record<string, unknown>).createEl;
});

describe("the PDF snip paints its ink for the page the user declares", () => {
	it("white page, default setting: faint pen ink lands readable over the viewer's own page crop", async () => {
		const r = await rig({}, WHITE_PAGE, [strokeOf("faint", FAINT)]);
		// The default is what loadSettings decides for a data.json without the key.
		expect(r.settings.inkPdfColorMode).toBe("darken");
		expect(contrastOn(FAINT, WHITE_PAGE), "fixture: the ink must start unreadable").toBeLessThan(
			EXPORT_MIN_CONTRAST
		);
		r.selectAll();

		const out = await snip(r);

		// The page under the ink is the viewer's rendered canvas, cropped around
		// the selection and stretched over the whole snip, before any ink.
		const at = out.calls.findIndex((c) => c.op === "drawImage");
		expect(at, "the snip never drew the viewer's page").toBeGreaterThanOrEqual(0);
		const [src, sx, sy, sw, sh, dx, dy] = out.calls[at]!.args as [
			object,
			number,
			number,
			number,
			number,
			number,
			number,
		];
		expect(src).toBe(r.viewerCanvas);
		const bb = r.strokes[0]!.bbox;
		expect(sx).toBeLessThanOrEqual(bb.x * K);
		expect(sy).toBeLessThanOrEqual(bb.y * K);
		expect(sx + sw).toBeGreaterThanOrEqual((bb.x + bb.width) * K);
		expect(sy + sh).toBeGreaterThanOrEqual((bb.y + bb.height) * K);
		expect(sw * sh, "the crop was the whole page, not the selection").toBeLessThan(
			(PAGE_W / SCALE) * K * (PAGE_H / SCALE) * K
		);
		expect([dx, dy]).toEqual([0, 0]);

		const ink = inkColours(out.calls);
		expect(ink.length, "no ink was painted over the page").toBeGreaterThan(0);
		for (const c of ink) {
			expect(contrastOn(c, WHITE_PAGE), `snip painted ${c} on a white page`).toBeGreaterThanOrEqual(
				EXPORT_MIN_CONTRAST
			);
		}
		expect(out.calls.some((c) => c.op === "getImageData"), "the snip read page pixels").toBe(false);
	});

	it("dark page, Lighten for dark pages: black pen ink lands readable", async () => {
		const r = await rig({ inkPdfColorMode: "lighten" }, DARK_PAGE, [strokeOf("black", BLACK)]);
		expect(contrastOn(BLACK, DARK_PAGE), "fixture: the ink must start unreadable").toBeLessThan(
			EXPORT_MIN_CONTRAST
		);
		r.selectAll();

		const ink = inkColours((await snip(r)).calls);
		expect(ink.length).toBeGreaterThan(0);
		for (const c of ink) {
			expect(contrastOn(c, DARK_PAGE), `snip painted ${c} on a dark page`).toBeGreaterThanOrEqual(
				EXPORT_MIN_CONTRAST
			);
		}
	});

	it("the setting is read at snip time: a change in the settings tab moves the very next snip", async () => {
		// A dark slide snipped under the default: the declared page is white, so
		// black ink is left alone and stays unreadable on the slide. The user
		// switches the dropdown and snips again on the same controller.
		const r = await rig({}, DARK_PAGE, [strokeOf("black", BLACK)]);
		r.selectAll();

		const first = inkColours((await snip(r)).calls);
		expect(first.length).toBeGreaterThan(0);
		for (const c of first) expect(contrastOn(c, DARK_PAGE)).toBeLessThan(EXPORT_MIN_CONTRAST);

		r.tab.setControlValue("inkPdfColorMode", "lighten");
		expect(r.settings.inkPdfColorMode).toBe("lighten");
		const second = inkColours((await snip(r)).calls);
		expect(second.length).toBeGreaterThan(0);
		for (const c of second) {
			expect(contrastOn(c, DARK_PAGE), `after switching to lighten the snip painted ${c}`).toBeGreaterThanOrEqual(
				EXPORT_MIN_CONTRAST
			);
		}

		r.tab.setControlValue("inkPdfColorMode", "darken");
		const third = inkColours((await snip(r)).calls);
		expect(third.length).toBeGreaterThan(0);
		for (const c of third) expect(contrastOn(c, DARK_PAGE)).toBeLessThan(EXPORT_MIN_CONTRAST);
	});

	it("declared, not detected: a dark page snipped under darken keeps the white-page answer", async () => {
		// The controller cannot see the page and must not try. Faint ink on a
		// dark slide already reads; the declared white page says darken it,
		// and it is darkened - toward the slide. That is the documented cost of
		// an assumption, and the reason the dropdown has a lighten option.
		const r = await rig({}, DARK_PAGE, [strokeOf("faint", FAINT)]);
		r.selectAll();
		const out = await snip(r);
		const ink = inkColours(out.calls);
		expect(ink.length).toBeGreaterThan(0);
		for (const c of ink) {
			expect(contrastOn(c, WHITE_PAGE)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
			expect(lum(c)).toBeLessThan(lum(FAINT));
		}
		expect(out.calls.some((c) => c.op === "getImageData")).toBe(false);
	});

	it("Keep original colors: the snip paints the stored colour byte for byte", async () => {
		const r = await rig({ inkPdfColorMode: "keep" }, WHITE_PAGE, [strokeOf("faint", FAINT)]);
		expect(r.settings.inkPdfColorMode).toBe("keep");
		r.selectAll();
		const ink = inkColours((await snip(r)).calls);
		expect(ink.length).toBeGreaterThan(0);
		expect(new Set(ink)).toEqual(new Set([FAINT]));
	});

	it("export readability off: the snip paints the stored colour byte for byte under any page setting", async () => {
		const r = await rig({}, WHITE_PAGE, [strokeOf("faint", FAINT)]);
		r.tab.setControlValue("inkReadableInExports", "keep");
		expect(r.settings.inkReadableInExports).toBe(false);
		r.selectAll();
		for (const mode of ["darken", "lighten"]) {
			r.tab.setControlValue("inkPdfColorMode", mode);
			const ink = inkColours((await snip(r)).calls);
			expect(ink.length).toBeGreaterThan(0);
			expect(new Set(ink), `readability off, ${mode}`).toEqual(new Set([FAINT]));
		}
	});

	it("the stored ink and the store are untouched by a readable snip", async () => {
		const r = await rig({}, WHITE_PAGE, [strokeOf("faint", FAINT), strokeOf("black", BLACK)]);
		const before = JSON.stringify(r.strokes);
		r.selectAll();
		const ink = inkColours((await snip(r)).calls);
		// It really did adjust something, or "untouched" would be vacuous.
		expect(ink.some((c) => c !== FAINT && c !== BLACK)).toBe(true);
		expect(JSON.stringify(r.strokes)).toBe(before);
		expect(r.strokes.map((s) => s.color)).toEqual([FAINT, BLACK]);
		expect(r.writes).toEqual([]);
	});
});

describe("the snip's destination ends with its paint", () => {
	it("an overlay repaint while the PNG is still encoding paints the stored colour", async () => {
		const r = await rig({}, WHITE_PAGE, [strokeOf("faint", FAINT)]);
		r.selectAll();
		r.holdEncode();

		const pending = r.controller.snipSelection();
		expect(r.encodePending(), "the snip did not reach its encode").toBe(true);
		// The live overlay repaints in the gap, as a scroll or a pen stroke would.
		const live = r.paintOverlay();
		expect(live.length).toBeGreaterThan(0);
		expect(new Set(live), "a live repaint during the encode took the snip's colours").toEqual(new Set([FAINT]));

		r.releaseEncode();
		const result = await pending;
		expect(result.ok).toBe(true);
		// ...and the snip itself was painted readable, so the scope was real.
		const ink = inkColours(r.snips[r.snips.length - 1]!.calls);
		expect(ink.length).toBeGreaterThan(0);
		for (const c of ink) expect(contrastOn(c, WHITE_PAGE)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);

		expect(new Set(r.paintOverlay()), "a live repaint after the snip").toEqual(new Set([FAINT]));
	});

	it("a snip whose ink paint throws leaves no destination behind", async () => {
		const r = await rig({}, WHITE_PAGE, [strokeOf("faint", FAINT)]);
		r.selectAll();
		r.failNextPaint();
		await expect(r.controller.snipSelection()).rejects.toThrow("paint failed mid-snip");

		const live = r.paintOverlay();
		expect(live.length).toBeGreaterThan(0);
		expect(new Set(live), "a live repaint after a failed snip took the snip's colours").toEqual(new Set([FAINT]));
	});
});
