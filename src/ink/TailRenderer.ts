import { CameraState } from "../camera/coordinates";
import { PenSample } from "../input/PointerRouter";
import { PenStyle, widthForPressure } from "./PenStyle";
import { Point2 } from "./Smoothing";
import { fillRibbon } from "./RibbonRenderer";
import { inkColorFor } from "./InkTheme";
import type { InkStroke } from "./Stroke";
import { strokeRev } from "./StrokeRev";

/**
 * How much width the predicted tail gives up by its tip.
 *
 * The far end of a guess is the least certain part of it, so it is drawn as
 * the faintest part. At full weight a wrong guess announces itself - the tip
 * jumps a nib-width sideways and the eye follows it - which is what made
 * prediction read as distortion while writing even though the committed
 * stroke was correct.
 */
const TAIL_TIP_TAPER = 0.5;

/**
 * The transient overlay: a canvas above the wet ink layer holding only
 * geometry that will be replaced on the next input event. Two things live
 * here:
 *
 *   the live head   the short raw stub from the settled smooth curve to the
 *                   nib, which is what keeps the tip lag-free
 *   prediction      the experimental predicted tail, when enabled
 *
 * Both are erased and redrawn constantly, which is why they cannot live on the
 * append-only wet canvas. Erasing clears only the bounding box of the last
 * draw: at ~200–250 Hz a full-viewport clear per event is real GPU work, and
 * this is a few dozen pixels across.
 */
export class TailRenderer {
	private ctx: CanvasRenderingContext2D;
	private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
	private readonly requested: boolean;
	private spacePaths = new WeakMap<InkStroke,{rev:number;path:Path2D}>();

	/**
	 * `desynchronized` asks the browser to present this canvas without waiting
	 * for the normal compositing sync - the low-latency path.
	 *
	 * It belongs here more than anywhere else in the plugin. This canvas holds
	 * the stub that reaches the nib; the wet canvas below it holds geometry
	 * that is already, by construction, behind the pen. The inline overlay
	 * asked for it on the wet layer from the start and never asked for it
	 * here, which had the tip presenting on the slower path than the ink
	 * trailing it.
	 *
	 * It is only a HINT. Browsers refuse it silently, so `actualDesynchronized`
	 * reports what was really granted rather than what was asked for - the same
	 * shape WetInkRenderer uses, and the reason a latency claim about this can
	 * be checked instead of assumed.
	 */
	constructor(canvas: HTMLCanvasElement, desynchronized = false) {
		this.requested = desynchronized;
		// Exactly the call this made before the flag existed when nothing is
		// asked for. Passing `{ desynchronized: false }` ought to be identical
		// to passing nothing, and after what asking for `true` did on hardware
		// here, "ought to be" is not a good enough reason to change the call
		// the working path makes.
		const ctx = desynchronized
			? canvas.getContext("2d", { desynchronized: true })
			: canvas.getContext("2d");
		if (!ctx) throw new Error("Handwriting: could not acquire tail 2d context");
		this.ctx = ctx;
	}

	/** What the browser actually granted; undefined where unreportable. */
	get actualDesynchronized(): boolean | undefined {
		return (
			this.ctx as CanvasRenderingContext2D & {
				getContextAttributes?: () => { desynchronized?: boolean };
			}
		).getContextAttributes?.().desynchronized;
	}

	/** Compact one-line report, for the metrics panel. */
	describeLatency(): string {
		return `tail: req ${this.requested} | granted ${String(this.actualDesynchronized ?? "n/a")}`;
	}

	applyDpr(dpr: number): void {
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/**
	 * Erase the previous tail: the dirty rect when there is one, and the WHOLE
	 * canvas when there is not and a size is given.
	 *
	 * The fallback is the point, and it is the same one `WetInkRenderer.
	 * clearStroke` has: no box means clear everything, because leaving ink
	 * behind is the one outcome an erase must never produce. Without it this
	 * method was `if (!this.dirty) return;` - a total no-op - and three paths
	 * on this class paint the canvas and then NULL the box without leaving one
	 * behind: `drawLasso`, `drawSelectionBox` and `drawSpaceDivider`, one of
	 * which says so in a comment ("selection UI clears with clearAll, not a
	 * dirty rect"). Measured in real Chromium with an exhaustive pixel count
	 * (`test/measure/TailClearBox.test.ts`), a `clear()` over a nulled box
	 * left 920, 1453, 3356 and 5091 px across the four zoom/dpr configs - in
	 * every one, EXACTLY what had just been drawn, so nothing was erased at
	 * all - where `clearAll` erased the canvas in all twelve cases. An
	 * independent run on another tree saw the same total no-op at its own
	 * fixture's counts (1027/3170/1191/3784).
	 *
	 * That is a CONDITIONAL fact: IF the box is null then the old `clear()`
	 * erased nothing. Whether an ink pen-up can actually reach that state is
	 * NOT established - a pen-down dissolves the selection for a bare tip, and
	 * a lasso gesture ends on its own branch - so this is not the fix for a
	 * known on-screen defect. The fallback makes the question moot at no cost,
	 * which is why it is here instead of a reachability hunt.
	 *
	 * The size is OPTIONAL so the hot-path callers do not have to change. They
	 * erase the previous tail once per pointer event at 200-250 Hz, where the
	 * dirty rect is a few dozen pixels across and a whole-canvas clear is real
	 * GPU work; they pass nothing and keep exactly the behaviour they have,
	 * including the early return. The pen-up sites, which run once per stroke
	 * and must leave the canvas clean for the committed layer, pass the size
	 * and get the fallback.
	 */
	clear(cssWidth?: number, cssHeight?: number): void {
		const d = this.dirty;
		if (!d) {
			// No box. Clear everything if we were told how big everything is,
			// and otherwise do what this always did.
			if (
				cssWidth !== undefined &&
				cssHeight !== undefined &&
				cssWidth > 0 &&
				cssHeight > 0
			) {
				this.ctx.clearRect(0, 0, cssWidth, cssHeight);
			}
			return;
		}
		this.ctx.clearRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
		this.dirty = null;
	}

	/** Erase everything, for stroke end / resize. */
	clearAll(cssWidth: number, cssHeight: number): void {
		this.ctx.clearRect(0, 0, cssWidth, cssHeight);
		this.dirty = null;
	}

	/**
	 * Selection UI: the lasso being drawn, and the outline around what it
	 * caught. Both take world coordinates and are redrawn whenever the camera
	 * moves, which is what keeps a selection glued to its contents through pan
	 * and zoom.
	 */
	drawLasso(cam: CameraState, world: readonly Point2[], color: string): void {
		if (world.length < 2) return;
		const ctx = this.ctx;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.beginPath();
		ctx.moveTo((world[0]!.x - cam.x) * cam.zoom, (world[0]!.y - cam.y) * cam.zoom);
		for (let i = 1; i < world.length; i++) {
			ctx.lineTo((world[i]!.x - cam.x) * cam.zoom, (world[i]!.y - cam.y) * cam.zoom);
		}
		ctx.closePath();
		ctx.stroke();
		ctx.restore();
		this.dirty = null; // selection UI clears with clearAll, not a dirty rect
	}

	drawSelectionBox(
		cam: CameraState,
		box: { x: number; y: number; width: number; height: number },
		color: string
	): void {
		const ctx = this.ctx;
		const pad = 6;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([4, 4]);
		ctx.strokeRect(
			(box.x - cam.x) * cam.zoom - pad,
			(box.y - cam.y) * cam.zoom - pad,
			box.width * cam.zoom + pad * 2,
			box.height * cam.zoom + pad * 2
		);
		ctx.restore();
		this.dirty = null;
	}

	/**
	 * Insert-space divider: a full-width dashed rule at the gesture's world
	 * y. World-anchored like the rest of the selection chrome, so it stays
	 * glued to the seam it marks; the ink below it follows the pen, the
	 * rule itself never moves.
	 */
	drawSpaceDivider(cam: CameraState, yWorld: number, color: string, cssWidth: number): void {
		const y = (yWorld - cam.y) * cam.zoom;
		const ctx = this.ctx;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([8, 5]);
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(cssWidth, y);
		ctx.stroke();
		ctx.restore();
		this.dirty = null;
	}

	/** Actual stroke paths, never a union box or a stored color change. Hover
	 * reuses geometry; offscreen strokes are rejected before path construction. */
	drawSpaceStroke(cam:CameraState,stroke:InkStroke,color:string,width:number,height:number,cssScale:number):boolean {
		const b=stroke.bbox,pad=4/cssScale;
		if((b.x+b.width-cam.x)*cam.zoom < -pad || (b.y+b.height-cam.y)*cam.zoom < -pad ||
			(b.x-cam.x)*cam.zoom > width+pad || (b.y-cam.y)*cam.zoom > height+pad || !stroke.points.length)return false;
		let cached=this.spacePaths.get(stroke);
		const rev=strokeRev(stroke);
		if(!cached||cached.rev!==rev){
			const path=new Path2D(),points=stroke.points;
			path.moveTo(points[0]!.x,points[0]!.y);
			for(let i=1;i<points.length;i++)path.lineTo(points[i]!.x,points[i]!.y);
			if(points.length===1)path.lineTo(points[0]!.x+.001,points[0]!.y);
			cached={rev,path};this.spacePaths.set(stroke,cached);
		}
		const ctx=this.ctx;
		ctx.save();ctx.translate(-cam.x*cam.zoom,-cam.y*cam.zoom);ctx.scale(cam.zoom,cam.zoom);
		ctx.strokeStyle=color;ctx.globalAlpha=.65;ctx.lineWidth=Math.max(stroke.width,4/(cssScale*cam.zoom));
		ctx.lineCap="round";ctx.lineJoin="round";ctx.setLineDash([]);ctx.stroke(cached.path);ctx.restore();
		this.dirty=null;
		return true;
	}

	/** Small physical-size label/tick, including the exact rounded landing.
	 * Keep origin and landing labels on opposite sides when their Y agrees. */
	drawSpaceLabel(cam:CameraState,yWorld:number,label:string,color:string,cssScale:number,landing=false):void {
		const ctx=this.ctx,y=(yWorld-cam.y)*cam.zoom;
		ctx.save();ctx.translate(0,y);ctx.scale(1/cssScale,1/cssScale);
		ctx.font="12px sans-serif";ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash([]);
		if(landing){ctx.beginPath();ctx.moveTo(8,-4);ctx.lineTo(8,4);ctx.moveTo(8,0);ctx.lineTo(30,0);ctx.stroke();}
		ctx.fillText(label,landing?36:8,landing?16:-7);ctx.restore();this.dirty=null;
	}

	/**
	 * Draw the live head: one straight world-space segment, widthed to match
	 * the ribbon underneath it so the join is invisible.
	 *
	 * `hwWorld` is that width - a WORLD half-width, the same unit as a ribbon
	 * point's `hw` - and it wins when given. Callers get it from
	 * `WetInkRenderer.liveHalfWidth`, which is the wet layer reporting what it
	 * is actually laying down. Widthing the head from raw pressure instead
	 * misses three things the ribbon has (velocity thinning, the start taper,
	 * smoothed pressure) and the head is a separate canvas layer over the
	 * ribbon, so the difference reads as a step at the join - up to ~12x wide
	 * at stroke start with a fast pen.
	 *
	 * `pressure` stays, and stays the fallback, because it is honest: it is
	 * exactly what the wet layer's own non-shaping branch computes. A caller
	 * with no wet renderer to ask still gets the width this drew before
	 * `hwWorld` existed rather than a zero or a guess.
	 *
	 * Accumulates into the dirty rect, so it can be combined with a predicted
	 * tail in the same pass.
	 */
	drawHead(
		cam: CameraState,
		style: PenStyle,
		from: Point2,
		to: Point2,
		pressure: number,
		hwWorld?: number
	): void {
		const x1 = (from.x - cam.x) * cam.zoom;
		const y1 = (from.y - cam.y) * cam.zoom;
		const x2 = (to.x - cam.x) * cam.zoom;
		const y2 = (to.y - cam.y) * cam.zoom;
		const hw = hwWorld ?? widthForPressure(style, pressure) / 2;
		fillRibbon(
			this.ctx,
			cam,
			[
				{ x: from.x, y: from.y, hw },
				{ x: to.x, y: to.y, hw },
			],
			// The head continues the wet ribbon; it has to be the same colour the
			// ribbon under it was painted (InkTheme.ts).
			inkColorFor(style)
		);
		this.growDirty(x1, y1, x2, y2, hw * cam.zoom + 2);
	}

	private growDirty(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		pad: number
	): void {
		const box = {
			x0: Math.min(x1, x2) - pad,
			y0: Math.min(y1, y2) - pad,
			x1: Math.max(x1, x2) + pad,
			y1: Math.max(y1, y2) + pad,
		};
		if (!this.dirty) {
			this.dirty = box;
			return;
		}
		this.dirty = {
			x0: Math.min(this.dirty.x0, box.x0),
			y0: Math.min(this.dirty.y0, box.y0),
			x1: Math.max(this.dirty.x1, box.x1),
			y1: Math.max(this.dirty.y1, box.y1),
		};
	}

	/**
	 * Draw the tail from the last real screen-space position through the
	 * predicted points. Same colour and width as the live stroke, because the
	 * tail is meant to read as ink, not as a hint.
	 */
	draw(
		fromX: number,
		fromY: number,
		points: readonly PenSample[],
		color: string,
		lineWidthPx: number
	): void {
		if (points.length === 0) return;
		const ctx = this.ctx;
		// `color` here is always the pen's ink (the predicted tail), never
		// selection chrome - the lasso and the dividers below keep their raw
		// colour, because they are UI and not ink.
		ctx.strokeStyle = inkColorFor(color);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const base = Math.max(0.5, lineWidthPx);
		let px = fromX;
		let py = fromY;
		let x0 = fromX;
		let y0 = fromY;
		let x1 = fromX;
		let y1 = fromY;
		// Segment at a time, narrowing toward the tip. One stroked polyline is
		// cheaper, but it draws the least certain end at full weight: when the
		// guess is wrong the eye is pulled to a full-width tip snapping
		// sideways. Tapered, a correction is a thin line moving slightly.
		for (let i = 0; i < points.length; i++) {
			const p = points[i]!;
			const t = (i + 1) / points.length;
			ctx.lineWidth = Math.max(0.5, base * (1 - TAIL_TIP_TAPER * t));
			ctx.beginPath();
			ctx.moveTo(px, py);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();
			px = p.x;
			py = p.y;
			if (p.x < x0) x0 = p.x;
			if (p.y < y0) y0 = p.y;
			if (p.x > x1) x1 = p.x;
			if (p.y > y1) y1 = p.y;
		}
		this.growDirty(x0, y0, x1, y1, base / 2 + 2);
	}
}
