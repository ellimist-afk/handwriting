/**
 * The pdf pan trace: the pure summary line, and the structural claim that
 * none of it runs with diagnostics off.
 *
 * The second half is the one that matters more, and it is not behaviour this
 * repo can execute: `penRaw` needs a mounted pdf viewer, and the cost being
 * asserted is a cost that shows up as NOTHING happening. So it is pinned as
 * source shape, the house technique (CommandPaletteSplit.test.ts,
 * InkSurfaceRules.test.ts), with comments blanked through `codeOnly` first -
 * a guard a comment can satisfy is a guard a comment can defeat, and this
 * file's own prose in the controller talks about `performance.now()` and
 * `recordPdfPanMove` at length.
 *
 * What the structural half asserts, in the order the cost is incurred:
 *
 *   - the pan branch reads NO switch of its own. `diagOn` comes from the one
 *     `diagnosticsEnabled()` call `penRaw` already made for its eight trace
 *     branches, so the instrument added zero boolean reads, not one.
 *   - the only clock read outside the gate is the `diagOn ? ... : 0` ternary
 *     that starts the measurement, which reads a local and calls nothing.
 *   - the recording call's innermost enclosing block is `if (diagOn)`, and
 *     the coalesced probe - the one genuinely expensive argument, since
 *     `getCoalescedEvents()` allocates - is inside it too.
 *
 * What it cannot answer: whether the numbers are RIGHT on a Surface. Nothing
 * here can. That is what the instrument is for.
 */
import { describe, expect, it } from "vitest";
import traceSrc from "./PdfPanTrace.ts?raw";
import mainSrc from "../main.ts?raw";
import commandsSrc from "../commands/RegisterCommands.ts?raw";
import diagCommandsSrc from "../commands/RegisterDiagCommands.ts?raw";
import { codeOnly } from "../CodeOnly";
import { surfaceCode } from "../inline/surfaceFiles.testutil";
import { type PdfPanEntry, summarizePdfPanMoves } from "./PdfPanTrace";

// The pdf surface's code across every file the ink-surface ledger lists for it (surfaceCode). The glob literal stays per module.
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const CONTROLLER = surfaceCode("pdf", ALL_TS);
const TRACE = codeOnly(traceSrc.replace(/\r\n/g, "\n"));
// The command registrations live in commands/RegisterCommands.ts and RegisterDiagCommands.ts, read here with main.ts.
const MAIN = codeOnly([mainSrc, commandsSrc, diagCommandsSrc].join("\n").replace(/\r\n/g, "\n"));

/** A recorded pan move, healthy by default; override the column under test. */
function move(over: Partial<PdfPanEntry> = {}): PdfPanEntry {
	return {
		kind: "pan",
		t: 0,
		sincePrevMs: 4,
		handlerMs: 0.02,
		dx: 0,
		dy: -12,
		samples: 4,
		coalesced: 4,
		ptr: "pen",
		repaint: false,
		frameMs: 8,
		...over,
	};
}

/** A recorded native scroll event, with the columns a scroll row does not have. */
function scroll(over: Partial<PdfPanEntry> = {}): PdfPanEntry {
	return move({
		kind: "scroll",
		handlerMs: 0.3,
		dx: 0,
		dy: 0,
		samples: 0,
		coalesced: 0,
		ptr: "",
		repaint: false,
		...over,
	});
}

describe("summarizePdfPanMoves: the one line worth pasting", () => {
	it("says so rather than dividing by zero on an empty buffer", () => {
		expect(summarizePdfPanMoves([])).toBe("pdf pan: no moves recorded");
	});

	it("reports count, pointerType, coalesced share, handler, gap and slow frames", () => {
		// Quarters and whole milliseconds so every mean and p95 below is
		// exact in binary and the expected string is arithmetic, not a
		// recording of whatever the code happened to print.
		//
		//   handler  0.25 .. 5.00 step 0.25  -> mean 2.625, p95 (rank 19) 4.75
		//   frame    5 .. 24 step 1          -> mean 14.5,  p95 (rank 19) 23
		//   frames over 20ms: 21, 22, 23, 24 -> 4
		//   coalesced on all but the last two -> 18/20
		const entries = Array.from({ length: 20 }, (_, i) =>
			move({
				handlerMs: (i + 1) / 4,
				frameMs: i + 5,
				coalesced: i < 18 ? 4 : 0,
			})
		);
		expect(summarizePdfPanMoves(entries)).toBe(
			"pdf pan: 20 move(s) ptr=pen coalesced 18/20 | " +
				"handler mean 2.625ms p95 4.750ms | " +
				"gap mean 14.5ms p95 23.0ms over 20 framed | frames over 20ms: 4"
		);
	});

	it("names every pointerType present, most-used first", () => {
		const mixed = [
			move({ ptr: "touch" }),
			move({ ptr: "pen" }),
			move({ ptr: "pen" }),
			move({ ptr: "pen" }),
		];
		expect(summarizePdfPanMoves(mixed)).toContain("ptr=pen(3)+touch(1)");
	});

	it("breaks a pointerType tie by name, so the line is stable", () => {
		expect(summarizePdfPanMoves([move({ ptr: "pen" }), move({ ptr: "mouse" })])).toContain(
			"ptr=mouse(1)+pen(1)"
		);
	});

	it("prints ? for a move whose pointerType never arrived", () => {
		expect(summarizePdfPanMoves([move({ ptr: "" })])).toContain("ptr=?");
	});

	it("counts a move with no coalesced list as not coalesced", () => {
		// The shape the Surface investigation is looking for: pen-rate moves
		// arriving one event per sample instead of one batch per frame.
		const raw = [move({ coalesced: 0 }), move({ coalesced: 0 }), move({ coalesced: 3 })];
		expect(summarizePdfPanMoves(raw)).toContain("coalesced 1/3");
	});

	it("leaves moves whose frame has not run yet out of the gap statistics", () => {
		const partly = [move({ frameMs: 10 }), move({ frameMs: 30 }), move({ frameMs: -1 })];
		const line = summarizePdfPanMoves(partly);
		expect(line).toContain("gap mean 20.0ms p95 30.0ms over 2 framed");
		expect(line).toContain("frames over 20ms: 1");
		expect(line).toContain("pdf pan: 3 move(s)");
	});

	it("says the gap was not measured rather than printing a zero", () => {
		const line = summarizePdfPanMoves([move({ frameMs: -1 }), move({ frameMs: -1 })]);
		expect(line).toContain("gap not measured (0 framed)");
		expect(line).toContain("frames over 20ms: 0");
	});

	it("does not count a frame at exactly the 20ms threshold as slow", () => {
		expect(summarizePdfPanMoves([move({ frameMs: 20 })])).toContain("frames over 20ms: 0");
		expect(summarizePdfPanMoves([move({ frameMs: 20.1 })])).toContain("frames over 20ms: 1");
	});
});

describe("summarizePdfPanMoves: the two kinds are summarised apart", () => {
	it("prints nothing about scrolls when the capture holds none", () => {
		// The line a pan-only capture produced before scroll rows existed, to
		// the character: a reader who ran the pan command and panned should
		// not have to skip past a row of zeroes about something else.
		expect(summarizePdfPanMoves([move()]).split("\n")).toHaveLength(1);
	});

	it("gives each kind its own count, and never averages one into the other", () => {
		// The handler numbers are two orders apart on purpose - that is the
		// real shape, a pan branch of microseconds beside a scroll handler
		// that can schedule a repaint - and a single mean over the six would
		// be a number describing neither.
		const entries = [
			move({ handlerMs: 0.02, frameMs: 8 }),
			scroll({ handlerMs: 1, frameMs: 8, repaint: true }),
			move({ handlerMs: 0.02, frameMs: 8 }),
			scroll({ handlerMs: 3, frameMs: 30 }),
			scroll({ handlerMs: 2, frameMs: 8 }),
			move({ handlerMs: 0.02, frameMs: 8 }),
		];
		const [panLine, scrollLine, ...rest] = summarizePdfPanMoves(entries).split("\n");
		expect(rest).toEqual([]);
		expect(panLine).toContain("pdf pan: 3 move(s)");
		expect(panLine).toContain("handler mean 0.020ms");
		expect(panLine).toContain("frames over 20ms: 0");
		expect(scrollLine).toContain("pdf scroll: 3 event(s) repaint 1/3");
		expect(scrollLine).toContain("handler mean 2.000ms");
		expect(scrollLine).toContain("frames over 20ms: 1");
	});

	it("still says so on the pan line when only scrolls were recorded", () => {
		// A finger scroll never touches the Pan tool, so this is the ordinary
		// shape of a capture taken to answer the scroll question - and the
		// reader still ran a command with "pan" in its name.
		const [panLine, scrollLine] = summarizePdfPanMoves([
			scroll({ repaint: true }),
			scroll(),
		]).split("\n");
		expect(panLine).toBe("pdf pan: no moves recorded");
		expect(scrollLine).toContain("pdf scroll: 2 event(s) repaint 1/2");
	});

	it("counts the repaints and not the events that scheduled nothing", () => {
		const none = summarizePdfPanMoves([scroll(), scroll(), scroll()]).split("\n")[1];
		expect(none).toContain("repaint 0/3");
		const all = summarizePdfPanMoves([scroll({ repaint: true }), scroll({ repaint: true })]);
		expect(all.split("\n")[1]).toContain("repaint 2/2");
	});

	it("leaves the pan line's pointerType free of the scrolls, which have none", () => {
		// The bug this refuses: `ptr=pen(3)+?(40)` on a capture where forty
		// finger scrolls landed between three pan moves.
		const line = summarizePdfPanMoves([move({ ptr: "mouse" }), scroll(), scroll()]);
		expect(line.split("\n")[0]).toContain("ptr=mouse");
		expect(line.split("\n")[0]).not.toContain("?");
	});
});

/** The `{ ... }` block opened by the first brace at or after `from`. */
function blockFrom(src: string, from: number): string {
	const open = src.indexOf("{", from);
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return "";
}

/** The line that opened the innermost block enclosing `index`, trimmed. */
function enclosingBlockHeader(src: string, index: number): string {
	let depth = 0;
	for (let i = index; i >= 0; i--) {
		const ch = src[i];
		if (ch === "}") depth++;
		else if (ch === "{") {
			if (depth === 0) {
				const head = src.slice(0, i);
				return head.slice(head.lastIndexOf("\n") + 1).trim();
			}
			depth--;
		}
	}
	return "";
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("the recording sits behind the diagnostics read", () => {
	// Asserted non-trivial: a slice that silently became empty, or the whole
	// file, would satisfy every `not.toContain` below for free.
	const branchAt = CONTROLLER.indexOf("if (this.panLast !== null)");
	const PAN_BRANCH = blockFrom(CONTROLLER, branchAt);
	const GATED = blockFrom(PAN_BRANCH, PAN_BRANCH.indexOf("if (diagOn) {"));
	const OUTSIDE = PAN_BRANCH.split(GATED).join("");

	it("found the pan branch and the gate inside it", () => {
		expect(branchAt, "the pan branch in PdfInkController.ts").toBeGreaterThan(-1);
		// The write, which is what the branch is FOR. It read to be `-=` per
		// sample; PanScroll.test.ts owns the rule that it is now one write per
		// axis and no read at all, and this line only has to prove the slice
		// really is the pan branch.
		expect(PAN_BRANCH).toContain("scroller.scrollLeft = to.x;");
		// A ceiling, not a measurement: it says the slice is a branch and not
		// the 150KB file. `codeOnly` blanks comments in place rather than
		// deleting them, so this number tracks the branch's prose as well as
		// its code, and the prose here earned its keep twice over.
		expect(PAN_BRANCH.length).toBeLessThan(6000);
		expect(GATED.length).toBeGreaterThan(100);
		expect(GATED.length).toBeLessThan(PAN_BRANCH.length);
	});

	it("adds no boolean read of its own: diagOn is penRaw's single one", () => {
		expect(CONTROLLER).toContain("const diagOn = diagnosticsEnabled();");
		expect(occurrences(CONTROLLER, "const diagOn = diagnosticsEnabled();")).toBe(1);
		expect(PAN_BRANCH).not.toContain("diagnosticsEnabled(");
	});

	it("records inside `if (diagOn)` and nowhere else", () => {
		const at = PAN_BRANCH.indexOf("recordPdfPanMove(");
		expect(at, "recordPdfPanMove in the pan branch").toBeGreaterThan(-1);
		expect(enclosingBlockHeader(PAN_BRANCH, at)).toBe("if (diagOn)");
		expect(occurrences(CONTROLLER, "recordPdfPanMove(")).toBe(1);
		expect(OUTSIDE).not.toContain("recordPdfPanMove(");
	});

	it("keeps the coalesced probe inside the gate, where its allocation is paid for", () => {
		expect(GATED).toContain("coalescedCount(ev)");
		expect(OUTSIDE).not.toContain("coalescedCount(");
	});

	it("reads the clock outside the gate only through the diagOn ternary", () => {
		expect(OUTSIDE).toContain("const panT0 = diagOn ? performance.now() : 0;");
		expect(occurrences(OUTSIDE, "performance.now()")).toBe(1);
		expect(GATED).toContain("handlerMs: performance.now() - panT0,");
	});

	it("requests no animation frame from the pan branch itself", () => {
		// The one rAF per move is inside recordPdfPanMove, which returns
		// before it on the switch, so an off capture schedules none.
		expect(PAN_BRANCH).not.toContain("requestAnimationFrame");
		expect(TRACE).toContain("win?.requestAnimationFrame(");
	});

	it("keeps the second line of defence inside the recorder", () => {
		const at = TRACE.indexOf("export function recordPdfPanMove(");
		expect(at, "recordPdfPanMove in PdfPanTrace.ts").toBeGreaterThan(-1);
		expect(blockFrom(TRACE, at)).toContain("if (!diagnosticsEnabled()) return;");
	});
});

/**
 * The scroll instrument, same rules, one listener along.
 *
 * The gate cannot be reused here and that is the difference worth pinning:
 * `penRaw` had a `diagnosticsEnabled()` read for the pan branch to borrow,
 * `onScroll` had none, so this one takes its own - and takes exactly one,
 * ahead of the clock read that would otherwise be paid on every scroll event
 * of every pdf pane whether anybody was recording or not.
 */
describe("the scroll instrument is gated the same way, on its own read", () => {
	const at = CONTROLLER.indexOf("readonly onScroll = (): void => {");
	const HANDLER = blockFrom(CONTROLLER, at);
	const GATE = blockFrom(HANDLER, HANDLER.indexOf("if (scrollDiagOn) {"));
	const OUT = HANDLER.split(GATE).join("");

	it("found the listener and the gate inside it", () => {
		expect(at, "onScroll in PdfInkController.ts").toBeGreaterThan(-1);
		expect(HANDLER).toContain("this.syncBand(scroller)");
		expect(GATE.length).toBeGreaterThan(50);
		expect(GATE.length).toBeLessThan(HANDLER.length);
	});

	it("takes exactly one boolean read, and it is not penRaw's", () => {
		expect(occurrences(HANDLER, "diagnosticsEnabled()")).toBe(1);
		expect(HANDLER).toContain("const scrollDiagOn = diagnosticsEnabled();");
		// The pan branch's own claim, unchanged by a second instrument
		// arriving in the same file: penRaw still makes ONE read for its
		// eight trace branches and the pan branch still borrows it.
		expect(occurrences(CONTROLLER, "const diagOn = diagnosticsEnabled();")).toBe(1);
	});

	it("reads the clock outside the gate only through the ternary", () => {
		expect(OUT).toContain("const scrollT0 = scrollDiagOn ? performance.now() : 0;");
		expect(occurrences(OUT, "performance.now()")).toBe(1);
		expect(GATE).toContain("handlerMs: performance.now() - scrollT0,");
	});

	it("records inside the gate and nowhere else", () => {
		const call = HANDLER.indexOf("recordPdfScrollEvent(");
		expect(call, "recordPdfScrollEvent in onScroll").toBeGreaterThan(-1);
		expect(enclosingBlockHeader(HANDLER, call)).toBe("if (scrollDiagOn)");
		expect(occurrences(CONTROLLER, "recordPdfScrollEvent(")).toBe(1);
		expect(OUT).not.toContain("recordPdfScrollEvent(");
	});

	it("measures the repaint decision rather than guessing at it", () => {
		// `repaint` is the column that tells a cheap scroll event from an
		// expensive one, so it has to be what `syncBand` actually answered -
		// and the schedule it triggers has to be inside the timed span.
		expect(OUT).toContain("const repaint = this.syncBand(scroller);");
		expect(OUT).toContain("if (repaint) this.schedule();");
		expect(GATE).toContain("repaint }");
	});

	it("keeps the second line of defence inside the recorder", () => {
		const fn = TRACE.indexOf("export function recordPdfScrollEvent(");
		expect(fn, "recordPdfScrollEvent in PdfPanTrace.ts").toBeGreaterThan(-1);
		// From the signature's END, not from `fn`: this one's parameter is an
		// inline object type, so the first `{` after the name is the type
		// literal and `blockFrom` would hand back `{ t: number; ... }` - a
		// non-empty slice that fails the assertion for the wrong reason.
		const body = blockFrom(TRACE, TRACE.indexOf("): void {", fn));
		expect(body).toContain("if (!diagnosticsEnabled()) return;");
	});

	it("requests no animation frame from the listener itself", () => {
		expect(HANDLER).not.toContain("requestAnimationFrame");
	});
});

describe("the palette entries are gated exactly like the scroll trace", () => {
	/** True when this id's `addCommand` sits directly inside the setting's `if`. */
	function gatedByDevDiagnostics(id: string): boolean {
		const at = MAIN.indexOf(`id: "${id}"`);
		if (at < 0) return false;
		const before = MAIN.slice(0, at);
		const add = before.lastIndexOf("this.addCommand({");
		return before.slice(0, add).trimEnd().endsWith("if (this.settings.devDiagnostics) {");
	}

	it.each([
		["copy-pdf-pan-trace", "Diagnostics: show PDF pan trace"],
		["clear-pdf-pan-trace", "Diagnostics: clear PDF pan trace"],
	])("%s registers behind devDiagnostics", (id, name) => {
		expect(MAIN).toContain(`id: "${id}"`);
		expect(MAIN).toContain(`name: "${name}"`);
		expect(gatedByDevDiagnostics(id), `${id} is not behind devDiagnostics`).toBe(true);
	});

	it("is the same gate the scroll trace uses", () => {
		expect(gatedByDevDiagnostics("copy-inline-scroll-trace")).toBe(true);
	});
});
