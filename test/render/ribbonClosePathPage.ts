/**
 * Pixel parity for the ribbon path with and without a `closePath` per quad.
 *
 * THE POINT. `fillRibbon` puts every quad and disc of a stroke into ONE path
 * and fills it once. A quad is `moveTo` + 3x `lineTo` + `closePath`, and the
 * close is what the device trace bills: 3332.0 ms of a 3536.8 ms task, and
 * ~1800x the per-call cost of the `lineTo` beside it. `fill()` closes every open
 * subpath implicitly, so the closes should not be reaching the raster at all -
 * but "should" is not a measurement, and removing a call from the paint path on
 * the strength of a spec sentence is how a renderer regression gets shipped.
 *
 * HOW THIS AVOIDS A REPLICA. Nothing here re-implements the quad geometry. The
 * real `fillRibbon` paints once into a RECORDING context, which captures its
 * exact call stream; that one stream is then replayed onto real canvases twice,
 * once with a `closePath` on every subpath and once with none. Both arms are the
 * production painter's own output, so the comparison cannot drift away from what
 * the painter really emits, and the cell keeps its meaning whichever way the
 * painter itself is written - before the closes are removed, and after.
 *
 * The plant arm moves ONE vertex by one pixel. It exists because two identical
 * byte arrays prove nothing unless a difference would have shown up.
 */
import { fillRibbon } from "../../src/ink/RibbonRenderer";
import type { RibbonPt } from "../../src/ink/Ribbon";
import type { CameraState } from "../../src/camera/coordinates";

type Call =
	| { op: "moveTo"; a: number[] }
	| { op: "lineTo"; a: number[] }
	| { op: "closePath" }
	| { op: "arc"; a: number[] }
	| { op: "fill" };

/** Records the painter's call stream without rasterising anything. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
	const calls: Call[] = [];
	const ctx = {
		fillStyle: "",
		beginPath() { /* a subpath is opened by the moveTo that follows */ },
		moveTo(x: number, y: number) { calls.push({ op: "moveTo", a: [x, y] }); },
		lineTo(x: number, y: number) { calls.push({ op: "lineTo", a: [x, y] }); },
		closePath() { calls.push({ op: "closePath" }); },
		arc(x: number, y: number, r: number, s: number, e: number, ccw?: boolean) { calls.push({ op: "arc", a: [x, y, r, s, e, ccw ? 1 : 0] }); },
		fill() { calls.push({ op: "fill" }); },
	} as unknown as CanvasRenderingContext2D;
	return { ctx, calls };
}

/**
 * Replay one recorded stream.
 *
 * `closes` "every" puts a `closePath` at the end of every subpath regardless of
 * what the painter emitted; "none" removes them all. Normalising both ways from
 * the same recording is what keeps the two arms comparable no matter which the
 * painter does today.
 *
 * `plantAt` displaces the nth recorded `lineTo` by one pixel.
 */
function replay(calls: readonly Call[], closes: "every" | "none", plantAt: number | null): Uint8ClampedArray {
	const canvas = document.createElement("canvas");
	canvas.width = 480; canvas.height = 360;
	const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = "#1040c0";
	let lineTos = 0;
	ctx.beginPath();
	for (let i = 0; i < calls.length; i++) {
		const call = calls[i]!;
		if (call.op === "closePath") continue; // re-inserted below, never replayed as recorded
		if (call.op === "moveTo") {
			// A new subpath begins. Close the one before it if this arm closes.
			if (closes === "every" && i > 0) ctx.closePath();
			ctx.moveTo(call.a[0]!, call.a[1]!);
		} else if (call.op === "lineTo") {
			const plant = plantAt !== null && lineTos === plantAt;
			lineTos++;
			ctx.lineTo(call.a[0]! + (plant ? 1 : 0), call.a[1]!);
		} else if (call.op === "arc") {
			ctx.arc(call.a[0]!, call.a[1]!, call.a[2]!, call.a[3]!, call.a[4]!, call.a[5] === 1);
		} else if (call.op === "fill") {
			if (closes === "every") ctx.closePath();
			ctx.fill();
		}
	}
	return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** FNV-1a over the raster, so the cell can compare and report without shipping megabytes. */
function hash(bytes: Uint8ClampedArray): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i]!;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

function differingBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
	return n;
}

/**
 * A stroke with many quads and several hard turns, so the recording covers the
 * quad loop, the joint discs and both caps rather than one straight run.
 */
function wavyStroke(samples: number): RibbonPt[] {
	const pts: RibbonPt[] = [];
	for (let i = 0; i < samples; i++) {
		const u = i / (samples - 1);
		pts.push({
			x: 30 + u * 420,
			y: 180 + Math.sin(u * Math.PI * 6) * 110,
			hw: 3 + Math.sin(u * Math.PI * 13) * 2,
		});
	}
	return pts;
}

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/**
 * @param perSegment the smoothing-off path, which emits a disc at EVERY joint -
 * the Boox case, and the one with the most subpaths per stroke.
 */
function run(samples: number, perSegment: boolean) {
	const rec = recorder();
	fillRibbon(rec.ctx, CAM, wavyStroke(samples), "#1040c0", perSegment);
	const counts = rec.calls.reduce((acc, c) => { acc[c.op] = (acc[c.op] ?? 0) + 1; return acc; }, {} as Record<string, number>);
	const closed = replay(rec.calls, "every", null);
	const open = replay(rec.calls, "none", null);
	const planted = replay(rec.calls, "none", Math.floor((counts.lineTo ?? 3) / 2));
	return {
		samples, perSegment, counts,
		closedHash: hash(closed), openHash: hash(open), plantedHash: hash(planted),
		openVsClosedBytes: differingBytes(open, closed),
		plantedVsClosedBytes: differingBytes(planted, closed),
		/** Ink on the canvas, so an all-blank comparison cannot pass as parity. */
		inkedPixels: (() => { let n = 0; for (let i = 3; i < closed.length; i += 4) if (closed[i]! > 0) n++; return n; })(),
	};
}

/**
 * The per-call cost, measured on the same stream: replay the whole path with
 * every subpath closed and with none, timed. This is the rig's own version of
 * the trace's closePath-against-lineTo ratio.
 */
function cost(samples: number, perSegment: boolean, reps: number) {
	const rec = recorder();
	fillRibbon(rec.ctx, CAM, wavyStroke(samples), "#1040c0", perSegment);
	const counts = rec.calls.reduce((acc, c) => { acc[c.op] = (acc[c.op] ?? 0) + 1; return acc; }, {} as Record<string, number>);
	const time = (closes: "every" | "none") => {
		replay(rec.calls, closes, null); // one warm replay, not timed
		const t = performance.now();
		for (let i = 0; i < reps; i++) replay(rec.calls, closes, null);
		return Math.round((performance.now() - t) / reps * 100) / 100;
	};
	const closedMs = time("every");
	const openMs = time("none");
	const closes = counts.moveTo ?? 0;
	return {
		samples, perSegment, reps, counts, closedMs, openMs,
		deltaMs: Math.round((closedMs - openMs) * 100) / 100,
		usPerClose: closes ? Math.round((closedMs - openMs) * 1000 / closes * 1000) / 1000 : null,
	};
}

(window as any).ribbonClosePath = { run, cost };
