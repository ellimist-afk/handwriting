/**
 * A note switch releases the five ink canvases' backing memory.
 *
 * CodeMirror runs the plugin's destroy() on every same-tab note switch
 * (Obsidian's setViewData rebuilds every ViewPlugin), and unmount() used to
 * remove the container without sizing the canvases to 0x0 first, so their
 * full backings stayed allocated until the collector freed the dead overlay.
 * On an iPad that is five full-size backings per switch.
 *
 * What runs for real: the constructor, handleResize -> syncBand -> the
 * backing allocation, and destroy() -> unmount(). The container measures
 * what syncBand writes; the canvases record every size assignment.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { TailRenderer } from "../ink/TailRenderer";

type Fields = Record<string, unknown>;

const noop = (): undefined => undefined;

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: noop,
		remove: noop,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		style: { removeProperty: noop, setProperty: noop },
		...extra,
	};
}

function cmLine(left: number): Fields {
	return {
		classList: { contains: (name: string) => name === "cm-line" },
		children: [] as unknown[],
		getBoundingClientRect: () => ({ left, top: 0, width: 400, height: 20, right: left + 400, bottom: 20 }),
	};
}

const NAMES = ["committed", "wet", "tail", "highlight", "highlightWet"] as const;

function makeRig(dpr: number) {
	const frames: Array<() => void> = [];
	const win = {
		devicePixelRatio: dpr,
		// A page that places canvases with CSS translate (the compact tail needs it); zoom stays unsupported.
		CSS: { supports: (property: string) => property === "translate" },
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: noop,
		clearTimeout: noop,
		requestAnimationFrame: (fn: () => void) => {
			frames.push(fn);
			return frames.length;
		},
	};
	const scrollDOM = el({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 0,
		clientHeight: 0,
		scrollWidth: 0,
		scrollHeight: 0,
		clientLeft: 0,
		clientTop: 0,
		addEventListener: noop,
		removeEventListener: noop,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	const view: Fields = {
		dom: el({ ownerDocument: { defaultView: win }, parentElement: el() }),
		scrollDOM,
		contentDOM: el({
			children: [cmLine(60)],
			getBoundingClientRect: () => ({ left: 60, top: 0, width: 1024, height: 0, right: 1084, bottom: 0 }),
		}),
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
		// `mount()` stays inert on undefined (the constructor's mount bails here).
		state: { field: () => undefined },
	};

	const o = new InkOverlayPlugin(view as never) as unknown as Fields;

	const containerStyle = { left: 0, top: 0, width: 0, height: 0 };
	const container = el({
		nodeType: 1,
		setCssStyles: (styles: Record<string, string>) => {
			for (const key of ["left", "top", "width", "height"] as const) {
				if (styles[key] !== undefined) containerStyle[key] = Number.parseFloat(styles[key]);
			}
		},
		getBoundingClientRect: () => ({
			left: containerStyle.left,
			top: containerStyle.top,
			width: containerStyle.width,
			height: containerStyle.height,
			right: containerStyle.left + containerStyle.width,
			bottom: containerStyle.top + containerStyle.height,
		}),
	});
	Object.defineProperties(container, {
		offsetWidth: { get: () => containerStyle.width },
		offsetHeight: { get: () => containerStyle.height },
	});

	const sizeLog: string[] = [];
	const tailCtx = {
		setTransform: noop, save: noop, restore: noop,
		clearRect: noop, drawImage: noop,
		getLineDash: () => [], setLineDash: noop,
		lineCap: "butt", lineJoin: "miter", lineWidth: 1,
		strokeStyle: "#000", fillStyle: "#000", globalAlpha: 1,
		globalCompositeOperation: "source-over", lineDashOffset: 0,
		miterLimit: 10, filter: "none", imageSmoothingEnabled: true,
		shadowBlur: 0, shadowColor: "transparent", shadowOffsetX: 0, shadowOffsetY: 0,
		font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic",
	} as unknown as CanvasRenderingContext2D;
	const canvas = (name: string): Fields => {
		let w = 300;
		let h = 150;
		const c = el({
			getContext: () => name === "tail" ? tailCtx : null,
			ownerDocument: { defaultView: win },
			__name: name,
		});
		Object.defineProperties(c, {
			width: { get: () => w, set: (v: number) => { w = v; sizeLog.push(`${name}.width=${v}`); } },
			height: { get: () => h, set: (v: number) => { h = v; sizeLog.push(`${name}.height=${v}`); } },
		});
		return c;
	};
	const ctx = (): CanvasRenderingContext2D => ({
		beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
		arc: noop, ellipse: noop, rect: noop, closePath: noop, fill: noop, stroke: noop, clip: noop,
		save: noop, restore: noop, clearRect: noop, setTransform: noop, fillRect: noop,
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	}) as unknown as CanvasRenderingContext2D;

	const canvases = {
		committed: canvas("committed"),
		wet: canvas("wet"),
		tail: canvas("tail"),
		highlight: canvas("highlight"),
		highlightWet: canvas("highlightWet"),
	};
	o.container = container;
	o.committedCanvas = canvases.committed;
	o.wetCanvas = canvases.wet;
	o.tailCanvas = canvases.tail;
	o.highlightCanvas = canvases.highlight;
	o.highlightWetCanvas = canvases.highlightWet;
	o.committedCtx = ctx();
	o.highlightCtx = ctx();
	const layer = { applyDpr: noop, clear: noop, clearAll: noop };
	o.wet = layer;
	o.highlightWet = layer;
	o.tail = new TailRenderer(canvases.tail as unknown as HTMLCanvasElement);
	o.mobileTools = null;
	o.router = null;

	// Shadowed exactly as FirstPaintEmptyBand.test.ts does: editor state,
	// DOM class toggles, the spacer, other panes. None of them sizes a canvas.
	o.filePath = () => "probe.md";
	o.updateHandwritingPageClass = noop;
	o.updateExtent = noop;
	o.repaintPath = noop;

	return {
		overlay: o,
		canvases,
		sizeLog,
		layout(w: number, h: number) {
			scrollDOM.clientWidth = w;
			scrollDOM.clientHeight = h;
			scrollDOM.scrollWidth = w;
			scrollDOM.scrollHeight = h * 4;
		},
		hostResized: () => (o.handleResize as () => void)(),
		sizes: () => NAMES.map((n) => `${n} ${canvases[n].width as number}x${canvases[n].height as number}`),
	};
}

describe("destroy() on a note switch releases the five ink canvases", () => {
	it("every canvas sized by the real handleResize is 0x0 after the real destroy()", () => {
		// A 12.9-inch iPad pane in CSS px, at dpr 2.
		const rig = makeRig(2);
		rig.layout(1024, 1366);
		rig.hostResized();

		// PRECONDITION: the four non-tail canvases have full backings.
		// An idle tail keeps its compact tile, smaller than the band.
		const idle = NAMES.map((n) => ({ n, w: rig.canvases[n].width as number, h: rig.canvases[n].height as number }));
		for (const c of idle.filter((c) => c.n !== "tail")) {
			expect(c.w, `precondition: ${c.n} allocated`).toBeGreaterThan(300);
			expect(c.h, `precondition: ${c.n} allocated`).toBeGreaterThan(150);
		}
		const tailBefore = idle.find((c) => c.n === "tail")!;
		const committedBefore = idle.find((c) => c.n === "committed")!;
		expect(tailBefore.w, "precondition: idle tail width").toBeGreaterThan(0);
		expect(tailBefore.h, "precondition: idle tail height").toBeGreaterThan(0);
		expect(tailBefore.w * tailBefore.h, "precondition: idle tail is a tile").toBeLessThan(committedBefore.w * committedBefore.h);
		(rig.overlay.tail as TailRenderer).restoreFullSurface();
		const before = NAMES.map((n) => ({ n, w: rig.canvases[n].width as number, h: rig.canvases[n].height as number }));
		for (const c of before) {
			expect(c.w, `precondition: ${c.n} allocated before destroy`).toBeGreaterThan(300);
			expect(c.h, `precondition: ${c.n} allocated before destroy`).toBeGreaterThan(150);
		}
		const bytesBefore = before.reduce((s, c) => s + c.w * c.h * 4, 0);
		const logBeforeDestroy = rig.sizeLog.length;

		// TRIGGER: the plugin destroy CodeMirror runs when setState rebuilds plugins.
		(rig.overlay.destroy as () => void)();

		// destroy() really ran unmount(): the container is gone.
		expect(rig.overlay.container, "unmount ran").toBeNull();

		const after = rig.sizes();
		const writesDuringDestroy = rig.sizeLog.slice(logBeforeDestroy);
		const stillReferenced = NAMES.filter((n) => {
			const field = n === "committed" ? "committedCanvas"
				: n === "wet" ? "wetCanvas"
				: n === "tail" ? "tailCanvas"
				: n === "highlight" ? "highlightCanvas"
				: "highlightWetCanvas";
			return rig.overlay[field] === rig.canvases[n];
		});
		const heldBytes = NAMES.reduce(
			(s, n) => s + (rig.canvases[n].width as number) * (rig.canvases[n].height as number) * 4,
			0,
		);
		const detail =
			`before destroy: ${before.map((c) => `${c.n} ${c.w}x${c.h}`).join(", ")} (${(bytesBefore / 1e6).toFixed(1)} MB); ` +
			`after destroy: ${after.join(", ")} (${(heldBytes / 1e6).toFixed(1)} MB still backed); ` +
			`size writes during destroy: [${writesDuringDestroy.join(", ")}]; ` +
			`fields still pointing at the canvases: [${stillReferenced.join(", ")}]`;

		// CORRECT behaviour: every backing released before the overlay is dropped.
		for (const n of NAMES) {
			expect(`${n} ${rig.canvases[n].width as number}x${rig.canvases[n].height as number}`, detail).toBe(`${n} 0x0`);
		}
	});
});
