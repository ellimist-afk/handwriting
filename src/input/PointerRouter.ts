import { Camera } from "../camera/Camera";
import { Point } from "../camera/coordinates";
import { telemetry } from "../diag/Telemetry";
import { PalmGate } from "./PalmGate";

/**
 * Routes every PointerEvent that reaches the Handwriting canvas root to the right
 * behavior, by device (handoff §13, §53):
 *
 *   Pen    -> ink
 *   Touch  -> navigation (pan / pinch)
 *   Mouse  -> navigation (wheel pan, ctrl+wheel zoom, middle-drag and
 *             space+drag pan)
 *
 * Everything is scoped to the view's root element: no document-level
 * listeners (§40/§82). Screen coordinates handed to callbacks are CSS pixels
 * relative to the canvas root.
 */

export interface PenSample {
	x: number;
	y: number;
	pressure: number;
	timestamp: number;
	tiltX: number;
	tiltY: number;
}

export interface PointerStatus {
	pointerType: string;
	buttons: number;
	pressure: number;
	tiltX: number;
	tiltY: number;
	penStrokeActive: boolean;
	activeTouches: number;
	blockedTouches: number;
}

export interface RouterCallbacks {
	/** Pen contact began. `sample` is root-relative screen space. */
	onPenDown(sample: PenSample, ev: PointerEvent): void;
	/**
	 * Coalesced pen samples during a stroke, oldest first. When the view has
	 * set `deliverMoveSamples = false` (raw-update pipeline), `samples` is
	 * empty and only `coalescedCount` is meaningful. Building the sample
	 * array 60 to 90 times a second is pure main-thread cost when nothing consumes it.
	 */
	onPenMove(samples: PenSample[], ev: PointerEvent, coalescedCount: number): void;
	/** Pen lifted (or capture lost). */
	onPenUp(ev: PointerEvent): void;
	/** Live device telemetry for the HUD. */
	onStatus(status: PointerStatus): void;
	/**
	 * Coalesced pen samples from `pointerrawupdate`, oldest first. Fires at
	 * input rate (200 to 250 Hz on the test Surface) instead of rAF rate. Optional: only
	 * subscribed when the view wants the raw pipeline. When subscribed, the
	 * view is responsible for ignoring the same samples arriving again via
	 * onPenMove (they will).
	 */
	onPenRaw?: (samples: PenSample[], ev: PointerEvent, predicted: PenSample[]) => void;
	/**
	 * A deliberate tap that moved almost nothing: mouse left-click, or a single
	 * finger touched and lifted. This is how the canvas gets "click here and
	 * type" (§13) without touch ever creating ink. Coordinates are root-relative
	 * CSS pixels.
	 */
	onTap?(x: number, y: number, source: "mouse" | "touch", ev: PointerEvent): void;
}

interface TapCandidate {
	x: number;
	y: number;
	at: number;
	source: "mouse" | "touch";
}

const TAP_MAX_MOVE_PX = 8;
const TAP_MAX_MS = 500;

interface TouchState {
	x: number;
	y: number;
}

const EMPTY_SAMPLES: PenSample[] = [];

/**
 * Is the user editing text right now? The canvas must not steal keys when they
 * are.
 *
 * Deliberately a question about editing CONTEXT, not about one element type.
 * `isContentEditable` is inherited, so it covers a CodeMirror instance and
 * anything nested inside it, which is what §16 will eventually put in a text
 * container. And the focused element is checked as well as the event target,
 * because a key event can be retargeted while focus sits in a field.
 */
function isTextEditingContext(target: EventTarget | null): boolean {
	const looksEditable = (el: Element | null): boolean => {
		const h = el as HTMLElement | null;
		if (!h || typeof h.tagName !== "string") return false;
		return (
			h.isContentEditable === true ||
			h.tagName === "TEXTAREA" ||
			h.tagName === "INPUT" ||
			h.tagName === "SELECT" ||
			h.closest?.(".cm-editor, .handwriting-box-editor") != null
		);
	};
	return looksEditable(target as Element | null) || looksEditable(document.activeElement);
}

/**
 * A pen sample that claims a live stroke but is already hovering: zero
 * pressure and neither contact bit set (tip = 1, eraser = 32). The side button
 * bit (2) is ignored because it can be held through a lift.
 *
 * The Surface Slim Pen can lift without a discrete pointerup ever reaching
 * the app; the raw stream simply resumes hovering under the same pointerId,
 * and every hover sample would become trailing ink. The Surface Pen (1776)
 * always delivers the event, so this never fires for it. Both contact bits
 * and pressure must read zero together, which is exactly the hover
 * signature; a mid-stroke pressure dip still carries the tip bit and a
 * buttons glitch still carries pressure, so neither ends a real stroke.
 */
export function silentLift(sample: { pressure: number; buttons: number }): boolean {
	return sample.pressure === 0 && (sample.buttons & 1) === 0 && (sample.buttons & 32) === 0;
}

const WHEEL_LINE_HEIGHT = 16;
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

export class PointerRouter {
	private root: HTMLElement;
	private camera: Camera;
	private gate = new PalmGate();
	private callbacks: RouterCallbacks;

	private rect: DOMRect;
	private activePenId: number | null = null;
	private touches = new Map<number, TouchState>();
	private ignoredTouchIds = new Set<number>();
	private panPointerId: number | null = null;
	private panLast: Point | null = null;
	private spaceHeld = false;

	private disposers: Array<() => void> = [];

	/** Set false when ink comes from pointerrawupdate: skips per-move sample building. */
	deliverMoveSamples = true;
	/** Set true only while the prediction experiment wants Chromium's predicted events. */
	wantPredicted = false;

	// Instrumentation counters (read by the view's metrics panel).
	penDowns = 0;
	penUps = 0;
	/** Stroke ends that only the window-level backstop caught. */
	fallbackEnds = 0;
	/** Stroke ends synthesized from a hover sample (no pointerup arrived). */
	silentLiftEnds = 0;

	private winEndFn: ((e: Event) => void) | null = null;
	private tapCandidates = new Map<number, TapCandidate>();

	constructor(root: HTMLElement, camera: Camera, callbacks: RouterCallbacks) {
		this.root = root;
		this.camera = camera;
		this.callbacks = callbacks;
		this.rect = root.getBoundingClientRect();

		const on = <K extends keyof HTMLElementEventMap>(
			type: K,
			fn: (ev: HTMLElementEventMap[K]) => void,
			options?: AddEventListenerOptions
		) => {
			root.addEventListener(type, fn as EventListener, options);
			this.disposers.push(() => root.removeEventListener(type, fn as EventListener, options));
		};

		on("pointerdown", (e) => this.pointerDown(e));
		on("pointermove", (e) => this.pointerMove(e));
		// pointerrawupdate is Chromium-only and missing from the TS DOM lib.
		{
			const rawFn = (ev: Event) => this.pointerRawUpdate(ev as PointerEvent);
			root.addEventListener("pointerrawupdate", rawFn);
			this.disposers.push(() =>
				root.removeEventListener("pointerrawupdate", rawFn)
			);
		}
		on("pointerup", (e) => this.pointerUp(e));
		on("pointercancel", (e) => this.pointerUp(e));
		on("pointerleave", (e) => this.pointerLeave(e));
		on("lostpointercapture", (e) => this.lostCapture(e));
		on("wheel", (e) => this.wheel(e), { passive: false });
		on("keydown", (e) => this.key(e, true));
		on("keyup", (e) => this.key(e, false));
		// Never let the browser interpret gestures on the canvas.
		on("contextmenu", (e) => e.preventDefault());
	}

	dispose(): void {
		for (const d of this.disposers) d();
		this.disposers = [];
		this.disarmEndBackstop();
	}

	/** Call when the view resizes or moves so screen math stays correct. */
	refreshRect(): void {
		this.rect = this.root.getBoundingClientRect();
	}

	// ---- coordinate helpers -------------------------------------------------

	private toLocal(clientX: number, clientY: number): Point {
		return { x: clientX - this.rect.left, y: clientY - this.rect.top };
	}

	private sampleFrom(e: PointerEvent): PenSample {
		const p = this.toLocal(e.clientX, e.clientY);
		return {
			x: p.x,
			y: p.y,
			pressure: e.pressure > 0 ? e.pressure : e.pointerType === "pen" ? 0 : 0.5,
			timestamp: e.timeStamp,
			tiltX: e.tiltX,
			tiltY: e.tiltY,
		};
	}

	private emitStatus(e?: PointerEvent): void {
		this.callbacks.onStatus({
			pointerType: e?.pointerType ?? "",
			buttons: e?.buttons ?? 0,
			pressure: e?.pressure ?? 0,
			tiltX: e?.tiltX ?? 0,
			tiltY: e?.tiltY ?? 0,
			penStrokeActive: this.activePenId !== null,
			activeTouches: this.touches.size,
			blockedTouches: this.ignoredTouchIds.size,
		});
	}

	// ---- pointerdown --------------------------------------------------------

	private pointerDown(e: PointerEvent): void {
		// UI chrome (toolbar) lives inside the routed root; a pen or finger
		// landing on a button must click it, not start a stroke or steal
		// capture. Without this, mode switches are unusable by pen/touch.
		const target = e.target as HTMLElement | null;
		if (target?.closest?.(".handwriting-ui")) return;

		this.refreshRect();
		switch (e.pointerType) {
			case "pen":
				this.penDown(e);
				break;
			case "touch":
				this.touchDown(e);
				break;
			default:
				this.mouseDown(e);
				break;
		}
		this.emitStatus(e);
	}

	private penDown(e: PointerEvent): void {
		if (this.activePenId !== null) return; // one pen at a time
		e.preventDefault();
		this.activePenId = e.pointerId;
		this.penDowns++;
		telemetry.bump("router.penDown");
		this.armEndBackstop();
		this.gate.penStrokeStarted();
		// A pen arriving cancels any in-flight touch navigation: the palm may
		// already be resting on the glass.
		this.dropTouchGesture();
		try {
			this.root.setPointerCapture(e.pointerId);
		} catch {
			/* capture is best-effort; diagnostics will tell us if it fails */
		}
		this.callbacks.onPenDown(this.sampleFrom(e), e);
	}

	private touchDown(e: PointerEvent): void {
		const now = performance.now();
		if (this.gate.blocksNewTouch(now)) {
			this.ignoredTouchIds.add(e.pointerId);
			return;
		}
		const p = this.toLocal(e.clientX, e.clientY);
		// A tap is only a tap if it is the only finger down.
		if (this.touches.size === 0) {
			this.tapCandidates.set(e.pointerId, {
				x: p.x,
				y: p.y,
				at: performance.now(),
				source: "touch",
			});
		} else {
			this.tapCandidates.clear();
		}
		this.touches.set(e.pointerId, { x: p.x, y: p.y });
		try {
			this.root.setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
	}

	private mouseDown(e: PointerEvent): void {
		const isMiddle = e.button === 1;
		const isSpacePan = e.button === 0 && this.spaceHeld;
		if (isMiddle || isSpacePan) {
			e.preventDefault();
			this.panPointerId = e.pointerId;
			this.panLast = this.toLocal(e.clientX, e.clientY);
			try {
				this.root.setPointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
		}
		if (e.button === 0 && !this.spaceHeld) {
			const p = this.toLocal(e.clientX, e.clientY);
			this.tapCandidates.set(e.pointerId, {
				x: p.x,
				y: p.y,
				at: performance.now(),
				source: "mouse",
			});
		}
	}

	/** Fire onTap if this pointer went down and up in nearly the same place. */
	private resolveTap(e: PointerEvent): void {
		const cand = this.tapCandidates.get(e.pointerId);
		if (!cand) return;
		this.tapCandidates.delete(e.pointerId);
		const p = this.toLocal(e.clientX, e.clientY);
		const moved = Math.hypot(p.x - cand.x, p.y - cand.y);
		if (moved > TAP_MAX_MOVE_PX) return;
		if (performance.now() - cand.at > TAP_MAX_MS) return;
		// A pen in flight owns the surface; a stray finger must not place a caret.
		if (this.activePenId !== null) return;
		this.callbacks.onTap?.(cand.x, cand.y, cand.source, e);
	}

	// ---- pointermove --------------------------------------------------------

	private pointerMove(e: PointerEvent): void {
		switch (e.pointerType) {
			case "pen":
				this.penMove(e);
				break;
			case "touch":
				this.touchMove(e);
				break;
			default:
				this.mouseMove(e);
				break;
		}
		// While ink is flowing, status emission is pure overhead on the hot
		// path (an allocation + a callback per event, 60–90×/s) and the view
		// suppresses HUD writes anyway. pointerup re-emits.
		if (this.activePenId === null) this.emitStatus(e);
	}

	private penMove(e: PointerEvent): void {
		if (this.activePenId === null) {
			// Hovering: keeps the palm gate warm so a palm planted just
			// before the pen tip lands is rejected.
			this.gate.penHoverSeen(performance.now());
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.silentLiftEnds++;
			telemetry.bump("router.penUp.silentLift");
			this.endPenStroke(e, false);
			return;
		}
		e.preventDefault();
		telemetry.bump("router.penMove");
		const coalesced =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const count = coalesced.length > 0 ? coalesced.length : 1;
		if (!this.deliverMoveSamples) {
			this.callbacks.onPenMove(EMPTY_SAMPLES, e, count);
			return;
		}
		const events = coalesced.length > 0 ? coalesced : [e];
		this.callbacks.onPenMove(events.map((ce) => this.sampleFrom(ce)), e, count);
	}

	/**
	 * Input-rate pen samples (Chromium `pointerrawupdate`). Forwarded only
	 * while a pen stroke is active and only if the view subscribed. Hover raw
	 * updates keep the palm gate warm just like hover moves do.
	 */
	private pointerRawUpdate(e: PointerEvent): void {
		if (e.pointerType !== "pen") return;
		if (this.activePenId === null) {
			this.gate.penHoverSeen(performance.now());
			return;
		}
		if (e.pointerId !== this.activePenId) return;
		if (silentLift(e)) {
			this.silentLiftEnds++;
			telemetry.bump("router.penUp.silentLift");
			this.endPenStroke(e, false);
			return;
		}
		const cb = this.callbacks.onPenRaw;
		if (!cb) return;
		telemetry.bump("router.rawUpdate");
		const coalesced =
			typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const events = coalesced.length > 0 ? coalesced : [e];
		const predicted = this.wantPredicted ? this.predictedFrom(e) : EMPTY_SAMPLES;
		cb(events.map((ce) => this.sampleFrom(ce)), e, predicted);
	}

	/**
	 * Chromium's own prediction, if this build has it. Reported once into
	 * telemetry so "the API exists" and "the API returned anything" are
	 * separately visible.
	 */
	private predictedFrom(e: PointerEvent): PenSample[] {
		const fn = (
			e as PointerEvent & { getPredictedEvents?: () => PointerEvent[] }
		).getPredictedEvents;
		if (typeof fn !== "function") {
			telemetry.bump("pred.apiMissing");
			return EMPTY_SAMPLES;
		}
		let events: PointerEvent[] = [];
		try {
			events = fn.call(e);
		} catch (err) {
			telemetry.fail("getPredictedEvents", err);
			return EMPTY_SAMPLES;
		}
		if (events.length === 0) {
			telemetry.bump("pred.apiEmpty");
			return EMPTY_SAMPLES;
		}
		telemetry.bump("pred.apiEvents", events.length);
		return events.map((pe) => this.sampleFrom(pe));
	}

	private touchMove(e: PointerEvent): void {
		const state = this.touches.get(e.pointerId);
		if (!state) return;
		const p = this.toLocal(e.clientX, e.clientY);

		if (this.touches.size === 1) {
			this.camera.panBy(p.x - state.x, p.y - state.y);
			state.x = p.x;
			state.y = p.y;
			return;
		}

		// Pinch: use the first two contacts.
		const ids = [...this.touches.keys()].slice(0, 2);
		if (!ids.includes(e.pointerId)) return; // extra fingers ignored
		const a = this.touches.get(ids[0]!)!;
		const b = this.touches.get(ids[1]!)!;
		const prevMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		const prevDist = Math.hypot(a.x - b.x, a.y - b.y);

		state.x = p.x;
		state.y = p.y;

		const a2 = this.touches.get(ids[0]!)!;
		const b2 = this.touches.get(ids[1]!)!;
		const nextMid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
		const nextDist = Math.hypot(a2.x - b2.x, a2.y - b2.y);

		this.camera.pinch(prevMid, prevDist, nextMid, nextDist);
	}

	private mouseMove(e: PointerEvent): void {
		if (this.panPointerId === e.pointerId && this.panLast) {
			const p = this.toLocal(e.clientX, e.clientY);
			this.camera.panBy(p.x - this.panLast.x, p.y - this.panLast.y);
			this.panLast = p;
		}
	}

	// ---- pointerup / cancel -------------------------------------------------

	/**
	 * Single funnel for ending a pen stroke, whatever delivered the end:
	 * pointerup, pointercancel, lostpointercapture, or the window backstop.
	 * Idempotent: only the first one through does anything.
	 */
	private endPenStroke(e: PointerEvent, viaFallback: boolean): void {
		if (this.activePenId === null || e.pointerId !== this.activePenId) return;
		this.activePenId = null;
		this.penUps++;
		telemetry.bump("router.penUp");
		if (viaFallback) {
			this.fallbackEnds++;
			telemetry.bump("router.penUp.backstop");
		}
		this.disarmEndBackstop();
		this.gate.penStrokeEnded(performance.now());
		this.callbacks.onPenUp(e);
	}

	/**
	 * Backstop for a stroke end that never reaches the root element. Armed
	 * only while a stroke is active, so this is not a standing document
	 * listener (§40/§82). It also tells us, via fallbackEnds, whether the
	 * root listeners are missing events, which is exactly the anomaly the
	 * diagnostics view turned up.
	 */
	private armEndBackstop(): void {
		this.disarmEndBackstop();
		const fn = (ev: Event) => {
			const pe = ev as PointerEvent;
			if (pe.pointerType !== "pen") return;
			this.endPenStroke(pe, true);
		};
		this.winEndFn = fn;
		window.addEventListener("pointerup", fn, { capture: true });
		window.addEventListener("pointercancel", fn, { capture: true });
	}

	private disarmEndBackstop(): void {
		if (!this.winEndFn) return;
		window.removeEventListener("pointerup", this.winEndFn, { capture: true });
		window.removeEventListener("pointercancel", this.winEndFn, { capture: true });
		this.winEndFn = null;
	}

	private pointerUp(e: PointerEvent): void {
		switch (e.pointerType) {
			case "pen":
				this.endPenStroke(e, false);
				break;
			case "touch":
				if (e.type === "pointerup") this.resolveTap(e);
				else this.tapCandidates.delete(e.pointerId);
				this.touches.delete(e.pointerId);
				this.ignoredTouchIds.delete(e.pointerId);
				// Re-anchor a remaining finger so the camera doesn't jump.
				if (this.touches.size === 1) {
					// nothing needed: pan uses per-pointer last positions
				}
				break;
			default:
				if (e.type === "pointerup") this.resolveTap(e);
				else this.tapCandidates.delete(e.pointerId);
				if (e.pointerId === this.panPointerId) {
					this.panPointerId = null;
					this.panLast = null;
				}
				break;
		}
		this.emitStatus(e);
	}

	private pointerLeave(e: PointerEvent): void {
		if (e.pointerType === "pen" && this.activePenId === null) {
			// Hover left the surface; the gate tail handles the rest.
			this.emitStatus(e);
		}
	}

	private lostCapture(e: PointerEvent): void {
		// Treat lost capture like pointerup for whichever role owned it
		// (§61: lost pointer capture, app loses focus mid-stroke).
		this.endPenStroke(e, false);
		this.touches.delete(e.pointerId);
		this.ignoredTouchIds.delete(e.pointerId);
		if (e.pointerId === this.panPointerId) {
			this.panPointerId = null;
			this.panLast = null;
		}
	}

	private dropTouchGesture(): void {
		for (const id of this.touches.keys()) this.ignoredTouchIds.add(id);
		this.touches.clear();
	}

	// ---- wheel / keys -------------------------------------------------------

	private wheel(e: WheelEvent): void {
		// Never navigate while ink is flowing.
		if (this.activePenId !== null) {
			e.preventDefault();
			return;
		}
		e.preventDefault();
		const scale = e.deltaMode === 1 ? WHEEL_LINE_HEIGHT : 1;
		const dx = e.deltaX * scale;
		const dy = e.deltaY * scale;
		if (e.ctrlKey) {
			// Ctrl+wheel zoom (also how Chromium reports pinch on precision
			// touchpads). Zoom around the cursor.
			const p = this.toLocal(e.clientX, e.clientY);
			const factor = Math.exp(-dy * ZOOM_WHEEL_SENSITIVITY);
			this.camera.zoomAt(p.x, p.y, this.camera.zoom * factor);
		} else if (e.shiftKey) {
			this.camera.panBy(-dy, -dx);
		} else {
			this.camera.panBy(-dx, -dy);
		}
	}

	private key(e: KeyboardEvent, down: boolean): void {
		// Space is the pan modifier, but a text container lives inside the
		// routed root, so its keystrokes bubble through here. Claiming Space
		// unconditionally swallowed every space bar press while typing,
		// which also turned "## Test" into "##Test" and lost the heading.
		if (isTextEditingContext(e.target)) return;
		if (e.code === "Space" && !e.repeat) {
			this.spaceHeld = down;
			if (down) e.preventDefault();
		}
	}
}
