/**
 * Ink saved before strokes carried their own pressure setting has no mark. Those strokes draw under one stored value,
 * the legacy key, taken once from the switch when this build first launched; the switch then sets new strokes only.
 * So an unmarked stroke paints, caches and exports exactly as 1.4.22 painted it under the legacy value, whatever the
 * switch says, and flipping the switch redraws nothing. With no legacy value (never set) an unmarked stroke still
 * follows the switch, which is what every earlier build did.
 */
import { afterEach, describe, expect, it } from "vitest";
import frozen from "../../test/fixtures/pressure-mark-1.4.22.json";
import { parsePage } from "../model/PageData";
import { drawStroke, resetRibbonCacheStats, ribbonCacheStats } from "./StrokeRenderer";
import { ribbonOf } from "./StrokeOutline";
import { strokePathData } from "./SvgExport";
import { strokePdfOps } from "./InkPdf";
import { setLegacyInkPressure, setPressureSensitivity } from "./PenStyle";
import { inkLookKey } from "../inline/InkOverlayConstants";
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

afterEach(() => {
	setPressureSensitivity(true);
	setLegacyInkPressure(null);
});

describe("an unmarked stroke draws under the legacy key, whatever the switch says", () => {
	for (const c of frozen.cases) {
		it(`${c.id}, legacy ${c.pressureOn ? "on" : "off"}, switch the other way: committed draw, export ribbon, SVG path and PDF ops as 1.4.22 drew them`, () => {
			const stroke = loaded().find((s) => s.id === c.id)!;
			expect(stroke.pressureSensitivity, "premise: the 1.4.22 stroke carries no mark").toBeUndefined();
			setLegacyInkPressure(c.pressureOn);
			setPressureSensitivity(!c.pressureOn);
			expect(drawn(stroke), "committed draw").toEqual(c.drawLog);
			expect(ribbonOf(stroke), "export ribbon").toEqual(c.ribbon);
			expect(strokePathData(stroke), "SVG path").toBe(c.svg);
			expect(strokePdfOps(stroke), "PDF ops").toBe(c.pdf);
		});
	}

	it("a marked stroke still draws under its own mark, not the legacy key", () => {
		const stroke = { ...loaded().find((s) => s.id === "pen-exp7")!, pressureSensitivity: "on" as const };
		setLegacyInkPressure(false);
		setPressureSensitivity(false);
		const underMark = drawn(stroke);
		setLegacyInkPressure(null);
		setPressureSensitivity(true);
		expect(drawn(loaded().find((s) => s.id === "pen-exp7")!), "an unmarked stroke under the switch on").toEqual(underMark);
	});

	it("CONTROL: with no legacy value, an unmarked stroke follows the switch", () => {
		const stroke = loaded().find((s) => s.id === "pen-exp7")!;
		setPressureSensitivity(true);
		const on = drawn(stroke);
		setPressureSensitivity(false);
		expect(drawn(stroke)).not.toEqual(on);
	});
});

describe("flipping the switch changes no saved stroke's ribbon", () => {
	for (const legacy of [true, false]) {
		it(`legacy ${legacy ? "on" : "off"}: unmarked and marked strokes keep their cached ribbons across a flip, and paint the same`, () => {
			setLegacyInkPressure(legacy);
			const strokes = [...loaded(), { ...loaded()[0]!, pressureSensitivity: "off" as const }, { ...loaded()[0]!, pressureSensitivity: "on" as const }];
			setPressureSensitivity(true);
			const before = strokes.map((s) => drawn(s, true));
			resetRibbonCacheStats();
			setPressureSensitivity(false);
			const after = strokes.map((s) => drawn(s, true));
			expect(after).toEqual(before);
			expect(ribbonCacheStats().misses, "no stroke was flattened again").toBe(0);
		});

		it(`legacy ${legacy ? "on" : "off"}: export ribbon, SVG path and PDF ops are the same before and after a flip`, () => {
			setLegacyInkPressure(legacy);
			const strokes = loaded();
			const read = () => strokes.map((s) => [ribbonOf(s), strokePathData(s), strokePdfOps(s)]);
			setPressureSensitivity(true);
			const before = read();
			setPressureSensitivity(false);
			expect(read()).toEqual(before);
		});
	}

	it("the extent raster's look key does not move with the switch once the legacy key is set, and moves with the legacy key", () => {
		setLegacyInkPressure(true);
		setPressureSensitivity(true);
		const on = inkLookKey();
		setPressureSensitivity(false);
		expect(inkLookKey(), "a flip of the switch").toBe(on);
		setLegacyInkPressure(false);
		expect(inkLookKey(), "a change of the legacy key").not.toBe(on);
	});
});
