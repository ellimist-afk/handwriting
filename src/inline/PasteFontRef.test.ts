/**
 * Pasting ink between notes keeps its size and place against each note's font
 * reference.
 *
 * A stroke's coordinates are in the frame of the note's reference font size.
 * Ink copied from a note whose reference is 16px and pasted unchanged into one
 * whose reference is 20px is painted at 80% of its size and 80% of its
 * distance from the top left. The paste scales each stroke by target over
 * source when both references are known and differ; an unknown size on either
 * side means no scaling.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { clearInkClipboard } from "./InkClipboard";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.ResizeObserver ??= NoopObserver;
globals.MutationObserver ??= NoopObserver;

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 4,
		points: [
			{ x: 80, y: 160, pressure: 0.5, t: 0 },
			{ x: 112, y: 192, pressure: 0.5, t: 8 },
		],
		bbox: { x: 78, y: 158, width: 36, height: 36 },
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

let serial = 0;

/** Copy one stroke out of a note whose reference font is `sourceRef` (null: none stored). */
async function copyFrom(sourceRef: number | null): Promise<void> {
	const path = `paste-font-ref-source-${++serial}.md`;
	await inlineInk.ensureLoaded(path);
	if (sourceRef !== null) inlineInk.setFontRefPx(path, sourceRef);
	inlineInk.applyAdd(path, [stroke("s")]);
	const rig = pasteRig(path);
	const overlay = rig.overlay as unknown as { selection: { selectExactly(ids: string[]): void } };
	overlay.selection.selectExactly(["s"]);
	expect(rig.overlay.copySelectedInk(), "premise: the stroke was copied").toBe(1);
}

/** Paste into a note whose reference font is `targetRef`; the stroke that landed. */
async function pasteInto(targetRef: number | null): Promise<InkStroke> {
	const path = `paste-font-ref-target-${++serial}.md`;
	await inlineInk.ensureLoaded(path);
	if (targetRef !== null) inlineInk.setFontRefPx(path, targetRef);
	const rig = pasteRig(path);
	expect(rig.overlay.pasteInkHere(), "premise: the stroke was pasted").toBe(1);
	return inlineInk.strokes(path)[0]!;
}

const placeOf = (s: InkStroke) => ({ x: s.points[0]!.x, y: s.points[0]!.y, w: s.bbox.width });

describe("pasting ink between notes with different font references", () => {
	beforeEach(() => clearInkClipboard());
	afterEach(() => clearInkClipboard());

	it("ink from a 16px note lands at the same look in a 20px note", async () => {
		await copyFrom(16);
		const pasted = await pasteInto(20);
		expect(placeOf(pasted)).toEqual({ x: 100, y: 200, w: 45 });
		expect(pasted.width).toBe(5);
	});

	it("ink from a 20px note lands at the same look in a 16px note", async () => {
		await copyFrom(20);
		const pasted = await pasteInto(16);
		expect(placeOf(pasted)).toEqual({ x: 64, y: 128, w: expect.closeTo(28.8, 6) });
		expect(pasted.width).toBeCloseTo(3.2, 6);
	});

	it("control: two notes with the same reference paste unchanged", async () => {
		await copyFrom(16);
		expect(placeOf(await pasteInto(16))).toEqual({ x: 80, y: 160, w: 36 });
	});

	it("control: a target with no stored reference pastes unchanged", async () => {
		await copyFrom(16);
		expect(placeOf(await pasteInto(null))).toEqual({ x: 80, y: 160, w: 36 });
	});

	it("control: a source with no stored reference pastes unchanged", async () => {
		await copyFrom(null);
		expect(placeOf(await pasteInto(20))).toEqual({ x: 80, y: 160, w: 36 });
	});
});
