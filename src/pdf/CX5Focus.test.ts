import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMobileApp: false }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Platform: {
			...(actual.Platform as Record<string, unknown>),
			get isMobileApp(): boolean {
				return platform.isMobileApp;
			},
		},
	};
});
vi.mock("../inline/MobileTools", () => {
	class MobileTools {
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		stale(): boolean {
			return false;
		}
		destroy(): void {}
	}
	return { MobileTools };
});
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => null }));

import { PdfInkController } from "./PdfInkController";
import { mouseActsAsPen, setMouseInk } from "../inline/MouseInk";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

/** Minimal element: attributes, a parent chain, and a scroll box. */
class N {
	attrs = new Map<string, string>();
	parentElement: N | null = null;
	children: N[] = [];
	constructor(
		readonly tagName: string,
		readonly cls: string,
		readonly overflowY: "hidden" | "auto" | "visible" = "visible",
		readonly scrollHeight = 0,
		readonly clientHeight = 0
	) {}
	add(child: N): N {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	hasAttribute(k: string): boolean {
		return this.attrs.has(k);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	querySelector(): null {
		return null;
	}
	contains(n: unknown): boolean {
		if (n === this) return true;
		return this.children.some((c) => c.contains(n));
	}
}

const NATIVE_FOCUSABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

/** Chromium click focus: nearest focusable ancestor-or-self, else none (body). */
function clickFocus(target: N): N | null {
	for (let n: N | null = target; n; n = n.parentElement) {
		if (n.hasAttribute("tabindex") || NATIVE_FOCUSABLE.has(n.tagName)) return n;
	}
	return null;
}

/** Chromium keyboard scroll: from focused ?? pressed, up to the first user-scrollable box. */
function keyboardScrolls(focused: N | null, pressed: N): N | null {
	for (let n: N | null = focused ?? pressed; n; n = n.parentElement) {
		if (n.overflowY === "auto" && n.scrollHeight > n.clientHeight) return n;
	}
	return null;
}

function buildPdfLeaf() {
	const body = new N("BODY", "", "hidden");
	const leaf = body.add(new N("DIV", "workspace-leaf", "hidden"));
	const leafContent = leaf.add(new N("DIV", "workspace-leaf-content", "hidden"));
	const viewContent = leafContent.add(new N("DIV", "view-content", "hidden"));
	const pdfContainer = viewContent.add(new N("DIV", "pdf-container", "hidden"));
	const contentContainer = pdfContainer.add(new N("DIV", "pdf-content-container", "hidden"));
	const scroller = contentContainer.add(new N("DIV", "pdf-viewer-container", "auto", 5000, 800));
	const pdfViewer = scroller.add(new N("DIV", "pdfViewer"));
	const page = pdfViewer.add(new N("DIV", "page"));
	const textLayer = page.add(new N("DIV", "textLayer"));
	textLayer.setAttribute("tabindex", "0"); // pdf.js TextLayerBuilder: div.tabIndex = 0
	return { leafContent, scroller, pdfViewer, textLayer };
}

function mountOn(root: N): PdfInkController {
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { maxTouchPoints: 0, userAgent: "test" },
	};
	const controller = new PdfInkController(
		root as unknown as HTMLElement,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => []
	);
	controller.mount();
	return controller;
}

describe("PDF gray-space click in a PDF keeps keyboard scrolling", () => {
	it("stock tree: gray-space click and page click both leave the keys on the PDF scroller", () => {
		const t = buildPdfLeaf();
		// Precondition: stock Obsidian leaf content has no tabindex.
		expect(t.leafContent.hasAttribute("tabindex")).toBe(false);
		expect(keyboardScrolls(clickFocus(t.pdfViewer), t.pdfViewer)).toBe(t.scroller);
		expect(keyboardScrolls(clickFocus(t.textLayer), t.textLayer)).toBe(t.scroller);
	});

	it("plugin on (PdfInkController mounted on the leaf content): gray-space click still scrolls the PDF", () => {
		setMouseInk(false);
		// Precondition: a desktop mouse with mouse ink off is not claimed by the
		// router, so its mousedown is not preventDefaulted and native focus runs.
		expect(mouseActsAsPen("mouse", false, false)).toBe(false);
		const t = buildPdfLeaf();
		const controller = mountOn(t.leafContent);
		try {
			const focused = clickFocus(t.pdfViewer);
			const scrolled = keyboardScrolls(focused, t.pdfViewer);
			expect(
				scrolled,
				`gray-space click focused ${focused ? "." + focused.cls + " tabindex=" + focused.getAttribute("tabindex") : "nothing (body)"}; PageDown scroll chain reaches ${scrolled ? "." + scrolled.cls : "no scroller"}`
			).toBe(t.scroller);
		} finally {
			controller.unmount();
		}
	});
	it("unmount leaves the original leaf tabindex absent", () => {
		const t=buildPdfLeaf(); const controller=mountOn(t.leafContent);
		controller.unmount(); expect(t.leafContent.getAttribute("tabindex")).toBeNull();
	});
	it("preserves a tabindex that the host already owns", () => {
		const t=buildPdfLeaf(); t.leafContent.setAttribute("tabindex","0");
		const controller=mountOn(t.leafContent); controller.unmount();
		expect(t.leafContent.getAttribute("tabindex")).toBe("0");
	});});
