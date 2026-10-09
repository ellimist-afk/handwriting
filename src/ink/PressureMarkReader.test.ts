/**
 * PR 31 reader: a stroke may carry
 * `pressureSensitivity: "on" | "off"`, the pressure setting it was written
 * under. A stroke that carries it is painted, cached and exported under that
 * value whatever the switch says now; a stroke without it (all ink saved
 * before 1.4.24, and any value this build does not know) follows the switch
 * exactly as it did in 1.4.22. Nothing in 1.4.23 writes the field.
 *
 * The 1.4.22 fixture was frozen by executing refs/tags/1.4.22, not by calling
 * today's code.
 */
import { afterEach, describe, expect, it } from "vitest";
import frozen from "../../test/fixtures/pressure-mark-1.4.22.json";
import { parsePage, serializePage } from "../model/PageData";
import { drawStroke, resetRibbonCacheStats, ribbonCacheStats } from "./StrokeRenderer";
import { ribbonOf } from "./StrokeOutline";
import { strokePathData } from "./SvgExport";
import { strokePdfOps } from "./InkPdf";
import { pressureSensitivityEnabled, setPressureSensitivity } from "./PenStyle";
import type { InkStroke } from "./Stroke";

const CAM = { x: 0, y: 0, zoom: 1 };

/** A 2D context that records every call and property write, in order. */
function recorder(): { ctx: CanvasRenderingContext2D; log: unknown[] } {
	const log: unknown[] = [];
	const state: Record<string, unknown> = {};
	const ctx = new Proxy(state, {
		get(t, p) {
			if (typeof p !== "string") return undefined;
			if (p in t) return t[p];
			return (...args: unknown[]) => void log.push([p, ...args]);
		},
		set(t, p, v) {
			t[p as string] = v;
			log.push([`=${String(p)}`, v]);
			return true;
		},
	});
	return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

/** What the committed layer paints for this stroke under the switch as it is now. */
function drawn(stroke: InkStroke, cacheRibbon = false): unknown[] {
	const { ctx, log } = recorder();
	drawStroke(ctx, CAM, stroke, undefined, true, cacheRibbon);
	return log;
}

function loaded(): InkStroke[] {
	const parsed = parsePage(
		JSON.stringify({ schemaVersion: 1, pageId: "pressure-mark-1422", strokes: frozen.stored }),
		"pressure-mark-1422"
	);
	expect(parsed.damaged).toBeUndefined();
	return parsed.data.strokes;
}

/** The mark as the loader left it, read without leaning on the field's type. */
function markOf(stroke: InkStroke): unknown {
	return (stroke as { pressureSensitivity?: unknown }).pressureSensitivity;
}

function marked(stroke: InkStroke, value: "on" | "off"): InkStroke {
	return { ...stroke, pressureSensitivity: value } as InkStroke;
}

afterEach(() => setPressureSensitivity(true));

describe("a 1.4.22 ink file paints exactly as 1.4.22 painted it, with pressure on and with it off", () => {
	for (const c of frozen.cases) {
		it(`${c.id}, pressure ${c.pressureOn ? "on" : "off"}: committed draw, export ribbon, SVG path and PDF ops`, () => {
			const stroke = loaded().find((s) => s.id === c.id)!;
			setPressureSensitivity(c.pressureOn);
			expect(drawn(stroke), "committed draw").toEqual(c.drawLog);
			expect(ribbonOf(stroke), "export ribbon").toEqual(c.ribbon);
			expect(strokePathData(stroke), "SVG path").toBe(c.svg);
			expect(strokePdfOps(stroke), "PDF ops").toBe(c.pdf);
		});
	}
});

describe("a stroke marked with its pressure setting paints under that setting, whatever the switch says", () => {
	for (const value of ["off", "on"] as const) {
		it(`marked ${value}: the same with the switch on and off, and the same as an unmarked stroke under ${value}`, () => {
			for (const stroke of loaded()) {
				setPressureSensitivity(value === "on");
				const reference = drawn(stroke);
				setPressureSensitivity(true);
				expect(drawn(marked(stroke, value)), `${stroke.id}, switch on`).toEqual(reference);
				setPressureSensitivity(false);
				expect(drawn(marked(stroke, value)), `${stroke.id}, switch off`).toEqual(reference);
			}
		});
	}

	it("an unmarked stroke still follows the switch (control)", () => {
		const stroke = loaded().find((s) => s.id === "pen-exp7")!;
		setPressureSensitivity(true);
		const on = drawn(stroke);
		setPressureSensitivity(false);
		expect(drawn(stroke)).not.toEqual(on);
	});
});

describe("the mark round-trips through the ink file, v1 and v2", () => {
	for (const version of [1, 2]) {
		it(`v${version}: "on" and "off" load onto the stroke and save back; an unknown value reads as absent and saves back as written`, () => {
			const base = frozen.stored[0]!;
			const file = {
				schemaVersion: 1,
				pageId: "mark-round-trip",
				strokes: [
					{ ...base, id: "a", pressureSensitivity: "on" },
					{ ...base, id: "b", pressureSensitivity: "off" },
					{ ...base, id: "c", pressureSensitivity: "sideways" },
					{ ...base, id: "d" },
				],
			};
			const first = parsePage(JSON.stringify(file), "mark-round-trip");
			expect(first.damaged).toBeUndefined();
			const read = new Map(first.data.strokes.map((s) => [s.id, markOf(s)]));
			expect(read.get("a")).toBe("on");
			expect(read.get("b")).toBe("off");
			expect(read.get("c"), "an unknown value reads as absent").toBeUndefined();
			expect(read.get("d")).toBeUndefined();

			const saved = JSON.parse(serializePage(first.data, version)) as { strokes: Array<Record<string, unknown>> };
			const written = new Map(saved.strokes.map((s) => [s.id, s.pressureSensitivity]));
			expect(written.get("a")).toBe("on");
			expect(written.get("b")).toBe("off");
			expect(written.get("c"), "an unknown value is written back as found").toBe("sideways");
			expect(saved.strokes.find((s) => s.id === "d")).not.toHaveProperty("pressureSensitivity");

			const again = parsePage(JSON.stringify(saved), "mark-round-trip");
			expect(again.data.strokes.map(markOf)).toEqual(["on", "off", undefined, undefined]);
		});
	}
});

describe("flipping the switch re-flattens unmarked strokes only", () => {
	it("a marked stroke keeps its cached ribbon when the switch flips; an unmarked one is flattened again", () => {
		const [plain] = loaded();
		const mark = marked(loaded()[0]!, "off");
		setPressureSensitivity(true);
		drawn(plain!, true);
		drawn(mark, true);
		resetRibbonCacheStats();
		setPressureSensitivity(false);
		drawn(mark, true);
		expect(ribbonCacheStats().hits, "the marked stroke after the flip").toBe(1);
		expect(ribbonCacheStats().misses).toBe(0);
		drawn(plain!, true);
		expect(ribbonCacheStats().misses, "the unmarked stroke after the flip").toBe(1);
	});
});

describe("SVG export and PDF ink follow the mark", () => {
	for (const value of ["off", "on"] as const) {
		it(`marked ${value}: the same SVG path and PDF ops with the switch on and off, equal to an unmarked stroke under ${value}`, () => {
			for (const stroke of loaded()) {
				setPressureSensitivity(value === "on");
				const svg = strokePathData(stroke);
				const pdf = strokePdfOps(stroke);
				for (const sw of [true, false]) {
					setPressureSensitivity(sw);
					expect(strokePathData(marked(stroke, value)), `${stroke.id} SVG, switch ${sw ? "on" : "off"}`).toBe(svg);
					expect(strokePdfOps(marked(stroke, value)), `${stroke.id} PDF, switch ${sw ? "on" : "off"}`).toBe(pdf);
				}
			}
		});
	}
});

describe("a mark of the wrong type reads as absent and is written back as found", () => {
	for (const version of [1, 2]) {
		it(`v${version}: a number and true load as no mark, the stroke follows the switch, and a save writes each back unchanged`, () => {
			const base = frozen.stored[0]!;
			const file = {
				schemaVersion: 1,
				pageId: "mark-wrong-type",
				strokes: [
					{ ...base, id: "number", pressureSensitivity: 0 },
					{ ...base, id: "true", pressureSensitivity: true },
				],
			};
			const first = parsePage(JSON.stringify(file), "mark-wrong-type");
			expect(first.damaged).toBeUndefined();
			for (const stroke of first.data.strokes) {
				expect(markOf(stroke), `${stroke.id} reads as absent`).toBeUndefined();
				setPressureSensitivity(false);
				const off = drawn(stroke);
				setPressureSensitivity(true);
				expect(drawn(stroke), `${stroke.id} follows the switch`).not.toEqual(off);
			}
			const saved = JSON.parse(serializePage(first.data, version)) as { strokes: Array<Record<string, unknown>> };
			const written = new Map(saved.strokes.map((s) => [s.id, s.pressureSensitivity]));
			expect(written.get("number"), "a number is written back as found").toBe(0);
			expect(written.get("true"), "true is written back as found").toBe(true);
		});
	}
});

describe("a draw or an export that throws leaves the switch as it was", () => {
	/** A 2D context whose every call throws, so the draw fails part way. */
	function failing(): CanvasRenderingContext2D {
		return new Proxy({}, {
			get: (_t, p) => (typeof p === "string" ? () => { throw new Error(`draw failed at ${p}`); } : undefined),
			set: () => true,
		}) as unknown as CanvasRenderingContext2D;
	}

	/** The stroke with its points made unreadable, so the flatten fails part way. */
	function unreadable(stroke: InkStroke): InkStroke {
		const copy = { ...stroke };
		Object.defineProperty(copy, "points", { get: () => { throw new Error("points unreadable"); } });
		return copy;
	}

	for (const [sw, value] of [[true, "off"], [false, "on"]] as const) {
		it(`switch ${sw ? "on" : "off"}, stroke marked ${value}: after a failed draw and a failed export, an unmarked stroke paints under the switch`, () => {
			const stroke = loaded().find((s) => s.id === "pen-exp7")!;
			setPressureSensitivity(sw);
			const reference = drawn(stroke);
			const ribbon = ribbonOf(stroke);

			expect(() => drawStroke(failing(), CAM, marked(stroke, value), undefined, true, false)).toThrow();
			expect(pressureSensitivityEnabled(), "after the failed draw").toBe(sw);
			expect(drawn(stroke), "an unmarked stroke after the failed draw").toEqual(reference);

			expect(() => ribbonOf(unreadable(marked(stroke, value)))).toThrow();
			expect(pressureSensitivityEnabled(), "after the failed export").toBe(sw);
			expect(ribbonOf(stroke), "an unmarked ribbon after the failed export").toEqual(ribbon);
		});
	}
});

describe("PDF ink follows the mark, read on its own", () => {
	for (const value of ["off", "on"] as const) {
		it(`marked ${value}: the same PDF ops with the switch on and off, equal to an unmarked stroke under ${value}`, () => {
			for (const stroke of loaded()) {
				setPressureSensitivity(value === "on");
				const pdf = strokePdfOps(stroke);
				for (const sw of [true, false]) {
					setPressureSensitivity(sw);
					expect(strokePdfOps(marked(stroke, value)), `${stroke.id} PDF, switch ${sw ? "on" : "off"}`).toBe(pdf);
				}
			}
		});
	}
});
