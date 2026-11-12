/**
 * A canvas that is thrown away gives up its backing store first.
 *
 * A removed canvas is collectible, but its backing store stays held until the
 * collector reaches it. The pdf off-band branch of `paint` sizes the canvas to
 * 0 x 0 before `remove()` for that reason (PdfInkBand.ts, "Sized to nothing
 * before it goes"). Three other drop sites did not:
 *
 * - the slides follow's extra pair when the follow turns to hide
 *   (SlidesTransition.ts `followFrame`),
 * - the same pair when the follow ends (`cancelFollow`), once per slide change,
 * - the pdf evict loop in `sync`, for a page the viewer let go of.
 *
 * Each cell records the canvas size at the moment `remove()` is called.
 */

import { describe, expect, it, vi } from "vitest";
import { SlidesDeck } from "./slides/SlidesInkSurface";
import type { SlidesFollow } from "./slides/SlidesTransition";
import { InkStroke } from "./ink/Stroke";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "./pdf/PdfInkController";

type Released = HTMLCanvasElement & { removedAt: { w: number; h: number } | null };

/** A canvas with a backing store that notes its own size when removed. */
function canvas(): Released {
	const style: Record<string, string> = {};
	const c = {
		width: 1920,
		height: 1080,
		removedAt: null as { w: number; h: number } | null,
		parentElement: null as unknown,
		style: Object.assign(style, { removeProperty: (k: string) => delete style[k] }),
		setCssStyles: (s: Record<string, string>) => Object.assign(style, s),
		setCssProps: () => {},
		getContext: () => null,
		remove() {
			c.removedAt ??= { w: c.width, h: c.height };
		},
	};
	return c as unknown as Released;
}

/** A deck in the middle of a slide change, with the extra pair live. */
function deckInFollow() {
	const win = {
		// No DOMMatrixReadOnly: every section reads as not a pure translation.
		getComputedStyle: () => ({ opacity: "1", transform: "none" }),
		requestAnimationFrame: () => 7,
		cancelAnimationFrame: () => {},
		clearTimeout: () => {},
	};
	const deck = Object.create(SlidesDeck.prototype) as SlidesDeck & {
		follow: SlidesFollow | null;
		win(): Window;
		repaint(): void;
	};
	const section = () => ({ removeEventListener: () => {} }) as unknown as HTMLElement;
	const extra = { committed: canvas(), highlight: canvas() };
	deck.follow = {
		out: section(),
		inc: section(),
		main: { committed: canvas(), highlight: canvas() },
		extra,
		mode: "translate",
		frame: null,
		timer: null,
		settled: 0,
		onEnd: () => {},
	};
	deck.win = () => win as unknown as Window;
	// The follow reads `k` only; the rest of the geometry is never touched.
	deck.geometry = (() => ({ k: 1 })) as unknown as typeof deck.geometry;
	deck.repaint = () => {};
	return { deck, extra };
}

describe("a dropped follow canvas gives up its backing store first", () => {
	it("when the follow turns to hide", () => {
		const { deck, extra } = deckInFollow();
		deck.followFrame();
		expect(deck.follow?.mode).toBe("hide");
		expect(extra.committed.removedAt).toEqual({ w: 0, h: 0 });
		expect(extra.highlight.removedAt).toEqual({ w: 0, h: 0 });
	});

	it("when the follow ends", () => {
		const { deck, extra } = deckInFollow();
		deck.cancelFollow();
		expect(deck.follow).toBeNull();
		expect(extra.committed.removedAt).toEqual({ w: 0, h: 0 });
		expect(extra.highlight.removedAt).toEqual({ w: 0, h: 0 });
	});
});

describe("a pdf page the viewer let go of gives up its backing store first", () => {
	it("in the evict loop", () => {
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: 600,
			clientHeight: 800,
			scrollWidth: 600,
			scrollHeight: 1610,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
		};
		probe.current = {
			scroller,
			scaleFactor: 2,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 2, leftPx: 0, topPx: 810, widthPx: 600, heightPx: 800, hasCanvas: false },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			requestAnimationFrame: () => 0,
			cancelAnimationFrame: () => {},
			getComputedStyle: () => ({ position: "relative" }),
		};
		const strokes: InkStroke[] = [];
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			() => {}
		);
		const priv = controller as unknown as {
			mounted: boolean;
			boundScroller: unknown;
			overlays: Map<number, unknown>;
			sync(): void;
		};
		priv.mounted = true;
		priv.boundScroller = scroller;
		const page2 = canvas();
		priv.overlays.set(2, { canvas: page2, paintedScale: 2, paintedCount: 3, paintedBand: null });
		priv.sync();
		expect(priv.overlays.has(2)).toBe(false);
		expect(page2.removedAt).toEqual({ w: 0, h: 0 });
	});
});
