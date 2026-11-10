/**
 * The zoom-out overview picture: the note's whole ink drawn once, in pieces, after a whole repaint where no extent raster holds or
 * is being built (at or above 100 percent, where none may be built, or below it on a note too big for the extent caps), at the
 * largest scale at or under the landed zoom that fits those same caps. A zoom out's first preview frame holds it up when nothing
 * else is held (heldRasterSource): the pane's own canvases stay shown and the picture is clipped off the start view, so the ink the
 * start view did not hold shows from the first frame and nothing paints twice. Methods of InkOverlayPlugin, installed by
 * InkOverlay.ts just before the extent methods (installOverview, then installExtent).
 */
import { InkStroke } from "../ink/Stroke";
import { drawStroke } from "../ink/StrokeRenderer";
import { installMethods } from "./InstallMethods";
import { committedFloorFor, EXTENT_PIECE_MS, EXTENT_PIECE_RETRY_MS, extentPairCapPx, extentRasterFits, inkLookKey, inlineInk, type RasterCamera, standInFactorFits, type InkOverlayPlugin } from "./InkOverlay";

/** How much less sharp than a new build a kept picture may be and still stand for it, as a fraction of the build's scale. */
const OVERVIEW_SHARP_SLACK = 0.01;

/** The picture: device px = (world - at) * at.zoom * backing, holding the store's first `count` strokes. */
export interface OverviewPicture {
	path: string; pen: HTMLCanvasElement; hl: HTMLCanvasElement | null; at: { x: number; y: number; zoom: number }; backing: number;
	dpr: number; look: number; strokes: readonly InkStroke[]; count: number; generation: number;
}

/** A build under way: the picture's target, `next` the store index the next piece starts at, `timer` as extentBuild's. */
export interface OverviewBuild extends Omit<OverviewPicture, "pen" | "hl"> {
	w: number; h: number; hasHl: boolean; floor: ReturnType<typeof committedFloorFor>;
	pen: HTMLCanvasElement | null; hl: HTMLCanvasElement | null; next: number; timer: number;
}

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		overview?: OverviewPicture | null;
		overviewBuild?: OverviewBuild | null;
		/** Set on a zoom preview's first frame when it held nothing up and was no zoom out: the first zoom-out frame tries once more. */
		heldRetryOwed?: boolean;
		armOverviewBuild(cam: RasterCamera, strokes: readonly InkStroke[]): void;
		scheduleOverviewPiece(ms: number, first?: boolean): void;
		runOverviewPiece(): void;
		overviewHolds(ov: OverviewPicture | OverviewBuild, strokes: readonly InkStroke[]): boolean;
		drawIntoOverview(path: string, added: readonly InkStroke[]): void;
		dropOverview(): void;
	}
}

/**
 * The side scale the whole ink is drawn at: the largest at or under 1 whose raster (the box plus the 2 px margin each side
 * armExtentBuild keeps) fits extentRasterFits, 0 when none does. `spanW` and `spanH` are the ink's box in device px at scale 1.
 */
export function overviewScale(spanW: number, spanH: number): number {
	if (!(spanW >= 0) || !(spanH >= 0) || !Number.isFinite(spanW + spanH)) return 0;
	const fits = (s: number) => extentRasterFits(Math.ceil(spanW * s) + 4, Math.ceil(spanH * s) + 4);
	if (fits(1)) return 1;
	// Fitting only gets easier as the scale falls: bisect to 2^-30 of the landed zoom.
	let lo = 0, hi = 1;
	for (let i = 0; i < 30; i++) {
		const m = (lo + hi) / 2;
		if (fits(m)) lo = m;
		else hi = m;
	}
	return lo;
}

	/**
	 * Start drawing the overview at the landed camera `cam`, unless one for the same note content is already held or under way. Only
	 * on a whole repaint with no extent raster held or building (the caller's test), and under extentBuildAllowed's other terms: no
	 * scroll-only frame, no contact holding the frame, no stroke being built, and no pinch held or previewing (a paint under a pinch
	 * hold paints at the retained camera, not a landing). The pinch settle's paint is a landing: the lift's commit pays its whole
	 * repaint while the pinch still counts as held, so that paint is let through (previewPaperSettling), as the extent arm lets it
	 * through. A note at rest after it opens is a landing too. One build at a time: a new arm always drops the old build. Every
	 * refusal and the held tests come before any walk over the strokes but the sharpness one.
	 *
	 * A WHOLE PICTURE FROM AN EARLIER LANDING IS KEPT while it still holds the strokes, so a zoom out that starts before the new
	 * build's last piece still has the ink the start view did not hold. Kept and nothing armed when its copy factor at this zoom fits
	 * and it is as sharp as a new build would be (a note too big for the caps is built at about the same device size at any zoom);
	 * else kept through the new build when both, with any held stand-in, fit the pair cap, and the build's last piece swaps it out;
	 * else dropped, as before.
	 */
	function armOverviewBuild(this: InkOverlayPlugin, cam: RasterCamera, strokes: readonly InkStroke[]): void {
		if ((this.pinchHeld() && !this.previewPaperSettling) || this.repaintScrollOnly || this.frame.locked || this.builder !== null) return;
		const path = this.filePath(), backing = this.committedBacking ?? 0;
		const held = this.overviewBuild ?? this.overview;
		if (held && held.at.zoom === cam.zoom && this.overviewHolds(held, strokes)) return;
		dropOverviewBuild(this);
		const ov = this.overview ?? null;
		const kept = ov && ov.pen.width > 0 && this.overviewHolds(ov, strokes) ? ov : null;
		if (!kept) this.dropOverview();
		if (!path || !(backing > 0) || !Number.isFinite(backing) || !(cam.zoom > 0) || strokes.length === 0) { this.dropOverview(); return; }
		// The kept picture's device px per world px against this landing's committed layer, and its copy factor here.
		const kKept = kept ? kept.at.zoom * kept.backing : 0, f = kept ? (cam.zoom * backing) / kKept : 0;
		const copies = kept !== null && Number.isFinite(f) && standInFactorFits(f);
		// No build is sharper than the landed zoom at scale 1: a kept picture at least that sharp needs no walk.
		if (copies && kKept >= cam.zoom * backing) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const s of strokes) {
			const b = s.bbox;
			if (b.x < x0) x0 = b.x;
			if (b.y < y0) y0 = b.y;
			if (b.x + b.width > x1) x1 = b.x + b.width;
			if (b.y + b.height > y1) y1 = b.y + b.height;
		}
		if (!Number.isFinite(x0 + y0 + x1 + y1)) { this.dropOverview(); return; }
		const k = cam.zoom * backing, s = overviewScale((x1 - x0) * k, (y1 - y0) * k);
		if (!(s > 0)) { this.dropOverview(); return; }
		const ks = k * s, w = Math.ceil((x1 - x0) * ks) + 4, h = Math.ceil((y1 - y0) * ks) + 4;
		// The 2 px margins make two cap-bound builds differ by a few parts in a thousand: within a hundredth is as sharp.
		if (copies && kKept >= ks * (1 - OVERVIEW_SHARP_SLACK)) return;
		const hasHl = strokes.some(st => st.tool === "highlighter");
		if (kept) {
			const px = (c: HTMLCanvasElement, hl: unknown) => c.width * c.height * (hl ? 2 : 1);
			const stand = this.standIn && this.standIn.pen.width > 0 ? px(this.standIn.pen, this.standIn.hl) : 0;
			if (px(kept.pen, kept.hl) + w * h * (hasHl ? 2 : 1) + stand > extentPairCapPx()) this.dropOverview();
		}
		this.overviewBuild = {
			path, at: { x: x0 - 2 / ks, y: y0 - 2 / ks, zoom: cam.zoom }, backing: backing * s, dpr: this.dpr, look: inkLookKey(), strokes,
			count: strokes.length, generation: inlineInk.generation(path), w, h, hasHl, floor: committedFloorFor(backing * s, this.dpr),
			pen: null, hl: null, next: 0, timer: 0,
		};
		this.scheduleOverviewPiece(0, true);
	}

	/** Ask for the next piece: a timer for a wait, else the next frame for the first piece and a message-channel task after it. */
	function scheduleOverviewPiece(this: InkOverlayPlugin, ms: number, first = false): void {
		const b = this.overviewBuild;
		if (!b || b.timer !== 0) return;
		const run = () => {
			if (this.overviewBuild !== b) return;
			b.timer = 0;
			this.runOverviewPiece();
		};
		if (ms > 0) {
			b.timer = this.winRef.setTimeout(run, ms);
			return;
		}
		b.timer = -1;
		const post = () => {
			if (this.overviewBuild !== b) return;
			const MC = (this.winRef as Window & { MessageChannel?: typeof MessageChannel }).MessageChannel ?? MessageChannel;
			const ch = new MC();
			ch.port1.onmessage = () => { ch.port1.close(); run(); };
			ch.port2.postMessage(0);
		};
		if (first || this.bounceState) this.winRef.requestAnimationFrame(post);
		else post();
	}

	/**
	 * One piece: strokes from `next` on, each to its own layer, until EXTENT_PIECE_MS has passed, under the extent pieces' own gate
	 * (extentPieceAllowed) and never while an extent build runs. The last piece makes the picture; until then nothing reads it.
	 */
	function runOverviewPiece(this: InkOverlayPlugin): void {
		const b = this.overviewBuild;
		if (!b || this.retiring) return;
		if (!this.overviewHolds(b, this.committedStrokes(this.freeStrokes(b.path)))) { this.dropOverview(); return; }
		if (this.extentBuild || !this.extentPieceAllowed()) { this.scheduleOverviewPiece(EXTENT_PIECE_RETRY_MS); return; }
		// A dirty stroke index is rebuilt first, in a piece of its own: the pieces run back to back as tasks and leave the page no idle
		// period, so the index's idle rebuild (scheduleIndexIdle) could wait until the next fling and land in its first frames.
		if (this.indexDirty) {
			const path = this.filePath();
			this.rebuildIndex(path ? this.committedStrokes(this.noteStrokes(path)) : [], "idle");
			this.scheduleOverviewPiece(0);
			return;
		}
		const t0 = performance.now();
		if (!b.pen) {
			const layer = (): HTMLCanvasElement | null => {
				// A detached canvas in the layer's own document (a popout's, in a popout).
				const c = this.committedCanvas.cloneNode(false) as HTMLCanvasElement;
				c.width = b.w; c.height = b.h;
				const ctx = c.getContext("2d");
				if (!ctx) return null;
				ctx.setTransform(b.backing, 0, 0, b.backing, 0, 0);
				return c;
			};
			b.pen = layer();
			b.hl = b.hasHl ? layer() : null;
			if (!b.pen || (b.hasHl && !b.hl)) { this.dropOverview(); return; }
		}
		const pen = b.pen.getContext("2d")!, hl = b.hl?.getContext("2d") ?? null;
		while (b.next < b.count) {
			const s = b.strokes[b.next++]!;
			const ctx = s.tool === "pen" ? pen : s.tool === "highlighter" ? hl : null;
			if (ctx) drawStroke(ctx, b.at, s, undefined, true, undefined, b.floor);
			if (performance.now() - t0 >= EXTENT_PIECE_MS) break;
		}
		if (b.next < b.count) { this.scheduleOverviewPiece(0); return; }
		// The picture kept through the build is swapped out here and freed, taken down first if a preview shows it.
		const old = this.overview ?? null;
		this.overviewBuild = null;
		this.overview = {
			path: b.path, pen: b.pen, hl: b.hl, at: b.at, backing: b.backing, dpr: b.dpr, look: b.look, strokes: b.strokes, count: b.count,
			generation: b.generation,
		};
		if (old) releaseOverview(this, old);
	}

	/**
	 * Whether the picture (or the build's target) is the note's ink as it is now: same note, device ratio and ink look, the store's
	 * same array with no stroke added or changed. A stroke added since refuses: the pane's canvases show it in the start view only.
	 * A pen commit's strokes are the one way in, and only through drawIntoOverview, which brings the count and generation level.
	 */
	function overviewHolds(this: InkOverlayPlugin, ov: OverviewPicture | OverviewBuild, strokes: readonly InkStroke[]): boolean {
		const path = this.filePath();
		return !!path && ov.path === path && ov.dpr === this.dpr && ov.look === inkLookKey() && ov.strokes === strokes &&
			ov.count === strokes.length && ov.generation === inlineInk.generation(path) && !(ov.hl && this.highlightPairDeferred);
	}

	/**
	 * A pen commit's strokes taken into the picture, or the build, that held the store just before (overviewHolds, read in store()
	 * beside extentHoldsStore), on drawIntoExtent's terms: the same store array grown by exactly these strokes, each in its place, each
	 * inside the picture's world rect (its `at` and canvas size), a highlighter stroke only where a highlighter layer is kept. The
	 * picture draws them on top in store order with the paint its pieces gave; a build takes the new count and its pieces reach them.
	 * Any term failing changes nothing, and overviewHolds refuses the picture or the build as before.
	 */
	function drawIntoOverview(this: InkOverlayPlugin, path: string, added: readonly InkStroke[]): void {
		const b = this.overviewBuild ?? null, ov = b ? null : this.overview ?? null, held = b ?? ov, now = this.freeStrokes(path);
		if (!held || held.path !== path || now !== held.strokes || now.length !== held.count + added.length) return;
		const k = held.at.zoom * held.backing, w = b ? b.w : ov!.pen.width, h = b ? b.h : ov!.pen.height, hasHl = b ? b.hasHl : !!ov!.hl;
		const x0 = held.at.x, y0 = held.at.y, x1 = x0 + w / k, y1 = y0 + h / k;
		for (let i = 0; i < added.length; i++) {
			const s = added[i]!, bb = s.bbox;
			if (now[held.count + i] !== s) return;
			if (!(bb.x >= x0 && bb.y >= y0 && bb.x + bb.width <= x1 && bb.y + bb.height <= y1)) return;
			if (s.tool === "highlighter" && !hasHl) return;
		}
		if (ov) {
			const pen = ov.pen.getContext("2d"), hl = ov.hl?.getContext("2d") ?? null;
			if (!pen || (ov.hl && !hl)) return;
			const floor = committedFloorFor(ov.backing, ov.dpr);
			for (const s of added) {
				const ctx = s.tool === "pen" ? pen : s.tool === "highlighter" ? hl : null;
				if (!ctx) continue;
				ctx.setTransform(ov.backing, 0, 0, ov.backing, 0, 0);
				drawStroke(ctx, ov.at, s, undefined, true, undefined, floor);
			}
		}
		held.count = now.length;
		held.generation = inlineInk.generation(path);
	}

	/** Stop a build and let the picture go, releasing their canvases now; a preview showing the picture takes it down first. */
	function dropOverview(this: InkOverlayPlugin): void {
		const ov = this.overview;
		dropOverviewBuild(this);
		this.overview = null;
		if (ov) releaseOverview(this, ov);
	}

/** Stop a build and release its canvases now, leaving any whole picture held. */
function dropOverviewBuild(o: InkOverlayPlugin): void {
	const b = o.overviewBuild;
	o.overviewBuild = null;
	if (!b) return;
	if (b.timer > 0) o.winRef.clearTimeout(b.timer);
	freeCanvases(b.pen, b.hl);
}

/** A picture no longer held: taken down if a preview shows it, then its canvases released. */
function releaseOverview(o: InkOverlayPlugin, ov: OverviewPicture): void {
	if (o.heldRaster?.src.pen === ov.pen) o.takeDownHeldRaster();
	freeCanvases(ov.pen, ov.hl);
}

function freeCanvases(...cs: (HTMLCanvasElement | null)[]): void {
	for (const c of cs) {
		if (!c) continue;
		c.width = 0;
		c.height = 0;
	}
}

export function installOverview(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		armOverviewBuild,
		scheduleOverviewPiece,
		runOverviewPiece,
		overviewHolds,
		drawIntoOverview,
		dropOverview,
	});
}
