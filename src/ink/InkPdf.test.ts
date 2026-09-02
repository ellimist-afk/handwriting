/**
 * The PDF writer, judged by the two things that make a file open or not: a
 * cross-reference table whose byte offsets actually land on their objects, and
 * a content stream whose numbers are legal PDF literals.
 *
 * Geometry is not re-tested here. It comes from StrokeOutline, which the SVG
 * export shares, and is already covered by the ribbon suites.
 */

import { afterEach, describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { strokeOutline } from "./StrokeOutline";
import { setInkShaping } from "./InkShape";
import {
	PX_TO_PT,
	discOps,
	inkPageBox,
	inkPdfContent,
	inkToPdf,
	pdfColor,
	pdfDocument,
	strokePdfOps,
} from "./InkPdf";

function stroke(
	tool: "pen" | "highlighter",
	xs: number[],
	y: number,
	color?: string
): InkStroke {
	const points = xs.map((x, i) => ({ x, y: y + i, pressure: 0.5, t: i * 8 }));
	return {
		id: `s-${tool}-${y}-${color ?? "d"}`,
		tool,
		color: color ?? (tool === "pen" ? "#4b7bec" : "#ffd60a"),
		width: 4,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

/**
 * The sub-paths a viewer would trace, from the operators actually emitted.
 * Beziers are sampled; everything else is followed literally.
 */
function subpaths(ops: string): { x: number; y: number }[][] {
	const out: { x: number; y: number }[][] = [];
	let cur: { x: number; y: number }[] = [];
	let at = { x: 0, y: 0 };
	let stack: number[] = [];
	for (const token of ops.trim().split(/\s+/)) {
		if (/^-?[\d.]+$/.test(token)) {
			stack.push(Number(token));
			continue;
		}
		const n = stack.length;
		if (token === "m") {
			if (cur.length > 0) out.push(cur);
			at = { x: stack[n - 2]!, y: stack[n - 1]! };
			cur = [at];
		} else if (token === "l") {
			at = { x: stack[n - 2]!, y: stack[n - 1]! };
			cur.push(at);
		} else if (token === "c") {
			const [x1, y1, x2, y2, x3, y3] = stack.slice(n - 6) as number[];
			for (let i = 1; i <= 8; i++) {
				const t = i / 8;
				const u = 1 - t;
				cur.push({
					x: u * u * u * at.x + 3 * u * u * t * x1! + 3 * u * t * t * x2! + t * t * t * x3!,
					y: u * u * u * at.y + 3 * u * u * t * y1! + 3 * u * t * t * y2! + t * t * t * y3!,
				});
			}
			at = { x: x3!, y: y3! };
		} else if (token === "h" && cur.length > 0) {
			out.push(cur);
			cur = [];
		}
		stack = [];
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

/** The nonzero winding number at a point: what decides whether it is filled. */
function windingAt(ops: string, px: number, py: number): number {
	let w = 0;
	for (const path of subpaths(ops)) {
		for (let i = 0; i < path.length; i++) {
			const a = path[i]!;
			const b = path[(i + 1) % path.length]!;
			const side = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
			if (a.y <= py) {
				if (b.y > py && side > 0) w++;
			} else if (b.y <= py && side < 0) w--;
		}
	}
	return w;
}

describe("the fill", () => {
	// The bug this exists for shipped invisible: every test passed, the file
	// opened, and the ink came out with a hole punched at every cap and joint
	// because the discs turned against the body. Nothing here asked what the
	// fill rule would actually DO, so this does.
	it("covers a disc that sits on the body instead of cancelling it", () => {
		const s = stroke("highlighter", [0, 20, 40, 60, 80], 100);
		const disc = strokeOutline(s)!.discs[0]!;
		expect(windingAt(strokePdfOps(s), disc.x, disc.y)).not.toBe(0);
	});

	it("covers it whichever way the stroke was drawn", () => {
		// The outline closes the other way round on a stroke drawn backwards,
		// so a disc direction fixed at write time is right only half the time.
		for (const xs of [[0, 20, 40, 60, 80], [80, 60, 40, 20, 0]]) {
			const s = stroke("pen", xs, 100);
			for (const disc of strokeOutline(s)!.discs) {
				expect(windingAt(strokePdfOps(s), disc.x, disc.y)).not.toBe(0);
			}
		}
	});

	it("leaves the paper outside the stroke alone", () => {
		const s = stroke("pen", [0, 20, 40], 100);
		expect(windingAt(strokePdfOps(s), -500, -500)).toBe(0);
	});
});

describe("export shaping (§5n: PDF export is always shaped)", () => {
	// StrokeOutline stopped reading inkShapingEnabled() for exports (Alan,
	// 2026-09-02): a Boox user's on-screen shaping-off setting was leaking
	// into every exported PDF for a screen-performance reason that has
	// nothing to do with paper. These pin that the PDF is now byte-identical
	// whichever way the toggle sits, for a pen stroke, and that a mouse
	// stroke and a highlighter stroke - never shaped in the first place -
	// were already unaffected by it.
	afterEach(() => setInkShaping(true));

	it("a pen stroke's pdf is unaffected by the ink-shaping toggle", () => {
		const s = stroke("pen", [10, 20, 40, 60, 90], 100);
		setInkShaping(true);
		const shapedOn = inkToPdf([s]);
		setInkShaping(false);
		const shapedOff = inkToPdf([s]);
		expect(shapedOff).toBe(shapedOn);
	});

	it("a mouse stroke's pdf is unaffected by the toggle (it was never shaped)", () => {
		const s: InkStroke = { ...stroke("pen", [10, 20, 40, 60, 90], 100), device: "mouse" };
		setInkShaping(true);
		const shapedOn = inkToPdf([s]);
		setInkShaping(false);
		const shapedOff = inkToPdf([s]);
		expect(shapedOff).toBe(shapedOn);
	});

	it("a highlighter stroke's pdf is unaffected by the toggle (it was never shaped)", () => {
		const s = stroke("highlighter", [10, 20, 40, 60, 90], 100);
		setInkShaping(true);
		const shapedOn = inkToPdf([s]);
		setInkShaping(false);
		const shapedOff = inkToPdf([s]);
		expect(shapedOff).toBe(shapedOn);
	});
});

describe("the cross-reference table", () => {
	// The offsets are the whole reason this file is assembled rather than
	// templated. Re-deriving them from the finished bytes is a check that can
	// FAIL: it reads the table, jumps to each offset, and asks whether the
	// object it claims is really there. A builder that miscounts by one byte
	// produces a file some readers open and others reject, which is the worst
	// possible failure to discover from a user.
	function xrefOffsets(pdf: string): number[] {
		const at = pdf.indexOf("xref\n");
		// "xref", the subsection header, then the mandatory free entry for
		// object 0, which is not an offset and is not in the list below.
		const lines = pdf.slice(at).split("\n").slice(3);
		const out: number[] = [];
		for (const line of lines) {
			const m = /^(\d{10}) 00000 n $/.exec(line);
			if (!m) break;
			out.push(Number.parseInt(m[1]!, 10));
		}
		return out;
	}

	it("every offset lands exactly on the object it names", () => {
		const pdf = inkToPdf([stroke("pen", [10, 20, 30], 40)]);
		const offsets = xrefOffsets(pdf);
		expect(offsets.length).toBe(5);
		offsets.forEach((off, i) => {
			expect(pdf.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
		});
	});

	it("startxref lands on the table itself", () => {
		const pdf = inkToPdf([stroke("pen", [10, 20], 40)]);
		const m = /startxref\n(\d+)\n%%EOF/.exec(pdf);
		expect(m).not.toBeNull();
		expect(pdf.slice(Number.parseInt(m![1]!, 10), Number.parseInt(m![1]!, 10) + 4)).toBe("xref");
	});

	it("declares a stream length matching the bytes it wrote", () => {
		// A short /Length truncates the drawing; a long one runs past the
		// stream and the page renders blank. Neither says anything on open.
		const pdf = inkToPdf([stroke("pen", [10, 20, 30], 40)]);
		const declared = Number.parseInt(/\/Length (\d+)/.exec(pdf)![1]!, 10);
		const body = pdf.slice(pdf.indexOf("stream\n") + 7, pdf.indexOf("\nendstream"));
		expect(body.length).toBe(declared);
	});

	it("opens and closes like a pdf", () => {
		const pdf = inkToPdf([stroke("pen", [10, 20], 40)]);
		expect(pdf.startsWith("%PDF-1.7\n")).toBe(true);
		expect(pdf.endsWith("%%EOF\n")).toBe(true);
	});
});

describe("numbers", () => {
	it("never writes exponent notation", () => {
		// `1e-7` is a syntax error in a content stream, not a small number,
		// and the whole page silently fails to draw.
		const ops = discOps({ x: 0.0000001, y: 1e21, r: 0.0000004 });
		expect(ops).not.toMatch(/e[+-]?\d/i);
		const content = inkPdfContent([stroke("pen", [0.000001, 0.000002], 0)], 100);
		expect(content).not.toMatch(/e[+-]?\d/i);
	});

	it("writes colours as three components in 0..1", () => {
		expect(pdfColor("pen", "#000000")).toBe("0 0 0");
		expect(pdfColor("pen", "#ffffff")).toBe("1 1 1");
	});

	it("refuses a colour the sidecar could have invented", () => {
		// Same guard the svg export uses: nothing user-authored reaches the
		// document, so there is no string to escape and nothing to inject.
		expect(pdfColor("pen", '#f00" /X (')).toBe(pdfColor("pen", undefined));
	});
});

describe("the content stream", () => {
	it("flips the origin once, at the top", () => {
		// PDF counts y upward from the bottom; ink counts it downward from the
		// top. One transform, or every stroke is upside down.
		const content = inkPdfContent([stroke("pen", [10, 20], 40)], 500);
		expect(content.startsWith("q 1 0 0 -1 0 500 cm ")).toBe(true);
		expect(content.endsWith("Q")).toBe(true);
	});

	it("merges consecutive strokes of one colour into a single fill", () => {
		const content = inkPdfContent(
			[stroke("pen", [10, 20], 40, "#111111"), stroke("pen", [30, 40], 60, "#111111")],
			500
		);
		expect(content.match(/ f /g)?.length ?? 0).toBe(1);
	});

	it("breaks the run when the colour changes, preserving paint order", () => {
		// Grouping every red together would lift early reds above a blue that
		// was drawn over them.
		const content = inkPdfContent(
			[
				stroke("pen", [10, 20], 40, "#111111"),
				stroke("pen", [30, 40], 60, "#222222"),
				stroke("pen", [50, 60], 80, "#111111"),
			],
			500
		);
		expect(content.match(/ f /g)?.length ?? 0).toBe(3);
	});

	it("puts highlighter under the pen, inside the alpha state", () => {
		const content = inkPdfContent(
			[stroke("pen", [10, 20], 40), stroke("highlighter", [10, 20], 40)],
			500
		);
		const alpha = content.indexOf("/GSa gs");
		expect(alpha).toBeGreaterThan(-1);
		// The highlighter group closes before any pen fill is emitted.
		expect(content.indexOf("Q ", alpha)).toBeLessThan(content.lastIndexOf(" rg"));
	});

	it("says nothing about a stroke with no points", () => {
		expect(strokePdfOps(stroke("pen", [], 0))).toBe("");
		expect(inkToPdf([stroke("pen", [], 0)])).toBe("");
		expect(inkToPdf([])).toBe("");
	});
});

describe("the page", () => {
	it("is measured in points, from a box measured in pixels", () => {
		const pdf = pdfDocument(800, 1000, "");
		expect(pdf).toContain(`/MediaBox [0 0 ${800 * PX_TO_PT} ${1000 * PX_TO_PT}]`);
	});

	it("is sized to the ink, with room around it", () => {
		const box = inkPageBox([stroke("pen", [100, 200], 300)]);
		expect(box.w).toBeGreaterThan(200);
		expect(box.h).toBeGreaterThan(300);
	});

	it("ignores strokes that hold nothing when sizing", () => {
		const withEmpty = inkPageBox([stroke("pen", [100], 100), stroke("pen", [], 9999)]);
		const without = inkPageBox([stroke("pen", [100], 100)]);
		expect(withEmpty).toEqual(without);
	});
});
