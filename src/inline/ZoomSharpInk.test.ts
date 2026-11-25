/**
 * Sharp ink above 100%: what the band margin in the reader's px does to the settle's ease, and a printed report of
 * the pen's small canvases at the zooms the backing now follows.
 *
 * THE EASE. With Infinite Canvas on, a page the settle moves left or up from where the preview painted it eases back
 * only within one band margin of room past the far edge (travelledEaseRoom), in scroller px; past it the correction
 * lands at the lift. Above 100% that room was 320 scroller px, 2560 screen px at 800%, while at and below 100% it is
 * 320 screen px. The margin is now the reader's px at every zoom, so the room is too: at 800% a correction of 400
 * screen px (50 scroller px) against 100 scroller px of scroll left past the edge is past a room of 40 and lands.
 *
 * THE REPORT. The wet tile and the compact tail need a backing on a whole pixel grid. The backing now follows the
 * zoom, so on a band over the area cap it is trimmed to a value with no grid, and the pen strips draw into the full
 * canvas. The report prints grid and tile px at each zoom for the iPad band; it pins nothing.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin, travelledEaseRoom } from "./InkOverlay";
import { bandFor } from "./ScrollBand";
import { backingScale } from "./ZoomScale";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";

function settleWithRunningEase(scale: number, roomPastX: number, pinch?: number) {
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	const hold = {};
	overlay.canvasMode = true;
	overlay.cssScale = scale;
	if (pinch !== undefined) overlay.pinchScaleNow = pinch;
	overlay.viewportPan = { x: 0, y: 0 };
	Object.defineProperty(overlay, "winRef", { value: { performance: { now: () => 1000 } } });
	const clientWidth = Math.round(834 / scale), clientHeight = Math.round(1194 / scale);
	overlay.view = { scrollDOM: { scrollLeft: 0, scrollTop: 0, clientWidth, clientHeight, scrollWidth: clientWidth + roomPastX, scrollHeight: clientHeight } };
	// The settle's first ease is running; each measure attempt re-aims it by the start's own rule.
	overlay.bounceOffset = { x: -30, y: 0 };
	overlay.bouncedHold = hold;
	overlay.bounceState = { hold, fromX: -30, fromY: 0, startedAt: 0, raf: 0 };
	return { overlay, hold };
}

describe("the settle's leftward ease above 100%, Infinite Canvas on", () => {
	it("lands a 400 screen px correction at 800% instead of easing it, with 100 scroller px past the edge", () => {
		const { overlay, hold } = settleWithRunningEase(8, 100);
		overlay.startOverscrollBounce(hold, -400, 0, true, true);
		expect(overlay.bounceOffset.x, "the ease took 50 scroller px against a room of 40").toBe(0);
		expect(overlay.bounceState.fromX).toBe(0);
	});

	it("control: still eases a 300 screen px correction there (38 scroller px, inside the room)", () => {
		const { overlay, hold } = settleWithRunningEase(8, 100);
		overlay.startOverscrollBounce(hold, -300, 0, true, true);
		expect(overlay.bounceOffset.x).toBe(-300);
	});

	it("control: at 100% the room is the same 320 screen px it was", () => {
		const { overlay, hold } = settleWithRunningEase(1, 1000);
		overlay.startOverscrollBounce(hold, -320, 0, true, true);
		expect(overlay.bounceOffset.x, "320 px is inside the room").toBe(-320);
		const past = settleWithRunningEase(1, 1000);
		past.overlay.startOverscrollBounce(past.hold, -321, 0, true, true);
		expect(past.overlay.bounceOffset.x, "321 px is past it").toBe(0);
	});
});

/**
 * AN OUTER CSS SCALE OF 1.25 WITH THE PINCH AT 100%. The zoom the person set is 100%, so the ease room is the base's:
 * 320 scroller px, and a leftward settle of 330, 360 or 399 painted px (264, 288, 320 scroller px) eases back as it did
 * before the margin was divided above 100%, where that division refused it against a room of 256 and the page jumped at the lift. At a pinch of 2 the room is half
 * the 100% room of the same pane, 160 scroller px.
 */
describe("the settle's leftward ease under an outer CSS scale of 1.25, Infinite Canvas on", () => {
	it("at pinch 100%, eases a 330, 360 and 399 painted px correction, as the base did", () => {
		for (const d of [330, 360, 399]) {
			const { overlay, hold } = settleWithRunningEase(1.25, 1000, 1);
			overlay.startOverscrollBounce(hold, -d, 0, true, true);
			expect(overlay.bounceOffset.x, `${d} painted px, ${Math.ceil(d / 1.25)} scroller px against the base's 320`).toBe(-d);
		}
	});

	it("control: at pinch 100%, a 401 painted px correction lands, as at the base (321 scroller px)", () => {
		const { overlay, hold } = settleWithRunningEase(1.25, 1000, 1);
		overlay.startOverscrollBounce(hold, -401, 0, true, true);
		expect(overlay.bounceOffset.x).toBe(0);
	});

	it("at pinch 2, the room is 160 scroller px: 400 painted px eases, 401 lands", () => {
		const eased = settleWithRunningEase(2.5, 1000, 2);
		eased.overlay.startOverscrollBounce(eased.hold, -400, 0, true, true);
		expect(eased.overlay.bounceOffset.x, "160 scroller px, inside the room").toBe(-400);
		const past = settleWithRunningEase(2.5, 1000, 2);
		past.overlay.startOverscrollBounce(past.hold, -401, 0, true, true);
		expect(past.overlay.bounceOffset.x, "161 scroller px, past it").toBe(0);
	});

	it("the room itself, read with the pinch: 320 at pinch 100%, 160 at pinch 2", () => {
		const v = { scrollLeft: 0, scrollTop: 0, clientWidth: 667, clientHeight: 955, scrollWidth: 1667, scrollHeight: 1955 };
		expect(travelledEaseRoom({ ...v, scale: 1.25, pinch: 1 })).toEqual({ x: 320, y: 320 });
		expect(travelledEaseRoom({ ...v, scale: 2.5, pinch: 2 })).toEqual({ x: 160, y: 160 });
	});
});

/** syncBand's margin at outer 1.25: the base's at pinch 100%, half the 100% margin at pinch 2. */
describe("the band syncBand places under an outer CSS scale of 1.25", () => {
	function rig(pinch: number, scale: number, clientHeight: number) {
		const scroller = { scrollLeft: 0, scrollTop: 2000, clientWidth: 1100, clientHeight, scrollWidth: 1100, scrollHeight: 6000 };
		const overlay = Object.create(InkOverlayPlugin.prototype) as any;
		Object.assign(overlay, {
			container: { setCssStyles: () => undefined },
			view: { scrollDOM: scroller, contentHeight: 6000 },
			cssScale: scale,
			pinchScaleNow: pinch,
			bounceState: null,
			bandEase: null,
			band: null,
			bandSyncDeferred: false,
			bandFreeScrollWidth: null,
			frame: { locked: false },
			router: { refreshRect: () => undefined },
		});
		expect(overlay.syncBand(), "premise: the first sync places the band").toBe("resized");
		return overlay.band as { top: number; height: number };
	}

	it("at pinch 100%, the base margin: 280 each way on a pane 1120 scroller px tall", () => {
		const band = rig(1, 1.25, 1120);
		expect([band.top, band.height]).toEqual([1720, 1680]);
	});

	it("at pinch 2, half the 100% margin: 140 each way on the same pane, 560 scroller px tall there", () => {
		const band = rig(2, 2.5, 560);
		expect([band.top, band.height]).toEqual([1860, 840]);
	});
});

/** A canvas the renderers can configure: a device ratio, translate support, and a context that records nothing. */
function fakeCanvas(dpr: number): HTMLCanvasElement {
	const ctx = new Proxy({} as CanvasRenderingContext2D, {
		get(_t, prop) {
			if (prop === "getContextAttributes") return () => ({ desynchronized: false });
			return () => undefined;
		},
		set() { return true; },
	});
	let w = 1, h = 1;
	return {
		get width() { return w; }, set width(v: number) { w = v; },
		get height() { return h; }, set height(v: number) { h = v; },
		style: {} as Record<string, string>,
		getContext: () => ctx,
		ownerDocument: { defaultView: { devicePixelRatio: dpr, CSS: { supports: () => true } } },
	} as unknown as HTMLCanvasElement;
}

describe("report: the pen's small canvases across the zoom, iPad band", () => {
	it("prints grid and tile px at 1, 2, 4, 6 and 8 (pins nothing)", () => {
		const dpr = 2, rows: string[] = [];
		for (const scale of [1, 2, 4, 6, 8]) {
			const cw = Math.round(834 / scale), ch = Math.round(1194 / scale);
			const band = bandFor({ scrollLeft: 0, scrollTop: 0, clientWidth: cw, clientHeight: ch, scrollWidth: cw * 4, scrollHeight: 200000, scale });
			const backing = backingScale(dpr, scale, band.width, band.height, true);
			const wet = new WetInkRenderer(fakeCanvas(dpr), false);
			wet.applyDpr(backing);
			wet.configureWetTile(fakeCanvas(dpr), band.width, band.height, backing, scale, false);
			const tileCfg = (wet as any).tileConfig as { grid: number | null; tileW: number; tileH: number };
			const tail = new TailRenderer(fakeCanvas(dpr));
			tail.configureInlineBacking(band.width, band.height, backing, scale, false);
			const tailCfg = (tail as any).inlineBacking as { grid: number | null; tileW: number; tileH: number };
			rows.push(`zoom ${scale}: band ${band.width} x ${band.height}, backing ${backing.toFixed(4)}, device px ${(band.width * backing * band.height * backing / 1e6).toFixed(2)}M, ` +
				`wet grid ${tileCfg.grid} tile ${tileCfg.tileW} x ${tileCfg.tileH}, tail grid ${tailCfg.grid} tile ${tailCfg.tileW} x ${tailCfg.tileH}`);
		}
		// eslint-disable-next-line no-console
		console.log(`PEN CANVASES iPad 834 x 1194 dpr 2, mobile:\n${rows.join("\n")}`);
		expect(rows).toHaveLength(5);
	});
});
