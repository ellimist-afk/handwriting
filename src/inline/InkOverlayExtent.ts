/**
 * The note surface's committed-layer extent raster and zoom stand-in: the idle piecewise build of the extent,
 * the stand-in taken at a zoom start, and the copies of both into the committed layers. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads.
 */
import { Platform } from "obsidian";

import { BBox, InkStroke } from "../ink/Stroke";
import { drawStroke } from "../ink/StrokeRenderer";
import { installMethods } from "./InstallMethods";
import { committedFloorFor, EXTENT_PIECE_MS, EXTENT_PIECE_RETRY_MS, EXTENT_SCROLL_QUIET_MS, extentPairCapPx, extentPairFits, extentRasterFits, inkLookKey, inlineInk, type RasterCamera, standInFactorFits, type StandInMark, ZOOM_STAND_IN_ENABLED, type InkOverlayPlugin } from "./InkOverlay";

/** The smallest side scale a shrunk stand-in is made at: under it the copy would upscale more than twice, and the build runs alone. */
const STAND_IN_SHRINK_MIN = 0.5;

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		extentBuildAllowed(): boolean;
		armExtentBuild(cam: RasterCamera, strokes: readonly InkStroke[], floor: ReturnType<typeof committedFloorFor>): void;
		scheduleExtentPiece(ms: number, first?: boolean): void;
		extentPieceAllowed(): boolean;
		extentBuildHolds(b: NonNullable<InkOverlayPlugin["extentBuild"]>): boolean;
		runExtentPiece(): void;
		dropExtentBuild(): void;
		usableExtent(cam: RasterCamera, strokes: readonly InkStroke[]): NonNullable<InkOverlayPlugin["extentRaster"]> | null;
		extentHolds(ext: NonNullable<InkOverlayPlugin["extentRaster"]>, cam: RasterCamera, strokes: readonly InkStroke[]): boolean;
		extentToStandIn(strokes: readonly InkStroke[]): void;
		takeStandIn(paintedDpr: number, backing: number): void;
		usableStandIn(strokes: readonly InkStroke[], wholeFrame: boolean, cam: RasterCamera): NonNullable<InkOverlayPlugin["standIn"]> | null;
		dropStandIn(): void;
		retryStandInLater(): void;
		repaintOverStandIn(): void;
		copyFromStandIn(st: NonNullable<InkOverlayPlugin["standIn"]>, cam: RasterCamera, rect: BBox | null, strokes: readonly InkStroke[], floor: ReturnType<typeof committedFloorFor>): boolean;
		standInMarkNow(cam: RasterCamera, strokes: readonly InkStroke[]): StandInMark;
		standInMarkHolds(mark: StandInMark, cam: RasterCamera, strokes: readonly InkStroke[]): boolean;
		extentHoldsStore(path: string): boolean;
		drawIntoExtent(path: string, added: readonly InkStroke[]): void;
		copyFromExtent(ext: NonNullable<InkOverlayPlugin["extentRaster"]>, cam: RasterCamera, rect: BBox | null): boolean;
	}
}

	/** Whether this repaint may build the extent raster: below 100 percent, and on no pan or stroke frame. */
	function extentBuildAllowed(this: InkOverlayPlugin): boolean {
		// Built only where the whole layer is redrawn anyway, never on the frames whose lag it exists to remove. A frame that may not
		// build paints by path while the raster is stale, and the next whole repaint that may, builds it. A bounce does not stop it:
		// the settle's paint arms the build at the settled camera and the pieces run under the bounce, so the crisp layer does not
		// wait for the bounce to end (a slow note's pinch was crisp only at 1310 ms).
		return this.cssScale < 1 && !this.repaintScrollOnly && !this.frame.locked && this.builder === null;
	}

	/**
	 * Replace the held stand-in by one drawn from the old pictures on the largest grid at or under the build's (`w` x `h` device pixels
	 * at `at`, the committed backing) at which the build's pair fits: the build's grid scaled by s on each side, s = min(1,
	 * sqrt((cap - buildPx) / the stand-in's px on the build's grid)), its backing the committed one times s. A big note's old raster and
	 * its build do not fit side by side, nor on the same grid. Under STAND_IN_SHRINK_MIN a side, or when it is not smaller than the
	 * held one, it is not made. Returns whether it did; on false the stand-in is as it was. The copy from it upscales by 1 / s.
	 */
	function shrinkStandIn(plugin: InkOverlayPlugin, at: { x: number; y: number; zoom: number }, k: number, backing: number, w: number, h: number, buildPx: number, held: number): boolean {
		const st = plugin.standIn;
		if (!st) return false;
		const layers = st.hl ? 2 : 1;
		const s = Math.min(1, Math.sqrt(Math.max(0, extentPairCapPx() - buildPx) / (w * h * layers)));
		if (!(s >= STAND_IN_SHRINK_MIN)) return false;
		const sw = Math.floor(w * s), sh = Math.floor(h * s), shrunk = sw * sh * layers, ks = k * s;
		if (!(sw > 0 && sh > 0) || !(shrunk < held) || !extentPairFits(buildPx, shrunk)) return false;
		const made: HTMLCanvasElement[] = [];
		const copy = (src: HTMLCanvasElement): HTMLCanvasElement | null => {
			// A detached canvas in the layer's own document (a popout's, in a popout).
			const c = plugin.committedCanvas.cloneNode(false) as HTMLCanvasElement;
			made.push(c);
			c.width = sw;
			c.height = sh;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			const f = ks / (st.at.zoom * st.backing);
			ctx.drawImage(src, (st.at.x - at.x) * ks, (st.at.y - at.y) * ks, src.width * f, src.height * f);
			return c;
		};
		const pen = copy(st.pen), hl = st.hl ? copy(st.hl) : null;
		if (!pen || (st.hl && !hl)) {
			for (const c of made) { c.width = 0; c.height = 0; }
			return false;
		}
		// A zoom preview showing the old canvases takes them down before they are freed.
		if (plugin.heldRaster?.src.pen === st.pen) plugin.takeDownHeldRaster();
		plugin.standIn = { ...st, pen, hl, at: { ...at }, backing: backing * s, mark: null };
		for (const c of [st.pen, st.hl]) {
			if (!c) continue;
			c.width = 0;
			c.height = 0;
		}
		return true;
	}

	/**
	 * Start building the extent raster for the note's whole ink at the camera `cam` (see `extentBuild`), unless a build for the same
	 * content is already under way, or leave none when it would not fit. Nothing is drawn here; the first piece runs on a later task.
	 */
	function armExtentBuild(this: InkOverlayPlugin, cam: RasterCamera, strokes: readonly InkStroke[], floor: ReturnType<typeof committedFloorFor>): void {
		const path = this.filePath(), backing = this.committedBacking ?? 0;
		const b = this.extentBuild;
		if (b && b.path === path && b.cam0.zoom === cam.zoom && b.backing === backing && b.dpr === this.dpr && b.look === inkLookKey() &&
			b.strokes === strokes && b.count === strokes.length && path !== null && b.generation === inlineInk.generation(path) && b.shownMoves === this.shownMoves) return;
		this.dropExtentBuild();
		this.extentRaster = null;
		if (!path || !(backing > 0) || !Number.isFinite(backing) || !(cam.zoom > 0) || strokes.length === 0) return;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const s of strokes) {
			const b = s.bbox;
			if (b.x < x0) x0 = b.x;
			if (b.y < y0) y0 = b.y;
			if (b.x + b.width > x1) x1 = b.x + b.width;
			if (b.y + b.height > y1) y1 = b.y + b.height;
		}
		if (!Number.isFinite(x0 + y0 + x1 + y1)) return;
		const k = cam.zoom * backing;
		// The origin sits on the committed raster's device grid, so a copy between the two moves whole pixels.
		const kx = Math.floor((x0 - cam.x) * k) - 2, ky = Math.floor((y0 - cam.y) * k) - 2;
		const w = Math.ceil((x1 - cam.x) * k) + 2 - kx, h = Math.ceil((y1 - cam.y) * k) + 2 - ky;
		if (!extentRasterFits(w, h)) return;
		const at = { x: cam.x + kx / k, y: cam.y + ky / k, zoom: cam.zoom };
		// Both pictures are held until the build is whole: the pair must fit the pair cap. When it does not, the held stand-in is cut down
		// to the build's own grid (smaller than it, and what the frame's copy shows anyway) and the pair is asked again; if that does not
		// fit either, the stand-in goes now and the build is armed alone: the frame paints by path until the build is whole, and the
		// peak is the build's own pictures. Left armed with nothing, the next whole repaint let the stand-in go and nothing asked again.
		const held = this.standIn ? this.standIn.pen.width * this.standIn.pen.height * (this.standIn.hl ? 2 : 1) : 0;
		const buildPx = w * h * (strokes.some(s => s.tool === "highlighter") ? 2 : 1);
		if (held > 0 && !extentPairFits(buildPx, held) && !shrinkStandIn(this, at, k, backing, w, h, buildPx, held)) this.dropStandIn();
		// On mobile the overview goes before the build is armed: the pair budget above counts the stand-in, never the overview, and
		// a third picture held through the build is a peak the mobile budget does not cover. A blank canvas is the worse failure.
		if (Platform.isMobile) this.dropOverview();
		this.extentBuild = {
			path, cam0: { ...cam }, at, kx, ky, w, h, world: { x0: at.x, y0: at.y, x1: at.x + w / k, y1: at.y + h / k }, backing, dpr: this.dpr,
			look: inkLookKey(), floor, strokes, count: strokes.length, generation: inlineInk.generation(path),
			hasHl: strokes.some(s => s.tool === "highlighter"), pen: null, hl: null, next: 0, timer: 0, shownMoves: this.shownMoves,
		};
		this.scheduleExtentPiece(0, true);
	}

	/**
	 * Ask for the next piece. A wait (the gate said no) is a timer; otherwise the piece runs as the next task, posted on a message
	 * channel, since a chain of zero timers is clamped to 4 ms each and the gaps between pieces were most of the time to sharp. The
	 * first piece of a build waits for the next frame, so the settle's own frame is painted before any piece runs, and so does every
	 * piece while a bounce plays. timer is -1 while
	 * a post or a frame is pending; a dropped build is no longer this.extentBuild, and its callback does nothing.
	 */
	function scheduleExtentPiece(this: InkOverlayPlugin, ms: number, first = false): void {
		const b = this.extentBuild;
		if (!b || b.timer !== 0) return;
		const run = () => {
			if (this.extentBuild !== b) return;
			b.timer = 0;
			this.runExtentPiece();
		};
		if (ms > 0) {
			b.timer = this.winRef.setTimeout(run, ms);
			return;
		}
		b.timer = -1;
		const post = () => {
			if (this.extentBuild !== b) return;
			const MC = (this.winRef as Window & { MessageChannel?: typeof MessageChannel }).MessageChannel ?? MessageChannel;
			const ch = new MC();
			ch.port1.onmessage = () => { ch.port1.close(); run(); };
			ch.port2.postMessage(0);
		};
		// Under a bounce each piece waits for the next frame, so at most one runs between two of the bounce's frames (two 4 ms pieces
		// a frame stretched a slow note's bounce frames to 25 ms); off the bounce the channel chain resumes.
		if (first || this.bounceState) this.winRef.requestAnimationFrame(post);
		else post();
	}

	/**
	 * Whether a piece may run now: no contact holding the frame, no stroke being built or routed, no touch, pinch, assist pointer or
	 * fling, no pinch scale held, no repaint queued, and no scroll repaint asked for in the last EXTENT_SCROLL_QUIET_MS. A bounce
	 * playing does not hold the pieces back: each is a task between its frames, and the bounce moves the layer by its translate.
	 */
	function extentPieceAllowed(this: InkOverlayPlugin): boolean {
		return !this.frame.locked && this.builder === null && !(this.router?.isStroking ?? false) && !(this.router?.hasActiveNavigation ?? false) &&
			this.pinchRefScale === null && !this.repaintQueued && performance.now() - this.lastScrollAskAt >= EXTENT_SCROLL_QUIET_MS;
	}

	/**
	 * Whether the build still holds for the note as it is now. A pen commit's strokes added at the end of the same store array, inside
	 * the raster's world rect, with a highlighter layer where one is needed (the test drawIntoExtent applies), extend its target and
	 * the pieces reach them in store order; any other change to the note, the zoom, the backing, the device ratio or the ink look fails.
	 */
	function extentBuildHolds(this: InkOverlayPlugin, b: NonNullable<InkOverlayPlugin["extentBuild"]>): boolean {
		const path = this.filePath(), cam = this.lastPaintCam;
		if (path !== b.path || !cam || cam.zoom !== b.cam0.zoom || this.committedBacking !== b.backing || this.dpr !== b.dpr || inkLookKey() !== b.look) return false;
		const now = this.freeStrokes(path), generation = inlineInk.generation(path);
		if (now !== b.strokes) return false;
		if (now.length === b.count) return generation === b.generation;
		if (now.length < b.count) return false;
		const w = b.world;
		for (let i = b.count; i < now.length; i++) {
			const s = now[i]!, bb = s.bbox;
			if (!(bb.x >= w.x0 && bb.y >= w.y0 && bb.x + bb.width <= w.x1 && bb.y + bb.height <= w.y1)) return false;
			if (s.tool === "highlighter" && !b.hasHl) return false;
		}
		b.count = now.length;
		b.generation = generation;
		return true;
	}

	/**
	 * A build that drops itself asks a whole repaint only while a stand-in is held (repaintOverStandIn). With none held nothing
	 * repaints, so the overview arm the last whole repaint skipped while the build was set is taken here, at the last paint's camera
	 * with the strokes that repaint draws. Under a pinch the arm refuses, and the pinch end's landing arms it.
	 */
	function armOverviewAfterDrop(plugin: InkOverlayPlugin): void {
		const path = plugin.filePath(), cam = plugin.lastPaintCam;
		if (plugin.standIn || !path || !cam) return;
		const strokes = plugin.committedStrokes(plugin.freeStrokes(path));
		plugin.armOverviewWhenNoExtent(cam, strokes, plugin.usableExtent(cam, strokes));
	}

	/**
	 * One piece of the build: strokes from `next` on, each to its own layer with the paint drawCommitted gives it (same camera, same
	 * floor, store order), until EXTENT_PIECE_MS has passed. The last piece hands the whole raster over; until then nothing reads it.
	 */
	function runExtentPiece(this: InkOverlayPlugin): void {
		const b = this.extentBuild;
		if (!b || this.retiring) return;
		if (!this.extentBuildHolds(b)) { this.dropExtentBuild(); armOverviewAfterDrop(this); this.repaintOverStandIn(); return; }
		if (!this.extentPieceAllowed()) { this.scheduleExtentPiece(EXTENT_PIECE_RETRY_MS); return; }
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
			if (!b.pen || (b.hasHl && !b.hl)) { this.dropExtentBuild(); armOverviewAfterDrop(this); this.repaintOverStandIn(); return; }
		}
		const pen = b.pen.getContext("2d")!, hl = b.hl?.getContext("2d") ?? null;
		while (b.next < b.count) {
			const s = b.strokes[b.next++]!;
			const ctx = s.tool === "pen" ? pen : s.tool === "highlighter" ? hl : null;
			if (ctx) drawStroke(ctx, b.at, s, undefined, true, undefined, b.floor);
			if (performance.now() - t0 >= EXTENT_PIECE_MS) break;
		}
		if (b.next < b.count) { this.scheduleExtentPiece(0); return; }
		// The attached groups inside the raster's world rect get their sprites in the same pieces, at a still camera, so a zoom
		// preview's hold can put them up beside it (heldTiles). The raster itself holds free ink only.
		const layer = this.attachedLayer, cam = this.lastPaintCam;
		if (layer?.live && cam && cam.zoom === b.cam0.zoom && layer.stillNear(cam)) {
			const groups = this.attachedGroups(b.path);
			if (groups.length > 0) {
				const rect = { x: b.world.x0, y: b.world.y0, width: b.world.x1 - b.world.x0, height: b.world.y1 - b.world.y0 };
				const more = () => performance.now() - t0 < EXTENT_PIECE_MS;
				if (!more() || layer.buildIn(cam, groups, rect, committedFloorFor(this.committedBacking, this.dpr), b.backing, more)) { this.scheduleExtentPiece(0); return; }
			}
		}
		this.extentBuild = null;
		this.extentRaster = {
			path: b.path, pen: b.pen, hl: b.hl, kx: b.kx, ky: b.ky, cam0: b.cam0, at: b.at, world: b.world, backing: b.backing, dpr: b.dpr,
			look: b.look, strokes: b.strokes, generation: b.generation, count: b.count, shownMoves: b.shownMoves,
		};
		// An extent raster holds now: the overview picture a zoom out would have held is let go.
		this.dropOverview();
		// The sharp raster is whole: the next whole repaint copies it in and lets the stand-in go in the same step.
		this.repaintOverStandIn();
	}

	/** Stop an unfinished build and release its canvases now, as releaseBackings does for the ink canvases. */
	function dropExtentBuild(this: InkOverlayPlugin): void {
		const b = this.extentBuild;
		if (!b) return;
		this.extentBuild = null;
		if (b.timer > 0) this.winRef.clearTimeout(b.timer);
		for (const c of [b.pen, b.hl]) {
			if (!c) continue;
			c.width = 0;
			c.height = 0;
		}
	}

	/**
	 * The extent raster when its content still holds for this note at this camera's zoom (see `extentRaster`), else null. A stale
	 * raster is let go here: whatever made it stale, the next build draws a new one.
	 */
	function usableExtent(this: InkOverlayPlugin, cam: RasterCamera, strokes: readonly InkStroke[]): NonNullable<InkOverlayPlugin["extentRaster"]> | null {
		const ext = this.extentRaster;
		if (!ext) return null;
		if (this.extentHolds(ext, cam, strokes)) return ext;
		this.extentToStandIn(strokes);
		this.extentRaster = null;
		// A zoom preview showing this raster keeps it only as the stand-in it may have just become (same pixels, same canvases).
		if (this.heldRaster?.src.pen === ext.pen && this.standIn?.pen !== ext.pen) this.takeDownHeldRaster();
		return null;
	}

	/** Whether the extent raster's content holds for this note at this camera's zoom: usableExtent's test, with no side effect. */
	function extentHolds(this: InkOverlayPlugin, ext: NonNullable<InkOverlayPlugin["extentRaster"]>, cam: RasterCamera, strokes: readonly InkStroke[]): boolean {
		const path = this.filePath();
		return !!path && ext.path === path && ext.cam0.zoom === cam.zoom && ext.backing === this.committedBacking && ext.dpr === this.dpr && ext.look === inkLookKey() &&
			ext.strokes === strokes && ext.count === strokes.length && ext.generation === inlineInk.generation(path) &&
			ext.shownMoves === this.shownMoves && !(ext.hl && this.highlightPairDeferred);
	}

	/**
	 * Keep the extent raster as the stand-in when only its zoom or backing no longer match: same note, device ratio, ink look, and the
	 * store as it was or with strokes added at the end. A stand-in already held stays (never a copy of a copy). At or above 100 percent
	 * too: the raster was built below it, and usableStandIn decides whether its copy may be shown there.
	 */
	function extentToStandIn(this: InkOverlayPlugin, strokes: readonly InkStroke[]): void {
		if (!ZOOM_STAND_IN_ENABLED) return;
		const ext = this.extentRaster, path = this.filePath();
		if (!ext || this.standIn || !path || ext.path !== path || ext.dpr !== this.dpr || ext.look !== inkLookKey() || ext.strokes !== strokes ||
			strokes.length < ext.count || (strokes.length === ext.count && ext.generation !== inlineInk.generation(path))) return;
		this.standIn = {
			path, pen: ext.pen, hl: ext.hl, at: ext.at, backing: ext.backing, dpr: ext.dpr, look: ext.look, strokes: ext.strokes,
			count: ext.count, generation: ext.generation, mark: null, shownMoves: ext.shownMoves, store: inlineInk.strokes(path),
		};
		this.extentRaster = null;
	}

	/**
	 * Just before a resize clears the layers: when no stand-in is held, keep the old whole raster as one (extentToStandIn), or else copy
	 * the committed layers' own pixels, painted at lastPaintCam and the old backing, as one. With no stroke owning the frame, the whole
	 * store painted, and the device ratio unchanged. At or above 100 percent (the new cssScale) no raster replaces the stand-in: the
	 * crisp picture is the by-path repaint retryStandInLater asks for, the copy factor is at most STAND_IN_MAX_FACTOR_AT_100, and a
	 * layer copy must fit the extent raster's cap (on a phone, 8 million device px a layer).
	 */
	function takeStandIn(this: InkOverlayPlugin, paintedDpr: number, backing: number): void {
		if (!ZOOM_STAND_IN_ENABLED) return;
		const above = this.cssScale >= 1;
		// Never a copy of a copy. Below 100 percent the held stand-in stays and is copied at the new zoom from its own picture. At or
		// above it, the layers may hold that stand-in's soft copy, and a second zoom before the crisp repaint lets it go: by path.
		if (this.standIn) {
			if (above) this.dropStandIn();
			return;
		}
		// A held pinch paints its pause commits by path: a stand-in shown there would be scaled up by the preview. Its lift's settle
		// commit is not one: the preview is over there, and the stand-in is taken as for any zoom commit.
		if (this.frame.locked || paintedDpr !== this.dpr || (this.pinchHeld() && !this.previewPaperSettling)) return;
		const path = this.filePath();
		if (!path) return;
		const strokes = this.freeStrokes(path);
		const cam = this.lastPaintCam, from = this.committedBacking ?? 0;
		// The copy factor the next paint would use at the painted zoom; a stand-in below the bar would only be let go unshown.
		const fits = (at: { zoom: number }, atBacking: number) => standInFactorFits(((cam ?? at).zoom * backing) / (at.zoom * atBacking), above);
		const ext = this.extentRaster;
		if (ext) {
			if (!fits(ext.at, ext.backing)) return;
			this.extentToStandIn(strokes);
			if (this.standIn) return;
		}
		if (!cam || !fits(cam, from)) return;
		if (this.committedBlank || !(from > 0) || this.committedCanvas.width === 0 || strokes.length === 0 || this.paintedStrokeCount !== strokes.length) return;
		// Both layers are the same size. Below 100 percent the copy keeps no cap, as in 1.4.24.
		if (above && !extentRasterFits(this.committedCanvas.width, this.committedCanvas.height)) return;
		const copy = (src: HTMLCanvasElement): HTMLCanvasElement | null => {
			// A detached canvas in the layer's own document (a popout's, in a popout).
			const c = this.committedCanvas.cloneNode(false) as HTMLCanvasElement;
			c.width = src.width;
			c.height = src.height;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(src, 0, 0);
			return c;
		};
		const wantHl = !this.highlightPairDeferred && !this.highlightBlank;
		const pen = copy(this.committedCanvas), hl = wantHl ? copy(this.highlightCanvas) : null;
		if (!pen || (wantHl && !hl)) {
			for (const c of [pen, hl]) if (c) { c.width = 0; c.height = 0; }
			return;
		}
		this.standIn = {
			path, pen, hl, at: { ...cam }, backing: from, dpr: paintedDpr, look: inkLookKey(), strokes, count: strokes.length,
			generation: inlineInk.generation(path), mark: null, shownMoves: this.paintedShownMoves, store: inlineInk.strokes(path),
		};
		this.standInSnapshots++;
	}

	/**
	 * The stand-in while it still pictures this note's ink at a copy factor of STAND_IN_MIN_FACTOR or more at `cam` (and at or above
	 * 100 percent, STAND_IN_MAX_FACTOR_AT_100 or less, with the layer's view at `cam` inside the world the stand-in holds), else null,
	 * and it is let go. Let go from a frame that repaints only rects, the rest of the layer still shows it, so a whole repaint is asked for.
	 */
	function usableStandIn(this: InkOverlayPlugin, strokes: readonly InkStroke[], wholeFrame: boolean, cam: RasterCamera): NonNullable<InkOverlayPlugin["standIn"]> | null {
		const st = this.standIn;
		if (!st) return null;
		const path = this.filePath();
		// Shown places moved since it was painted, every move known and all of them under one device pixel at `cam`: the stand-in
		// still shows each stroke within a pixel of its place, on the moved list too, and the queued frame copies it. Only over the
		// store list it was taken from, unedited: a replaced list (a sync adoption, a restore, a load) may hold other strokes at the same
		// count, and the store edits its own list in place (an eraser cut takes a stroke and puts its pieces back), moving the generation.
		const near = st.shownMoves !== this.shownMoves && movesUnderOnePixel(this, st.shownMoves, cam);
		if (path === st.path && st.dpr === this.dpr && st.look === inkLookKey() && (st.strokes === strokes || (near && inlineInk.strokes(path) === st.store && inlineInk.generation(path) === st.generation)) && strokes.length >= st.count &&
			(strokes.length > st.count || inlineInk.generation(path) === st.generation) && (this.cssScale < 1 || standInCoversView(this, st, cam)) && !(st.hl && this.highlightPairDeferred) && !(this.pinchHeld() && !this.previewPaperSettling) &&
			standInFactorFits((cam.zoom * (this.committedBacking ?? 0)) / (st.at.zoom * st.backing), this.cssScale >= 1) &&
			// Shown places moved since it was painted: refused, except under one device pixel (near) or by a whole paint outside the queued
			// frame, which only defers to that frame (paintCommittedWork); otherwise the queued frame refuses it here and paints by path.
			(near || (wholeFrame && !this.inQueuedFrame) || st.shownMoves === this.shownMoves)) return st;
		this.dropStandIn();
		if (!wholeFrame && !this.retiring) {
			this.damage.addAll();
			this.scheduleRepaint("other");
		}
		return null;
	}

	/**
	 * Whether every move after move `from` is known (its ring entry is still held and has a size) and their bounds sum under one device
	 * pixel at `cam`, on the clip's own factor (paintCommittedWork's partial branch). The sum bounds each stroke's net move.
	 */
	function movesUnderOnePixel(plugin: InkOverlayPlugin, from: number, cam: RasterCamera): boolean {
		let sum = 0;
		for (let n = from + 1; n <= plugin.shownMoves; n++) {
			const e = plugin.shownSteps[n & 15]!;
			if (e.step !== n || e.bound === null) return false;
			sum += e.bound;
		}
		const k = cam.zoom * (plugin.committedCanvas.width / plugin.cssWidth);
		return Number.isFinite(k) && k > 0 && sum * k < 1;
	}

	/**
	 * Whether the committed layer's view at `cam` lies inside the world the stand-in's picture holds, within one device pixel. At or
	 * above 100 percent a zoom out shows world the old layer never held; a copy would leave it blank until the crisp repaint, so the
	 * stand-in is refused there and the layer is drawn by path.
	 */
	function standInCoversView(plugin: InkOverlayPlugin, st: NonNullable<InkOverlayPlugin["standIn"]>, cam: RasterCamera): boolean {
		const ko = st.at.zoom * st.backing, kn = cam.zoom * (plugin.committedBacking ?? 0);
		if (!(ko > 0) || !(kn > 0)) return false;
		const slack = 1 / kn;
		return cam.x >= st.at.x - slack && cam.y >= st.at.y - slack &&
			cam.x + plugin.committedCanvas.width / kn <= st.at.x + st.pen.width / ko + slack &&
			cam.y + plugin.committedCanvas.height / kn <= st.at.y + st.pen.height / ko + slack;
	}

	function dropStandIn(this: InkOverlayPlugin): void {
		// Its retry has nothing left to replace; teardown comes through here too. A timer id is never 0, and an instance built without
		// its initializers has no timer at all.
		if (this.standInRetryTimer) {
			this.winRef.clearTimeout(this.standInRetryTimer);
			this.standInRetryTimer = 0;
		}
		const st = this.standIn;
		if (!st) return;
		this.standIn = null;
		// A zoom preview showing these canvases takes them down, the pane's own shown again, before they are freed.
		if (this.heldRaster?.src.pen === st.pen) this.takeDownHeldRaster();
		for (const c of [st.pen, st.hl]) {
			if (!c) continue;
			c.width = 0;
			c.height = 0;
		}
	}

	/**
	 * Once a piece could run (extentPieceAllowed: nothing live, no scroll in the quiet time) and no zoom preview is held, ask for the
	 * whole repaint that starts the build or lets the stand-in go; until then wait and look again. Nothing is asked on a pan, stroke or
	 * bounce frame, nor in a held zoom's pause, where a whole repaint would take the preview's offset off the ink. At or above 100
	 * percent no build replaces the stand-in: it is let go here, and that whole repaint draws the crisp layer by path.
	 */
	function retryStandInLater(this: InkOverlayPlugin): void {
		if (this.standInRetryTimer !== 0) return;
		this.standInRetryTimer = this.winRef.setTimeout(() => {
			this.standInRetryTimer = 0;
			if (!this.standIn || this.extentBuild || this.retiring) return;
			if (!this.extentPieceAllowed() || this.pinchPreview) { this.retryStandInLater(); return; }
			if (this.cssScale >= 1) {
				this.dropStandIn();
				this.damage.addAll();
				this.scheduleRepaint("other");
				return;
			}
			this.repaintOverStandIn();
		}, EXTENT_PIECE_RETRY_MS);
	}

	/** While a stand-in is on screen, ask for a whole repaint: it copies a finished raster in, or shows the stand-in or path again. */
	function repaintOverStandIn(this: InkOverlayPlugin): void {
		if (!this.standIn || this.retiring) return;
		this.damage.addAll();
		this.scheduleRepaint("other");
	}

	/**
	 * Fill `rect` (world units, out to whole device px), or the whole layer with null, from the stand-in: one scaled copy per layer, then
	 * the strokes the store gained since the stand-in was taken, drawn by path on top so they are sharp at once.
	 */
	function copyFromStandIn(this: InkOverlayPlugin, st: NonNullable<InkOverlayPlugin["standIn"]>, cam: RasterCamera, rect: BBox | null, strokes: readonly InkStroke[],
		floor: ReturnType<typeof committedFloorFor>): boolean {
		const backing = this.committedBacking ?? 0;
		const kn = cam.zoom * backing, ko = st.at.zoom * st.backing;
		if (!(kn > 0) || !(ko > 0) || !Number.isFinite(kn / ko)) return false;
		const f = kn / ko, ox = (st.at.x - cam.x) * kn, oy = (st.at.y - cam.y) * kn;
		const cw = this.committedCanvas.width, ch = this.committedCanvas.height;
		let dx = 0, dy = 0, dw = cw, dh = ch;
		if (rect) {
			const x0 = Math.max(0, Math.floor((rect.x - cam.x) * kn + 1e-6)), y0 = Math.max(0, Math.floor((rect.y - cam.y) * kn + 1e-6));
			const x1 = Math.min(cw, Math.ceil((rect.x + rect.width - cam.x) * kn - 1e-6)), y1 = Math.min(ch, Math.ceil((rect.y + rect.height - cam.y) * kn - 1e-6));
			if (!(x1 > x0) || !(y1 > y0)) return true;
			dx = x0; dy = y0; dw = x1 - x0; dh = y1 - y0;
		}
		const added = strokes.length > st.count ? strokes.slice(st.count) : [];
		const layers: [CanvasRenderingContext2D, HTMLCanvasElement | null, InkStroke["tool"]][] = [[this.committedCtx, st.pen, "pen"]];
		if (!this.highlightPairDeferred) layers.push([this.highlightCtx, st.hl, "highlighter"]);
		for (const [ctx, src, tool] of layers) {
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(dx, dy, dw, dh);
			ctx.beginPath();
			ctx.rect(dx, dy, dw, dh);
			ctx.clip();
			if (src) {
				// Placed by the transform, not by a scaled destination rect (whose edges the canvas snaps to whole pixels, which moved the
				// ink by up to half a pixel); a reduction filtered at high quality, so thin strokes do not drop out between samples.
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = f < 1 ? "high" : "low";
				ctx.setTransform(f, 0, 0, f, ox, oy);
				ctx.drawImage(src, 0, 0);
			}
			if (added.length > 0) {
				ctx.setTransform(backing, 0, 0, backing, 0, 0);
				for (const s of added) if (s.tool === tool) drawStroke(ctx, cam, s, undefined, true, undefined, floor);
			}
			ctx.restore();
		}
		if (!rect) st.mark = this.standInMarkNow(cam, strokes);
		return true;
	}

	/** What the committed layers hold after a whole stand-in copy at `cam` with `strokes`, for standInMarkHolds. */
	function standInMarkNow(this: InkOverlayPlugin, cam: RasterCamera, strokes: readonly InkStroke[]): StandInMark {
		const path = this.filePath();
		return { x: cam.x, y: cam.y, zoom: cam.zoom, backing: this.committedBacking ?? 0, dpr: this.dpr, w: this.committedCanvas.width,
			h: this.committedCanvas.height, hlDeferred: this.highlightPairDeferred, strokes, count: strokes.length,
			generation: path ? inlineInk.generation(path) : -1, shownMoves: this.shownMoves };
	}

	/** Whether the layers' stand-in copy, as `mark` records it, is what a whole copy at `cam` with `strokes` would paint now. */
	function standInMarkHolds(this: InkOverlayPlugin, mark: StandInMark, cam: RasterCamera, strokes: readonly InkStroke[]): boolean {
		const now = this.standInMarkNow(cam, strokes);
		return mark.x === now.x && mark.y === now.y && mark.zoom === now.zoom && mark.backing === now.backing && mark.dpr === now.dpr &&
			mark.w === now.w && mark.h === now.h && mark.hlDeferred === now.hlDeferred && mark.strokes === now.strokes &&
			mark.count === now.count && mark.generation === now.generation && mark.shownMoves === now.shownMoves;
	}

	/** Whether the extent raster holds the note's store exactly as it is now, read just before a pen commit changes it. */
	function extentHoldsStore(this: InkOverlayPlugin, path: string): boolean {
		const ext = this.extentRaster;
		if (!ext || ext.path !== path) return false;
		const now = this.freeStrokes(path);
		return ext.strokes === now && ext.count === now.length && ext.generation === inlineInk.generation(path) && ext.look === inkLookKey();
	}

	/**
	 * A pen commit's strokes drawn into the extent raster, which held the store as it was just before (extentHoldsStore): the same
	 * paint the committed layer gets, at the raster's camera, on top in store order, so the raster stays what a whole redraw gives
	 * and a pan after writing still fills by copy. Anything else leaves the raster stale: a commit that replaced a stroke rather
	 * than adding one, a stroke reaching past the raster's edge, a highlighter stroke with no highlighter layer.
	 */
	function drawIntoExtent(this: InkOverlayPlugin, path: string, added: readonly InkStroke[]): void {
		const ext = this.extentRaster, now = this.freeStrokes(path);
		if (!ext || ext.path !== path || now !== ext.strokes || now.length !== ext.count + added.length) return;
		for (let i = 0; i < added.length; i++) {
			const s = added[i]!, b = s.bbox, w = ext.world;
			if (now[ext.count + i] !== s) return;
			if (!(b.x >= w.x0 && b.y >= w.y0 && b.x + b.width <= w.x1 && b.y + b.height <= w.y1)) return;
			if (s.tool === "highlighter" && !ext.hl) return;
		}
		const floor = committedFloorFor(ext.backing, ext.dpr);
		for (const s of added) {
			const ctx = (s.tool === "highlighter" ? ext.hl : ext.pen)?.getContext("2d");
			if (!ctx) {
				this.extentRaster = null;
				return;
			}
			ctx.setTransform(ext.backing, 0, 0, ext.backing, 0, 0);
			drawStroke(ctx, ext.at, s, undefined, true, undefined, floor);
		}
		ext.count = now.length;
		ext.generation = inlineInk.generation(path);
	}

	/**
	 * Fill `rect` (world units, widened to whole device px), or the whole raster with null, from the extent raster: a copy by whole
	 * device pixels onto cleared pixels, byte for byte what drawing every stroke there gives. False, and nothing touched, when the
	 * camera's move since the build is not whole device pixels; the caller paints by path as before. "Whole" allows 1/16 device
	 * pixel: the document top and the content left settle in layout units of 1/64 css px after a bounce, and the camera follows,
	 * so a build's origin and the settled camera differ by that much and no more (under 1/16 device px at any backing up to 4).
	 * The copy then lands on the nearest whole pixel, under 1/16 px from the exact place; a half pixel is a real move and refuses.
	 */
	function copyFromExtent(this: InkOverlayPlugin, ext: NonNullable<InkOverlayPlugin["extentRaster"]>, cam: RasterCamera, rect: BBox | null): boolean {
		const k = cam.zoom * ext.backing;
		const whole = (v: number) => Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1 / 16;
		const mx = (cam.x - ext.cam0.x) * k, my = (cam.y - ext.cam0.y) * k;
		if (!whole(mx) || !whole(my)) return false;
		const offX = Math.round(mx) - ext.kx, offY = Math.round(my) - ext.ky;
		const cw = this.committedCanvas.width, ch = this.committedCanvas.height;
		let dx = 0, dy = 0, dw = cw, dh = ch;
		if (rect) {
			// Out to whole device px: the copy holds every stroke's true pixels, so a pixel the rect only grazes gets its whole
			// value, the one a whole-layer redraw gives it.
			const x0 = Math.max(0, Math.floor((rect.x - cam.x) * k + 1e-6)), y0 = Math.max(0, Math.floor((rect.y - cam.y) * k + 1e-6));
			const x1 = Math.min(cw, Math.ceil((rect.x + rect.width - cam.x) * k - 1e-6)), y1 = Math.min(ch, Math.ceil((rect.y + rect.height - cam.y) * k - 1e-6));
			if (!(x1 > x0) || !(y1 > y0)) return true;
			dx = x0; dy = y0; dw = x1 - x0; dh = y1 - y0;
		}
		const layers: [CanvasRenderingContext2D, HTMLCanvasElement | null][] = [[this.committedCtx, ext.pen]];
		if (!this.highlightPairDeferred) layers.push([this.highlightCtx, ext.hl]);
		for (const [ctx, src] of layers) {
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(dx, dy, dw, dh);
			if (src) ctx.drawImage(src, dx + offX, dy + offY, dw, dh, dx, dy, dw, dh);
			ctx.restore();
		}
		return true;
	}

export function installExtent(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		extentBuildAllowed,
		armExtentBuild,
		scheduleExtentPiece,
		extentPieceAllowed,
		extentBuildHolds,
		runExtentPiece,
		dropExtentBuild,
		usableExtent,
		extentHolds,
		extentToStandIn,
		takeStandIn,
		usableStandIn,
		dropStandIn,
		retryStandInLater,
		repaintOverStandIn,
		copyFromStandIn,
		standInMarkNow,
		standInMarkHolds,
		extentHoldsStore,
		drawIntoExtent,
		copyFromExtent,
	});
}
