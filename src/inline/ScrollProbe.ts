import { DIAG_OFF_NOTE, diagnosticsEnabled } from "../diag/DiagSwitch";
/**
 * Scroll/wheel probe: instrumentation for the touchpad-scroll dead zone.
 *
 * Reproduction facts this exists to explain (test Surface, 2026-08-20/21):
 *
 *   - Two-finger PRECISION-TOUCHPAD scrolling precedes the dead zone.
 *   - Touchscreen finger scrolling does NOT produce it.
 *   - While the dead zone is visible, pen acquisition is healthy: contacts
 *     are delivered, claimed, accepted. The loss is downstream of input.
 *
 * Touchpad scrolling reaches Chromium through the WHEEL pipeline; touch
 * scrolling through touch gestures. This probe records everything on the
 * wheel/scroll path and the state every stage of the render path read, so a
 * capture taken across "touchpad scroll → dead zone → strokes inside and
 * outside it" names the stage where the two scroll types diverge.
 *
 * Everything here is observation: passive listeners, no preventDefault, no
 * behavior. The ring is always on and cheap (small plain objects); the report
 * is built only when copied.
 *
 * What one capture holds, in one merged timeline:
 *
 *   wheel    every wheel event: deltaX/Y/mode, ctrlKey, and the scroller's
 *            scrollLeft/scrollTop AT the event. Nonzero deltaX, and any
 *            nonzero scrollLeft, is prime evidence: the wheel pipeline can
 *            pan the scroller horizontally (no axis lock), a finger cannot
 *            (touch scrolls axis-lock), and Handwriting's own extent spacer is what
 *            makes the scroller horizontally scrollable at all.
 *   scroll   every scroll event: position, per-event delta, and ages since
 *            the last wheel / last touch contact, which classifies the
 *            scroll as wheel-driven or touch-driven, including fling tails.
 *   sched    scheduleRepaint() requested (and from where).
 *   repaint  the repaint actually ran: how long after the request, and every
 *            geometry input it used: camera origin, documentTop,
 *            contentLeft, overlay rect, scale, scroll position.
 *   extent   the surface-extent spacer moved / the overflow-x axis guard
 *            fired. Handwriting-driven layout mutations during scrolling are
 *            suspects for compositor/anchoring side effects.
 *   pendown  pen acquisition: client + note coordinates, scroll position,
 *            overlay rect, canvas CSS/backing size, camera, spacer position,
 *            scrollWidth/Height vs client box.
 *   commit   the stroke entered the model: id, points, bbox, store count,
 *            and whether that bbox intersects the camera viewport at commit
 *            ("visible=NO on a stroke drawn under the nib" = the render path
 *            lost it, not the input path).
 */

interface WheelEntry {
	kind: "wheel";
	t: number;
	deltaX: number;
	deltaY: number;
	deltaMode: number;
	ctrlKey: boolean;
	scrollLeft: number;
	scrollTop: number;
	/** A pen stroke was ACTIVE when this wheel arrived: the danger case. */
	duringStroke: boolean;
}

interface ScrollEntry {
	kind: "scroll";
	t: number;
	scrollLeft: number;
	scrollTop: number;
	dLeft: number;
	dTop: number;
	sinceWheelMs: number;
	sinceTouchMs: number;
	/** The scroller moved WHILE a pen stroke was active (frame is locked). */
	duringStroke: boolean;
}

interface SchedEntry {
	kind: "sched";
	t: number;
	via: string;
}

interface RepaintEntry {
	kind: "repaint";
	t: number;
	waitedMs: number;
	camX: number;
	camY: number;
	documentTop: number;
	contentLeft: number;
	rectLeft: number;
	rectTop: number;
	scale: number;
	scrollLeft: number;
	scrollTop: number;
	strokesDrawn: number;
	/**
	 * frameLocked was set: a stroke owns the coordinate frame, syncCamera was
	 * skipped, and this repaint drew committed ink with the PEN-DOWN camera.
	 * driftX/Y = (what a fresh camera read would be) − (the locked camera):
	 * exactly how far the whole ink layer is displaced on screen, in note px,
	 * relative to the document that scrolled underneath it.
	 */
	locked: boolean;
	driftX: number;
	driftY: number;
}

interface ExtentEntry {
	kind: "extent";
	t: number;
	what: string;
}

interface PenDownEntry {
	kind: "pendown";
	t: number;
	/** How stale the wheel/touch pipelines were at acquisition. A pen-down
	 * inside a live inertia tail is the dead-zone danger window. */
	sinceWheelMs: number;
	sinceScrollMs: number;
	clientX: number;
	clientY: number;
	noteX: number;
	noteY: number;
	scrollLeft: number;
	scrollTop: number;
	rectLeft: number;
	rectTop: number;
	cssW: number;
	cssH: number;
	camX: number;
	camY: number;
	scale: number;
	spacerLeft: number;
	spacerTop: number;
	axisPatched: boolean;
	scrollWidth: number;
	scrollHeight: number;
	clientWidth: number;
	clientHeight: number;
}

interface CommitEntry {
	kind: "commit";
	t: number;
	strokeId: string;
	points: number;
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
	visible: boolean;
	storeCount: number;
	camX: number;
	camY: number;
	scrollLeft: number;
	scrollTop: number;
	/**
	 * (fresh camera − locked camera) at commit, note px. Nonzero means the
	 * scroller moved during this stroke: the stroke's coordinates are pinned
	 * to the PEN-DOWN frame, so at the next fresh repaint the ink will
	 * visibly jump by exactly this amount ("snap-back"), and its committed
	 * note position is offset from where the ink appeared under the nib.
	 */
	driftX: number;
	driftY: number;
	/** Scroll events that fired while this stroke was active. */
	scrollsDuring: number;
	/**
	 * Painted-pixel ground truth, sampled from the canvas backing stores over
	 * the stroke's screen-space bbox: wet layer just before it is cleared at
	 * pen-up, committed layer just after the direct commit draw. `visible`
	 * proves only bbox∩viewport; THESE prove actual paint. 0 with healthy
	 * input = accepted-but-unpainted; >0 while the user sees nothing =
	 * occlusion/compositing above the canvas. −1 = readback refused.
	 */
	wetPx: number;
	committedPx: number;
	/** Screen-space sample rect (CSS px, clamped to the canvas). */
	sampleW: number;
	sampleH: number;
	/** Fraction of the stroke's screen bbox falling OUTSIDE the canvas. */
	clippedPct: number;
	/** Top hit-testable element at the stroke's screen center at commit. */
	topEl: string;
}

type ProbeEntry =
	| WheelEntry
	| ScrollEntry
	| SchedEntry
	| RepaintEntry
	| ExtentEntry
	| PenDownEntry
	| CommitEntry;

const MAX_ENTRIES = 6000;
const entries: ProbeEntry[] = [];

let lastWheelAt = Number.NEGATIVE_INFINITY;
let lastTouchAt = Number.NEGATIVE_INFINITY;
let lastScrollLeft = 0;
let lastScrollTop = 0;
let pendingSchedAt: number | null = null;

function push(e: ProbeEntry): void {
	entries.push(e);
	if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function clearScrollProbe(): void {
	entries.length = 0;
	pendingSchedAt = null;
}

/** The router reports finger contacts so scrolls can be classified. */
export function scrollProbeTouch(): void {
	if (!diagnosticsEnabled()) return;
	lastTouchAt = performance.now();
}

export function scrollProbeWheel(
	e: WheelEvent,
	scrollLeft: number,
	scrollTop: number,
	duringStroke = false
): void {
	if (!diagnosticsEnabled()) return;
	lastWheelAt = performance.now();
	push({
		kind: "wheel",
		t: lastWheelAt,
		deltaX: e.deltaX,
		deltaY: e.deltaY,
		deltaMode: e.deltaMode,
		ctrlKey: e.ctrlKey,
		scrollLeft,
		scrollTop,
		duringStroke,
	});
}

let lastScrollAt = Number.NEGATIVE_INFINITY;

export function scrollProbeScroll(
	scrollLeft: number,
	scrollTop: number,
	duringStroke = false
): void {
	if (!diagnosticsEnabled()) return;
	const t = performance.now();
	push({
		kind: "scroll",
		t,
		scrollLeft,
		scrollTop,
		dLeft: scrollLeft - lastScrollLeft,
		dTop: scrollTop - lastScrollTop,
		sinceWheelMs: t - lastWheelAt,
		sinceTouchMs: t - lastTouchAt,
		duringStroke,
	});
	lastScrollLeft = scrollLeft;
	lastScrollTop = scrollTop;
	lastScrollAt = t;
}

export function scrollProbeSchedule(via: string): void {
	if (!diagnosticsEnabled()) return;
	const t = performance.now();
	if (pendingSchedAt === null) pendingSchedAt = t;
	push({ kind: "sched", t, via });
}

export function scrollProbeRepaint(g: {
	camX: number;
	camY: number;
	documentTop: number;
	contentLeft: number;
	rectLeft: number;
	rectTop: number;
	scale: number;
	scrollLeft: number;
	scrollTop: number;
	strokesDrawn: number;
	locked: boolean;
	driftX: number;
	driftY: number;
}): void {
	if (!diagnosticsEnabled()) return;
	const t = performance.now();
	push({
		kind: "repaint",
		t,
		waitedMs: pendingSchedAt === null ? 0 : t - pendingSchedAt,
		...g,
	});
	pendingSchedAt = null;
}

export function scrollProbeExtent(what: string): void {
	if (!diagnosticsEnabled()) return;
	push({ kind: "extent", t: performance.now(), what });
}

export function scrollProbePenDown(
	g: Omit<PenDownEntry, "kind" | "t" | "sinceWheelMs" | "sinceScrollMs">
): void {
	if (!diagnosticsEnabled()) return;
	const t = performance.now();
	push({
		kind: "pendown",
		t,
		sinceWheelMs: t - lastWheelAt,
		sinceScrollMs: t - lastScrollAt,
		...g,
	});
}

export function scrollProbeCommit(g: Omit<CommitEntry, "kind" | "t">): void {
	if (!diagnosticsEnabled()) return;
	push({ kind: "commit", t: performance.now(), ...g });
}


/** Pure, unit-tested: does this bbox intersect the camera viewport? */
export function bboxVisibleInViewport(
	bbox: { x: number; y: number; width: number; height: number },
	cam: { x: number; y: number },
	cssW: number,
	cssH: number
): boolean {
	return !(
		bbox.x > cam.x + cssW ||
		bbox.y > cam.y + cssH ||
		bbox.x + bbox.width < cam.x ||
		bbox.y + bbox.height < cam.y
	);
}

/** Pure, unit-tested: which input drove this scroll event? */
export function classifyScroll(sinceWheelMs: number, sinceTouchMs: number): string {
	const wheelFresh = sinceWheelMs < 200;
	const touchFresh = sinceTouchMs < 200;
	if (wheelFresh && (!touchFresh || sinceWheelMs <= sinceTouchMs)) return "wheel";
	if (touchFresh) return "touch";
	// Neither input is fresh: a fling tail from whichever came last, or a
	// programmatic scroll if neither ever fired.
	if (sinceWheelMs === Number.POSITIVE_INFINITY && sinceTouchMs === Number.POSITIVE_INFINITY) {
		return "program";
	}
	return sinceWheelMs <= sinceTouchMs ? "wheel-tail" : "touch-tail";
}

function fmtAge(ms: number): string {
	return Number.isFinite(ms) ? `${ms.toFixed(0)}ms` : "never";
}

export function formatScrollProbe(): string {
	if (entries.length === 0) {
		return diagnosticsEnabled()
			? "Handwriting scroll probe: no samples. Scroll (touchpad and touchscreen), draw, then copy again."
			: `Handwriting scroll probe: no samples. ${DIAG_OFF_NOTE}`;
	}

	// ---- summary ------------------------------------------------------------
	let wheels = 0;
	let wheelDx = 0;
	let wheelDxMax = 0;
	let wheelCtrl = 0;
	let scrolls = 0;
	let scrollsWheel = 0;
	let scrollsTouch = 0;
	let scrollLeftNonZero = 0;
	let maxAbsScrollLeft = 0;
	let repaints = 0;
	let repaintWaitMax = 0;
	let lockedRepaints = 0;
	let maxLockedDrift = 0;
	let scrollsDuringStroke = 0;
	let wheelsDuringStroke = 0;
	let extents = 0;
	let commits = 0;
	let commitsInvisible = 0;
	let commitsDrifted = 0;
	let commitsUnpainted = 0;
	let maxCommitDrift = 0;
	let downs = 0;
	for (const e of entries) {
		switch (e.kind) {
			case "wheel":
				wheels++;
				wheelDx += Math.abs(e.deltaX);
				if (Math.abs(e.deltaX) > wheelDxMax) wheelDxMax = Math.abs(e.deltaX);
				if (e.ctrlKey) wheelCtrl++;
				if (e.duringStroke) wheelsDuringStroke++;
				break;
			case "scroll": {
				scrolls++;
				const cls = classifyScroll(e.sinceWheelMs, e.sinceTouchMs);
				if (cls.startsWith("wheel")) scrollsWheel++;
				else if (cls.startsWith("touch")) scrollsTouch++;
				if (e.scrollLeft !== 0) scrollLeftNonZero++;
				if (Math.abs(e.scrollLeft) > maxAbsScrollLeft) {
					maxAbsScrollLeft = Math.abs(e.scrollLeft);
				}
				if (e.duringStroke) scrollsDuringStroke++;
				break;
			}
			case "repaint": {
				repaints++;
				if (e.waitedMs > repaintWaitMax) repaintWaitMax = e.waitedMs;
				if (e.locked) {
					lockedRepaints++;
					const d = Math.hypot(e.driftX, e.driftY);
					if (d > maxLockedDrift) maxLockedDrift = d;
				}
				break;
			}
			case "extent":
				extents++;
				break;
			case "pendown":
				downs++;
				break;
			case "commit": {
				commits++;
				if (!e.visible) commitsInvisible++;
				const d = Math.hypot(e.driftX, e.driftY);
				if (d > 0.5) commitsDrifted++;
				if (d > maxCommitDrift) maxCommitDrift = d;
				if (e.committedPx === 0 || e.wetPx === 0) commitsUnpainted++;
				break;
			}
		}
	}
	const lines: string[] = [
		`Handwriting scroll probe: ${entries.length} event(s)`,
		"",
		"SUMMARY",
		`  wheel events            : ${wheels}  (|deltaX| total ${wheelDx.toFixed(1)}, max ${wheelDxMax.toFixed(1)}, ctrl held on ${wheelCtrl})`,
		`  scroll events           : ${scrolls}  (wheel-driven ${scrollsWheel}, touch-driven ${scrollsTouch})`,
		`  scrollLeft ≠ 0          : ${scrollLeftNonZero} scroll event(s), max |scrollLeft| ${maxAbsScrollLeft}`,
		`     (the extent spacer makes the scroller horizontally scrollable;`,
		`      wheel input can pan that axis, an axis-locked finger cannot;`,
		`      nonzero here after touchpad-only scrolling is the divergence)`,
		`  repaints                : ${repaints}  (max request→run wait ${repaintWaitMax.toFixed(1)}ms)`,
		`  spacer/axis mutations   : ${extents}`,
		`  pen-downs / commits     : ${downs} / ${commits}`,
		`  commits NOT intersecting the viewport at commit time: ${commitsInvisible}` +
			(commitsInvisible > 0 ? "   *** accepted-but-invisible: render path ***" : ""),
		"",
		"STROKE-FRAME DESYNC (scroll while a pen stroke is active)",
		`  wheel / scroll events DURING an active stroke : ${wheelsDuringStroke} / ${scrollsDuringStroke}`,
		`  locked repaints (stroke frame frozen)         : ${lockedRepaints}, max ink-layer drift ${maxLockedDrift.toFixed(1)}px`,
		`  commits with frame drift > 0.5px              : ${commitsDrifted}, max ${maxCommitDrift.toFixed(1)}px` +
			(commitsDrifted > 0
				? "   *** stroke committed in a frame the scroller had left: visible snap-back ***"
				: ""),
		"",
		"PAINT GROUND TRUTH (pixel readback over each stroke's screen bbox)",
		`  commits with ZERO painted pixels (wet or committed): ${commitsUnpainted}` +
			(commitsUnpainted > 0
				? "   *** accepted-but-unpainted: the dead zone is at the canvas ***"
				: ""),
		"",
		"TIMELINE (newest last; wheel/scroll collapsed to every entry, ages vs last wheel/touch)",
	];

	// ---- timeline -----------------------------------------------------------
	const t0 = entries[0]!.t;
	for (const e of entries) {
		const at = (e.t - t0).toFixed(1).padStart(9);
		switch (e.kind) {
			case "wheel":
				lines.push(
					`${at}  wheel    dX=${e.deltaX.toFixed(2)} dY=${e.deltaY.toFixed(2)} mode=${e.deltaMode} ctrl=${e.ctrlKey ? 1 : 0}  scroll=(${e.scrollLeft},${e.scrollTop})` +
						(e.duringStroke ? "  *** DURING STROKE ***" : "")
				);
				break;
			case "scroll":
				lines.push(
					`${at}  scroll   (${e.scrollLeft},${e.scrollTop}) d=(${e.dLeft},${e.dTop})  src=${classifyScroll(e.sinceWheelMs, e.sinceTouchMs)} wheel ${fmtAge(e.sinceWheelMs)} touch ${fmtAge(e.sinceTouchMs)}` +
						(e.duringStroke ? "  *** DURING STROKE ***" : "")
				);
				break;
			case "sched":
				lines.push(`${at}  sched    repaint requested via ${e.via}`);
				break;
			case "repaint":
				lines.push(
					`${at}  repaint  +${e.waitedMs.toFixed(1)}ms  cam=(${e.camX.toFixed(2)},${e.camY.toFixed(2)}) docTop=${e.documentTop.toFixed(2)} contentLeft=${e.contentLeft.toFixed(2)} rect=(${e.rectLeft.toFixed(2)},${e.rectTop.toFixed(2)}) scale=${e.scale} scroll=(${e.scrollLeft},${e.scrollTop}) strokes=${e.strokesDrawn}` +
						(e.locked
							? `  LOCKED drift=(${e.driftX.toFixed(1)},${e.driftY.toFixed(1)})`
							: "")
				);
				break;
			case "extent":
				lines.push(`${at}  extent   ${e.what}`);
				break;
			case "pendown":
				lines.push(
					`${at}  PENDOWN  client(${e.clientX.toFixed(1)},${e.clientY.toFixed(1)}) note(${e.noteX.toFixed(1)},${e.noteY.toFixed(1)}) cam=(${e.camX.toFixed(2)},${e.camY.toFixed(2)}) scroll=(${e.scrollLeft},${e.scrollTop}) rect=(${e.rectLeft.toFixed(2)},${e.rectTop.toFixed(2)}) canvas=${e.cssW.toFixed(0)}x${e.cssH.toFixed(0)} scale=${e.scale} spacer=(${e.spacerLeft},${e.spacerTop}) axisPatched=${e.axisPatched} scrollWH=${e.scrollWidth}x${e.scrollHeight} clientWH=${e.clientWidth}x${e.clientHeight} lastWheel=${fmtAge(e.sinceWheelMs)} lastScroll=${fmtAge(e.sinceScrollMs)}`
				);
				break;
			case "commit":
				lines.push(
					`${at}  COMMIT   ${e.strokeId.slice(0, 8)} pts=${e.points} bbox=(${e.bboxX.toFixed(1)},${e.bboxY.toFixed(1)} ${e.bboxW.toFixed(1)}x${e.bboxH.toFixed(1)}) cam=(${e.camX.toFixed(2)},${e.camY.toFixed(2)}) scroll=(${e.scrollLeft},${e.scrollTop}) store=${e.storeCount}  visible=${e.visible ? "yes" : "NO ***"}` +
						`  drift=(${e.driftX.toFixed(1)},${e.driftY.toFixed(1)}) scrollsDuring=${e.scrollsDuring}` +
						(Math.hypot(e.driftX, e.driftY) > 0.5 ? "  *** FRAME DESYNC: ink will snap by this much ***" : "") +
						`  wetPx=${e.wetPx} commitPx=${e.committedPx} sample=${e.sampleW.toFixed(0)}x${e.sampleH.toFixed(0)} clipped=${(e.clippedPct * 100).toFixed(0)}% top=${e.topEl}` +
						(e.wetPx === 0 || e.committedPx === 0 ? "  *** UNPAINTED ***" : "")
				);
				break;
		}
	}
	return lines.join("\n");
}
