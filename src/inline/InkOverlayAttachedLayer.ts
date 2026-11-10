/**
 * Ink attached to text, painted on its own layer.
 *
 * A group's members leave the committed layers and the extent raster, which hold free ink only. Each group is drawn
 * once into an offscreen sprite at its stored points, and the sprite is copied onto this layer where the group is shown:
 * the stored box plus the group's correction, on whole device pixels. A follow that moves a group clears the swept
 * rectangle on this layer alone and copies again every sprite the rectangle touches, so free ink is never repainted by a
 * follow, and a keystroke above twenty groups costs twenty copies, not a path redraw of the screen beside them.
 *
 * A sprite is drawn again only when what it shows changes: a member stroke (object or revision), the zoom, the backing,
 * the device ratio, the ink look or the width floor, and only while the group is in view: a paint never builds or draws a
 * group it cannot show, and one off screen keeps its sprite until it comes back. A sprite is a grid of tiles of at most TILE_DEVICE_PX a side over
 * its box, from its origin on whole device pixels: only a tile a member's box touches is allocated, so a tall
 * group holds its ink, not its box. A group whose tiles pass spriteMaxDevicePx(), or would take the layer's tiles past
 * four times that once the sprites of groups not shown, at another raster, are let go, draws by path on this layer instead, only the members a paint's rects or view touch. Pen members go on the pen canvas, above the committed pen layer; highlighter members on the highlight canvas,
 * above the committed highlight layer at the same opacity, which keeps a backing only once a group holds a highlighter
 * stroke. A note with no groups gives this layer no backing and no paint: existing notes pay nothing.
 */
import { Platform } from "obsidian";
import type { CameraState } from "../camera/coordinates";
import type { BBox, InkStroke, InkTool } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import { drawCommitted, drawStroke } from "../ink/StrokeRenderer";
import { inkLookKey } from "./InkOverlayConstants";

/** The most device pixels one group's allocated tiles may hold, per tool; past it the group is drawn by path. */
export const SPRITE_MAX_DEVICE_PX = { mobile: 2_000_000, desktop: 8_000_000 };
/** The cap for this platform, read when a sprite is built: a suite that sets the platform after import gets its own. */
export const spriteMaxDevicePx = (): number => (Platform.isMobileApp ? SPRITE_MAX_DEVICE_PX.mobile : SPRITE_MAX_DEVICE_PX.desktop);
/** The most device pixels all groups' allocated tiles may hold, per tool; a group past it, in paint order, draws by path. */
export const spriteLayerMaxDevicePx = (): number => 4 * spriteMaxDevicePx();
/** A sprite tile's side, device px, both platforms. */
export const TILE_DEVICE_PX = 1024;
/**
 * The most tiles one paint draws into sprites, both platforms: a still paint after a fling that reveals
 * ten groups draws sixteen tiles, draws the rest by path under each tile's clip, and asks one more frame for the next.
 */
export const TILE_BUILD_PER_PAINT = 16;
/** CSS px of room around a sprite's box, so anti-aliased edges and the width floor are not cut. */
export const SPRITE_PAD = 3;

type Floor = { backing: number; dpr: number } | undefined;

/** One group as this surface shows it now. */
export interface AttachedGroup {
	id: string;
	/** The members as stored, in store order. */
	members: readonly InkStroke[];
	/** The group's correction, world units. */
	offset: { dx: number; dy: number };
	/** The members as shown (stored points plus the correction), for the by-path fallback. */
	shown: () => readonly InkStroke[];
}

/** One tile canvas a zoom preview's hold puts up: its group, and its place, device px from the layer's pixel (0, 0). */
export interface HeldTile {
	id: string;
	c: HTMLCanvasElement;
	x: number;
	y: number;
}

/** One allocated tile: its place in the sprite, device px from the sprite's pixel (0, 0), and its canvases. */
interface Tile {
	key: string;
	x: number;
	y: number;
	w: number;
	h: number;
	pen: HTMLCanvasElement | null;
	hl: HTMLCanvasElement | null;
	/** Drawn into its canvases: until then a paint draws the tile's part by path. */
	done: boolean;
}

interface Sprite {
	members: readonly InkStroke[];
	revs: number[];
	zoom: number;
	backing: number;
	dpr: number;
	look: number;
	floorKey: string;
	/** World top-left of the sprite's pixel (0, 0) at its stored points. */
	ox: number;
	oy: number;
	/** World box of the stored members, padded: what the sprite covers. */
	box: BBox;
	tiles: Tile[];
	/** Device px the tiles hold, per tool: what this sprite counts against the layer total. */
	px: number;
	/** Past a cap: drawn by path. */
	byPath: boolean;
	/** Tiles not yet drawn: a later paint at a still camera draws them, TILE_BUILD_PER_PAINT a paint. */
	pending: number;
}

/**
 * Counts the cells read: sprites drawn, copies made, groups drawn by path, paints run and how many of them whole; why each
 * whole paint was whole (first is checked first, so each whole paint counts once); who asked for "all"; and the largest
 * sprite, in device px, a group past the cap would have needed.
 */
export interface AttachedLayerCounts {
	built: number;
	/** Sprites kept across a held group's move in the store, origin moved. */
	translated: number;
	blits: number;
	byPath: number;
	paints: number;
	whole: number;
	wholeCommitted: number;
	wholeDirty: number;
	wholeFirst: number;
	wholeCamera: number;
	wholeBacking: number;
	invalidFollow: number;
	invalidLayout: number;
	invalidLift: number;
	byPathPxMax: number;
	/** Tiles allocated by sprite builds. */
	tiles: number;
	/** The most device px the layer's tiles held at once. */
	spritePx: number;
	/** Builds refused for the layer total: the group draws by path. */
	byPathBudget: number;
	/** Strokes a by-path group drew: only those a rect or the view touches. */
	byPathStrokes: number;
	/** Device px of the tiles copied, before the clip. */
	blitPx: number;
	/** Paints that left a sprite unbuilt because the camera was moving: the group drew by path, culled. */
	buildDeferred: number;
	/** Tiles drawn into sprites by the last paint, and the most by any one paint. */
	tilesLastPaint: number;
	tilesPaintMax: number;
	/** Undrawn tiles a paint drew by path under their clip. */
	tilesByPath: number;
	/** Paints at a still camera that stopped at TILE_BUILD_PER_PAINT with tiles left to draw. */
	buildCapped: number;
	/** The most paints in a row a build took to finish once the cap split it (1 when nothing waited). */
	finishPaintsMax: number;
}

/** Who asked the layer to paint whole: a follow whose move cannot be told, a new backing box, a drag's lift or its end. */
export type InvalidateReason = "follow" | "layout" | "lift";

export class AttachedLayer {
	private penCtx: CanvasRenderingContext2D | null = null;
	private hlCtx: CanvasRenderingContext2D | null = null;
	private hlLive = false;
	private backingW = 0;
	private backingH = 0;
	private backing = 0;
	private cssW = 0;
	private cssH = 0;
	private sprites = new Map<string, Sprite>();
	/** The camera this layer was last painted whole at, or null: the next paint is whole. */
	private paintedAt: { x: number; y: number; zoom: number; backing: number } | null = null;
	/** World rects a follow moved since the last paint, or "all". */
	private dirty: BBox[] | "all" = [];
	/** Whether anything is on either canvas. */
	private occupied = false;
	/** Rig only: told of each sprite drawn again, why, and its tiles and px. Unset in the plugin. */
	onSprite: ((id: string, why: "missing" | "raster" | "members" | "revs", tiles: number, px: number) => void) | null = null;
	/** Rig only: told of the sprites each paint lets go, by site and group id. Unset in the plugin. */
	onDrop: ((site: "empty" | "notLive", ids: readonly string[]) => void) | null = null;
	readonly counts: AttachedLayerCounts = {
		built: 0, translated: 0, blits: 0, byPath: 0, paints: 0, whole: 0, wholeCommitted: 0, wholeDirty: 0, wholeFirst: 0, wholeCamera: 0, wholeBacking: 0,
		invalidFollow: 0, invalidLayout: 0, invalidLift: 0, byPathPxMax: 0, tiles: 0, spritePx: 0, byPathBudget: 0, byPathStrokes: 0, blitPx: 0, buildDeferred: 0,
		tilesLastPaint: 0, tilesPaintMax: 0, tilesByPath: 0, buildCapped: 0, finishPaintsMax: 0,
	};
	/** Tiles this paint may still draw into sprites: TILE_BUILD_PER_PAINT at a still camera, 0 while it moves. */
	private tileBudget = 0;
	/** Paints in a row that left tiles undrawn. */
	private capRun = 0;
	/** A sprite this paint did not build because the camera moved: the next paint at a still camera builds it. */
	private deferred = false;
	/** Device px the kept sprites' tiles hold now. */
	private spritePx = 0;
	/** The groups the current paint shows: their sprites are never let go to make room. */
	private showingIds: ReadonlySet<string> = new Set();

	constructor(
		readonly pen: HTMLCanvasElement,
		readonly hl: HTMLCanvasElement,
		private readonly makeCanvas: () => HTMLCanvasElement
	) {
		for (const c of [pen, hl]) {
			c.width = 0;
			c.height = 0;
		}
	}

	/**
	 * Whether `cam` is where this layer was last painted whole, or it was never painted (a load): a sprite may be built
	 * only then. A fling or a pan preview moves the camera every frame, so nothing is built until it settles.
	 */
	stillAt(cam: CameraState): boolean {
		const at = this.paintedAt;
		return !at || (at.x === cam.x && at.y === cam.y && at.zoom === cam.zoom);
	}

	/**
	 * Whether `cam` is within 1/16 device px of where this layer was last painted whole, at its zoom and on the layer's own
	 * painted backing, or it was never painted: a build in the extent raster's pieces may draw sprites then. A landing on a
	 * stand-in recomputes the camera a millionth of a world unit off the paint, and an exact test refused every such build.
	 */
	stillNear(cam: CameraState): boolean {
		const at = this.paintedAt;
		return !at || this.paintedNear(cam, at.backing);
	}

	/**
	 * Whether the last paint left a sprite unbuilt for a moving camera, or tiles undrawn for the cap: ask one more paint,
	 * which draws them when still.
	 */
	get buildWaits(): boolean {
		return this.deferred;
	}

	/** Whether the pen canvas shows nothing (the pinch hides or composites by this). */
	get penBlank(): boolean {
		return !this.occupied;
	}

	/** Whether the highlight canvas shows nothing. */
	get hlBlank(): boolean {
		return !this.occupied || !this.hlLive;
	}

	/** Whether the layer holds a backing: false until a group is painted. */
	get live(): boolean {
		return this.backingW > 0;
	}

	/** The committed layers let their backings go: so does this one. */
	release(): void {
		for (const c of [this.pen, this.hl]) {
			c.width = 0;
			c.height = 0;
		}
		this.backingW = this.backingH = 0;
		this.hlLive = false;
		this.occupied = false;
		this.paintedAt = null;
		this.dirty = [];
	}

	/** A follow moved groups: their swept rectangles, world units. */
	moved(rects: readonly BBox[]): void {
		if (this.dirty === "all") return;
		for (const r of rects) this.dirty.push(r);
	}

	/** Everything on the layer is to be painted again (a first read, a membership change, an unknown move). */
	invalidate(reason: InvalidateReason): void {
		if (reason === "follow") this.counts.invalidFollow++;
		else if (reason === "layout") this.counts.invalidLayout++;
		else this.counts.invalidLift++;
		this.dirty = "all";
	}

	/**
	 * Every member of group `id` moved by `dy` in the store, in place (Insert Space over a held group): the
	 * sprite shows the same picture `dy` lower, so its origin moves and the members' revisions are taken as drawn. A sprite
	 * not yet drawn whole, or none, is left to the next paint.
	 */
	translated(id: string, dy: number): void {
		const sp = this.sprites.get(id);
		if (!sp || sp.byPath || sp.revs.length !== sp.members.length) return;
		sp.oy += dy;
		sp.box = { x: sp.box.x, y: sp.box.y + dy, width: sp.box.width, height: sp.box.height };
		sp.revs = sp.members.map(strokeRev);
		this.counts.translated++;
	}

	/**
	 * Before a build is refused for the layer total: lets go each sprite whose group this paint does not show and whose
	 * raster is not `now`'s, giving its pixels back. A shown group's sprite, or one at the current raster, stays. The
	 * group `now` is built for is skipped: its old sprite's pixels already left the total when the build began.
	 */
	private releaseStale(now: Sprite, building: string): void {
		for (const [id, sp] of this.sprites) {
			if (id === building || this.showingIds.has(id)) continue;
			if (sp.zoom === now.zoom && sp.backing === now.backing && sp.dpr === now.dpr && sp.look === now.look && sp.floorKey === now.floorKey) continue;
			this.spritePx -= sp.px;
			this.sprites.delete(id);
		}
	}

	/** Lets go each sprite whose group id is not in `keep`. */
	private dropUnkept(keep: ReadonlySet<string>, site: "empty" | "notLive"): void {
		for (const [id, sp] of this.sprites) {
			if (keep.has(id)) continue;
			this.spritePx -= sp.px;
			this.sprites.delete(id);
			if (this.onDrop) this.onDrop(site, [id]);
		}
	}

	/** Lets every sprite go (another note, a disposed surface). */
	clearSprites(): void {
		this.sprites.clear();
		this.spritePx = 0;
	}

	/**
	 * Whether this layer was last painted whole at `cam`'s zoom and `backing`, its place within 1/16 device px of `cam`'s (the held
	 * raster's own test). A landing on a stand-in recomputes the camera, which can move it by a millionth of a world unit from where
	 * the layer painted; an exact test then put up no tiles.
	 */
	private paintedNear(cam: CameraState, backing: number): boolean {
		const at = this.paintedAt;
		if (!at || at.zoom !== cam.zoom || at.backing !== backing) return false;
		const k = cam.zoom * backing;
		return Math.abs((cam.x - at.x) * k) < 1 / 16 && Math.abs((cam.y - at.y) * k) < 1 / 16;
	}

	/**
	 * What a zoom preview's hold puts up of this layer, with no side effect: for each group whose shown box meets `rect` (world),
	 * with a current sprite (the one paint() would copy at `cam`: same raster, same members, every tile drawn), its tiles, device px
	 * from the layer's pixel (0, 0), where paint() copies them, by tool and in paint order. A group off the view without one is left
	 * out and pops in at the landing. Null when the layer was not painted whole at `cam`, or a group the view shows has no current
	 * sprite: the hold then leaves this layer's canvases shown.
	 */
	heldTiles(cam: CameraState, groups: readonly AttachedGroup[], rect: BBox, floor: Floor, backing: number): { pen: HeldTile[]; hl: HeldTile[] } | null {
		const at = this.paintedAt;
		if (!at || !this.paintedNear(cam, backing)) return null;
		const look = inkLookKey(), floorKey = floor ? `${floor.backing}/${floor.dpr}` : "", dpr = floor?.dpr ?? 0;
		const view: BBox = { x: cam.x, y: cam.y, width: this.cssW / cam.zoom, height: this.cssH / cam.zoom };
		const out: { pen: HeldTile[]; hl: HeldTile[] } = { pen: [], hl: [] };
		for (const g of groups) {
			const shown = shownBox(g, cam.zoom);
			if (!shown) continue;
			const inView = overlaps(shown, view);
			if (!inView && !overlaps(shown, rect)) continue;
			const sp = this.sprites.get(g.id);
			const current = !!sp && !sp.byPath && sp.pending === 0 && sp.zoom === cam.zoom && sp.backing === backing && sp.dpr === dpr && sp.look === look &&
				sp.floorKey === floorKey && sameMembers(sp, g.members);
			if (!current) {
				if (inView) return null;
				continue;
			}
			// Rounded from where the layer painted, as paint() did: `cam` may sit a hair off it, and at .5 px it rounds the other way.
			const dx = Math.round((sp.ox + g.offset.dx - at.x) * cam.zoom * backing);
			const dy = Math.round((sp.oy + g.offset.dy - at.y) * cam.zoom * backing);
			for (const t of sp.tiles) {
				if (t.pen) out.pen.push({ id: g.id, c: t.pen, x: dx + t.x, y: dy + t.y });
				if (t.hl) out.hl.push({ id: g.id, c: t.hl, x: dx + t.x, y: dy + t.y });
			}
		}
		return out;
	}

	/**
	 * While the extent raster builds, at a still camera: builds the sprites of the groups whose shown box meets `rect` (world), at
	 * `cam`'s zoom, so a later hold can put them up. Draws one tile, then more while `more()` says the piece has time; the caps
	 * hold as in paint(), and a sprite of a group the last paint showed is never let go for room. Returns whether tiles wait.
	 */
	buildIn(cam: CameraState, groups: readonly AttachedGroup[], rect: BBox, floor: Floor, backing: number, more: () => boolean): boolean {
		if (!this.stillNear(cam) || !(backing > 0)) return false;
		let first = true;
		for (const g of groups) {
			const shown = shownBox(g, cam.zoom);
			if (!shown || !overlaps(shown, rect)) continue;
			for (;;) {
				if (!first && !more()) return true;
				this.tileBudget = 1;
				const sp = this.sprite(g, cam.zoom, backing, floor, true, true);
				const drew = this.tileBudget === 0;
				this.tileBudget = 0;
				if (drew) first = false;
				if (sp.byPath || sp.pending === 0) break;
			}
		}
		return false;
	}

	/**
	 * Paints the layer for this frame at `cam`: whole when the camera, the backing or the committed work asks it, else
	 * only the rectangles a follow moved. With no groups and nothing on the layer, no call reaches a canvas. With `build`
	 * false (the camera is moving) no sprite is built: a group without one draws by path, culled to the view.
	 *
	 * `keep`, the note's group ids (its attachments list), says which sprites live: a group this paint
	 * leaves out (a drag lifted it) draws nothing and keeps its sprite, and a sprite goes only when its id leaves the list.
	 * Without it, the groups painted are the ones kept.
	 */
	paint(cam: CameraState, groups: readonly AttachedGroup[], committedAll: boolean, floor: Floor, size: { backingW: number; backingH: number; backing: number; cssW: number; cssH: number }, build = true, keep: ReadonlySet<string> | null = null): void {
		this.deferred = false;
		this.tileBudget = build ? TILE_BUILD_PER_PAINT : 0;
		this.counts.tilesLastPaint = 0;
		if (groups.length === 0) {
			if (this.occupied) this.wipe();
			if (keep) this.dropUnkept(keep, "empty");
			else {
				if (this.onDrop && this.sprites.size > 0) this.onDrop("empty", [...this.sprites.keys()]);
				this.clearSprites();
			}
			this.dirty = [];
			return;
		}
		const { backingW, backingH, backing } = size;
		if (!(backingW > 0 && backingH > 0 && backing > 0)) return;
		this.cssW = size.cssW;
		this.cssH = size.cssH;
		if (this.backingW !== backingW || this.backingH !== backingH || this.backing !== backing) this.allocate(backingW, backingH, backing);
		if (!this.penCtx) return;
		// A first highlighter member gives the highlight canvas a backing: blank, so this paint is whole.
		const needHl = groups.some((g) => g.members.some((s) => s.tool === "highlighter"));
		if (needHl && !this.hlLive) this.allocateHl();
		const at = this.paintedAt;
		const whole = committedAll || this.dirty === "all" || !at || at.x !== cam.x || at.y !== cam.y || at.zoom !== cam.zoom || at.backing !== backing;
		const rects = whole ? null : (this.dirty as BBox[]);
		const dirtyAll = this.dirty === "all";
		this.dirty = [];
		if (rects && rects.length === 0) return;
		this.counts.paints++;
		if (whole) {
			const c = this.counts;
			c.whole++;
			if (!at) c.wholeFirst++;
			else if (committedAll) c.wholeCommitted++;
			else if (dirtyAll) c.wholeDirty++;
			else if (at.backing !== backing) c.wholeBacking++;
			else c.wholeCamera++;
		}
		if (keep) this.dropUnkept(keep, "notLive");
		else {
			const live = new Set<string>();
			for (const g of groups) live.add(g.id);
			this.dropUnkept(live, "notLive");
		}
		const view: BBox = { x: cam.x, y: cam.y, width: this.cssW / cam.zoom, height: this.cssH / cam.zoom };
		// The groups this paint can show, found before any sprite is asked for: a group off the view, or outside every
		// rect, is neither built nor drawn and keeps whatever sprite it has, so a zoom step builds the groups on screen
		// alone and the tile budget goes to them first. Off screen, a group is built once when it comes into view.
		const showing: AttachedGroup[] = [];
		for (const g of groups) {
			const shown = shownBox(g, cam.zoom);
			if (!shown || !overlaps(shown, view)) continue;
			if (rects && !rects.some((r) => overlaps(shown, r))) continue;
			showing.push(g);
		}
		this.showingIds = new Set(showing.map((g) => g.id));
		for (const [ctx, tool] of [[this.penCtx, "pen"], [this.hlLive ? this.hlCtx : null, "highlighter"]] as const) {
			if (!ctx) continue;
			ctx.save();
			if (rects) {
				// On whole device pixels, outward: a clip edge between pixels clears and draws an edge pixel in part, which
				// leaves a sprite cut by the rectangle fainter along the cut than a whole paint draws it.
				ctx.beginPath();
				for (const r of rects) {
					const k = cam.zoom * backing;
					const x0 = Math.floor((r.x - cam.x) * k) / backing, y0 = Math.floor((r.y - cam.y) * k) / backing;
					const x1 = Math.ceil((r.x + r.width - cam.x) * k) / backing, y1 = Math.ceil((r.y + r.height - cam.y) * k) / backing;
					ctx.rect(x0, y0, x1 - x0, y1 - y0);
					ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
				}
				ctx.clip();
			} else {
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, this.backingW, this.backingH);
				ctx.setTransform(backing, 0, 0, backing, 0, 0);
			}
			for (const g of showing) {
				const sp = this.sprite(g, cam.zoom, backing, floor, !rects, build);
				if (sp.byPath) {
					// Only the members this paint can show: a one-line rect never strokes a tall group whole.
					this.counts.byPath++;
					for (const s of g.shown()) {
						if (s.tool !== tool || !overlaps(s.bbox, view)) continue;
						if (rects && !rects.some((r) => overlaps(s.bbox, r))) continue;
						this.counts.byPathStrokes++;
						drawStroke(ctx, cam, s, undefined, true, undefined, floor);
					}
					continue;
				}
				// On whole device pixels: the sprite's origin moved by the correction, against the camera. Each tile sits a
				// whole number of device px from it, so tiles abut and never overlap: no seam takes alpha twice.
				const dx = Math.round((sp.ox + g.offset.dx - cam.x) * cam.zoom * backing);
				const dy = Math.round((sp.oy + g.offset.dy - cam.y) * cam.zoom * backing);
				const k = sp.zoom * sp.backing;
				let members: readonly InkStroke[] | null = null;
				for (const t of sp.tiles) {
					const img = tool === "pen" ? t.pen : t.hl;
					if (t.done && !img) continue;
					const at: BBox = { x: sp.ox + g.offset.dx + t.x / k, y: sp.oy + g.offset.dy + t.y / k, width: t.w / k, height: t.h / k };
					if (!overlaps(at, view)) continue;
					if (rects && !rects.some((r) => overlaps(at, r))) continue;
					if (!t.done) {
						// Not drawn yet (the cap): this tile's part by path, under its clip, so tiles still abut.
						members ??= g.shown();
						this.counts.tilesByPath++;
						ctx.save();
						ctx.beginPath();
						ctx.rect((dx + t.x) / backing, (dy + t.y) / backing, t.w / backing, t.h / backing);
						ctx.clip();
						for (const s of members) {
							if (s.tool !== tool || !overlaps(s.bbox, at) || !overlaps(s.bbox, view)) continue;
							if (rects && !rects.some((r) => overlaps(s.bbox, r))) continue;
							this.counts.byPathStrokes++;
							drawStroke(ctx, cam, s, undefined, true, undefined, floor);
						}
						ctx.restore();
						continue;
					}
					if (!img) continue;
					ctx.save();
					ctx.setTransform(1, 0, 0, 1, 0, 0);
					ctx.drawImage(img, dx + t.x, dy + t.y);
					ctx.restore();
					this.counts.blits++;
					this.counts.blitPx += t.w * t.h;
				}
			}
			ctx.restore();
		}
		this.occupied = true;
		if (whole) this.paintedAt = { x: cam.x, y: cam.y, zoom: cam.zoom, backing };
		const c = this.counts;
		c.tilesPaintMax = Math.max(c.tilesPaintMax, c.tilesLastPaint);
		let waiting = false;
		// Only the groups shown: one off screen that holds undrawn tiles waits until it comes into view.
		for (const g of showing) if ((this.sprites.get(g.id)?.pending ?? 0) > 0) waiting = true;
		if (waiting) {
			// Tiles left undrawn: one more paint, whole, which draws the next TILE_BUILD_PER_PAINT if the camera is still.
			this.deferred = true;
			if (build) c.buildCapped++;
			this.capRun++;
		} else {
			c.finishPaintsMax = Math.max(c.finishPaintsMax, this.capRun + 1);
			this.capRun = 0;
		}
		// A group drawn by path for a moving camera: the next paint is whole, and builds its sprite if the camera is still.
		if (this.deferred) this.dirty = "all";
	}

	/**
	 * The sprite for a group, drawn again only when what it shows changed. A paint of rectangles (an eraser scrub, an
	 * undo) that finds a group's members changed draws that group by path under its clip, as the committed layers draw
	 * a damage rect, and leaves the sprite to the next whole paint: a scrub never redraws a whole group per frame.
	 */
	private sprite(g: AttachedGroup, zoom: number, backing: number, floor: Floor, mayBuild: boolean, build: boolean): Sprite {
		const look = inkLookKey(), floorKey = floor ? `${floor.backing}/${floor.dpr}` : "", dpr = floor?.dpr ?? 0;
		const old = this.sprites.get(g.id);
		const sameRaster = !!old && old.zoom === zoom && old.backing === backing && old.dpr === dpr && old.look === look && old.floorKey === floorKey;
		if (old && sameRaster && sameMembers(old, g.members)) {
			if (old.pending > 0 && mayBuild) this.drawTiles(g, old, floor);
			return old;
		}
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const s of g.members) {
			const b = s.bbox;
			if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
			x0 = Math.min(x0, b.x);
			y0 = Math.min(y0, b.y);
			x1 = Math.max(x1, b.x + b.width);
			y1 = Math.max(y1, b.y + b.height);
		}
		const pad = SPRITE_PAD / zoom;
		const ox = x0 - pad, oy = y0 - pad;
		const cssW = (x1 - x0) * zoom + 2 * SPRITE_PAD, cssH = (y1 - y0) * zoom + 2 * SPRITE_PAD;
		const w = Math.ceil(cssW * backing) + 1, h = Math.ceil(cssH * backing) + 1;
		const box: BBox = { x: ox, y: oy, width: cssW / zoom, height: cssH / zoom };
		if (!mayBuild && old && sameRaster) {
			// Not kept: the next whole paint finds the members changed and draws the sprite again.
			return { ...old, members: g.members, revs: [], box, ox, oy, tiles: [], px: 0, byPath: Number.isFinite(x0), pending: 0 };
		}
		if (!build) {
			// The camera is moving: by path this frame and not kept; an old sprite (another zoom) stays for the next still paint.
			if (!this.deferred) this.counts.buildDeferred++;
			this.deferred = true;
			return { members: g.members, revs: [], zoom, backing, dpr, look, floorKey, ox, oy, box, tiles: [], px: 0, byPath: Number.isFinite(x0), pending: 0 };
		}
		const sp: Sprite = { members: g.members, revs: g.members.map(strokeRev), zoom, backing, dpr, look, floorKey, ox, oy, box, tiles: [], px: 0, byPath: false, pending: 0 };
		// This sprite replaces the old one: the old tiles leave the layer total, and their canvases are reused by place.
		if (old) this.spritePx -= old.px;
		const reuse = new Map<string, Tile>();
		for (const t of old?.tiles ?? []) reuse.set(t.key, t);
		// One pad, device px, for the tiles a member touches and for what each tile draws.
		const tilePad = SPRITE_PAD * backing;
		const plan = !(x1 > x0 || y1 > y0) || !(w > 0 && h > 0) || !Number.isFinite(w * h) ? null : tilesFor(g.members, ox, oy, zoom * backing, tilePad, w, h);
		if (!plan) {
			sp.byPath = Number.isFinite(x0);
			if (!sp.byPath) sp.box = { x: 0, y: 0, width: 0, height: 0 };
		} else if (plan.px > spriteMaxDevicePx()) {
			sp.byPath = true;
			this.counts.byPathPxMax = Math.max(this.counts.byPathPxMax, plan.px);
		} else if (this.spritePx + plan.px > spriteLayerMaxDevicePx() && (this.releaseStale(sp, g.id), this.spritePx + plan.px > spriteLayerMaxDevicePx())) {
			sp.byPath = true;
			this.counts.byPathBudget++;
		} else {
			// An old tile's canvases are reused by place; each is drawn again before it is copied. A tool the group no longer
			// holds keeps no canvas: drawTiles draws only the tools the group has, and paint copies any canvas a tile holds.
			const hasPen = g.members.some((s) => s.tool === "pen"), hasHl = g.members.some((s) => s.tool === "highlighter");
			for (const t of plan.tiles) {
				const was = reuse.get(t.key);
				t.pen = hasPen ? was?.pen ?? null : null;
				t.hl = hasHl ? was?.hl ?? null : null;
			}
			sp.tiles = plan.tiles;
			sp.pending = plan.tiles.length;
			sp.px = plan.px;
			this.spritePx += plan.px;
			this.counts.spritePx = Math.max(this.counts.spritePx, this.spritePx);
			this.counts.tiles += plan.tiles.length;
			this.counts.built++;
		}
		this.sprites.set(g.id, sp);
		if (this.onSprite) {
			const why = !old ? "missing" : !sameRaster ? "raster" : old.members.length !== g.members.length || old.members.some((m, i) => m !== g.members[i]) ? "members" : "revs";
			this.onSprite(g.id, why, sp.tiles.length, sp.px);
		}
		if (sp.pending > 0) this.drawTiles(g, sp, floor);
		return sp;
	}

	/**
	 * Draws a sprite's undrawn tiles, in order, while this paint's tile budget lasts; the rest wait for
	 * the next paint, and this paint draws their parts by path.
	 */
	private drawTiles(g: AttachedGroup, sp: Sprite, floor: Floor): void {
		const { zoom, backing, ox, oy } = sp;
		const tilePad = SPRITE_PAD * backing;
		const tools = (["pen", "highlighter"] as InkTool[]).filter((tool) => g.members.some((s) => s.tool === tool));
		for (const t of sp.tiles) {
			if (this.tileBudget <= 0) return;
			if (t.done) continue;
			// The tile's camera starts `tilePad` device px up and left of its pixel (0, 0), the sprite's (t.x, t.y), and the
			// draw is moved back by as much: drawCommitted culls by the tile grown by the pad the allocation used, so a
			// stroke whose anti-aliased edge or width floor crosses a seam past its box is drawn on both sides of it. The
			// canvas edge clips the rest. A tile draws what the one sprite would have drawn there.
			const cam: CameraState = { x: ox + (t.x - tilePad) / (zoom * backing), y: oy + (t.y - tilePad) / (zoom * backing), zoom };
			for (const tool of tools) {
				const c = (tool === "pen" ? t.pen : t.hl) ?? this.makeCanvas();
				c.width = t.w;
				c.height = t.h;
				const ctx = c.getContext("2d");
				if (!ctx) continue;
				ctx.setTransform(backing, 0, 0, backing, -tilePad, -tilePad);
				drawCommitted(ctx, cam, g.members, (t.w + 2 * tilePad) / backing, (t.h + 2 * tilePad) / backing, true, tool, false, floor);
				if (tool === "pen") t.pen = c;
				else t.hl = c;
			}
			t.done = true;
			sp.pending--;
			this.tileBudget--;
			this.counts.tilesLastPaint++;
		}
	}

	private allocate(backingW: number, backingH: number, backing: number): void {
		this.backingW = backingW;
		this.backingH = backingH;
		this.backing = backing;
		this.pen.width = backingW;
		this.pen.height = backingH;
		this.penCtx = this.pen.getContext("2d");
		this.penCtx?.setTransform(backing, 0, 0, backing, 0, 0);
		if (this.hlLive) this.allocateHl();
		this.paintedAt = null;
		this.occupied = false;
	}

	private allocateHl(): void {
		this.hl.width = this.backingW;
		this.hl.height = this.backingH;
		this.hlCtx = this.hl.getContext("2d");
		this.hlCtx?.setTransform(this.backing, 0, 0, this.backing, 0, 0);
		this.hlLive = !!this.hlCtx;
		this.paintedAt = null;
	}

	private wipe(): void {
		for (const ctx of [this.penCtx, this.hlCtx]) {
			if (!ctx) continue;
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, this.backingW, this.backingH);
			ctx.restore();
		}
		this.occupied = false;
		this.paintedAt = null;
	}
}

/**
 * The tiles a sprite of `w` by `h` device px needs: those a member's box, padded by `pad` device px for its anti-aliased
 * edge, touches; edge tiles are cut to the sprite. Walks the members, never the grid: a tall group's empty rows cost
 * nothing. `k` is device px per world unit.
 */
function tilesFor(members: readonly InkStroke[], ox: number, oy: number, k: number, pad: number, w: number, h: number): { tiles: Tile[]; px: number } {
	const T = TILE_DEVICE_PX, cols = Math.ceil(w / T), rows = Math.ceil(h / T);
	const seen = new Map<string, Tile>();
	for (const s of members) {
		const b = s.bbox;
		if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
		const i0 = Math.max(0, Math.floor(((b.x - ox) * k - pad) / T)), i1 = Math.min(cols - 1, Math.floor(((b.x + b.width - ox) * k + pad) / T));
		const j0 = Math.max(0, Math.floor(((b.y - oy) * k - pad) / T)), j1 = Math.min(rows - 1, Math.floor(((b.y + b.height - oy) * k + pad) / T));
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) {
				const key = i + "," + j;
				if (seen.has(key)) continue;
				seen.set(key, { key, x: i * T, y: j * T, w: Math.min(T, w - i * T), h: Math.min(T, h - j * T), pen: null, hl: null, done: false });
			}
		}
	}
	const tiles = [...seen.values()];
	let px = 0;
	for (const t of tiles) px += t.w * t.h;
	return { tiles, px };
}

/**
 * The world box group `g` shows at zoom `zoom`: its members' box padded by SPRITE_PAD css px, plus its correction, as
 * sprite() lays the sprite's box out; null when no member has a finite box (such a group draws nothing).
 */
function shownBox(g: AttachedGroup, zoom: number): BBox | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of g.members) {
		const b = s.bbox;
		if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
		x0 = Math.min(x0, b.x);
		y0 = Math.min(y0, b.y);
		x1 = Math.max(x1, b.x + b.width);
		y1 = Math.max(y1, b.y + b.height);
	}
	if (!Number.isFinite(x0)) return null;
	const pad = SPRITE_PAD / zoom;
	const cssW = (x1 - x0) * zoom + 2 * SPRITE_PAD, cssH = (y1 - y0) * zoom + 2 * SPRITE_PAD;
	return { x: x0 - pad + g.offset.dx, y: y0 - pad + g.offset.dy, width: cssW / zoom, height: cssH / zoom };
}

function sameMembers(sp: Sprite, members: readonly InkStroke[]): boolean {
	if (sp.members.length !== members.length) return false;
	for (let i = 0; i < members.length; i++) {
		const s = members[i]!;
		if (sp.members[i] !== s || sp.revs[i] !== strokeRev(s)) return false;
	}
	return true;
}

const overlaps = (a: BBox, b: BBox): boolean =>
	a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
