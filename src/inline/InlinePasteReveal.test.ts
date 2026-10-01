import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { clearInkClipboard, copyInk } from "./InkClipboard";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.ResizeObserver ??= NoopObserver;
globals.MutationObserver ??= NoopObserver;

function importedStroke(x = 2400, y = 3200, id = "imported"): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 3.5,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 40, y: y + 40, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: y - 2, width: 44, height: 44 },
		createdAt: 1,
	};
}

type PasteRig = {
	overlay: InkOverlayPlugin;
	extentCalls: boolean[];
	geometryCalls: string[];
	repaintCalls: string[];
	scroll: { left: number; top: number };
};

/**
 * A real pasteInkHere with just its host chrome replaced. The scroll setters
 * model the browser's clamp on a blank note: an attempted scroll is zero until
 * the extent spacer has synchronously made that axis reachable.
 */
function pasteRig(path: string): PasteRig {
	const noop = (): void => undefined;
	let fileReady = false;
	let extentReady = false;
	const extentCalls: boolean[] = [];
	const geometryCalls: string[] = [];
	const repaintCalls: string[] = [];
	const scroll = { left: 0, top: 0 };
	const scrollDOM = {
		clientWidth: 800,
		clientHeight: 600,
		clientLeft: 0,
		clientTop: 0,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		get scrollLeft(): number {
			return scroll.left;
		},
		set scrollLeft(value: number) {
			geometryCalls.push("scroll-left");
			scroll.left = extentReady ? Math.max(0, value) : 0;
		},
		get scrollTop(): number {
			return scroll.top;
		},
		set scrollTop(value: number) {
			geometryCalls.push("scroll-top");
			scroll.top = extentReady ? Math.max(0, value) : 0;
		},
	};
	const dom = {
		ownerDocument: { defaultView: { getComputedStyle: () => ({ position: "relative" }) } },
		parentElement: null,
		closest: (selector: string): unknown => selector === ".markdown-source-view" ? root : null,
	};
	const root = { ownerDocument: dom.ownerDocument, querySelector: () => dom };
	const view = {
		dom,
		scrollDOM,
		state: {
			field: () => (fileReady ? { file: { path } } : undefined),
		},
		dispatch: noop,
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	fileReady = true;
	overlay.container = { nodeType: 1, remove: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.mobileTools = null;
	overlay.scheduleRepaint = () => void repaintCalls.push("self");
	overlay.repaintPath = (path: string) => void repaintCalls.push(path);
	overlay.redrawSelectionUI = noop;
	overlay.updateExtent = (force = false) => {
		extentCalls.push(force);
		geometryCalls.push("extent");
		extentReady = true;
	};
	overlay.syncCamera = () => void geometryCalls.push("camera");

	return {
		overlay: overlay as unknown as InkOverlayPlugin,
		extentCalls,
		geometryCalls,
		repaintCalls,
		scroll,
	};
}

describe("pasting fixed-grid ink into a blank note", () => {
	beforeEach(() => clearInkClipboard());

	afterEach(() => clearInkClipboard());

	it("makes the pasted coordinates reachable before revealing both axes", () => {
		const path = "blank-paste-both-axes.md";
		copyInk([importedStroke()], "imported-source.md");
		const rig = pasteRig(path);

		expect(rig.overlay.pasteInkHere()).toBe(1);

		expect(inlineInk.strokes(path)).toHaveLength(1);
		expect(rig.repaintCalls).toEqual(["self", path]);
		expect(rig.extentCalls).toEqual([true]);
		expect(rig.geometryCalls).toEqual(["extent", "camera", "scroll-left", "scroll-top"]);
		expect(rig.scroll.left).toBeGreaterThan(0);
		expect(rig.scroll.top).toBeGreaterThan(0);
	});

	it("reveals real ink when a sparse selection's in-view union corner is empty", () => {
		const path = "blank-paste-sparse.md";
		copyInk(
			[importedStroke(1200, 20, "right"), importedStroke(20, 1800, "below")],
			"imported-source.md",
		);
		const rig = pasteRig(path);

		expect(rig.overlay.pasteInkHere()).toBe(2);

		expect(inlineInk.strokes(path)).toHaveLength(2);
		// The first real stroke is offscreen to the right. The union bbox's
		// top-left (18,18) is already in view, but contains no pasted pixels.
		expect(rig.scroll.left).toBeGreaterThan(0);
		expect(rig.scroll.top).toBe(0);
	});

	it("does not mistake one bent stroke's empty bbox interior for visible ink", () => {
		const path = "blank-paste-bent.md";
		const bent = importedStroke(1200, 20, "bent");
		bent.points = [
			{ x: 1200, y: 20, pressure: 0.5, t: 0 },
			{ x: 1200, y: 1800, pressure: 0.5, t: 8 },
			{ x: 20, y: 1800, pressure: 0.5, t: 16 },
		];
		bent.bbox = { x: 18, y: 18, width: 1184, height: 1784 };
		copyInk([bent], "imported-source.md");
		const rig = pasteRig(path);

		expect(rig.overlay.pasteInkHere()).toBe(1);

		// The bbox overlaps the 800x600 viewport, but both segments miss it.
		// Reveal from the first real point at (1200,20).
		expect(rig.scroll.left).toBeGreaterThan(0);
		expect(rig.scroll.top).toBe(0);
	});

	it("does not move a viewport that already contains pasted ink", () => {
		const path = "blank-paste-visible.md";
		copyInk([importedStroke(100, 100)], "imported-source.md");
		const rig = pasteRig(path);

		expect(rig.overlay.pasteInkHere()).toBe(1);

		expect(rig.extentCalls).toEqual([true]);
		expect(rig.scroll).toEqual({ left: 0, top: 0 });
	});
});
