import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;
const g = globalThis as Record<string, unknown>;
if (typeof g.addEventListener !== "function") g.addEventListener = () => {};
if (typeof g.removeEventListener !== "function") g.removeEventListener = () => {};

import { InkOverlayPlugin } from "../inline/InkOverlay";
import { InlinePenRouter } from "../inline/InlinePenRouter";
import { fakeEl } from "../../test/routerHarness";

type Fields = Record<string, any>;
const noop = (): undefined => undefined;

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: noop,
		remove: noop,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		style: { removeProperty: noop, setProperty: noop },
		...extra,
	};
}

describe("J1D-92 unmount during an Infinite Canvas edge give", () => {
	it("leaves no preview paper on the kept EditorView after destroy()", () => {
		const frames: Array<(t: number) => void> = [];
		const win: Fields = {
			devicePixelRatio: 1,
			CSS: { supports: () => false },
			getComputedStyle: () => ({ fontSize: "16px", position: "relative", getPropertyValue: () => "" }),
			cancelAnimationFrame: noop,
			clearTimeout: noop,
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			addEventListener: noop,
			removeEventListener: noop,
			performance: { now: () => 1000 },
			requestAnimationFrame: (fn: (t: number) => void) => { frames.push(fn); return frames.length; },
		};
		const scrollDOM = el({
			scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 2400,
			clientLeft: 0, clientTop: 0, addEventListener: noop, removeEventListener: noop,
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
		});
		const view: Fields = {
			dom: el({ ownerDocument: { defaultView: win }, parentElement: el(), querySelector: () => null }),
			scrollDOM,
			contentDOM: el({ children: [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 0, right: 800, bottom: 0 }) }),
			scaleX: 1, scaleY: 1, documentTop: 0,
			state: { field: () => undefined },
		};
		const o = new InkOverlayPlugin(view as never) as unknown as Fields;
		o.container = el({ nodeType: 1 });
		o.mobileTools = null;
		o.filePath = () => "old.md";
		o.updateHandwritingPageClass = noop;
		o.updateExtent = noop;
		o.repaintPath = noop;
		o.canvasMode = true;

		const attached = new Set<Fields>();
		o.beginPreviewPaper = function (this: Fields) {
			if (this.previewPaperEl) return;
			const paper: Fields = { remove: () => void attached.delete(paper) };
			attached.add(paper);
			this.previewPaperEl = paper;
		};

		const rEl: Fields = Object.assign(fakeEl(), {
			ownerDocument: { defaultView: win },
			scrollWidth: 800, clientWidth: 800, scrollHeight: 2400, clientHeight: 600,
		});
		const router = new InlinePenRouter(rEl as unknown as HTMLElement, rEl as unknown as HTMLElement, {
			onPenDown: noop, onPenHover: noop, onPenLeave: noop, onPinch: noop,
			onPenRaw: noop, onPenMove: noop, onPenUp: noop,
			overscrollAllowancePx: () => 96,
			onOverscrollPull: (x: number, y: number) => (o.holdOverscrollGive as (x: number, y: number) => void).call(o, x, y),
			onOverscrollRelease: () => (o.releaseOverscrollGive as () => void).call(o),
		});
		o.router = router;

		(router as unknown as Fields).overscrollPullX = 0;
		(router as unknown as Fields).overscrollPullY = 40;
		(o.holdOverscrollGive as (x: number, y: number) => void).call(o, 0, 40);
		expect(attached.size, "premise: the held give put a preview paper up").toBe(1);

		(o.destroy as () => void)();
		expect(o.container, "unmount ran").toBeNull();

		for (let i = 0; i < 50 && frames.length; i++) {
			const fns = frames.splice(0);
			for (const fn of fns) fn(1000 + 100000);
		}

		expect(attached.size, `preview paper still attached after unmount (previewPaperEl held: ${!!o.previewPaperEl}, bounce active: ${!!o.bounceState}, ended: ${o.previewPaperEnded})`).toBe(0);
		expect(o.bounceState ?? null, "a bounce is still running on a retired overlay").toBeNull();
	});
});

/** The cloud case's rig, shared by the two cases below: an overlay in canvas mode, a router wired to its give, and the papers it puts up. */
function rig() {
	const frames: Array<(t: number) => void> = [];
	const win: Fields = {
		devicePixelRatio: 1,
		CSS: { supports: () => false },
		getComputedStyle: () => ({ fontSize: "16px", position: "relative", getPropertyValue: () => "" }),
		cancelAnimationFrame: noop,
		clearTimeout: noop,
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		addEventListener: noop,
		removeEventListener: noop,
		performance: { now: () => 1000 },
		requestAnimationFrame: (fn: (t: number) => void) => { frames.push(fn); return frames.length; },
	};
	const scrollDOM = el({
		scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 2400,
		clientLeft: 0, clientTop: 0, addEventListener: noop, removeEventListener: noop,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	const view: Fields = {
		dom: el({ ownerDocument: { defaultView: win }, parentElement: el(), querySelector: () => null }),
		scrollDOM,
		contentDOM: el({ children: [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 0, right: 800, bottom: 0 }) }),
		scaleX: 1, scaleY: 1, documentTop: 0,
		state: { field: () => undefined },
	};
	const o = new InkOverlayPlugin(view as never) as unknown as Fields;
	o.container = el({ nodeType: 1 });
	o.mobileTools = null;
	o.filePath = () => "old.md";
	o.updateHandwritingPageClass = noop;
	o.updateExtent = noop;
	o.repaintPath = noop;
	o.canvasMode = true;
	// The bounce's last frame asks for a camera sync; this rig has no layout to sync.
	o.syncCamera = noop;
	const attached = new Set<Fields>();
	o.beginPreviewPaper = function (this: Fields) {
		if (this.previewPaperEl) return;
		const paper: Fields = { remove: () => void attached.delete(paper) };
		attached.add(paper);
		this.previewPaperEl = paper;
	};
	const rEl: Fields = Object.assign(fakeEl(), {
		ownerDocument: { defaultView: win },
		scrollWidth: 800, clientWidth: 800, scrollHeight: 2400, clientHeight: 600,
	});
	const router = new InlinePenRouter(rEl as unknown as HTMLElement, rEl as unknown as HTMLElement, {
		onPenDown: noop, onPenHover: noop, onPenLeave: noop, onPinch: noop,
		onPenRaw: noop, onPenMove: noop, onPenUp: noop,
		overscrollAllowancePx: () => 96,
		onOverscrollPull: (x: number, y: number) => (o.holdOverscrollGive as (x: number, y: number) => void).call(o, x, y),
		onOverscrollRelease: () => (o.releaseOverscrollGive as () => void).call(o),
	});
	o.router = router;
	const hold = (x: number, y: number): void => (o.holdOverscrollGive as (x: number, y: number) => void).call(o, x, y);
	const release = (): void => (o.releaseOverscrollGive as () => void).call(o);
	const runFrames = (): void => {
		for (let i = 0; i < 50 && frames.length; i++) {
			const fns = frames.splice(0);
			for (const fn of fns) fn(1000 + 100000);
		}
	};
	return { o, attached, hold, release, runFrames };
}

describe("a closed overlay takes no edge give", () => {
	it("a pull that arrives after the overlay closed puts no paper up and starts no bounce", () => {
		const { o, attached, hold, runFrames } = rig();
		(o.destroy as () => void)();
		expect(o.container, "premise: unmount ran").toBeNull();
		hold(0, 40);
		expect(attached.size, "a closed overlay put a preview paper up").toBe(0);
		runFrames();
		expect(attached.size, "a closed overlay left a preview paper up").toBe(0);
		expect(o.bounceState ?? null, "a bounce is running on a closed overlay").toBeNull();
	});

	it("control: on a live overlay a held give puts the paper up and its release takes it down", () => {
		const { o, attached, hold, release, runFrames } = rig();
		hold(0, 40);
		expect(attached.size, "the held give put a preview paper up").toBe(1);
		release();
		runFrames();
		expect(attached.size, "the released give left its preview paper up").toBe(0);
		expect(o.bounceState ?? null, "the release bounce did not finish").toBeNull();
		expect(o.previewPaperEnded, "the paper came down at the end of the bounce").toBe("bounce-end");
	});
});
