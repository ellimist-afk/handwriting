/**
 * A theme's paper pitch set by a stylesheet rule with a priority.
 *
 * The overlay writes its planned pitch inline on the editor. A stylesheet rule with `!important` beats an inline value
 * without one, so the scroller paints the theme's pitch while the overlay's inline write stands unseen. The scroller
 * route folds the paper's pan by the pitch the overlay recorded; a record of a pitch that does not paint folds the pan
 * by the wrong lattice, and the paper slides against the text through a pinch or a pan.
 *
 * The bound: under a pitch the overlay's inline value does not win, the scroller route's pan is folded by the pitch
 * that paints or not at all, and the overlay records no pitch that does not paint. No style read or write is added on
 * a re-plan that writes nothing (every preview frame's).
 *
 * Rig: the real InkOverlayPlugin off its prototype; writePaperVars and writePaperPan are the real ones. The host's
 * computed style is a small cascade: a stylesheet value with a priority wins, then the inline value, then a stylesheet
 * value without one. Each computed read is counted.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import * as registry from "./InkOverlayRegistry";
import { paperPlan } from "./PaperPlan";

type Fields = Record<string, any>;
const PITCH = "--handwriting-paper-pitch", PAN_Y = "--handwriting-paper-pan-y";

function styleOf() {
	const props = new Map<string, string>(), priority = new Map<string, string>();
	return {
		props,
		style: {
			getPropertyValue: (n: string) => props.get(n) ?? "",
			getPropertyPriority: (n: string) => priority.get(n) ?? "",
			setProperty: (n: string, v: string, p = "") => { props.set(n, v); if (p) priority.set(n, p); else priority.delete(n); },
			removeProperty: (n: string) => { props.delete(n); priority.delete(n); },
		},
	};
}

/**
 * The overlay over a host whose stylesheet sets `sheet` for the pitch (with `!important` when `important`), and a
 * scroller (the editor's child, the element that paints the paper) whose stylesheet sets `scrollerSheet`. The scroller
 * inherits the host's computed pitch unless a rule of its own sets one, which wins with or without a priority.
 */
function rig(sheet: { value: string; important: boolean } | null, scrollerSheet: { value: string } | null = null) {
	const host = styleOf(), scroller = styleOf();
	let reads = 0;
	const computed = (n: string): string => {
		if (n === PITCH && sheet?.important) return sheet.value;
		const inline = host.props.get(n);
		if (inline) return inline;
		return n === PITCH && sheet ? sheet.value : "";
	};
	const scrollerComputed = (n: string): string => n === PITCH && scrollerSheet?.value ? scrollerSheet.value : computed(n);
	const scrollEl = { style: scroller.style };
	const win = { getComputedStyle: (el: unknown) => { reads++; return { getPropertyValue: el === scrollEl ? scrollerComputed : computed }; } };
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	let panY = 0;
	Object.assign(o, {
		view: { dom: { isConnected: true, style: host.style, ownerDocument: { defaultView: win } }, scrollDOM: scrollEl },
		paperWritten: new Map<string, string>(), paperPanWritten: null, paperGridBox: null, paperGridBoxPanX: "",
		cssScale: 1, pinchPreview: false, previewPaperEl: null, paperSnapResidual: { x: 0, y: 0 },
		panX: () => 0, panY: () => panY, paperColumnDrift: 0, paperRewrapY: 0,
	});
	return {
		o, host, scroller,
		get reads() { return reads; },
		/** One plan at 16 px text with 24 px rows written, as updatePaperSpacing writes it. */
		plan(row = 24): boolean { return o.writePaperVars(paperPlan(16, 0, 2, 0, row)!); },
		/** The text moved `y` layout px against the scroller; the scroller route writes the paper's pan. */
		pan(y: number): string | undefined { panY = y; o.writePaperPan(); return scroller.props.get(PAN_Y); },
		/** The pitch the scroller paints. */
		painted(): string { return scrollerComputed(PITCH); },
	};
}

describe("a theme's pitch set by a stylesheet rule with a priority", () => {
	it("the overlay records no pitch that does not paint, and the pan of a drag of three and a half 40 px pitches is not folded by 24", () => {
		const r = rig({ value: "calc(20px + 20px)", important: true });
		r.plan();
		expect(r.painted(), "premise: the theme's pitch paints").toBe("calc(20px + 20px)");
		expect(r.o.paperWritten.get(PITCH), "no record of a pitch that does not paint").toBeUndefined();
		// 140 = 3.5 x 40: 20 mod 24, 20 mod 40. Folded by the pitch that paints or not at all; never by the 24 that does not.
		expect(r.pan(140), "the pan of the drag, not folded by the unpainted 24").toBe("140px");
	});

	it("the same at a second drag, a whole multiple of neither pitch", () => {
		const r = rig({ value: "calc(20px + 20px)", important: true });
		r.plan();
		// 90 = 2.25 x 40 = 3.75 x 24.
		expect(r.pan(90), "the pan of the drag, not folded by the unpainted 24").toBe("90px");
	});

	it("a px pitch the theme holds with a priority: no record, no fold by the planned pitch", () => {
		const r = rig({ value: "40px", important: true });
		r.plan();
		expect(r.o.paperWritten.get(PITCH), "no record of a pitch that does not paint").toBeUndefined();
		const pan = Number.parseFloat(r.pan(140) ?? "");
		// Folded by the painted 40 (20) or not at all (140); 140 mod 24 = 20 too, so the second drag tells the 24 apart.
		expect([20, 140], "the pan of the drag at 40 px").toContain(pan);
		const second = Number.parseFloat(r.pan(90) ?? "");
		expect([10, 90], "90 mod 40 = 10, not 90 mod 24 = 18").toContain(second);
	});

	it("re-plans that change nothing read and write no style, under the theme's pitch and without it", () => {
		for (const sheet of [{ value: "calc(20px + 20px)", important: true }, null]) {
			const r = rig(sheet);
			r.plan();
			const reads = r.reads, inline = r.host.props.get(PITCH);
			// A preview frame's re-plan: the same pitch at the new zoom.
			for (let i = 0; i < 5; i++) r.plan();
			expect(r.reads, `no computed read on a re-plan that writes nothing (${sheet ? "theme" : "no theme"})`).toBe(reads);
			expect(r.host.props.get(PITCH), `no inline change on such a re-plan (${sheet ? "theme" : "no theme"})`).toBe(inline);
		}
	});

	it("pin: a pitch the host holds inline is the host's: no write, no record, the pan unfolded, as before", () => {
		const r = rig(null);
		r.host.style.setProperty(PITCH, "40px");
		r.plan();
		expect(r.host.props.get(PITCH), "the host's inline pitch stays").toBe("40px");
		expect(r.o.paperWritten.get(PITCH), "no record").toBeUndefined();
		expect(r.pan(90), "unfolded").toBe("90px");
	});

	it("pin: a note with no host pitch: the overlay's pitch paints, is recorded, and folds the pan, as before", () => {
		const r = rig(null);
		expect(r.plan(), "a write").toBe(true);
		expect(r.painted(), "the planned pitch paints").toBe("24px");
		expect(r.o.paperWritten.get(PITCH), "recorded").toBe("24px");
		expect(r.pan(90), "90 mod 24").toBe("18px");
	});

	it("pin: a theme pitch without a priority loses to the overlay's inline write, as before", () => {
		const r = rig({ value: "40px", important: false });
		r.plan();
		expect(r.painted(), "the planned pitch paints").toBe("24px");
		expect(r.o.paperWritten.get(PITCH), "recorded").toBe("24px");
		expect(r.pan(90), "90 mod 24").toBe("18px");
	});

	it("a new plan tries again: the theme's rule gone, the overlay's pitch paints and is recorded", () => {
		const sheet = { value: "calc(20px + 20px)", important: true };
		const r = rig(sheet);
		r.plan();
		expect(r.o.paperWritten.get(PITCH), "premise: refused under the theme").toBeUndefined();
		sheet.important = false; sheet.value = "";
		r.plan(30);
		expect(r.painted(), "the new plan paints").toBe("30px");
		expect(r.o.paperWritten.get(PITCH), "recorded").toBe("30px");
	});
});

describe("a theme's pitch set on the scroller, the element that paints", () => {
	// A rule on .cm-scroller beats the value it inherits from the editor with or without a priority, and the editor's own
	// computed value still equals the overlay's: the check must read the element that paints.
	it("a scroller rule without a priority: no record, and the pan of a drag of 3.5 and 2.25 40 px pitches is not folded by 24", () => {
		const r = rig(null, { value: "calc(20px + 20px)" });
		r.plan();
		expect(r.painted(), "premise: the theme's pitch paints").toBe("calc(20px + 20px)");
		expect(r.o.paperWritten.get(PITCH), "no record of a pitch that does not paint").toBeUndefined();
		expect(r.pan(140), "140 = 3.5 x 40, not folded by the unpainted 24").toBe("140px");
		expect(r.pan(90), "90 = 2.25 x 40, not folded by the unpainted 24").toBe("90px");
	});

	it("a re-plan at the same value under the scroller rule reads and writes nothing", () => {
		const r = rig(null, { value: "calc(20px + 20px)" });
		r.plan();
		const reads = r.reads;
		for (let i = 0; i < 5; i++) r.plan();
		expect(r.reads, "no computed read on a re-plan that writes nothing").toBe(reads);
		expect(r.host.props.get(PITCH), "no inline pitch left").toBeUndefined();
	});
});

describe("a theme switch ends a refusal", () => {
	const paperCssChangeAll = () => (registry as unknown as { paperCssChangeAll?: () => void }).paperCssChangeAll?.();
	const withInstance = (o: Fields, fn: () => void) => {
		registry.instances.add(o as unknown as InkOverlayPlugin);
		try { fn(); } finally { registry.instances.delete(o as unknown as InkOverlayPlugin); }
	};

	it("refused under a theme, the theme left: the css-change and the same plan write the pitch, record it and fold by it", () => {
		const sheet = { value: "calc(20px + 20px)", important: true };
		const r = rig(sheet);
		r.plan();
		expect(r.o.paperWritten.get(PITCH), "premise: refused under the theme").toBeUndefined();
		sheet.important = false; sheet.value = "";
		r.o.updatePaperSpacing = () => r.plan();
		withInstance(r.o, paperCssChangeAll);
		r.plan();
		expect(r.painted(), "the overlay's pitch paints, not the stylesheet's 28 fallback").toBe("24px");
		expect(r.o.paperWritten.get(PITCH), "recorded").toBe("24px");
		expect(r.pan(90), "90 mod 24").toBe("18px");
	});

	it("the css-change re-plans at rest, and not on a preview frame (the refusal still ends)", () => {
		for (const preview of [false, true]) {
			const r = rig({ value: "calc(20px + 20px)", important: true });
			r.plan();
			let replans = 0;
			r.o.updatePaperSpacing = () => { replans++; };
			r.o.pinchPreview = preview;
			withInstance(r.o, paperCssChangeAll);
			expect(replans, `re-plans on the css-change (${preview ? "preview" : "at rest"})`).toBe(preview ? 0 : 1);
			expect(r.o.paperPitchRefused, `the refusal ends (${preview ? "preview" : "at rest"})`).toBeNull();
		}
	});
});

describe("a theme switch to a theme that holds the pitch ends the record (the reverse of a theme switch that ends a refusal)", () => {
	const paperCssChangeAll = () => registry.paperCssChangeAll();
	const withInstance = (o: Fields, fn: () => void) => {
		registry.instances.add(o as unknown as InkOverlayPlugin);
		try { fn(); } finally { registry.instances.delete(o as unknown as InkOverlayPlugin); }
	};
	// Theme 1 holds nothing: the overlay's 24 paints and is recorded, and a drag of 90 (3.75 x 24, 2.25 x 40) folds to 18.
	// Theme 2 holds calc(20px + 20px): on the scroller with no priority, or on the editor with one.
	const arms = [
		{ name: "rule on the scroller", hold: (r: { scrollerSheet: { value: string }; sheet: { value: string; important: boolean } }) => { r.scrollerSheet.value = "calc(20px + 20px)"; } },
		{ name: "rule on the editor with a priority", hold: (r: { scrollerSheet: { value: string }; sheet: { value: string; important: boolean } }) => { r.sheet.value = "calc(20px + 20px)"; r.sheet.important = true; } },
	];
	const start = () => {
		const sheet = { value: "", important: false }, scrollerSheet = { value: "" };
		const r = rig(sheet, scrollerSheet);
		r.o.updatePaperSpacing = () => r.plan();
		r.plan();
		expect(r.o.paperWritten.get(PITCH), "premise: theme 1, the overlay's pitch is recorded").toBe("24px");
		expect(r.pan(90), "premise: theme 1, 90 mod 24").toBe("18px");
		return { r, sheet, scrollerSheet };
	};

	for (const arm of arms) {
		it(`${arm.name}: the css-change drops the record and the inline pitch, and the pan of the drag goes unfolded`, () => {
			const { r, sheet, scrollerSheet } = start();
			arm.hold({ sheet, scrollerSheet });
			expect(r.painted(), "premise: theme 2's pitch paints").toBe("calc(20px + 20px)");
			withInstance(r.o, paperCssChangeAll);
			expect(r.o.paperWritten.get(PITCH), "no record of a pitch that no longer paints").toBeUndefined();
			expect(r.host.props.get(PITCH), "the overlay's inline pitch taken off").toBeUndefined();
			expect(r.scroller.props.get(PAN_Y), "the standing pan re-written, not folded by the unpainted 24").toBe("90px");
			expect(r.pan(140), "a later drag, 3.5 x 40 and 5.83 x 24, not folded by 24").toBe("140px");
		});

		it(`${arm.name}: the css-change that drops the record reads the computed style once`, () => {
			const { r, sheet, scrollerSheet } = start();
			arm.hold({ sheet, scrollerSheet });
			const before = r.reads;
			withInstance(r.o, paperCssChangeAll);
			expect(r.o.paperWritten.get(PITCH), "premise: the record dropped").toBeUndefined();
			expect(r.reads - before, "one computed read, the re-plan at the refused value reads nothing").toBe(1);
		});

		it(`${arm.name}: a css-change on a preview frame, the release's at-rest plan reads once and drops the record`, () => {
			const { r, sheet, scrollerSheet } = start();
			arm.hold({ sheet, scrollerSheet });
			r.o.pinchPreview = true;
			const atPreview = r.reads;
			withInstance(r.o, paperCssChangeAll);
			expect(r.reads, "no read on the preview frame").toBe(atPreview);
			r.o.pinchPreview = false;
			const before = r.reads;
			r.plan();
			expect(r.o.paperWritten.get(PITCH), "no record of a pitch that no longer paints after the release").toBeUndefined();
			expect(r.host.props.get(PITCH), "the overlay's inline pitch taken off").toBeUndefined();
			expect(r.reads - before, "one read at the release").toBe(1);
			expect(r.scroller.props.get(PAN_Y), "the standing pan re-written unfolded").toBe("90px");
			const after = r.reads;
			r.plan();
			expect(r.reads, "the check is spent: the next re-plan reads nothing").toBe(after);
		});

		it(`${arm.name}: theme 1 again, the next css-change writes and records the pitch and folds by it`, () => {
			const { r, sheet, scrollerSheet } = start();
			arm.hold({ sheet, scrollerSheet });
			withInstance(r.o, paperCssChangeAll);
			sheet.value = ""; sheet.important = false; scrollerSheet.value = "";
			withInstance(r.o, paperCssChangeAll);
			expect(r.o.paperWritten.get(PITCH), "recorded again").toBe("24px");
			expect(r.pan(90), "90 mod 24").toBe("18px");
		});
	}

	it("a pitch the host set inline after the overlay's record is the host's: a css-change neither reads nor takes it off", () => {
		const { r } = start();
		r.host.style.setProperty(PITCH, "40px");
		const before = r.reads;
		withInstance(r.o, paperCssChangeAll);
		expect(r.host.props.get(PITCH), "the host's inline pitch stays").toBe("40px");
		expect(r.reads - before, "no read of a pitch that is not the overlay's").toBe(0);
	});

	it("caps: a css-change at rest reads the computed style at most once and leaves a painting pitch alone; on a preview frame it reads and writes nothing", () => {
		const { r } = start();
		const before = r.reads;
		withInstance(r.o, paperCssChangeAll);
		expect(r.reads - before, "at most one computed read per css-change at rest").toBeLessThanOrEqual(1);
		expect([r.o.paperWritten.get(PITCH), r.host.props.get(PITCH)], "a pitch that still paints stays recorded and inline").toEqual(["24px", "24px"]);
		const spent = r.reads;
		r.plan();
		expect(r.reads, "the css-change's check is spent: the next re-plan reads nothing").toBe(spent);
		r.o.pinchPreview = true;
		const reads = r.reads, inline = r.host.props.get(PITCH), pan = r.scroller.props.get(PAN_Y);
		withInstance(r.o, paperCssChangeAll);
		expect(r.reads, "no computed read on a preview frame").toBe(reads);
		expect([r.host.props.get(PITCH), r.scroller.props.get(PAN_Y)], "no write on a preview frame").toEqual([inline, pan]);
	});
});

describe("a value the host set inline after the overlay's record (after any at-rest plan each record is absent or the editor's inline value with no priority)", () => {
	const NAMES = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase", "--handwriting-paper-phase-x"];
	/** Theme with no pitch; the overlay's plan at 24 px rows written and recorded, and a drag of 90 folded to 18 by it. */
	const start = () => {
		const r = rig(null);
		r.plan();
		for (const n of NAMES) expect(r.o.paperWritten.get(n), `premise: ${n} recorded`).toBe(r.host.props.get(n));
		expect(r.o.paperWritten.get(PITCH), "premise: the pitch recorded").toBe("24px");
		expect(r.pan(90), "premise: 90 mod 24").toBe("18px");
		return r;
	};
	/** Each record after the plan: absent, or the editor's inline value without a priority. */
	const bound = (r: ReturnType<typeof rig>) => NAMES.filter(n => {
		const rec = r.o.paperWritten.get(n);
		return rec !== undefined && (r.host.props.get(n) !== rec || r.host.style.getPropertyPriority(n) !== "");
	});

	it("the host's own pitch inline (40px): the next plan drops the record, reads nothing, and the standing pan goes unfolded", () => {
		const r = start();
		r.host.style.setProperty(PITCH, "40px");
		const before = r.reads;
		r.plan();
		expect(bound(r), "records the editor does not hold").toEqual([]);
		expect(r.host.props.get(PITCH), "the host's pitch stays").toBe("40px");
		expect(r.reads - before, "no computed read added").toBe(0);
		expect(r.scroller.props.get(PAN_Y), "the standing pan re-written, not folded by the old 24").toBe("90px");
	});

	it("leg 1: the host sets inline the very value the new plan wants (30px) while the record is the old 24: the record does not stand", () => {
		const r = start();
		r.host.style.setProperty(PITCH, "30px");
		r.plan(30);
		expect(bound(r), "records the editor does not hold").toEqual([]);
		expect(r.o.paperWritten.get(PITCH), "no record of the old 24").not.toBe("24px");
		expect(r.pan(90), "not folded by the old 24").not.toBe("18px");
	});

	it("the host takes the overlay's own value with a priority (24px !important): the record is dropped, the value stays", () => {
		const r = start();
		r.host.style.setProperty(PITCH, "24px", "important");
		r.plan();
		expect(bound(r), "records the editor does not hold").toEqual([]);
		expect([r.host.props.get(PITCH), r.host.style.getPropertyPriority(PITCH)], "the host's value and priority stay").toEqual(["24px", "important"]);
	});

	it("leg 2 and every other name: a value the host set inline over the record is not recorded after the next plan", () => {
		for (const n of NAMES) {
			const r = start();
			r.host.style.setProperty(n, "7px");
			r.plan();
			expect(bound(r), `records the editor does not hold, host set ${n}`).toEqual([]);
			expect(r.host.props.get(n), `the host's ${n} stays`).toBe("7px");
		}
	});

	it("pin: the overlay's own values untouched by the host stay recorded through a re-plan, with no read", () => {
		const r = start();
		const before = r.reads, recs = NAMES.map(n => r.o.paperWritten.get(n));
		r.plan();
		expect(NAMES.map(n => r.o.paperWritten.get(n)), "records kept").toEqual(recs);
		expect(r.reads, "no read").toBe(before);
	});
});
