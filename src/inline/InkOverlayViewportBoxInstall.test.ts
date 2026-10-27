/**
 * The viewport layout and box - taking the layout over from the editor and
 * handing it back, measuring the natural column, and writing the scroll, the
 * host transform, the canvas layers and the box - live in
 * InkOverlayViewportBox.ts and are installed on InkOverlayPlugin.prototype
 * when InkOverlay.ts loads. Two things a type check cannot see are held here,
 * as the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the box file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the box file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, declared once in the box file and in
 * neither the class body nor the pan settle file. A name left out of the
 * install still type-checks, because the interface declares it; every pinch
 * frame would then throw instead of writing the box.
 */
import { describe, expect, it } from "vitest";

import { installInkOverlayViewportBox } from "./InkOverlayViewportBox";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import panSettleRaw from "./InkOverlayPanSettle.ts?raw";
import boxRaw from "./InkOverlayViewportBox.ts?raw";

const MOVED = [
	"restoreViewportLayout",
	"prepareViewportLayout",
	"scheduleViewportStyleRefresh",
	"refreshViewportColumn",
	"measureNaturalColumn",
	"measureColumnAuto",
	"setViewportScroll",
	"setScrollResidual",
	"hostTransform",
	"scrollbarUnscaleAt",
	"scrollbarLocalAt",
	"placeCanvasLayers",
	"applyViewportBox",
] as const;

/** What the box file takes back from InkOverlay.ts: the pan fit slack, the scale epsilon, the paper properties, and the class as a type. */
const BACK = ["PAN_FIT_SLACK_PX", "SCALE_EPSILON", "PAPER_PROPERTIES", "InkOverlayPlugin"] as const;

type Layout = NonNullable<InkOverlayPlugin["viewportLayout"]>;

function bareOverlay(styledScrollbars = false): InkOverlayPlugin {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const body = { classList: { contains: (name: string) => styledScrollbars && name === "styled-scrollbars" } };
	overlay.view = { dom: { ownerDocument: { body } } } as unknown as InkOverlayPlugin["view"];
	overlay.zoomFormAt = () => false;
	return overlay;
}

describe("viewport layout and box methods on the overlay prototype", () => {
	it("load with the box file imported first, and a bare overlay writes the host transform the page shows", () => {
		expect(typeof installInkOverlayViewportBox).toBe("function");
		const overlay = bareOverlay();
		overlay.viewportLayout = { baseTransform: "none" } as Layout;
		overlay.scrollResidual = { x: 0, y: 0, left: 0, top: 0 };
		expect(overlay.hostTransform(2)).toBe("scale(2)");
		// The editor's own transform stays in front, and the scroll residual is carried out at the new scale.
		overlay.viewportLayout = { baseTransform: "translateX(4px)" } as Layout;
		overlay.scrollResidual = { x: 3, y: -1, left: 0, top: 0 };
		expect(overlay.hostTransform(2)).toBe("translateX(4px) translate(-6px, 2px) scale(2)");
	});

	it("a styled scrollbar is unscaled off a zoom of one, and its local width is the bar times that unscale", () => {
		const styled = bareOverlay(true);
		expect(styled.scrollbarUnscaleAt(2)).toBe(0.5);
		expect(styled.scrollbarUnscaleAt(1)).toBeNull();
		expect(styled.scrollbarLocalAt(10, 2)).toBe(10 * 0.5);
		expect(styled.scrollbarLocalAt(10, 1)).toBe(10);
		const plain = bareOverlay(false);
		expect(plain.scrollbarUnscaleAt(2)).toBeNull();
		expect(plain.scrollbarLocalAt(10, 2)).toBe(10);
		// A zoom form scales the bar with the page whatever the scrollbar style.
		plain.zoomFormAt = () => true;
		expect(plain.scrollbarLocalAt(10, 2)).toBe(5);
	});

	it("handing the layout back at rest still clears the pan, the preview offset and the measures", () => {
		// An unmount with no layout taken over returns early, so everything the release owes the page comes before that return.
		const overlay = bareOverlay();
		const calls: string[] = [];
		for (const name of ["clearOwnPaperVars", "releaseMeasures", "clearViewportPan", "clearPreviewInkOffset", "clearDeferredRepaint"] as const) {
			(overlay as unknown as Record<string, () => void>)[name] = () => void calls.push(name);
		}
		overlay.viewportLayout = null;
		overlay.restoreViewportLayout();
		expect(calls).toEqual(["clearOwnPaperVars", "releaseMeasures", "clearViewportPan", "clearPreviewInkOffset", "clearDeferredRepaint"]);
		expect(overlay.scrollResidual).toEqual({ x: 0, y: 0, left: 0, top: 0 });
	});

	it("every moved name is a prototype method with a class method's descriptor, declared once in the box file and not in the class body or the pan settle file", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const pan = panSettleRaw.replace(/\r\n/g, "\n");
		const box = boxRaw.replace(/\r\n/g, "\n");
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
			expect(box.match(new RegExp(`^[\\t ]function ${name}\\(`, "gm"))?.length ?? 0, `${name} in InkOverlayViewportBox.ts`).toBe(1);
		}
	});

	it("is installed once, after the class body closes, and takes back only its four names", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const box = boxRaw.replace(/\r\n/g, "\n");
		const call = "installInkOverlayViewportBox(InkOverlayPlugin.prototype);";
		expect(text.split(call).length - 1).toBe(1);
		const classStart = text.indexOf("export class InkOverlayPlugin {");
		const classEnd = text.indexOf("\n}\n", classStart);
		expect(classStart).toBeGreaterThan(-1);
		expect(text.indexOf(call)).toBeGreaterThan(classEnd);
		const back = box.match(/^import \{([^}]*)\} from "\.\/InkOverlay";/m);
		expect(back?.[1]?.split(",").map((s) => s.trim().replace(/^type /, "")).sort()).toEqual([...BACK].sort());
	});
});
