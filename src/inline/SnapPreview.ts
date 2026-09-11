import type { InkStroke } from "../ink/Stroke";
import { DWELL_MS, snapStroke } from "../ink/ShapeSnap";
import { drawStroke } from "../ink/StrokeRenderer";
import { worldToScreen, type CameraState } from "../camera/coordinates";

interface PreviewHost {
	clock: Pick<Window, "setTimeout" | "clearTimeout">;
	valid(): boolean;
	snapshot(): InkStroke[];
	show(stroke: InkStroke): boolean;
	hide(): void;
}

/** One fit per unchanged pause. It never owns or finalizes the live builder. */
export class SnapPreview {
	private timer: number | null = null;
	private epoch = 0;
	private body: InkStroke | null = null;
	private candidate: InkStroke | null = null;
	private live = false;
	private x = 0;
	private y = 0;
	constructor(private host: PreviewHost, private fit = snapStroke) {}
	start(x: number, y: number): void {
		this.clear();
		this.live = true;
		this.x = x; this.y = y;
		this.arm();
	}
	move(x: number, y: number): void {
		if (!this.check()) return;
		if (Math.hypot(x - this.x, y - this.y) <= 4) return;
		this.clear();
		this.live = true;
		this.x = x; this.y = y;
		this.arm();
	}
	check(): boolean {
		if (!this.live) return false;
		if (!this.host.valid()) { this.clear(); return false; }
		return true;
	}
	private arm(): void {
		const epoch = this.epoch;
		this.timer = this.host.clock.setTimeout(() => {
			if (epoch !== this.epoch || !this.check()) return;
			this.timer = null;
			const strokes = this.host.snapshot();
			if (strokes.length !== 1) return;
			const body = strokes[0]!;
			const candidate = this.fit(body, true);
			if (candidate && this.host.show(candidate)) {
				this.body = body;
				this.candidate = candidate;
			}
		}, DWELL_MS);
	}
	/** Final filtering may remove a body or split it. Never fit unseen geometry. */
	take(final: InkStroke[], lift: boolean): InkStroke | null {
		const body = this.body;
		const stroke = final[0];
		const matches = lift && this.check() && this.candidate && body && final.length === 1 && stroke &&
			stroke.points.length >= body.points.length && body.points.every((point, i) => {
				const end = stroke.points[i]!;
				return point.x === end.x && point.y === end.y && point.t === end.t;
			});
		const candidate = matches ? this.candidate : null;
		this.clear();
		return candidate;
	}
	clear(): void {
		this.epoch++;
		if (this.timer !== null) this.host.clock.clearTimeout(this.timer);
		this.timer = null;
		this.live = false;
		this.body = null;
		this.candidate = null;
		this.host.hide();
	}
}

/** A clipped stroke-sized layer inside the existing bounded ink band. */
export class SnapPreviewCanvas {
	private canvas: HTMLCanvasElement | null = null;
	show(parent: HTMLElement, cam: CameraState, stroke: InkStroke, width: number, height: number, backing: number): boolean {
		this.clear();
		const box = stroke.bbox;
		const start = worldToScreen(cam, box.x, box.y);
		const end = worldToScreen(cam, box.x + box.width, box.y + box.height);
		const left = Math.max(0, Math.floor(start.x - 2));
		const top = Math.max(0, Math.floor(start.y - 2));
		const right = Math.min(width, Math.ceil(end.x + 2));
		const bottom = Math.min(height, Math.ceil(end.y + 2));
		if (![left, top, right, bottom, backing].every(Number.isFinite) || right <= left || bottom <= top || backing <= 0) return false;
		const canvas = parent.createEl("canvas");
		canvas.className = "handwriting-snap-preview";
		canvas.setAttribute("aria-hidden", "true");
		Object.assign(canvas.style, { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${right-left}px`, height: `${bottom-top}px`, pointerEvents: "none", opacity: "0.45", zIndex: "4" });
		canvas.width = Math.ceil((right-left) * backing);
		canvas.height = Math.ceil((bottom-top) * backing);
		const ctx = canvas.getContext("2d");
		if (!ctx) { canvas.remove(); return false; }
		ctx.setTransform(backing, 0, 0, backing, 0, 0);
		drawStroke(ctx, { ...cam, x: cam.x+left/cam.zoom, y: cam.y+top/cam.zoom }, stroke, undefined, true, false);
		parent.appendChild(canvas);
		this.canvas = canvas;
		return true;
	}
	clear(): void {
		if (!this.canvas) return;
		this.canvas.remove();
		this.canvas.width = this.canvas.height = 0;
		this.canvas = null;
	}
}
