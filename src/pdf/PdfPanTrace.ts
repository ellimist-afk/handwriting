import { DIAG_OFF_NOTE, diagnosticsEnabled } from "../diag/DiagSwitch";

/**
 * The pdf Pan tool's move-path latency instrument.
 *
 * WHY IT EXISTS, because that decides what it records. Alan reports the pan
 * lagging on a pdf; the same pan was measured on the development desktop
 * over six runs and two documents in A-B-A order and showed nothing at all -
 * about 0.015 ms of handler time per move and not one frame over 20 ms. Then
 * "pan on pdf was on orion", and "orion is the surface pro". So the machine
 * that lags is a Windows tablet with a pen and a touchscreen, and the
 * measurement that found nothing was a MOUSE on a 240 Hz desktop.
 *
 * The variable the desktop run could not vary is therefore the input path,
 * and that is the one this file exists to report:
 *
 *   - `ptr`, the pointerType actually driving the pan. A Surface delivers
 *     pen, touch and mouse through the same handler and they are three
 *     different pipelines underneath.
 *   - `coalesced`, the size of the batch Chromium handed the move. A Surface
 *     pen samples at 240 Hz into a 60 Hz frame, so the healthy shape is a
 *     coalesced batch of about four per frame. A stream of UNcoalesced
 *     single moves at pen rate is a different machine altogether: four times
 *     the handler entries and four times the scroll writes.
 *
 * That last clause used to end "four times the forced layout", and it does
 * not any more. The drag reads the scroller once at pen-down and carries the
 * position from there (`PdfInkController.panLast`, `PanScroll.ts`), so the
 * move path writes two offsets and reads none. Which also settles what this
 * trace was first framed to find: Alan panned with a MOUSE, one sample per
 * move, so batch size was never the lever - the per-move READ was, and that
 * one is per move whatever the pointer is.
 *
 * Around those two, the plain latency columns: how long the handler took,
 * what it applied, and - the one that says whether any of it is VISIBLE -
 * how long the move waited for the next animation frame. Handler time can be
 * a rounding error while the frame it feeds arrives 40 ms later, and that is
 * lag whatever the handler says.
 *
 * IT IS AN INSTRUMENT AND NOT A FIX. Nothing here changes what the pan does.
 *
 * COST WITH DIAGNOSTICS OFF. Zero, and structurally rather than by promise:
 * every call into this module sits inside the `if (diagOn)` in
 * `PdfInkController.penRaw`, whose `diagOn` is the ONE `diagnosticsEnabled()`
 * read that call already made for its eight trace branches. No clock read,
 * no `getCoalescedEvents()`, no object, no animation frame is requested with
 * the switch off. The gates inside the functions below are the second line
 * of defence the call-site rule (DiagSwitch.ts) asks for, not the first.
 *
 * WITH DIAGNOSTICS ON it is an observer that costs something: two clock
 * reads, a coalesced-list allocation and one `requestAnimationFrame` per
 * move. The frame request in particular can keep the compositor's frame loop
 * warm during a pan that would otherwise idle, so the gap column is a
 * measurement of a pan being watched. That is the honest trade for having
 * any number at all from a machine none of us can attach a profiler to.
 *
 * AND THE OTHER HALF OF THE SURFACE, since 1.4.12: the same ring also takes a
 * row for every NATIVE scroll of the pdf viewer - a finger, a wheel, a
 * scrollbar, a keyboard page - recording what the controller's own
 * `onScroll` cost and whether it scheduled a repaint (`PdfPanKind`,
 * `recordPdfScrollEvent`). The pan trace could never see that: a finger
 * scroll goes nowhere near the Pan tool, and the pan's own scroll writes are
 * paid a frame later in a handler the pan rows knew nothing about. Same
 * switch, same zero cost off, one extra boolean read per scroll event on -
 * which is the whole of what the call-site rule asks of a listener that had
 * none to reuse.
 */

/**
 * WHICH HANDLER THIS ROW IS ABOUT.
 *
 * `pan` is a `penRaw` batch the pan branch consumed. `scroll` is a native
 * scroll event on the pdf viewer - a finger, a wheel, a scrollbar, a keyboard
 * page, or the pan's own write coming back round - measured in the
 * controller's `onScroll`.
 *
 * ONE RING FOR BOTH, deliberately, and interleaved in arrival order. The two
 * costs are not independent: a pan move writes the scroller, which fires a
 * scroll event a frame later, which is where the band check and any repaint
 * are actually paid. Reading them in two separate buffers would hide exactly
 * that relationship, and "the pan handler is 0.02 ms" beside "and the scroll
 * it caused cost 3 ms" is a different report from either half alone.
 */
export type PdfPanKind = "pan" | "scroll";

/** One handler entry: a pan move, or a native scroll event. See `PdfPanKind`. */
export interface PdfPanEntry {
	/** Which handler; the columns below say which apply. */
	kind: PdfPanKind;
	/** `performance.now()` on entry to the handler. */
	t: number;
	/**
	 * Since the previous recorded entry OF THE SAME KIND. Not finite for the
	 * first of each in a recording; across two separate pans it is simply the
	 * wall gap between them, which is what "since the previous move" honestly
	 * means.
	 *
	 * Per kind rather than across the ring, because the two interleave: a
	 * shared counter would report a pan's cadence as the gap to whichever
	 * scroll event happened to land between two of its moves, and a pan's
	 * cadence IS the question on a surface that feels slow.
	 */
	sincePrevMs: number;
	/**
	 * Time inside the handler.
	 *
	 * `pan`: this used to read "the scroll writes plus the reticle"; the
	 * reticle is no longer painted per move (1.4.12 §11), so it is the
	 * arithmetic and the two scroll writes and nothing else.
	 *
	 * `scroll`: everything the controller does on a native scroll - the live
	 * pan's reconciliation, the band check, and the repaint schedule when the
	 * band moved. It is OUR cost on somebody else's event, which is the
	 * number worth having: the browser's own scrolling is not ours to fix and
	 * this is.
	 */
	handlerMs: number;
	/**
	 * `pan` only: the scroll delta the batch actually applied, CSS px, signed.
	 *
	 * Zero on a `scroll` row, and that is a refusal rather than a gap. Saying
	 * how far a native scroll went means reading `scrollLeft`/`scrollTop`, and
	 * that read is the forced layout this whole slice removed from the pan;
	 * putting it back inside the instrument would make the instrument the
	 * thing being measured.
	 */
	dx: number;
	dy: number;
	/** `pan` only: samples in the batch the pan branch walked. */
	samples: number;
	/**
	 * `pan` only: the coalesced batch size the browser reported for the move
	 * carrying this batch. 0 means the move arrived with no coalesced list:
	 * one event per sample, the shape that multiplies the work.
	 */
	coalesced: number;
	/** `pan` only: pointerType of the contact driving the pan ("" when unknown). */
	ptr: string;
	/**
	 * `scroll` only: did this event move the band, and so schedule a repaint?
	 *
	 * The one column that separates a cheap scroll event from an expensive
	 * one. `syncBand` answers false for the overwhelming majority - the
	 * viewport is still inside the margin and nothing proportional to the ink
	 * on screen runs - and true is where the cost of a scroll actually is.
	 * Always false on a `pan` row: a pan move schedules nothing itself, it
	 * writes the scroller and the scroll event it causes is its own row.
	 */
	repaint: boolean;
	/** Entry -> the next animation frame. -1 until that frame runs. */
	frameMs: number;
}

/**
 * 600 entries. At a Surface pen's 240 Hz that is a two-and-a-half second
 * window and at 60 Hz a ten second one - either way the tail of the pan that
 * just felt slow, which is what a report needs, and small enough that the
 * ring never becomes the thing being measured.
 *
 * Shared by both kinds, so a long pan can push scroll rows out and vice
 * versa. That is the right trade for one ring in arrival order (see
 * `PdfPanKind`): the window is the last few seconds of whatever the surface
 * was doing, and the summary prints each kind's own count so a reader can see
 * what the window actually held.
 */
const PAN_TRACE_MAX = 600;

const moves: PdfPanEntry[] = [];
/** Per kind, for `sincePrevMs`; see that field for why not one counter. */
const lastAt: Record<PdfPanKind, number> = {
	pan: Number.NEGATIVE_INFINITY,
	scroll: Number.NEGATIVE_INFINITY,
};

/** Just the part of `Window` this needs, so a test can hand it a stub. */
export interface PanFrameSource {
	requestAnimationFrame(cb: (t: number) => void): number;
}

/**
 * The coalesced batch size for a move, or 0 when there is no list.
 *
 * Called ONLY from inside the diagnostics gate: `getCoalescedEvents()`
 * allocates an array of events, which is exactly the kind of argument work
 * the call-site rule exists to keep out of the hot path. The pan branch does
 * not otherwise need it - unlike the ink path, which consumes the list.
 */
export function coalescedCount(ev: PointerEvent | undefined): number {
	if (!ev || typeof ev.getCoalescedEvents !== "function") return 0;
	return ev.getCoalescedEvents().length;
}

/** The one push, shared by both kinds so the ring's rules cannot diverge. */
function push(entry: PdfPanEntry, win: PanFrameSource | null): void {
	lastAt[entry.kind] = entry.t;
	moves.push(entry);
	if (moves.length > PAN_TRACE_MAX) moves.splice(0, moves.length - PAN_TRACE_MAX);
	// The frame timestamp rather than a `performance.now()` inside the
	// callback: the argument is when the frame BEGAN, on the same timebase,
	// so the number is entry -> frame and not entry -> our callback's turn in
	// it. An entry the ring has already evicted still takes its write; it is
	// simply no longer read by anything.
	win?.requestAnimationFrame((frameT) => {
		entry.frameMs = (Number.isFinite(frameT) ? frameT : performance.now()) - entry.t;
	});
}

/**
 * Record one pan move. `win` supplies the animation frame; null skips the
 * gap measurement rather than reaching for a global.
 */
export function recordPdfPanMove(
	m: Omit<PdfPanEntry, "kind" | "repaint" | "sincePrevMs" | "frameMs">,
	win: PanFrameSource | null
): void {
	if (!diagnosticsEnabled()) return;
	push(
		{ ...m, kind: "pan", repaint: false, sincePrevMs: m.t - lastAt.pan, frameMs: -1 },
		win
	);
}

/**
 * Record one native scroll event on the pdf viewer: what OUR handler cost,
 * and whether it scheduled a repaint.
 *
 * The other half of "the pan feels slow", and the half a pan trace alone
 * cannot see. Alan pans with a mouse and scrolls with a finger, and on a
 * touchscreen the finger scroll is the browser's own compositor work with our
 * scroll listener riding on top of it - so the question this answers is
 * narrow and answerable: how much of the frame is OURS. It is not "is the
 * scroll smooth", which nothing in this process can measure.
 *
 * The columns a scroll row does not have - the delta, the sample count, the
 * coalesced size, the pointerType - are left at their zero values rather than
 * invented, and `PdfPanEntry.dx` says why the delta in particular is a
 * refusal and not an oversight.
 */
export function recordPdfScrollEvent(
	s: { t: number; handlerMs: number; repaint: boolean },
	win: PanFrameSource | null
): void {
	if (!diagnosticsEnabled()) return;
	push(
		{
			kind: "scroll",
			t: s.t,
			handlerMs: s.handlerMs,
			repaint: s.repaint,
			dx: 0,
			dy: 0,
			samples: 0,
			coalesced: 0,
			ptr: "",
			sincePrevMs: s.t - lastAt.scroll,
			frameMs: -1,
		},
		win
	);
}

export function clearPdfPanTrace(): void {
	moves.length = 0;
	lastAt.pan = Number.NEGATIVE_INFINITY;
	lastAt.scroll = Number.NEGATIVE_INFINITY;
}

/** The recorded moves, for the formatter and for tests. */
export function pdfPanMoves(): ReadonlyArray<PdfPanEntry> {
	return moves;
}

/** Nearest-rank p95 over an already-collected list. Empty list -> 0. */
function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
	return sorted[Math.max(0, rank)] ?? 0;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/**
 * The pointerTypes present, most-used first: `pen`, or `pen(300)+touch(112)`
 * when a capture mixes them. Named rather than counted-and-dropped because
 * "which input path" is the whole question this trace was built to answer,
 * and a pan that starts as touch and finishes as pen is itself an answer.
 */
function pointerLabel(entries: ReadonlyArray<PdfPanEntry>): string {
	const counts = new Map<string, number>();
	for (const e of entries) {
		const key = e.ptr === "" ? "?" : e.ptr;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (ordered.length === 1) return ordered[0]![0];
	return ordered.map(([k, n]) => `${k}(${n})`).join("+");
}

/** A frame this slow is a frame the hand can see missing. */
const SLOW_FRAME_MS = 20;

/**
 * The handler and frame statistics every kind shares, from one pass.
 *
 * Entries whose frame has not run yet (`frameMs < 0`) are excluded from the
 * gap statistics and from the slow-frame count, and the number that WERE
 * framed is printed, so a capture read mid-pan cannot quietly average over a
 * denominator it does not have.
 */
function commonStats(entries: ReadonlyArray<PdfPanEntry>): string {
	const handler: number[] = [];
	const gaps: number[] = [];
	let slow = 0;
	for (const e of entries) {
		handler.push(e.handlerMs);
		if (e.frameMs >= 0) {
			gaps.push(e.frameMs);
			if (e.frameMs > SLOW_FRAME_MS) slow++;
		}
	}
	const gapPart =
		gaps.length === 0
			? "gap not measured (0 framed)"
			: `gap mean ${mean(gaps).toFixed(1)}ms p95 ${p95(gaps).toFixed(1)}ms over ${gaps.length} framed`;
	return (
		`handler mean ${mean(handler).toFixed(3)}ms p95 ${p95(handler).toFixed(3)}ms | ` +
		`${gapPart} | frames over ${SLOW_FRAME_MS}ms: ${slow}`
	);
}

/** The pan line: what the tip cost while it held the page. */
function panSummary(entries: ReadonlyArray<PdfPanEntry>): string {
	let coalesced = 0;
	for (const e of entries) if (e.coalesced > 0) coalesced++;
	return (
		`pdf pan: ${entries.length} move(s) ptr=${pointerLabel(entries)} ` +
		`coalesced ${coalesced}/${entries.length} | ${commonStats(entries)}`
	);
}

/** The scroll line: what WE cost on somebody else's scroll. */
function scrollSummary(entries: ReadonlyArray<PdfPanEntry>): string {
	let repainted = 0;
	for (const e of entries) if (e.repaint) repainted++;
	return (
		`pdf scroll: ${entries.length} event(s) repaint ${repainted}/${entries.length} | ` +
		`${commonStats(entries)}`
	);
}

/**
 * PURE. The line - or the two lines - the report leads with, and the ones
 * worth pasting into a message on their own.
 *
 * TWO KINDS, SUMMARISED SEPARATELY, because averaging them together would be
 * the one thing that makes both numbers useless: the ring holds a pan handler
 * that runs at pointer rate and a scroll handler that runs at frame rate,
 * they cost different amounts for different reasons, and a mean over the pair
 * is a mean over a denominator nobody chose.
 *
 * The scroll line is printed only when there are scroll rows, so a capture
 * with nothing but a pan in it reads exactly as it did before this existed. A
 * capture with nothing at all still says so on the pan line, which is where a
 * reader who ran the pan command will look for it.
 */
export function summarizePdfPanMoves(entries: ReadonlyArray<PdfPanEntry>): string {
	if (entries.length === 0) return "pdf pan: no moves recorded";
	const pans = entries.filter((e) => e.kind !== "scroll");
	const scrolls = entries.filter((e) => e.kind === "scroll");
	const lines = [pans.length === 0 ? "pdf pan: no moves recorded" : panSummary(pans)];
	if (scrolls.length > 0) lines.push(scrollSummary(scrolls));
	return lines.join("\n");
}

function fmtSince(ms: number): string {
	return Number.isFinite(ms) ? `+${ms.toFixed(1)}ms` : "+--";
}

function fmtFrame(ms: number): string {
	return ms < 0 ? "frame --" : `frame ${ms.toFixed(1)}ms`;
}

/**
 * One row per entry, in arrival order, under the summary lines.
 *
 * The kind leads each row, and the two kinds print DIFFERENT columns rather
 * than one shape with blanks in it: a scroll row has no delta, no sample
 * count, no coalesced size and no pointerType, and printing `d=(0.0,0.0)
 * n=0 coalesced=0 ptr=-` five hundred times would read as five hundred
 * measurements of zero instead of four columns that do not apply.
 */
export function formatPdfPanTrace(): string {
	if (moves.length === 0) {
		return diagnosticsEnabled()
			? "Handwriting PDF pan trace: no moves. Pan a PDF with the Pan tool, then show this again."
			: `Handwriting PDF pan trace: no moves. ${DIAG_OFF_NOTE}`;
	}
	const t0 = moves[0]!.t;
	const rows = moves.map((m) => {
		const head =
			`${(m.t - t0).toFixed(1).padStart(9)}ms  ${m.kind.padEnd(6)} ` +
			`${fmtSince(m.sincePrevMs).padStart(9)}  handler ${m.handlerMs.toFixed(3)}ms  `;
		const body =
			m.kind === "scroll"
				? `repaint=${m.repaint ? "yes" : "no "}`
				: `ptr=${(m.ptr || "-").padEnd(6)} d=(${m.dx.toFixed(1)},${m.dy.toFixed(1)}) ` +
					`n=${m.samples} coalesced=${m.coalesced}`;
		return `${head}${body}  ${fmtFrame(m.frameMs)}`;
	});
	return [
		`Handwriting PDF pan trace: ${moves.length} entr(ies)`,
		"",
		summarizePdfPanMoves(moves),
		"",
		"How to read a row:",
		"  pan        a move of the Pan tool: what the tip cost while it held the page.",
		"  scroll     a native scroll of the viewer - finger, wheel, scrollbar, or the",
		"             pan's own write coming back round: what OUR handler cost on it.",
		"  +N         since the previous row OF THE SAME KIND.",
		"  handler    time inside that handler, and nothing the browser did around it.",
		"  ptr        (pan) the pointerType holding the page: pen, touch or mouse.",
		"  d          (pan) the scroll delta this batch applied, CSS px.",
		"  n          (pan) samples in the batch.",
		"  coalesced  (pan) the batch size the browser delivered. 0 = not coalesced, one",
		"             event per sample - four times the work at a pen's 240 Hz.",
		"  repaint    (scroll) the band moved, so a repaint was scheduled. This is where",
		"             an expensive scroll event differs from a cheap one.",
		`  frame      row -> the next animation frame. Over ${SLOW_FRAME_MS}ms is a frame the`,
		"             hand can see missing, whatever the handler column says.",
		"",
		...rows,
	].join("\n");
}
