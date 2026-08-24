import { describe, expect, it } from "vitest";
import { screenToWorld, worldToScreen } from "./coordinates";
import { noteToVisual, visualToNote } from "../inline/ZoomScale";

/**
 * v0.13.1 regression suite — the exact transform pipeline the inline
 * overlay uses, composed end to end, with the font zoom riding on the
 * CAMERA (cam.zoom) rather than on the unit conversion.
 *
 * Units, spelled out once:
 *   world / note   stored stroke coordinates (CSS px at zoom 1, scale 1)
 *   screen         canvas CSS px — what the canvases and PenSamples use
 *   visual         getBoundingClientRect / PointerEvent.clientX px
 *   cssScale       visual px per screen px (CSS transform zoom only)
 *   cam.zoom       screen px per world px (the font zoom)
 *
 * Forward:  visual = overlayLeft + worldToScreen(cam, w).x * cssScale
 * Inverse:  w = screenToWorld(cam, (visual - overlayLeft) / cssScale)
 * Camera:   cam.xy = (overlayLeft - contentLeft) / (cssScale * zoom)
 *           — the world coordinate of the overlay origin, note origin
 *           anchored at the content origin.
 *
 * The v0.13.0-part-2 bug: the font factor was folded into the unit
 * conversion (inverse and camera divided by it) while the render path's
 * zoom stayed 1 — forward and inverse differed by exactly the factor, so
 * a right-side pointer at visual x rendered at x/f: ink on the left.
 */

interface Frame {
	overlayLeft: number;
	overlayTop: number;
	contentLeft: number;
	documentTop: number;
	cssScale: number;
	zoom: number;
}

function cameraFor(f: Frame) {
	const total = f.cssScale * f.zoom;
	return {
		x: visualToNote(f.overlayLeft - f.contentLeft, total),
		y: visualToNote(f.overlayTop - f.documentTop, total),
		zoom: f.zoom,
	};
}

function pointerToWorld(f: Frame, clientX: number, clientY: number) {
	const cam = cameraFor(f);
	return screenToWorld(
		cam,
		visualToNote(clientX - f.overlayLeft, f.cssScale),
		visualToNote(clientY - f.overlayTop, f.cssScale)
	);
}

function worldToVisual(f: Frame, wx: number, wy: number) {
	const cam = cameraFor(f);
	const s = worldToScreen(cam, wx, wy);
	return {
		x: f.overlayLeft + noteToVisual(s.x, f.cssScale),
		y: f.overlayTop + noteToVisual(s.y, f.cssScale),
	};
}

const FRAMES: Frame[] = [
	// rest: mount font, no transform
	{ overlayLeft: 413.5, overlayTop: 78.29, contentLeft: 445, documentTop: 48.79, cssScale: 1, zoom: 1 },
	// pinched larger (Alan's config: font 30 vs a 16 reference = 1.875)
	{ overlayLeft: 413.5, overlayTop: 78.29, contentLeft: 445, documentTop: 48.79, cssScale: 1, zoom: 1.875 },
	// pinched smaller
	{ overlayLeft: 413.5, overlayTop: 78.29, contentLeft: 445, documentTop: 48.79, cssScale: 1, zoom: 0.5 },
	// far-right granted extent: contentLeft deep negative (real trace value)
	{ overlayLeft: 413.5, overlayTop: 78.29, contentLeft: -15962.23, documentTop: 290.79, cssScale: 1, zoom: 1.875 },
	// CSS-transform zoom AND font zoom together
	{ overlayLeft: 200, overlayTop: 50, contentLeft: 260, documentTop: 30, cssScale: 1.25, zoom: 2.5 },
	// vertical scroll: documentTop far above the viewport
	{ overlayLeft: 413.5, overlayTop: 78.29, contentLeft: 445, documentTop: -4200, cssScale: 1, zoom: 1.4 },
];

const POINTS: Array<[number, number]> = [
	[450, 100], // left
	[900, 400], // center
	[1400, 800], // right / low
];

describe("font-zoom transform — forward and inverse are true inverses", () => {
	it("round-trips representative points in every frame (≤1e-9 px)", () => {
		for (const f of FRAMES) {
			for (const [vx, vy] of POINTS) {
				const w = pointerToWorld(f, vx, vy);
				const back = worldToVisual(f, w.x, w.y);
				expect(Math.abs(back.x - vx)).toBeLessThan(1e-9);
				expect(Math.abs(back.y - vy)).toBeLessThan(1e-9);
			}
		}
	});

	it("REGRESSION: a right-side pointer renders on the right at zoom 1.875", () => {
		// The part-2 bug rendered visual 1400 at ≈ 1400/1.875 ≈ 747 — left.
		const f = FRAMES[1]!;
		const w = pointerToWorld(f, 1400, 300);
		const back = worldToVisual(f, w.x, w.y);
		expect(back.x).toBeCloseTo(1400, 6);
		// And explicitly: nowhere near the buggy left-shifted position.
		expect(Math.abs(back.x - 1400 / f.zoom)).toBeGreaterThan(100);
	});

	it("the note origin stays anchored at the content origin at every zoom", () => {
		for (const f of FRAMES) {
			const v = worldToVisual(f, 0, 0);
			expect(v.x).toBeCloseTo(f.contentLeft, 6);
			expect(v.y).toBeCloseTo(f.documentTop, 6);
		}
	});

	it("ink scales about the origin: rendered distance = note × cssScale × zoom", () => {
		for (const f of FRAMES) {
			const a = worldToVisual(f, 0, 0);
			const b = worldToVisual(f, 100, 100);
			expect(b.x - a.x).toBeCloseTo(100 * f.cssScale * f.zoom, 6);
			expect(b.y - a.y).toBeCloseTo(100 * f.cssScale * f.zoom, 6);
		}
	});

	it("zoom round trip returns ink to the identical visual position", () => {
		const rest = FRAMES[0]!;
		const zoomed = FRAMES[1]!;
		// Draw at rest, view at zoom, return to rest: same pixel.
		const w = pointerToWorld(rest, 1234.5, 456.7);
		const home = worldToVisual(rest, w.x, w.y);
		void worldToVisual(zoomed, w.x, w.y); // excursion
		const back = worldToVisual(rest, w.x, w.y);
		expect(back.x).toBe(home.x);
		expect(back.y).toBe(home.y);
	});
});
