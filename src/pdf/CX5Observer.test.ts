import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => { probe.calls++; return null; } }));
vi.mock("../inline/MobileTools", () => ({ MobileTools: class {
	setCorner() {} refresh() {} setInking() {} closeInkSliders() {} stale() { return false; } destroy() {}
} }));
import { PdfInkController } from "./PdfInkController";

class ElementModel {
	constructor(readonly classes: string[] = [], readonly parentElement: ElementModel | null = null) {}
	classList = { contains: (name: string) => this.classes.includes(name), add() {}, remove() {} };
	instanceOf() { return true; }
	closest(selector: string): ElementModel | null {
		const classes = selector.split(",").map((s) => s.trim().slice(1));
		for (let node: ElementModel | null = this; node; node = node.parentElement) {
			if (node.classes.some((name) => classes.includes(name))) return node;
		}
		return null;
	}
	setAttribute() {} hasAttribute() { return false; } addEventListener() {} removeEventListener() {}
	querySelector() { return null; }
}

describe("PDF observer ignores toolbar writes but keeps viewer changes", () => {
	let controller: PdfInkController;
	let notify: (records: MutationRecord[]) => void;
	let frames: Array<() => void>;
	let root: ElementModel;
	beforeEach(() => {
		vi.useFakeTimers(); probe.calls = 0; frames = []; root = new ElementModel();
		vi.stubGlobal("Element", ElementModel);
		vi.stubGlobal("MutationObserver", class {
			constructor(fn: (records: MutationRecord[]) => void) { notify = fn; }
			observe() {} disconnect() {}
		});
		const win = { devicePixelRatio: 1, navigator: { userAgent: "test", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout,
			requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} };
		controller = new PdfInkController(root as unknown as HTMLElement, win as unknown as Window, () => [], () => "pdf-id", () => []);
		controller.mount(); flush(); probe.calls = 0;
	});
	afterEach(() => { controller.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
	function flush() { const pending = frames.splice(0); pending.forEach((fn) => fn()); }
	function change(target: ElementModel, type = "attributes", attributeName = "class") {
		notify([{ target, type, attributeName, addedNodes: [], removedNodes: [] } as unknown as MutationRecord]);
		vi.advanceTimersByTime(300); flush();
	}
	for (const cls of ["handwriting-mobile-tools", "handwriting-pen-pill"]) {
		for (const nested of [false, true]) {
			it(`ignores class/style/icon changes inside ${cls}, nested=${nested}`, () => {
				const toolbar = new ElementModel([cls], root);
				const target = nested ? new ElementModel([], new ElementModel([], toolbar)) : toolbar;
				change(target); change(target, "attributes", "style"); change(target, "childList");
				expect(probe.calls).toBe(0);
			});
		}
	}
	for (const [type, attribute] of [["childList", ""], ["attributes", "style"], ["attributes", "width"]]) {
		it(`refreshes real viewer ${type}/${attribute}`, () => {
			change(new ElementModel(["page"], root), type, attribute);
			expect(probe.calls).toBe(1);
		});
	}
	it("ignores owned cursor viewport writes without ignoring host style changes", () => {
		const viewport = new ElementModel(["handwriting-pdf-cursor-viewport"], root);
		change(viewport, "attributes", "style");
		expect(probe.calls).toBe(0);
		change(root, "attributes", "style");
		expect(probe.calls).toBe(1);
	});
});
