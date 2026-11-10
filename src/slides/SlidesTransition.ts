/**
 * The slides surface's slide-change follow: between a slide change and the new slide's arrival, each slide's committed
 * and highlight ink moves with its own section. They are methods of SlidesDeck, installed on its prototype when
 * SlidesInkSurface.ts loads.
 *
 * The ink layers hang on `.reveal`, not inside a section (SlidesMount.ts `mountCanvases`), so Reveal's transition never
 * reaches them. Before this file the layers were repainted for the new slide the moment the change was seen, which is
 * before Reveal moves anything: the incoming slide's ink sat over the outgoing slide's text, and stood still while both
 * slides moved.
 *
 * At rest nothing here runs. At a change the main pair (committed and highlight) still holds the outgoing slide's ink;
 * one more pair, the same size and place, gets the incoming slide's ink drawn ONCE at the rest camera. Each frame both
 * sections are read - the translation and opacity Reveal's transition has them at - and each pair is given its own
 * section's: one computed-style read per section and two style writes per canvas, no stroke drawn again. When the
 * incoming slide is within LAND_SLOP_PX of rest the extra pair goes and the main pair is repainted once, plainly, for
 * the present slide; the incoming copy was drawn by the same code at the same camera, so the swap moves nothing.
 *
 * A transition that is not a pure translation (convex, concave, zoom, cube, page) cannot be followed by moving a flat
 * layer: the committed ink is hidden until the slide lands. So is it when the browser refuses the extra pair. Reveal's
 * config and API are never read: the transition is told from the sections' computed style only, which also sees a
 * per-slide `data-transition`.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { drawStroke } from "../ink/StrokeRenderer";
import { installMethods } from "../inline/InstallMethods";
import { log, type SlidesDeck } from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		startFollow(from: number, to: number): boolean;
		followPair(index: number): FollowPair | null;
		followFrame(fromTransitionEnd?: boolean): void;
		landFollow(): void;
		cancelFollow(): void;
	}
}

/** Reveal's slowest speed is 1.2 s. Past this the follow lands whatever the sections say. */
export const FOLLOW_TIMEOUT_MS = 1500;
/** The swap to the plain repaint happens only this close to rest, css px. */
export const LAND_SLOP_PX = 0.5;
/** And only this close to fully opaque. */
const LAND_OPACITY_SLOP = 0.01;
/** Matrix terms closer than this to identity count as identity. */
const MATRIX_EPS = 1e-4;

export const FOLLOW_COMMITTED_CLASS = "handwriting-slides-ink-follow";
export const FOLLOW_HIGHLIGHT_CLASS = "handwriting-slides-highlight-follow";

/** Where a section is against its rest place, in screen px, and how opaque. */
export interface SectionPose {
	dx: number;
	dy: number;
	opacity: number;
	/** The section's transform is a translation and nothing else. */
	pure: boolean;
}

/** A committed canvas and a highlight canvas that move as one. */
export interface FollowPair {
	committed: HTMLCanvasElement;
	highlight: HTMLCanvasElement;
}

export interface SlidesFollow {
	out: HTMLElement;
	inc: HTMLElement;
	/** The main pair, holding the outgoing slide's ink. */
	main: FollowPair;
	/** The incoming slide's ink; null in hide mode. */
	extra: FollowPair | null;
	/** "translate": each pair follows its section. "hide": the committed ink is hidden until the land. */
	mode: "translate" | "hide";
	frame: number | null;
	timer: number | null;
	/** Frames running with the incoming slide within the land slop. */
	settled: number;
	onEnd: (ev: Event) => void;
}

type MatrixCtor = new (init?: string) => DOMMatrixReadOnly;

/**
 * A section's pose, from its computed transform and opacity. The rest place is the untransformed one, so the
 * transform's translation IS the offset; `k` takes it from the deck's layout px to screen px.
 */
export function sectionPose(section: HTMLElement, k: number, win: Window): SectionPose {
	const cs = win.getComputedStyle(section);
	const parsed = Number.parseFloat(cs.opacity);
	const opacity = Number.isFinite(parsed) ? parsed : 1;
	const Matrix = (win as unknown as { DOMMatrixReadOnly?: MatrixCtor }).DOMMatrixReadOnly;
	if (!Matrix) return { dx: 0, dy: 0, opacity, pure: false };
	const m = new Matrix(cs.transform && cs.transform !== "none" ? cs.transform : undefined);
	const near = (v: number, to: number) => Math.abs(v - to) < MATRIX_EPS;
	const pure =
		near(m.m11, 1) && near(m.m12, 0) && near(m.m21, 0) && near(m.m22, 1) &&
		(m.is2D || (near(m.m13, 0) && near(m.m14, 0) && near(m.m23, 0) && near(m.m24, 0) && near(m.m31, 0) &&
			near(m.m32, 0) && near(m.m33, 1) && near(m.m34, 0) && near(m.m43, 0) && near(m.m44, 1)));
	return { dx: m.m41 * k, dy: m.m42 * k, opacity, pure };
}

/** Close enough to rest for the swap to move nothing. */
function nearRest(p: SectionPose): boolean {
	return p.pure && Math.abs(p.dx) <= LAND_SLOP_PX && Math.abs(p.dy) <= LAND_SLOP_PX && p.opacity >= 1 - LAND_OPACITY_SLOP;
}

function atRest(p: SectionPose): boolean {
	return p.pure && p.dx === 0 && p.dy === 0 && p.opacity >= 1;
}

function place(pair: FollowPair, p: SectionPose): void {
	const transform = `translate(${p.dx}px, ${p.dy}px)`;
	const opacity = String(p.opacity);
	for (const c of [pair.committed, pair.highlight]) {
		c.style.transform = transform;
		c.style.opacity = opacity;
	}
}

	/**
	 * Begin following a change from slide `from` to slide `to`, `l.index` already `to`. False when there is nothing to
	 * follow: no transition (`none`, or a change already landed), or no sections to read; the caller then repaints as
	 * it always has.
	 */
	function startFollow(this: SlidesDeck, from: number, to: number): boolean {
		const l = this.layers;
		if (!l || from < 0 || this.follow) return false;
		const sections = this.sections();
		const out = sections[from];
		const inc = sections[to];
		if (!out || !inc) return false;
		const win = this.win();
		// A window that cannot say where a section is, or cannot run a frame loop, keeps today's plain repaint.
		if (
			!(win as unknown as { DOMMatrixReadOnly?: MatrixCtor }).DOMMatrixReadOnly ||
			typeof win.getComputedStyle !== "function" ||
			typeof win.requestAnimationFrame !== "function"
		) {
			return false;
		}
		const k = this.geometry().k;
		const pin = sectionPose(inc, k, win);
		if (atRest(pin)) return false;
		const pout = sectionPose(out, k, win);
		const extra = pin.pure && pout.pure ? this.followPair(to) : null;
		const follow: SlidesFollow = {
			out,
			inc,
			main: { committed: l.committed, highlight: l.highlight },
			extra,
			mode: extra ? "translate" : "hide",
			frame: null,
			timer: null,
			settled: 0,
			onEnd: (ev: Event) => {
				if (ev.target === inc) this.followFrame(true);
			},
		};
		inc.addEventListener("transitionend", follow.onEnd);
		follow.timer = win.setTimeout(() => this.landFollow(), this.followTimeoutMs);
		this.follow = follow;
		if (diagnosticsEnabled()) {
			log(`slide change ${from} -> ${to}: following (${follow.mode}${pin.pure && pout.pure && !extra ? ", extra pair refused" : ""})`);
		}
		// The first write now, before the browser paints the change: the main pair is still at rest on the outgoing
		// slide's ink, and the incoming pair is drawn at rest, so both must take their sections' poses this frame.
		this.followFrame();
		return true;
	}

	/**
	 * The incoming slide's committed and highlight ink, drawn once at the rest camera into a new pair the size and place
	 * of the main one. The highlight canvas goes inside the one translucent group, so both slides' highlights are one
	 * composite. Null when the browser refuses a 2d context (WebKit past its store budget): the follow then hides.
	 */
	function followPair(this: SlidesDeck, index: number): FollowPair | null {
		const l = this.layers;
		if (!l) return null;
		// Built on the viewport as SlidesMount builds the main layers, so a popout window's deck makes its canvases in
		// its own document; `after()` below moves each beside the layer it shadows.
		const make = (cls: string, like: HTMLCanvasElement): HTMLCanvasElement => {
			const canvas = this.revealEl.createEl("canvas", { cls });
			Object.assign(canvas.style, {
				position: "absolute",
				left: "0",
				top: "0",
				pointerEvents: "none",
				zIndex: like.style.zIndex,
				width: like.style.width,
				height: like.style.height,
			} as Partial<CSSStyleDeclaration>);
			canvas.width = like.width;
			canvas.height = like.height;
			return canvas;
		};
		const committed = make(FOLLOW_COMMITTED_CLASS, l.committed);
		const highlight = make(FOLLOW_HIGHLIGHT_CLASS, l.highlight);
		const ctx = committed.getContext("2d");
		const highlightCtx = highlight.getContext("2d");
		if (!ctx || !highlightCtx) {
			// They are already in the viewport: a refused pair must not be left behind in it.
			committed.remove();
			highlight.remove();
			log("follow pair refused a 2d context; the slide's ink is hidden until it lands");
			return null;
		}
		try {
			ctx.setTransform(l.ctx.getTransform());
			highlightCtx.setTransform(l.highlightCtx.getTransform());
			const cam = this.geometry().camera;
			for (const s of this.strokes.get(index) ?? []) {
				drawStroke(s.tool === "highlighter" ? highlightCtx : ctx, cam, s, undefined, true);
			}
		} catch (err) {
			// A throw here would escape the slide change before its refresh; a failed pair is a refused one instead,
			// so the follow hides and the land repaints the arrived slide's own ink.
			committed.remove();
			highlight.remove();
			log(`follow pair draw failed (${String(err)}); the slide's ink is hidden until it lands`);
			return null;
		}
		l.committed.after(committed);
		l.highlight.after(highlight);
		return { committed, highlight };
	}

	/**
	 * One frame of the follow: read both sections, give each pair its section's pose, land once the incoming slide has
	 * arrived. A section that stops being a pure translation turns the follow to hide for the rest of the change.
	 */
	function followFrame(this: SlidesDeck, fromTransitionEnd = false): void {
		const f = this.follow;
		if (!f) return;
		const win = this.win();
		if (f.frame !== null) win.cancelAnimationFrame(f.frame);
		f.frame = null;
		const k = this.geometry().k;
		const pin = sectionPose(f.inc, k, win);
		const pout = sectionPose(f.out, k, win);
		if (f.mode === "translate" && !(pin.pure && pout.pure)) {
			f.extra?.committed.remove();
			f.extra?.highlight.remove();
			f.extra = null;
			f.mode = "hide";
		}
		if (f.mode === "translate" && f.extra) {
			place(f.main, pout);
			place(f.extra, pin);
		} else {
			for (const c of [f.main.committed, f.main.highlight]) c.setCssStyles({ visibility: "hidden" });
		}
		f.settled = nearRest(pin) ? f.settled + 1 : 0;
		if (atRest(pin) || f.settled >= 2 || (fromTransitionEnd && f.settled > 0)) {
			this.landFollow();
			return;
		}
		f.frame = win.requestAnimationFrame(() => this.followFrame());
	}

	/** The slide has arrived (or the timeout ran out): the plain repaint of the present slide, at rest. */
	function landFollow(this: SlidesDeck): void {
		if (!this.follow) return;
		this.cancelFollow();
		this.repaint();
	}

	/**
	 * End the follow and leave the layers as a plain repaint expects them: no extra pair, no transform, no opacity, no
	 * hidden layer. Paints nothing; every caller repaints, or is dispose.
	 */
	function cancelFollow(this: SlidesDeck): void {
		const f = this.follow;
		if (!f) return;
		this.follow = null;
		const win = this.win();
		if (f.frame !== null) win.cancelAnimationFrame(f.frame);
		if (f.timer !== null) win.clearTimeout(f.timer);
		f.inc.removeEventListener("transitionend", f.onEnd);
		f.extra?.committed.remove();
		f.extra?.highlight.remove();
		for (const c of [f.main.committed, f.main.highlight]) {
			c.style.removeProperty("transform");
			c.style.removeProperty("opacity");
			c.style.removeProperty("visibility");
		}
	}

export function installSlidesTransition(proto: SlidesDeck): void {
	installMethods(proto, {
		startFollow,
		followPair,
		followFrame,
		landFollow,
		cancelFollow,
	});
}
