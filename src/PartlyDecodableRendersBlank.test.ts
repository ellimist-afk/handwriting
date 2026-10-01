import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineInkStore } from "./inline/InlineInkStore";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { parsePage, type ParseResult } from "./model/PageData";
import surfaceSrc from "./slides/SlidesInkSurface.ts?raw";

/**
 * A PARTLY DECODABLE SIDECAR RENDERS BLANK, AND 1.4.12 SHOWED THE REST.
 *
 * A CHARACTERISATION FILE. IT PINS BEHAVIOUR THAT IS WRONG. DO NOT DELETE
 * THIS BECAUSE IT LOOKS BROKEN: the cases below assert that these surfaces
 * render ZERO strokes, so THE FIX WILL TURN THEM RED. That is the design -
 * whoever fixes this comes back here and re-pins the behaviour deliberately
 * rather than leaving a stale expectation to rot.
 *
 * This pins a user-visible DOWNGRADE, not a defect in the damage lock itself.
 * No data is destroyed - the original bytes are preserved, which is a strict
 * improvement on 1.4.12 - but two surfaces now show an empty page where the
 * previous release showed everything that still decoded.
 *
 * THE MECHANISM IS A PREMISE THAT SILENTLY STOPPED BEING TRUE. `parsePage`
 * reports `damaged` for two different shapes, and its own contract says so:
 *
 *   - UNREADABLE (the JSON did not parse): `data` is `emptyPage`, a
 *     placeholder, not the user's ink.
 *   - PARTLY DECODABLE: the JSON parsed and some strokes did not survive
 *     validation. `data` then holds "the readable REMNANT - real ink, just not
 *     all of it - so a caller that wants to show what survived can".
 *
 * The second shape did not exist when the fail-closed callers were written. At
 * `refs/tags/1.4.12` (compared by CONTENT - the tag and the lane share no
 * common ancestor) `parsePage` has exactly ONE `damaged: true`, in its catch
 * arm, returning `data: emptyPage(fallbackPageId)`. There is no `wasLossy` and
 * no `DecodeLoss` in that file at all. So on 1.4.12 a partly decodable sidecar
 * was NOT damaged, the caller adopted it, and the remnant rendered.
 *
 * Two of the three refusing callers still carry the old premise in a comment:
 * `PdfInkStore.ts:205` says "`damaged` means the bytes could not be understood
 * and `data` is a PLACEHOLDER", and `SlidesInkSurface.ts:2275` says "there is
 * genuinely nothing to draw: `parsePage`'s catch arm hands back `emptyPage`".
 * Both were TRUE when written and are false for the shape that now exists.
 *
 * THE FIX SHAPE IS ALREADY IN ALL THREE FUNCTIONS, a few lines below the
 * refusal: `futureVersion` is handled as READ-ONLY, NOT INVISIBLE, on exactly
 * this argument - "this used to return here, so a note whose sidecar came from
 * a newer build showed NO ink at all - which reads as the data loss the lock
 * exists to prevent". The contrast cases below drive both locks through the
 * same store so the inconsistency is visible in one file.
 *
 * Rendering the remnant is safe for BOTH shapes without a new flag, because in
 * the unreadable shape `data` is `emptyPage` and renders as nothing - which is
 * what those surfaces already show today.
 *
 * WHO REFUSES: inline (`InlineInkStore.ts:454`), pdf (`PdfInkStore.ts:208`) and
 * slides (`SlidesInkSurface.ts:2274`) all return before adopting. Every
 * surface in the plugin now refuses. The canvas page view was the one that
 * did NOT - it set `spatialDamaged`, fell through, rendered the remnant and
 * went read-only - and it was deleted, so the behaviour this file
 * argues for has no implementation left to point at. Slides is cited rather
 * than harnessed here: its load path needs a live deck, and the refusal is
 * the same two lines.
 */

const PAGE_ID = "partly-decodable-blank";
const NOTE = "note.md";

type Raw = Record<string, unknown>;

/** Two readable samples. */
const GOOD: Raw = { pts: [10, 20, 0.5, 0, 30, 40, 0.5, 8] };
/** Nonempty and wholly unreadable: the stroke is dropped and the loss counted. */
const RUINED: Raw = { pts: ["10", "20", 0.5, 0, "30", "40", 0.5, 8] };

function sidecar(surface: "inline" | "pdf", strokes: Raw[], version = 1): string {
	return JSON.stringify({
		schemaVersion: version,
		pageId: PAGE_ID,
		surface,
		textBoxes: [],
		images: [],
		strokes: strokes.map((s, i) => ({
			id: `s${i}`,
			tool: "pen",
			color: "#4b7bec",
			width: 2,
			createdAt: 1,
			...(surface === "pdf" ? { page: 1 } : {}),
			...s,
		})),
	});
}

/** A sidecar with one stroke that survives decoding and one that does not. */
const partlyDecodable = (surface: "inline" | "pdf") => sidecar(surface, [GOOD, RUINED]);

async function inlineStrokes(bytes: string): Promise<readonly { id: string }[]> {
	const store = new InlineInkStore();
	store.attachHost({
		readPageId: (p: string) => (p === NOTE ? PAGE_ID : null),
		claimId: async (_p: string, proposed: string) => ({ pageId: proposed }),
		loadSidecar: async (): Promise<ParseResult> => parsePage(bytes, PAGE_ID),
		scheduleSidecar: () => {},
		notify() {},
	});
	await store.ensureLoaded(NOTE);
	return store.strokes(NOTE);
}

async function pdfStrokes(bytes: string): Promise<readonly { id: string }[]> {
	const store = new PdfInkStore();
	store.attachHost({
		load: async (): Promise<ParseResult> => parsePage(bytes, PAGE_ID),
		schedule: () => {},
		notice: () => {},
	});
	await store.ensureLoaded(PAGE_ID);
	return store.strokes(PAGE_ID);
}

beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => vi.unstubAllGlobals());

describe("a partly decodable sidecar renders blank where 1.4.12 rendered the rest", () => {
	// THE PREMISE, asserted before anything is claimed about rendering: the
	// remnant is real ink and it is reachable on the result. If this fails,
	// every refusal below is correct and the finding is retired.
	it("the remnant is real and reachable: parsePage reports damage AND hands back the readable stroke", () => {
		const parsed = parsePage(partlyDecodable("inline"), PAGE_ID);
		expect(parsed.damaged).toBe(true);
		expect(parsed.data.strokes.map((s) => s.id)).toEqual(["s0"]);
	});

	// The controls. A clean sidecar renders, so a blank below is attributable
	// to the damage verdict and not to a harness that never renders anything.
	it("control: inline renders a clean sidecar", async () => {
		expect((await inlineStrokes(sidecar("inline", [GOOD]))).map((s) => s.id)).toEqual(["s0"]);
	});

	it("control: pdf renders a clean sidecar", async () => {
		expect((await pdfStrokes(sidecar("pdf", [GOOD]))).map((s) => s.id)).toEqual(["s0"]);
	});

	// THE REGRESSION.
	it("inline renders ZERO strokes for a partly decodable sidecar", async () => {
		expect(await inlineStrokes(partlyDecodable("inline"))).toHaveLength(0);
	});

	it("pdf renders ZERO strokes for a partly decodable sidecar", async () => {
		expect(await pdfStrokes(partlyDecodable("pdf"))).toHaveLength(0);
	});

	// THE INCONSISTENCY, in one file: the other lock on the same load path
	// renders what it recognises. Same store, same function, same "do not
	// write this back" requirement - one shows the ink and the other does not.
	it("but a future-version sidecar DOES render on both surfaces, which is the shape the fix already has", async () => {
		const future = (s: "inline" | "pdf") => sidecar(s, [GOOD], 999);
		expect((await inlineStrokes(future("inline"))).map((x) => x.id)).toEqual(["s0"]);
		expect((await pdfStrokes(future("pdf"))).map((x) => x.id)).toEqual(["s0"]);
	});
});

/**
 * SLIDES, THE THIRD CALLER - pinned STRUCTURALLY, and I am labelling that
 * plainly because it is weaker than the two behavioural pins above.
 *
 * Driving `SlidesInkSurface` needs a `SlidesDeck` over ~300 lines of DOM fakes
 * that live inside `SlidesInkSurface.test.ts` and are not exported. Duplicating
 * them here for one assertion would be a second copy to keep in step, so this
 * reads the source instead - the idiom that file already uses on itself via
 * `?raw`. **These cases prove what the code says, not what it does.**
 *
 * What they establish is narrow and sufficient: on slides the damaged branch
 * and the future-version branch are the SAME BRANCH except for one line. Both
 * set `this.futureLocked`, the very lock whose documented meaning is
 * "read-only, still rendered", and both call `noticeReadOnly`. The only
 * difference is that one returns and the other falls through into the adopt
 * loop. That loop is the only place a stored stroke enters a slide list during
 * a load, so returning before it adopts nothing.
 *
 * Which makes slides the SAFEST of the three to change, not the riskiest: it
 * already arms the correct lock and merely leaves before using it.
 */
describe("slides refuses by returning, and its two locks differ only in that", () => {
	/** A slice of the surface's own source, with both anchors asserted. */
	function between(start: string, end: string): string {
		const a = surfaceSrc.indexOf(start);
		expect(a, `anchor missing, this file is testing nothing: ${start}`).toBeGreaterThan(-1);
		const b = surfaceSrc.indexOf(end, a + 1);
		expect(b, `anchor missing, this file is testing nothing: ${end}`).toBeGreaterThan(a);
		return surfaceSrc.slice(a, b);
	}

	const DAMAGED = "if (result.damaged) {";
	const FUTURE = "if (result.futureVersion !== undefined) {";
	const AFTER = "// A live reload keeps the displayed ink";

	it("arms the same read-only lock for both, so the write refusal is already identical", () => {
		expect(between(DAMAGED, FUTURE)).toContain("this.futureLocked = true;");
		expect(between(FUTURE, AFTER)).toContain("this.futureLocked = true;");
	});

	it("but returns out of the damaged branch and falls through the future one", () => {
		// TRIMMED LINES, not a regex and not a substring: the future branch
		// quotes the word "return" inside its own comment ("this used to
		// return here"), and a substring check reads that prose as code.
		const code = (region: string) => region.split(String.fromCharCode(10)).map((l) => l.trim());
		expect(code(between(DAMAGED, FUTURE))).toContain("return null;");
		expect(code(between(FUTURE, AFTER)).some((l) => l.startsWith("return"))).toBe(false);
	});

	it("and the adopt loop that fills the slide lists is downstream of both", () => {
		const adopt = surfaceSrc.indexOf("this.strokes.set(index, list);");
		expect(adopt, "the adopt loop moved; re-derive this file").toBeGreaterThan(-1);
		expect(adopt).toBeGreaterThan(surfaceSrc.indexOf(FUTURE));
	});
});
