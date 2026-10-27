/**
 * Page half of ZoomSettleBaseline.test.ts: the PanBakeRepaint page (its mount and repaint recorder) plus what a zoom settle costs,
 * read around one gesture. Counting only; nothing here changes what the overlay does.
 */
import "./panBakeRepaintPage";
import { canvasReallocs, inkCanvasReallocs } from "../../src/inline/InkOverlayConstants";
import { overlayForPath, inkLookKey, inlineInk } from "../../src/inline/InkOverlay";

const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const PATH = "Untitled 1.md";

type Paint = { t0: number; ms: number; work: string; inTask: boolean; bounce: boolean; stand: number; copies: number; mayBuild: boolean; ext: boolean;
	heldBefore: boolean; heldAfter: boolean; buildAfter: boolean; deferrals: number; pts: number };
const zs: any = { paints: [] as Paint[], tasks: [] as Array<{ start: number; ms: number }>, task: 0, fates: [] as unknown[],
	pieceRuns: [] as Array<{ t0: number; ms: number; drew: number; bounce: boolean }>, frames: [] as Array<{ t: number; bounce: boolean }>, rafOn: false };

/** Long tasks, from the moment the page loads; the cell reads those that start after its gesture began. */
try {
	new PerformanceObserver(list => { for (const e of list.getEntries()) zs.tasks.push({ start: e.startTime, ms: e.duration }); }).observe({ entryTypes: ["longtask"] });
} catch { /* the cell reports none */ }

(window as any).zsb = {
	/** The committed layer's backing size, device px: the placement read's window is sized from it. */
	layerSize() { const c = (overlayForPath(PATH) as any).committedCanvas as HTMLCanvasElement; return { w: c.width, h: c.height }; },
	/** Wrap the overlay's repaint once more, after panBake.record(): each whole-layer paint's duration, and whether it ran in the gesture's own task. */
	watch() {
		const o: any = overlayForPath(PATH);
		const orig = o.paintCommittedWork;
		o.paintCommittedWork = function (this: any, cam: any, work: any, strokes: any) {
			const t0 = performance.now(), s0 = this.standInDeferrals ?? 0, mayBuild = !!this.extentMayBuild, ext = !!this.extentRaster, heldBefore = !!this.standIn;
			const bounce = !!this.bounceState;
			try { return orig.call(this, cam, work, strokes); } finally {
				const ms = performance.now() - t0;
				// Path points this paint put on the committed layer, from the recorder's own row for it (read after the timing).
				const rr = work === "all" ? (window as any).panBake.rows() : null, pts = rr && rr.length ? rr[rr.length - 1].pts ?? 0 : 0;
				if (work === "all") zs.paints.push({ t0, ms, work: "all", inTask: zs.task === 1, bounce, stand: !!this.standIn ? 1 : 0,
					copies: (this.standInDeferrals ?? 0) - s0, mayBuild, ext, heldBefore, heldAfter: !!this.standIn, buildAfter: !!this.extentBuild, deferrals: this.standInDeferrals ?? 0, pts });
			}
		};
		// The build's fate at each piece: which check of extentBuildHolds or extentPieceAllowed said no, read before the piece runs.
		const origPiece = o.runExtentPiece;
		o.runExtentPiece = function (this: any) {
			const b = this.extentBuild;
			if (b && zs.fates.length < 200) {
				const path = this.filePath(), cam = this.lastPaintCam, now = path ? this.noteStrokes(path) : null;
				const holds = { path: path === b.path, cam: !!cam, zoom: !!cam && cam.zoom === b.cam0.zoom, backing: this.committedBacking === b.backing, dpr: this.dpr === b.dpr,
					look: inkLookKey() === b.look, strokes: now === b.strokes, count: now ? now.length - b.count : null, generation: path ? inlineInk.generation(path) === b.generation : null };
				const allowed = { locked: !!this.frame?.locked, builder: this.builder !== null, stroking: !!this.router?.isStroking, nav: !!this.router?.hasActiveNavigation,
					pinchRef: this.pinchRefScale !== null, bounce: !!this.bounceState, queued: !!this.repaintQueued, scrollQuiet: performance.now() - this.lastScrollAskAt };
				const row = { at: performance.now(), next: b.next, count: b.count, holds, allowed, gate: this.extentPieceAllowed(), repeats: 0 };
				// A held gate retries every few ms: a row repeating the last one's verdicts is counted on it, not added.
				const last = zs.fates[zs.fates.length - 1], key = (r: any) => JSON.stringify([r.holds, r.gate, r.allowed.pinchRef, r.allowed.bounce, r.allowed.queued, r.allowed.nav]);
				if (last && key(last) === key(row)) last.repeats++; else zs.fates.push(row);
			}
			// Each piece that drew: its ms, and whether a bounce was playing when it ran.
			const n0 = b ? b.next : 0, bounce = !!this.bounceState, p0 = performance.now();
			try { return origPiece.call(this); } finally {
				const drew = b ? b.next - n0 : 0;
				if (drew > 0 && zs.pieceRuns.length < 2000) zs.pieceRuns.push({ t0: p0, ms: performance.now() - p0, drew, bounce });
			}
		};
		// Every animation frame's start, and whether a bounce was playing: the frame gaps over the bounce.
		zs.rafOn = true;
		const tick = () => { if (!zs.rafOn) return; if (zs.frames.length < 5000) zs.frames.push({ t: performance.now(), bounce: !!o.bounceState }); requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
		zs.restore = () => { o.paintCommittedWork = orig; o.runExtentPiece = origPiece; zs.rafOn = false; };
	},
	unwatch() { zs.restore?.(); zs.restore = null; },
	reallocs() { return { all: canvasReallocs, ink: inkCanvasReallocs }; },
	/**
	 * A two-finger pinch from the current scale by `ratio`, about the pane centre, in `steps` animation frames, then the lift. Returns
	 * the backing writes during the live frames and in the lift's own task, and the time the lift's task took.
	 */
	async pinch(ratio: number, steps: number) {
		const o: any = overlayForPath(PATH), r = o.view.scrollDOM.getBoundingClientRect();
		const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		zs.paints.length = 0; zs.fates.length = 0; zs.pieceRuns.length = 0; zs.frames.length = 0;
		const r0 = canvasReallocs;
		o.pinch("start", 1, c);
		for (let i = 1; i <= steps; i++) { await frame(); o.pinch("move", Math.pow(ratio, i / steps), c); }
		await frame();
		const live = canvasReallocs - r0;
		const r1 = canvasReallocs, t0 = performance.now();
		zs.task = 1;
		try { o.pinch("end", ratio, c); } finally { zs.task = 0; }
		const liftMs = performance.now() - t0;
		return { live, liftWrites: canvasReallocs - r1, liftMs, t0, scale: o.pinchScaleNow, cssScale: o.cssScale };
	},
	/** A zoom commit as the zoom bar makes one (zoomAroundCenter). Same readout as pinch. */
	commit(next: number) {
		const o: any = overlayForPath(PATH);
		zs.paints.length = 0; zs.fates.length = 0; zs.pieceRuns.length = 0; zs.frames.length = 0;
		const r1 = canvasReallocs, t0 = performance.now();
		zs.task = 1;
		let ok = false;
		try { ok = !!o.zoomAroundCenter(next); } finally { zs.task = 0; }
		return { ok, live: 0, liftWrites: canvasReallocs - r1, liftMs: performance.now() - t0, t0, scale: o.pinchScaleNow, cssScale: o.cssScale };
	},
	/**
	 * Wait until the settle is quiet: no whole paint for `quietMs`, no build pending and no stand-in held (or `limitMs`). Returns the
	 * whole paints since the gesture, the long tasks that started after `t0`, and when the crisp layer was whole (the last whole paint's
	 * end, or the raster's hand-over when a stand-in showed).
	 */
	async settled(t0: number, quietMs = 600, limitMs = 15_000) {
		const o: any = overlayForPath(PATH), start = performance.now();
		let sharpAt = -1, sawBounce = zs.paints.some((p: Paint) => p.bounce);
		for (;;) {
			await new Promise(r => setTimeout(r, 20));
			if (o.bounceState) sawBounce = true;
			const last = zs.paints.length ? zs.paints[zs.paints.length - 1].t0 + zs.paints[zs.paints.length - 1].ms : t0;
			if (sharpAt < 0 && !o.standIn && !o.extentBuild) sharpAt = performance.now();
			if (o.standIn || o.extentBuild) sharpAt = -1;
			if ((performance.now() - last >= quietMs && !o.standIn && !o.extentBuild) || performance.now() - start > limitMs) break;
		}
		const paints = zs.paints.map((p: Paint) => ({ ...p, at: p.t0 - t0 }));
		const tasks = zs.tasks.filter((t: any) => t.start + t.ms >= t0).map((t: any) => ({ at: t.start - t0, ms: t.ms }));
		const lastEnd = paints.length ? Math.max(...paints.map((p: any) => p.at + p.ms)) : 0;
		return { paints, tasks, longest: tasks.length ? Math.max(...tasks.map((t: any) => t.ms)) : 0, lastPaintEnd: lastEnd,
			fates: zs.fates.map((f: any) => ({ ...f, at: Math.round(f.at - t0), allowed: { ...f.allowed, scrollQuiet: Math.round(f.allowed.scrollQuiet) } })),
			pieceRuns: zs.pieceRuns.filter((r: any) => r.t0 >= t0).map((r: any) => ({ at: r.t0 - t0, ms: r.ms, drew: r.drew, bounce: r.bounce })),
			// Pieces run between each two consecutive frames that both had a bounce playing.
			perBounceFrame: zs.frames.filter((f: any) => f.t >= t0).map((f: any, i: number, a: any[]) => i > 0 && a[i - 1].bounce && f.bounce
				? zs.pieceRuns.filter((r: any) => r.t0 >= a[i - 1].t && r.t0 < f.t).length : null).filter((n: any) => n !== null),
			bounceEndAt: (() => { const fs = zs.frames.filter((f: any) => f.t >= t0), last = [...fs].reverse().find((f: any) => f.bounce); return last ? last.t - t0 : -1; })(),
			bounceGaps: zs.frames.filter((f: any) => f.t >= t0).map((f: any, i: number, a: any[]) => i > 0 && a[i - 1].bounce && f.bounce ? f.t - a[i - 1].t : null).filter((g: any) => g !== null),
			sharpAt: sharpAt < 0 ? -1 : sharpAt - t0, sawBounce, held: !!o.standIn, building: !!o.extentBuild, timedOut: performance.now() - start > limitMs };
	},
	clearTasks() { zs.tasks.length = 0; },
};
