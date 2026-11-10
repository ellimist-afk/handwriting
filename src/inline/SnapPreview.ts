import { computeBBox, type InkStroke } from "../ink/Stroke";
import { DWELL_MS, snapKindOf, snapStroke, type SnappedKind } from "../ink/ShapeSnap";
import { drawStroke } from "../ink/StrokeRenderer";
import { worldToScreen, type CameraState } from "../camera/coordinates";
import { scaledTime, wallSlide } from "./LassoTransform";

interface PreviewHost {
	clock: Pick<Window, "setTimeout" | "clearTimeout">;
	valid(): boolean;
	snapshot(): InkStroke[];
	show(stroke: InkStroke): boolean;
	hide(): void;
	/** Screen px to world. A drag measures scale and angle in the note's own units; absent, the two are the same. */
	world?(x: number, y: number): { x: number; y: number };
	/** A clear ended a showing shape while the gesture lives. Not called when a gesture end takes the shape. */
	ended?(): void;
	/** The next shown frame (requestAnimationFrame). Absent, each adjust shows at once. */
	frame?: { request(draw: () => void): number; cancel(id: number): void };
}

/** A drag starts past this many screen px from where the pen held, the same slack the dwell allows. */
const ADJUST_SLOP = 4;
/** A drag that starts nearer the centre than this (world px) turns the figure but does not resize it. */
const ADJUST_MIN_RADIUS = 8;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
/** Lines, rectangles and triangles settle on a right angle within this turn. */
const SQUARE_SNAP = 4 * Math.PI / 180;
/**
 * A dwell timer that runs this many ms past when it was due ran behind a busy main thread (a save, a sync, a long garbage
 * collection). On a free thread a timer runs a millisecond or two late.
 */
const LATE_MS = 4;

/** The turn a drag gives a figure of this kind: circles never turn; straight-sided figures settle on right angles. */
function turnFor(kind: SnappedKind | undefined, angle: number): number {
	if (kind === "circle") return 0;
	if (kind === "line" || kind === "rectangle" || kind === "triangle") {
		const square = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
		if (Math.abs(angle - square) <= SQUARE_SNAP) return square;
	}
	return angle;
}

/**
 * The figure scaled and turned about (cx, cy); everything but the points and their box is the figure's own, the width too:
 * it is new ink at the pen's width. The times scale with the points (scaledTime), so the speed thinning sees the speed the
 * figure was drawn at and the width stays the pen's at any size.
 */
export function transformed(base: InkStroke, cx: number, cy: number, scale: number, angle: number): InkStroke {
	const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
	const t0 = base.points[0]?.t ?? 0;
	const points = base.points.map(p => {
		const dx = p.x - cx, dy = p.y - cy;
		return { ...p, x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos, t: scaledTime(p.t, t0, scale) };
	});
	return { ...base, points, bbox: computeBBox(points, base.width * 2) };
}

/** The figure shifted by (dx, dy), its box with it. */
function moved(stroke: InkStroke, dx: number, dy: number): InkStroke {
	const points = stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
	return { ...stroke, points, bbox: { ...stroke.bbox, x: stroke.bbox.x + dx, y: stroke.bbox.y + dy } };
}

/**
 * One fit per unchanged pause. It never owns or finalizes the live builder.
 *
 * Once the shape shows, the pen keeps it: every move after that resizes and
 * turns it about the centre of its box (distance from the centre for size,
 * the angle about it for the turn), and the stroke underneath stops growing,
 * since those moves are not ink. Whatever ends the gesture commits the shape
 * as it shows; anything that changes what it would commit clears it first.
 */
export class SnapPreview {
	private timer: number | null = null;
	private epoch = 0;
	private body: InkStroke | null = null;
	/** The fitted figure, never moved: every drag frame is measured from it. */
	private candidate: InkStroke | null = null;
	/** What the canvas shows now, the one object a gesture end commits; null when the drag carried it off the band. */
	private shown: InkStroke | null = null;
	/** The drag's centre and the pen's distance and angle from it at the drag's first move. */
	private pivot: { cx: number; cy: number; r: number; a: number } | null = null;
	private live = false;
	private x = 0;
	private y = 0;
	/** Date.now() of the last meaningful move; the pending timer measures the dwell from here when it fires. */
	private movedAt = Number.NEGATIVE_INFINITY;
	/** The newest adjust sample not shown yet, and the frame that will show it. */
	private pending: { x: number; y: number } | null = null;
	private frameId: number | null = null;
	/** The frame a late dwell put its show off to. */
	private settleId: number | null = null;
	constructor(private host: PreviewHost, private fit = snapStroke) {}
	start(x: number, y: number): void {
		this.clear();
		this.live = true;
		this.x = x; this.y = y;
		this.arm(DWELL_MS);
	}
	/** A shape is showing: the pen's moves adjust it and are not ink. */
	get holding(): boolean {
		return this.candidate !== null;
	}
	/**
	 * A meaningful move restarts the dwell by stamping its time, not by
	 * replacing the timer: the one pending timer re-arms for the rest when it
	 * fires early. A pen in motion moves on nearly every sample, and a timer
	 * set and cleared per sample woke the main thread for nothing.
	 *
	 * True when the sample went to a showing shape, so the caller does not ink it.
	 */
	move(x: number, y: number): boolean {
		if (!this.check()) return false;
		if (this.candidate) { this.adjust(x, y); return true; }
		if (Math.hypot(x - this.x, y - this.y) <= 4) return false;
		this.x = x; this.y = y;
		this.movedAt = Date.now();
		if (this.timer === null && this.settleId === null) this.arm(DWELL_MS);
		return false;
	}
	/**
	 * The first move past the slop fixes the drag's centre and reach; each move after resizes and turns the figure from there.
	 *
	 * ONE SHOW PER SHOWN FRAME. A 240 Hz pen sends about four samples per 60 Hz frame, and showing each one drew three
	 * figures nobody saw (SnapAdjustCost.test.ts). A sample is kept as the newest and the frame shows that one; a gesture
	 * end shows a sample still waiting before it takes the shape (take), so the shape committed is the last one shown.
	 */
	private adjust(x: number, y: number): void {
		const base = this.candidate!;
		if (!this.pivot) {
			if (Math.hypot(x - this.x, y - this.y) <= ADJUST_SLOP) return;
			const w = this.toWorld(x, y);
			const cx = base.bbox.x + base.bbox.width / 2, cy = base.bbox.y + base.bbox.height / 2;
			this.pivot = { cx, cy, r: Math.hypot(w.x - cx, w.y - cy), a: Math.atan2(w.y - cy, w.x - cx) };
			return;
		}
		const frame = this.host.frame;
		if (!frame) { this.showAt(x, y); return; }
		this.pending = { x, y };
		if (this.frameId !== null) return;
		const epoch = this.epoch;
		this.frameId = frame.request(() => {
			this.frameId = null;
			if (epoch !== this.epoch || !this.check()) return;
			this.flush();
		});
	}
	/** Show the sample still waiting for its frame, if any; the frame no longer needs to. */
	private flush(): void {
		if (this.frameId !== null) { this.host.frame?.cancel(this.frameId); this.frameId = null; }
		const at = this.pending;
		this.pending = null;
		if (at && this.candidate && this.pivot) this.showAt(at.x, at.y);
	}
	private showAt(x: number, y: number): void {
		const base = this.candidate!;
		const p = this.pivot!;
		const w = this.toWorld(x, y);
		const scale = p.r < ADJUST_MIN_RADIUS ? 1
			: Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.hypot(w.x - p.cx, w.y - p.cy) / p.r));
		const angle = turnFor(snapKindOf(base), Math.atan2(w.y - p.cy, w.x - p.cx) - p.a);
		const resized = transformed(base, p.cx, p.cy, scale, angle);
		// Top and left are bounded: a figure grown or turned past a wall slides back so its own box lands on the wall, the
		// wall being 0 or where the figure's box already was, as the lasso slides a selection.
		const slide = wallSlide(base.bbox, resized.bbox);
		const next = slide.x === 0 && slide.y === 0 ? resized : moved(resized, slide.x, slide.y);
		this.shown = this.host.show(next) ? next : null;
	}
	private toWorld(x: number, y: number): { x: number; y: number } {
		return this.host.world ? this.host.world(x, y) : { x, y };
	}
	check(): boolean {
		if (!this.live) return false;
		if (!this.host.valid()) { this.clear(); return false; }
		return true;
	}
	private arm(ms: number): void {
		const epoch = this.epoch;
		const due = Date.now() + ms;
		this.timer = this.host.clock.setTimeout(() => {
			if (epoch !== this.epoch || !this.check()) return;
			this.timer = null;
			const rest = this.movedAt + DWELL_MS - Date.now();
			if (rest > 0) { this.arm(rest); return; }
			if (Date.now() - due > LATE_MS) { this.settle(); return; }
			this.showFit();
		}, ms);
	}
	/**
	 * A late timer cannot tell a pen that held still from a pen whose samples are queued behind it: a moving pen's samples
	 * wait while the thread is busy, and the timer can run before them. Shown now, the shape would hold a stroke that never
	 * stopped. The show waits for the next frame, by which time the queued samples have been read (pointer events are
	 * delivered before frame callbacks), and the dwell is measured again from them. Without frames it waits one turn.
	 */
	private settle(): void {
		const frame = this.host.frame;
		if (!frame) { this.arm(0); return; }
		const epoch = this.epoch;
		this.settleId = frame.request(() => {
			this.settleId = null;
			if (epoch !== this.epoch || !this.check() || this.timer !== null) return;
			const rest = this.movedAt + DWELL_MS - Date.now();
			if (rest > 0) this.arm(rest); else this.showFit();
		});
	}
	private showFit(): void {
		const strokes = this.host.snapshot();
		if (strokes.length !== 1) return;
		const body = strokes[0]!;
		const candidate = this.fit(body, true);
		if (candidate && this.host.show(candidate)) {
			this.body = body;
			this.candidate = candidate;
			this.shown = candidate;
		}
	}
	/**
	 * Any gesture end: the shape exactly as it shows, the same object the
	 * canvas drew. The stroke stopped growing when the shape showed, so the
	 * final stroke must equal the fitted body point for point; final filtering
	 * that removed or split it leaves the freehand. Never fit unseen geometry.
	 */
	take(final: InkStroke[]): InkStroke | null {
		if (this.check()) this.flush();
		const body = this.body;
		const stroke = final[0];
		const matches = this.check() && this.shown && body && final.length === 1 && stroke &&
			stroke.points.length === body.points.length && body.points.every((point, i) => {
				const end = stroke.points[i]!;
				return point.x === end.x && point.y === end.y && point.t === end.t;
			});
		const shown = matches ? this.shown : null;
		this.reset();
		return shown;
	}
	/** Drop the pending fit and any shape. A shape that was showing tells the host: its stroke stopped growing when it showed. */
	clear(): void {
		const held = this.candidate !== null;
		this.reset();
		if (held) this.host.ended?.();
	}
	private reset(): void {
		this.epoch++;
		if (this.timer !== null) this.host.clock.clearTimeout(this.timer);
		this.timer = null;
		if (this.frameId !== null) this.host.frame?.cancel(this.frameId);
		this.frameId = null;
		if (this.settleId !== null) this.host.frame?.cancel(this.settleId);
		this.settleId = null;
		this.pending = null;
		this.movedAt = Number.NEGATIVE_INFINITY;
		this.live = false;
		this.body = null;
		this.candidate = null;
		this.shown = null;
		this.pivot = null;
		this.host.hide();
	}
}

/** A canvas that has to grow takes this much room past the figure, so a drag that keeps pulling outward does not resize every frame. */
const GROW_ROOM = 1.25;

/**
 * A clipped stroke-sized layer inside the existing bounded ink band. A drag redraws the one canvas, moved, never a new one per move.
 * `floor` is the committed width floor the lift will draw the shape with (committedFloorFor), so a thin shape shows at the weight it lands.
 *
 * The canvas is resized only when the figure outgrows it or the backing changes; a figure that fits is drawn after a clearRect.
 * Its box is the canvas at the backing, never larger than the pane, and kept inside the pane, so a box larger than the figure
 * moves left or up rather than past the pane's edge.
 */
export class SnapPreviewCanvas {
	private canvas: HTMLCanvasElement | null = null;
	/** The backing the canvas was sized at. */
	private backing = 0;
	show(parent: HTMLElement, cam: CameraState, stroke: InkStroke, width: number, height: number, backing: number,
		floor?: { backing: number; dpr: number }): boolean {
		const box = stroke.bbox;
		const start = worldToScreen(cam, box.x, box.y);
		const end = worldToScreen(cam, box.x + box.width, box.y + box.height);
		const left = Math.max(0, Math.floor(start.x - 2));
		const top = Math.max(0, Math.floor(start.y - 2));
		const right = Math.min(width, Math.ceil(end.x + 2));
		const bottom = Math.min(height, Math.ceil(end.y + 2));
		if (![left, top, right, bottom, backing].every(Number.isFinite) || right <= left || bottom <= top || backing <= 0) { this.clear(); return false; }
		if (this.canvas && this.canvas.parentElement !== parent) this.clear();
		const fresh = !this.canvas;
		const canvas = this.canvas ?? parent.createEl("canvas");
		if (fresh) {
			canvas.className = "handwriting-snap-preview";
			canvas.setAttribute("aria-hidden", "true");
		}
		Object.assign(canvas.style, { position: "absolute", pointerEvents: "none", opacity: "0.45", zIndex: "4" });
		const w = Math.ceil((right-left) * backing), h = Math.ceil((bottom-top) * backing);
		const ctx = canvas.getContext("2d");
		if (!ctx) { canvas.remove(); this.canvas = null; this.backing = 0; return false; }
		if (fresh || this.backing !== backing) { canvas.width = w; canvas.height = h; }
		else if (canvas.width < w || canvas.height < h) {
			const maxW = Math.floor(width * backing), maxH = Math.floor(height * backing);
			canvas.width = Math.max(w, Math.min(maxW, Math.ceil(Math.max(canvas.width, w) * GROW_ROOM)));
			canvas.height = Math.max(h, Math.min(maxH, Math.ceil(Math.max(canvas.height, h) * GROW_ROOM)));
		}
		else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
		this.backing = backing;
		const boxW = canvas.width / backing, boxH = canvas.height / backing;
		const x = Math.max(0, Math.min(left, width - boxW)), y = Math.max(0, Math.min(top, height - boxH));
		Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${boxW}px`, height: `${boxH}px` });
		ctx.setTransform(backing, 0, 0, backing, 0, 0);
		drawStroke(ctx, { ...cam, x: cam.x+x/cam.zoom, y: cam.y+y/cam.zoom }, stroke, undefined, true, false, floor);
		if (fresh) parent.appendChild(canvas);
		this.canvas = canvas;
		return true;
	}
	clear(): void {
		if (!this.canvas) return;
		this.canvas.remove();
		this.canvas.width = this.canvas.height = 0;
		this.canvas = null;
		this.backing = 0;
	}
}
