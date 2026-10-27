import { afterEach, describe, expect, it } from "vitest";
import { attachEmbedInk, columnInset, initEmbedInkRefresh, teardownEmbedInk } from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

/**
 * The text column's left edge as the painted layer sees it, in a reading view
 * and in an embed. The anchor is measured on the first call
 * for a root and again on every anchor-watch tick, never on an ordinary paint;
 * these cells drive the watch and the paint, not the pure anchor.
 */

function stroke(): InkStroke {
	return {
		id: "s",
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [],
		bbox: { x: 0, y: 0, width: 40, height: 4 },
	} as unknown as InkStroke;
}

function block(left: number, width = 600, cls = "el-p") {
	return {
		classList: { contains: (c: string) => c === cls },
		getBoundingClientRect: () => ({ left, width, right: left + width, top: 0, height: 20, bottom: 20 }),
	};
}

type Block = ReturnType<typeof block>;

function fakeCanvas() {
	return {
		style: {} as Record<string, string>,
		width: 0,
		height: 0,
		setCssStyles(this: { style: Record<string, string> }, s: Record<string, string>) {
			Object.assign(this.style, s);
		},
		getContext: () => ({ setTransform() {}, clearRect() {}, globalAlpha: 1 }),
		remove() {},
	};
}

function fakeWindow(observers: Array<() => void>) {
	class FakeResizeObserver {
		constructor(private readonly cb: () => void) {}
		observe(): void {
			observers.push(() => this.cb());
		}
		unobserve(): void {}
		disconnect(): void {}
	}
	return {
		addEventListener() {},
		removeEventListener() {},
		getComputedStyle: () => ({ position: "relative", overflowX: "auto" }),
		devicePixelRatio: 1,
		ResizeObserver: FakeResizeObserver,
	};
}

/** A reading view at 344 whose sizer sits 32 in (rect 376) and holds `blocks`. */
function readingView(blocks: Block[]) {
	const attrs = new Map<string, string>();
	const sizerAttrs = new Map<string, string>();
	const observers: Array<() => void> = [];
	let canvas: ReturnType<typeof fakeCanvas> | null = null;
	const sizer = {
		offsetLeft: 32,
		offsetTop: 32,
		offsetParent: null as unknown,
		children: blocks,
		style: { getPropertyValue: () => "", removeProperty(): void {}, setProperty(): void {} },
		querySelector: () => null,
		getAttribute: (k: string) => sizerAttrs.get(k) ?? null,
		removeAttribute: (k: string) => void sizerAttrs.delete(k),
		getBoundingClientRect: () => ({ left: 376, width: 635, right: 1011, top: 104, height: 600, bottom: 704 }),
	};
	const root = {
		isConnected: true,
		parentElement: null,
		clientLeft: 0,
		clientWidth: 679,
		scrollLeft: 0,
		style: { position: "relative", removeProperty(): void {} },
		classList: {
			contains: (c: string) => c === "markdown-preview-view",
			add(): void {},
			remove(): void {},
		},
		setCssStyles(): void {},
		getBoundingClientRect: () => ({ left: 344, width: 679, right: 1023, top: 78, height: 722, bottom: 800 }),
		querySelector: (sel: string) => {
			if (sel.includes("markdown-preview-sizer")) return sizer;
			if (sel.includes("canvas.handwriting-embed-ink")) return canvas;
			return null;
		},
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => (canvas = fakeCanvas()),
		ownerDocument: { defaultView: fakeWindow(observers) },
	};
	sizer.offsetParent = root;
	return {
		root,
		sizer,
		layerLeft: () => canvas?.style.left,
		tick: () => {
			for (const fire of [...observers]) fire();
		},
	};
}

/** An embed content box at 444.7 whose text sits 24 px in. */
function embedRoot(blocks: Block[]) {
	const attrs = new Map<string, string>();
	let canvas: ReturnType<typeof fakeCanvas> | null = null;
	const style = { position: "static", minHeight: "", removeProperty(): void {} };
	const root = {
		isConnected: true,
		parentElement: null,
		clientLeft: 0,
		children: blocks,
		style,
		classList: { contains: (c: string) => c === "markdown-embed-content" },
		setCssStyles(s: Record<string, string>): void {
			if ("position" in s) style.position = s.position ?? "";
			if ("minHeight" in s) style.minHeight = s.minHeight ?? "";
		},
		getBoundingClientRect: () => ({ left: 444.7, width: 514, right: 958.7, top: 227.6, height: 286, bottom: 513.6 }),
		querySelector: (sel: string) => (sel.includes("canvas.handwriting-embed-ink") ? canvas : null),
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => (canvas = fakeCanvas()),
		ownerDocument: { defaultView: fakeWindow([]) },
	};
	return { root, layerLeft: () => canvas?.style.left };
}

function attach(root: unknown): void {
	const ink = [stroke()];
	initEmbedInkRefresh(() => ink);
	attachEmbedInk(root as HTMLElement, "note.md", ink);
}

function px(v: string | undefined): number {
	return Number.parseFloat(v ?? "NaN");
}

afterEach(() => teardownEmbedInk());

describe("the painted layer starts at the text column", () => {
	it("the readable line length toggle moves the column; the next watch tick moves the layer with it", () => {
		const view = readingView([block(414.1)]);
		attach(view.root);
		expect(px(view.layerLeft()), "Minimal, readable on: the column 70.1 from the view").toBeCloseTo(70.1, 6);
		// Readable off: the blocks fill the sizer, whose offset does not change.
		view.sizer.children = [block(376)];
		view.tick();
		expect(px(view.layerLeft()), "after the toggle, at the next watch tick").toBeCloseTo(32, 6);
	});

	it("a watch tick that finds only a header, a pusher and a zero-width child keeps the column it measured", () => {
		const view = readingView([block(414.1)]);
		attach(view.root);
		expect(px(view.layerLeft())).toBeCloseTo(70.1, 6);
		view.sizer.children = [block(300, 600, "mod-header"), block(300, 600, "markdown-preview-pusher"), block(700, 0)];
		view.tick();
		expect(px(view.layerLeft()), "nothing measurable: the last column holds").toBeCloseTo(70.1, 6);
	});

	it("an embed paints its layer 24 px in, where its text starts, in every theme", () => {
		const embed = embedRoot([block(468.7)]);
		attach(embed.root);
		expect(px(embed.layerLeft())).toBeCloseTo(24, 6);
	});
});

describe("the column inset is in the base's own px", () => {
	/** A base `inset` px in from a column block, drawn `ratio` of its layout width on screen (a CSS zoom on it). */
	function zoomedBase(inset: number, ratio: number, offsetWidth: number | undefined = 764) {
		const base = {
			children: [] as Block[],
			offsetWidth,
			getBoundingClientRect: () => ({ left: 100, width: (offsetWidth ?? 0) * ratio, right: 100, top: 0, height: 20, bottom: 20 }),
		};
		base.children.push(block(100 + inset * ratio, 600));
		return base as unknown as HTMLElement;
	}

	it("a base drawn at 0.8758 of its width gives the unzoomed inset, not the shrunk one", () => {
		const base = zoomedBase(32, 0.8758);
		expect(columnInset(base, base, base, true)).toBeCloseTo(32, 2);
	});

	it("a base at ratio 1 gives the inset unchanged", () => {
		const base = zoomedBase(32, 1);
		expect(columnInset(base, base, base, true)).toBeCloseTo(32, 5);
	});

	it("a base with no layout width is read as unzoomed", () => {
		const base = zoomedBase(32, 1, 0);
		expect(columnInset(base, base, base, true)).toBeCloseTo(32, 5);
		const bare = zoomedBase(32, 1, undefined);
		expect(columnInset(bare, bare, bare, true)).toBeCloseTo(32, 5);
	});
});
