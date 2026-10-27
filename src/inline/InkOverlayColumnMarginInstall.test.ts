/**
 * The column margin and overscroll - the painted and applied margin, the
 * column rest, and the overscroll give and bounce - live in
 * InkOverlayColumnMargin.ts and are installed on InkOverlayPlugin.prototype
 * when InkOverlay.ts loads. Two things a type check cannot see are held here,
 * as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the margin file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the margin file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, declared once in the margin file and in
 * neither the class body nor the pan settle file. A name left out of the
 * install still type-checks, because the interface declares it; every pan
 * frame that reaches the column rest or the overscroll would then throw.
 */
import { describe, expect, it } from "vitest";

import { installInkOverlayColumnMargin } from "./InkOverlayColumnMargin";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import panSettleRaw from "./InkOverlayPanSettle.ts?raw";
import marginRaw from "./InkOverlayColumnMargin.ts?raw";

const MOVED = [
	"paintedColumnMargin",
	"appliedColumnMargin",
	"restColumnAgainstCurrentGrant",
	"columnMarginDebtScrollLeft",
	"columnRestPan",
	"ownLinesPageBoxScrollLeft",
	"columnFitsPane",
	"columnRestCentred",
	"holdOverscrollGive",
	"releaseOverscrollGive",
	"startOverscrollBounce",
	"overscrollBounceReadout",
	"notePanBound",
] as const;

/** What the margin file takes back from InkOverlay.ts: the pan fit slack, the overscroll constants, the travelled ease room, and the class as a type. */
const BACK = ["PAN_FIT_SLACK_PX", "OVERSCROLL_BOUNCE_MS", "OVERSCROLL_BOUNCE_MIN_PX", "OVERSCROLL_GIVE_PX", "travelledEaseRoom", "InkOverlayPlugin"] as const;

type Layout = NonNullable<InkOverlayPlugin["viewportLayout"]>;

function bareOverlay(): InkOverlayPlugin {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const body = { classList: { contains: () => false } };
	overlay.view = { dom: { ownerDocument: { body } } } as unknown as InkOverlayPlugin["view"];
	overlay.zoomFormAt = () => false;
	overlay.columnRestMargin = null;
	return overlay;
}

function layout(fields: Partial<Layout>): Layout {
	return { columnLocal: 120, columnReserve: 20, columnAuto: null, sizerColumn: false, ownLines: false, width: 700, ...fields } as Layout;
}

describe("column margin and overscroll methods on the overlay prototype", () => {
	it("load with the margin file imported first, and a bare overlay counts only the pan bounds it hit", () => {
		expect(typeof installInkOverlayColumnMargin).toBe("function");
		const overlay = bareOverlay();
		overlay.panBoundHits = 0;
		overlay.panBoundMaxPx = 0;
		overlay.notePanBound(true, 10, 7);
		overlay.notePanBound(true, 4, 5);
		// Not fitting, not finite, or granted as asked: no bound was hit.
		overlay.notePanBound(false, 10, 0);
		overlay.notePanBound(true, Number.NaN, 0);
		overlay.notePanBound(true, 6, 6);
		expect(overlay.panBoundHits).toBe(2);
		expect(overlay.panBoundMaxPx).toBe(3);
	});

	it("the applied margin is the column's own less its reserve, held to what the pane leaves beside the line", () => {
		const overlay = bareOverlay();
		overlay.viewportLayout = null;
		expect(overlay.appliedColumnMargin(1)).toBe(0);
		overlay.viewportLayout = layout({ columnLocal: null });
		expect(overlay.appliedColumnMargin(1)).toBe(0);
		overlay.viewportLayout = layout({});
		expect(overlay.appliedColumnMargin(1)).toBe(100);
		// A sized column at zoom one: (700 - 40 fixed - 0 bar - 500 line) / 2 = 80 caps the 100 it wants.
		overlay.viewportLayout = layout({ sizerColumn: true, columnAuto: { lineWidth: 500, fixed: 40, scrollbar: 0 } });
		expect(overlay.appliedColumnMargin(1)).toBe(80);
		// A rest margin, once set, is what the column wants instead.
		overlay.columnRestMargin = 30;
		expect(overlay.appliedColumnMargin(1)).toBe(30);
	});

	it("a theme that centres its own lines is its own rest: no pan, where any other column pans to the centre", () => {
		const overlay = bareOverlay();
		overlay.columnRestCentred = () => 40;
		overlay.viewportLayout = layout({ ownLines: true });
		expect(overlay.columnRestPan(1, 1)).toBe(0);
		overlay.viewportLayout = layout({ ownLines: false });
		// (40 centred - 100 applied) * 1 effective scale.
		expect(overlay.columnRestPan(1, 1)).toBe(-60);
		// No inset to rest in at all is null, not zero.
		overlay.columnRestCentred = () => null;
		expect(overlay.columnRestPan(1, 1)).toBeNull();
	});

	it("every moved name is a prototype method with a class method's descriptor, declared once in the margin file and not in the class body or the pan settle file", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const pan = panSettleRaw.replace(/\r\n/g, "\n");
		const margin = marginRaw.replace(/\r\n/g, "\n");
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
			expect(new RegExp(`^\\t(private )?${name}\\(`, "m").test(text), `${name} is still declared in the class body`).toBe(false);
			expect(pan.match(new RegExp(`^[\\t ]function ${name}\\(`, "gm"))?.length ?? 0, `${name} in InkOverlayPanSettle.ts`).toBe(0);
			expect(margin.match(new RegExp(`^[\\t ]function ${name}\\(`, "gm"))?.length ?? 0, `${name} in InkOverlayColumnMargin.ts`).toBe(1);
		}
	});

	it("is installed once, after the class body closes, and takes back only its six names", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const margin = marginRaw.replace(/\r\n/g, "\n");
		const call = "installInkOverlayColumnMargin(InkOverlayPlugin.prototype);";
		expect(text.split(call).length - 1).toBe(1);
		const classStart = text.indexOf("export class InkOverlayPlugin {");
		const classEnd = text.indexOf("\n}\n", classStart);
		expect(classStart).toBeGreaterThan(-1);
		expect(text.indexOf(call)).toBeGreaterThan(classEnd);
		const back = margin.match(/^import \{([^}]*)\} from "\.\/InkOverlay";/m);
		expect(back?.[1]?.split(",").map((s) => s.trim().replace(/^type /, "")).sort()).toEqual([...BACK].sort());
	});
});
