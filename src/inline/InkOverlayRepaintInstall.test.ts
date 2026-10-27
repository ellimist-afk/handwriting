/**
 * The committed repaint - the layer a finished stroke is drawn on, the paint
 * of committed ink over a damage list, and the frame's repaint - lives in
 * InkOverlayRepaint.ts and is installed on InkOverlayPlugin.prototype when
 * InkOverlay.ts loads. Two things a type check cannot see are held here, as
 * the install tests of the other split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the repaint file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the repaint file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has, and none may be declared in the class
 * body as well. A name left out of the install still type-checks, because the
 * interface declares it; a frame with damage would then throw instead of
 * drawing the committed ink.
 */
import { describe, expect, it } from "vitest";

import { installInkOverlayRepaint } from "./InkOverlayRepaint";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import repaintRaw from "./InkOverlayRepaint.ts?raw";

const MOVED = ["committedCtxFor", "paintCommittedWork", "repaint"] as const;

/** What the repaint file takes back from InkOverlay.ts: the committed floor, the repaint plan, and the class as a type. */
const BACK = ["committedFloorFor", "committedRepaintPlan", "InkOverlayPlugin"] as const;

describe("committed repaint methods on the overlay prototype", () => {
	it("load with the repaint file imported first, and a bare overlay draws the highlighter on its own layer", () => {
		expect(typeof installInkOverlayRepaint).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		const highlight = {} as CanvasRenderingContext2D;
		const committed = {} as CanvasRenderingContext2D;
		overlay.highlightCtx = highlight;
		overlay.committedCtx = committed;
		expect(overlay.committedCtxFor("highlighter")).toBe(highlight);
		expect(overlay.committedCtxFor("pen")).toBe(committed);
	});

	it("every moved name is a prototype method with a class method's descriptor, declared once in the repaint file and not in the class body", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const repaint = repaintRaw.replace(/\r\n/g, "\n");
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
			expect(new RegExp(`^\\t(private )?${name}\\(`, "m").test(text), `${name} is still declared in the class body`).toBe(false);
			expect(repaint.match(new RegExp(`^\\tfunction ${name}\\(`, "gm"))?.length ?? 0, `${name} in InkOverlayRepaint.ts`).toBe(1);
		}
	});

	it("is installed once, after the class body closes, and takes back only its three names", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		const repaint = repaintRaw.replace(/\r\n/g, "\n");
		const call = "installInkOverlayRepaint(InkOverlayPlugin.prototype);";
		expect(text.split(call).length - 1).toBe(1);
		const classStart = text.indexOf("export class InkOverlayPlugin {");
		const classEnd = text.indexOf("\n}\n", classStart);
		expect(classStart).toBeGreaterThan(-1);
		expect(text.indexOf(call)).toBeGreaterThan(classEnd);
		const back = repaint.match(/^import \{([^}]*)\} from "\.\/InkOverlay";/m);
		expect(back?.[1]?.split(",").map((s) => s.trim().replace(/^type /, "")).sort()).toEqual([...BACK].sort());
	});
});
