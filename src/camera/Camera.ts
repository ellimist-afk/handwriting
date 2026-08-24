import {
	CameraState,
	Point,
	clampZoom,
	panBy,
	pinchUpdate,
	screenToWorld,
	worldToScreen,
	zoomAtPoint,
} from "./coordinates";

export type CameraListener = (cam: Readonly<CameraState>) => void;

/**
 * Mutable camera wrapper around the pure math in coordinates.ts.
 * Emits change events; the view schedules renders off those.
 */
export class Camera {
	private state: CameraState = { x: 0, y: 0, zoom: 1 };
	private listeners = new Set<CameraListener>();

	get x(): number {
		return this.state.x;
	}
	get y(): number {
		return this.state.y;
	}
	get zoom(): number {
		return this.state.zoom;
	}
	get snapshot(): Readonly<CameraState> {
		return { ...this.state };
	}

	onChange(fn: CameraListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private set(next: CameraState): void {
		if (
			next.x === this.state.x &&
			next.y === this.state.y &&
			next.zoom === this.state.zoom
		) {
			return;
		}
		this.state = next;
		for (const fn of this.listeners) fn(this.state);
	}

	setState(x: number, y: number, zoom: number): void {
		this.set({ x, y, zoom: clampZoom(zoom) });
	}

	panBy(dxScreen: number, dyScreen: number): void {
		this.set(panBy(this.state, dxScreen, dyScreen));
	}

	zoomAt(sx: number, sy: number, newZoom: number): void {
		this.set(zoomAtPoint(this.state, sx, sy, newZoom));
	}

	pinch(prevMid: Point, prevDist: number, nextMid: Point, nextDist: number): void {
		this.set(pinchUpdate(this.state, prevMid, prevDist, nextMid, nextDist));
	}

	screenToWorld(sx: number, sy: number): Point {
		return screenToWorld(this.state, sx, sy);
	}

	worldToScreen(wx: number, wy: number): Point {
		return worldToScreen(this.state, wx, wy);
	}
}
