/**
 * The pen router's lifecycle trace and window delivery mirror, split out of InlinePenRouter.ts: the ring of pointer events,
 * the summary and capture, the window-capture mirror, and the registries of live routers the mirror and the clear read.
 *
 * InlinePenRouter.ts re-exports every exported name here, so each importer keeps its import line. Nothing comes back from
 * InlinePenRouter.ts at run time: the one name taken from it is a type, which the compiler erases, so the two modules form no cycle.
 */
import { describeEl } from "./PenHitProbe";
import { DIAG_OFF_NOTE, diagnosticsEnabled, diagnosticsEpoch } from "../diag/DiagSwitch";
import { analyzePointerDeliveryTrace, PointerDeliveryAnalysis, PointerTraceMeta, PointerTraceRole } from "./PointerDeliveryTrace";
import { captureUndoTrace, clearUndoTrace } from "../diag/UndoHistoryTrace";
import type { InlinePenRouter } from "./InlinePenRouter";

// ---- lifecycle trace -------------------------------------------------------
//
// Every pointer event the router sees goes into this ring, cheap enough to be
// always on (one small object per EVENT, not per coalesced sample; the hot
// path already allocates far more building the sample array). `Diagnostics:
// copy pen trace` dumps it. This exists because strokes on the test Surface
// terminated after a few centimetres. The trace tells us exactly which event
// ended the stream: a `pointercancel` (browser gesture takeover), a
// `lostpointercapture` without a cancel (someone stole capture), or a silent
// stop (delivery ceased).

/** One coalesced sample as the ink consumed it - floats, untouched. */
export interface TraceSample {
	t: number;
	x: number;
	y: number;
	p: number;
}

export interface TraceEntry {
	t: number;
	type: string;
	id: number;
	ptr: string;
	buttons: number;
	button: number;
	pressure: number;
	x: number;
	y: number;
	tx: number;
	ty: number;
	note: string;
	/**
	 * The coalesced list the ink path actually consumed, when there was
	 * one. NOT diagnostic decoration: the router expands this list into
	 * builder samples (see the RC4 comment at the raw handler), so a replay
	 * without it collapses an iPad's 4-per-move stream into single points.
	 */
	cs?: TraceSample[];
	eventId?: string;
	epoch?: number;
	role?: PointerTraceRole;
	sourceT?: number;
	observationT?: number;
	partial?: boolean;
	termination?: "silent-lift";
}

const TRACE_MAX = 3000;
const TRACE_STORAGE_MAX = 20000;
const trace: TraceEntry[] = [];
let traceStorageEntries = 0;
let traceEvictedRows = 0;
let traceEvictedSamples = 0;
let traceTruncated = false;
let tracePartialBatch = false;
let traceEventSeq = 0;
let traceEventIds = new WeakMap<object, string>();
let traceCopyPartial = false;
/**
 * Native events the ownership guard's window-capture listener has eaten
 * since the last trace clear. Module-level (like `trace` itself, not
 * per-router): a bug report merges every live router's trace into one
 * timeline, and this count rides along with it, printed in the SUMMARY and
 * reset exactly when `clearInlinePenTrace()` starts a new recording.
 */
let suppressedNative = 0;

function traceRole(type: string, cs: TraceSample[] | undefined): PointerTraceRole {
	if (/^(pointerdown|pointerup|pointercancel|window-pointerdown)$/.test(type)) return "lifecycle";
	if (type === "pointermove" || type === "pointerrawupdate") return cs && cs.length > 0 ? "sample" : "sample";
	return "annotation";
}

function eventIdentity(e: PointerEvent | null): string {
	if (e && typeof e === "object") {
		const existing = traceEventIds.get(e);
		if (existing) return existing;
		const created = `${diagnosticsEpoch()}:${++traceEventSeq}`;
		traceEventIds.set(e, created);
		return created;
	}
	return `${diagnosticsEpoch()}:${++traceEventSeq}`;
}

export function traceSampleBudget(): number {
	return Math.max(0, TRACE_STORAGE_MAX - traceStorageEntries - 1);
}

export function tr(
	type: string,
	e: PointerEvent | null,
	note = "",
	cs?: TraceSample[],
	role?: PointerTraceRole,
	termination?: "silent-lift"
): void {
	if (!diagnosticsEnabled()) return;
	const observationT = performance.now();
	const budget = traceStorageEntries >= TRACE_STORAGE_MAX ? 0 : traceSampleBudget();
	let retained = cs;
	let partial = traceCopyPartial;
	if (retained && retained.length > budget) {
		retained = retained.slice(0, budget);
		partial = true;
	}
	traceCopyPartial = false;
	const cost = 1 + (retained?.length ?? 0);
	while (traceStorageEntries + cost > TRACE_STORAGE_MAX && trace.length > 0) {
		const removed = trace.shift()!;
		traceStorageEntries -= 1 + (removed.cs?.length ?? 0);
		traceEvictedRows++;
		traceEvictedSamples += removed.cs?.length ?? 0;
		traceTruncated = true;
	}
	if (traceStorageEntries + cost > TRACE_STORAGE_MAX) {
		traceTruncated = true;
		return;
	}
	const entry: TraceEntry = {
		t: observationT,
		type,
		id: e?.pointerId ?? -1,
		ptr: e?.pointerType ?? "",
		buttons: e?.buttons ?? -1,
		button: e?.button ?? -1,
		pressure: e?.pressure ?? -1,
		// Floats, deliberately: the ink path consumes the UNROUNDED values,
		// and a rounded trace made every replay lossy by half a pixel per
		// point. The human table rounds at FORMAT time instead.
		x: e ? e.clientX : 0,
		y: e ? e.clientY : 0,
		tx: e?.tiltX ?? 0,
		ty: e?.tiltY ?? 0,
		note,
		eventId: eventIdentity(e),
		epoch: diagnosticsEpoch(),
		role: role ?? traceRole(type, retained),
		sourceT: e?.timeStamp ?? -1,
		observationT,
		...(partial ? { partial: true } : {}),
		...(termination ? { termination } : {}),
		...(retained && retained.length > 0 ? { cs: retained } : {}),
	};
	trace.push(entry);
	traceStorageEntries += cost;
	if (partial) tracePartialBatch = true;
	while (traceStorageEntries > TRACE_STORAGE_MAX || trace.length > TRACE_MAX) {
		const removed = trace.shift();
		if (!removed) break;
		traceStorageEntries -= 1 + (removed.cs?.length ?? 0);
		traceEvictedRows++;
		traceEvictedSamples += removed.cs?.length ?? 0;
	}
}

/**
 * The guard's window rows only: an element's computed touch-action. The browser decides a native
 * touch by the value in force where the finger lands, and the inline style the guard writes does not
 * show it (a viewer's own stylesheet, or another plugin, can set it). Nothing is read while recording
 * is off; one getComputedStyle per call while it is on, and no caller is on the pen path.
 */
export function computedTouchActionNote(label: string, el: unknown): string {
	if (!diagnosticsEnabled()) return "";
	let value = "?";
	try {
		// The element's own window: a popout's elements are styled by the popout.
		const node = el as Element;
		const view = node.ownerDocument?.defaultView;
		value = (view ? view.getComputedStyle(node) : getComputedStyle(node)).touchAction || "?";
	} catch {
		// not an element here, or no style to read
	}
	return `; computed touch-action, ${label}: ${value}`;
}

/** The consumed coalesced list, as trace samples. */
export function csOf(events: ReadonlyArray<PointerEvent>): TraceSample[] {
	const limit = Math.min(events.length, traceSampleBudget());
	if (limit < events.length) traceCopyPartial = true;
	return events.slice(0, limit).map((ce) => ({ t: ce.timeStamp, x: ce.clientX, y: ce.clientY, p: ce.pressure }));
}

/** Pure, unit-tested: the acquisition-health counts the summary prints. */
export function summarizeAcquisitions(
	events: ReadonlyArray<{ type: string; note: string }>
): { delivered: number; claimed: number; ignored: number; cancelled: number; pressedHover: number } {
	let delivered = 0;
	let claimed = 0;
	let ignored = 0;
	let cancelled = 0;
	let pressedHover = 0;
	for (const e of events) {
		if (e.type === "window-pointerdown") delivered++;
		else if (e.type === "pointerdown" && e.note.includes("CLAIMED")) claimed++;
		else if (e.type === "pointerdown" && e.note.includes("IGNORED")) ignored++;
		else if (e.type === "pointercancel") cancelled++;
		else if (e.type === "pen-hover" && e.note.includes("PRESSED")) pressedHover++;
	}
	return { delivered, claimed, ignored, cancelled, pressedHover };
}

export function formatInlinePenTrace(): string {
	if (trace.length === 0) {
		return diagnosticsEnabled()
			? "Handwriting pen trace: empty"
			: `Handwriting pen trace: empty. ${DIAG_OFF_NOTE}`;
	}
	const t0 = trace[0]!.t;
	const lines = trace.map((e) => {
		const at = (e.t - t0).toFixed(1).padStart(8);
		return (
			`${at}ms  ${e.type.padEnd(18)} id=${e.id} ${e.ptr || "-"} ` +
			`buttons=${e.buttons} button=${e.button} p=${e.pressure.toFixed(3)} ` +
			`(${Math.round(e.x)},${Math.round(e.y)})${e.note ? "  " + e.note : ""}`
		);
	});
	const s = summarizeAcquisitions(trace);
	return [
		`Handwriting pen trace: ${trace.length} event(s)`,
		"",
		`SUMMARY: ${s.delivered} pen contact(s) delivered to the page, ${s.claimed} claimed, ${s.ignored} ignored, ${s.cancelled} cancelled, ${suppressedNative} native event(s) suppressed by the ownership guard.`,
		s.pressedHover > 0
			? `  *** ${s.pressedHover} hover sample(s) with the pen PRESSED and no pointerdown. Search "PRESSED BUT NO". ***`
			: "  No pressed-but-undelivered hover samples.",
		s.delivered === s.claimed && s.ignored === 0 && s.cancelled === 0 && s.pressedHover === 0
			? "  Every acquisition in this capture was healthy. No failure recorded."
			: "  At least one acquisition did not follow the healthy path.",
		"",
		"How to read an acquisition:",
		"  window-pointerdown  = the PAGE received the pen contact (window capture,",
		"                        before every other listener). Absent => the browser",
		"                        never delivered it.",
		"  pointerdown … CLAIMED   = the router received it and took it. guard=prearmed",
		"                        means hover had already pan-locked the scroller;",
		"                        guard=COLD means it had not.",
		"  pointerdown … IGNORED   = the router received it and dropped it (a previous",
		"                        stroke was still active).",
		"  pointercancel       = delivered, then reclassified as a gesture by the browser.",
		"  pen-hover           = pen NEAR, no contact claimed. buttons=1 here means the",
		"                        nib was pressed and the browser sent no pointerdown.",
		"",
		...lines,
	].join("\n");
}

/**
 * Environment context for a capture. Loose on purpose: the recorder fills
 * what it can reach, a future version adds fields, and unknown ones ride
 * through parse and re-serialize untouched - the sidecar discipline.
 */
export type TraceEnv = Record<string, unknown>;

export interface TraceCapture {
	v: 1;
	env: TraceEnv;
	events: TraceEntry[];
	traceMeta?: PointerTraceMeta;
	analysis?: PointerDeliveryAnalysis;
}

/**
 * A machine-readable snapshot of the ring buffer. The human table
 * (formatInlinePenTrace) stays exactly as it is - people paste it into
 * GitHub issues - and this is what becomes a replay fixture: a pointerdown
 * at (400, 300) is meaningless without the world it landed in, so the
 * recorder passes that world in env.
 */
export function captureInlinePenTrace(env: TraceEnv): TraceCapture {
	const traceMeta: PointerTraceMeta = {
		evictedRows: traceEvictedRows,
		evictedSamples: traceEvictedSamples,
		retainedRows: trace.length,
		retainedSamples: trace.reduce((sum, event) => sum + (event.cs?.length ?? 0), 0),
		truncated: traceTruncated,
		partialBatch: tracePartialBatch,
	};
	const events = trace.map((r) => ({ ...r, ...(r.cs ? { cs: r.cs.map((c) => ({ ...c })) } : {}) }));
	return {
		v: 1,
		env: { ...env, undoHistory: captureUndoTrace() },
		events,
		traceMeta,
		analysis: analyzePointerDeliveryTrace(events, traceMeta),
	};
}

export function clearInlinePenTrace(): void {
	trace.length = 0;
	traceStorageEntries = 0;
	traceEvictedRows = 0;
	traceEvictedSamples = 0;
	traceTruncated = false;
	tracePartialBatch = false;
	traceEventSeq = 0;
	traceEventIds = new WeakMap<object, string>();
	traceCopyPartial = false;
	suppressedNative = 0;
	// And every live router's per-type de-dupe set (see `liveSuppressedTypes`
	// below). The buffer and the counter were scoped to one recording and this
	// was not: a type de-duped during the last capture stayed de-duped into
	// this one, so the first suppressed click of a fresh recording - the strip
	// tap this trace exists to explain - wrote nothing, and went on writing
	// nothing until the next pen claim happened to call `armOwnership()`. A
	// recording that starts is a recording that has seen no event yet.
	for (const seen of liveSuppressedTypes) seen.clear();
	clearUndoTrace();
}

// ---- window delivery mirror -------------------------------------------------
//
// Log-only, always on while any router lives: a window-CAPTURE listener for
// pen pointerdown/pointercancel, ahead of every other handler in the page.
// Its entries prove whether the browser delivered a contact at all, the
// difference between "the page never got it" (OS/Chromium withheld it) and
// "the page got it and something upstream of the router ate it". Refcounted
// across routers; never intercepts, only traces.

let mirrorRefs = 0;
let mirrorFn: ((e: Event) => void) | null = null;
const MIRRORED_TYPES = ["pointerdown", "pointercancel"] as const;
/** Every live router's scroller, so the mirror can say "was this for us". */
export const liveScrollers = new Set<HTMLElement>();
/**
 * Every live router's `cb.describeChrome`, registered/unregistered exactly
 * where `liveScrollers` is (constructor/dispose). The window mirror below
 * calls these ONLY for a pen pointerdown whose composed path misses every
 * scroller, to say what the pen-toolbar chrome looked like at that instant -
 * see `InlinePenCallbacks.describeChrome`. A router whose overlay left the
 * callback undefined (the pdf surface) never adds to this set.
 */
export const liveChromeDescribers = new Set<(target: Element | null) => string>();
/**
 * Every live router's `suppressedTraced` set, registered/unregistered exactly
 * where the two above are (constructor/dispose), so `clearInlinePenTrace()`
 * can start a recording with all of them empty.
 *
 * The set itself rather than the router: this is the only thing the module
 * needs from the instance, and handing over one field cannot grow into a
 * second way to reach a router. Registration is once per router, so nothing
 * here is paid per event, and the loop runs only when a recording starts -
 * with diagnostics off, `traceSuppressed` returns before it can add to any of
 * these and the sets stay empty for the loop to walk in nothing flat.
 */
export const liveSuppressedTypes = new Set<Set<string>>();

/**
 * Every live router, registered/unregistered exactly where the three sets
 * above are (constructor/dispose). What it is for: "is a hand on the glass
 * ANYWHERE", which the reticle rule needs and one router cannot answer.
 *
 * NOT A STORED BIT, and that is the whole design. A cross-surface flag that
 * failed to clear would be a mouse reticle that never comes back - a worse
 * defect than the stale ring this fixes. Membership is the only state kept
 * here; the ANSWER is re-derived from each member on every ask, out of the
 * same self-healing terms `handOnGlass` already documents. If every router
 * forgot everything, `anyHandOnGlass()` goes false on its own, with no
 * cleanup call from anybody: an empty set returns on the first line, and a
 * live router with cleared touch sets, a null `activePenId` and an expired
 * hover stamp returns false from `handOnGlass()` unchanged.
 *
 * The router rather than the surface, deliberately: `PdfInkController` builds
 * its stroke handling on THIS class rather than a second router (see
 * `mouseActsAsPen`'s note), so one set here spans notes and pdfs with no
 * second registry, no `addStripSurface` plumbing, and no import back from
 * this module into `InkOverlay` - which would close a real cycle.
 */
export const liveRouters = new Set<InlinePenRouter>();

/**
 * Is a hand on the glass on ANY open ink surface?
 *
 * The 1.4.12 ruling ("hide the mouse reticle when a finger or pen is active")
 * read one surface's router, because the router is per-surface: with two panes
 * side by side, a finger writing in pane A left the mouse's ring lit in pane
 * B - the same marker-for-a-pointer-nobody-is-using the ruling was about.
 * There is one user with two hands, so a hand on pane A means the mouse over
 * pane B is parked by definition.
 *
 * COST, and it is the reason this is a plain loop over a Set. One iteration
 * per open ink surface (1 in the common case, 2-3 for a split), short-circuit
 * on the first true, each iteration being today's `handOnGlass()`: two set
 * sizes, two field reads, and the clock only when the first four say no. Paid
 * on MOUSE hover samples only - both read sites gate on the sample being a
 * mouse's, so pen and touch samples never evaluate this at all. No layout
 * read, no timer, no polling, no allocation.
 */
export function anyHandOnGlass(): boolean {
	for (const r of liveRouters) if (r.handOnGlass()) return true;
	return false;
}

export function armWindowMirror(scrollers: () => HTMLElement[]): void {
	mirrorRefs++;
	if (mirrorFn) return;
	const fn = (e: Event) => {
		// RC4: the switch is read BEFORE any work. This listener is on the
		// window capture path for every pen contact, so composedPath() (a full
		// ancestor-array allocation) and the live-scroller scan used to run at
		// the start of every stroke and be thrown away inside tr().
		if (!diagnosticsEnabled()) return;
		const pe = e as PointerEvent;
		if (pe.pointerType !== "pen") return;
		const path = typeof pe.composedPath === "function" ? pe.composedPath() : [];
		const forUs = scrollers().some((el) => path.includes(el));
		let note = `PAGE RECEIVED IT; composed path ${forUs ? "includes" : "does NOT include"} a Handwriting editor scroller`;
		// A scroller-missing pen DOWN is exactly the shape this mirror could
		// not otherwise explain: "the page got it and something upstream of
		// the router ate it" (module doc, above) could mean it landed on the
		// pen-toolbar strip - mounted OUTSIDE the scroller by design - or on
		// nothing at all. Ask every live overlay what its chrome looked like
		// right here, so a trace stops leaving those two indistinguishable.
		// pointerdown only: a pointercancel is not a new hit-test, and the
		// chrome cannot have changed since the down that preceded it.
		if (!forUs && pe.type === "pointerdown" && liveChromeDescribers.size > 0) {
			const target = (path[0] as Element | undefined) ?? (pe.target as Element | null) ?? null;
			for (const describe of liveChromeDescribers) {
				note += `; ${describe(target)}`;
			}
		}
		tr(`window-${pe.type}`, pe, note);
	};
	mirrorFn = fn;
	for (const type of MIRRORED_TYPES) {
		window.addEventListener(type, fn, { capture: true });
	}
}

export function disarmWindowMirror(): void {
	mirrorRefs = Math.max(0, mirrorRefs - 1);
	if (mirrorRefs > 0 || !mirrorFn) return;
	for (const type of MIRRORED_TYPES) {
		window.removeEventListener(type, mirrorFn, { capture: true });
	}
	mirrorFn = null;
}

/**
 * Trace-only: a click reached somewhere inside the pen-toolbar strip's own
 * DOM (root, pill, a button, or a slider pop). MobileTools calls this from
 * a capture-phase click listener on its own pane, so a capture running
 * after a scroller-missing `window-pointerdown` line (above) can tell two
 * failures apart that otherwise look identical: no line at all means the
 * pointerdown hit the strip but no click was ever synthesized; this line
 * with nothing useful after it means the click arrived and the strip's own
 * handler did nothing. Checked here, not left to `tr()`'s own gate, so
 * `describeEl` never runs while tracing is off - the listener itself stays
 * registered for the strip's whole lifetime, not just while recording.
 */
export function traceStripClick(target: Element | null): void {
	if (!diagnosticsEnabled()) return;
	tr("strip-click", null, `reached ${describeEl(target)}`);
}

/**
 * Trace-only entry point for OTHER surfaces (pdf, ...) to append into the
 * SAME ring `tr()` writes, so a bug report shows one merged, time-ordered
 * timeline instead of two that have to be correlated by hand after the
 * fact. The pdf controller has no trace of its own - every pdf bug report
 * to date showed only the router's view of the pointer stream and nothing
 * about what the controller did with it (2026-09-04).
 *
 * Same idiom as `traceStripClick`: gated here as the second line of
 * defence, matching `tr()`'s own gate. THE CALL-SITE RULE (DiagSwitch.ts)
 * still governs the CALLER - `note` must be built, and any DOM/computed
 * read it needs must happen, only after the caller's own
 * `diagnosticsEnabled()` check, or this gate is paid for after the cost
 * already landed.
 */
export function traceSurface(type: string, e: PointerEvent | null, note: string): void {
	if (!diagnosticsEnabled()) return;
	tr(type, e, note);
}

/** The ownership guard ate a native event: the one write to `suppressedNative` made from outside this file. */
export function noteSuppressedNative(): void {
	suppressedNative++;
}
