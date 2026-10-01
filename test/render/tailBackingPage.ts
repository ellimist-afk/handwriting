import { TailRenderer } from "../../src/ink/TailRenderer";
import { DEFAULT_PEN, HIGHLIGHTER_ALPHA, HIGHLIGHTER_PEN } from "../../src/ink/PenStyle";
import type { PenSample } from "../../src/input/PointerRouter";
import { canvasLayerBox } from "../../src/inline/ZoomScale";
import { overlayForPath } from "../../src/inline/InkOverlay";
import "./scrollColumnAnchorPage";

type Head = { from: { x: number; y: number }; to: { x: number; y: number }; hw: number; pressure?: number; highlighter?: boolean };
type Prediction = { fromX: number; fromY: number; points: { x: number; y: number }[]; width: number };
type Config = { width: number; height: number; backing: number; cssScale?: number; hostZoom?: boolean };
type CompactTail = TailRenderer & {
	configureInlineBacking?: (width: number, height: number, backing: number, cssScale: number, hostZoom: boolean) => void;
	prepareLive?: (head: { cam: { x: number; y: number; zoom: number }; style: typeof DEFAULT_PEN; from: Head["from"]; to: Head["to"]; pressure: number; hwWorld: number } | null,
		prediction: { fromX: number; fromY: number; points: readonly PenSample[]; lineWidthPx: number } | null) => void;
	restoreFullSurface?: () => void;
};
type Arm = { root: HTMLDivElement; layers: HTMLCanvasElement[]; tail: CompactTail; widthWrites: number; heightWrites: number };

let config: Config;
let full: Arm;
let compact: Arm;
const names = ["highlight", "highlightWet", "committed", "wet", "tail"] as const;
const tailIndex = 4;

function canvas(root: HTMLElement, name: string): HTMLCanvasElement {
	const c = root.appendChild(document.createElement("canvas"));
	c.dataset.layer = name;
	const box = canvasLayerBox(config.width, config.height, config.cssScale ?? 1, config.hostZoom ?? false);
	c.style.cssText = `position:absolute;left:0;top:0;width:${box.width}px;height:${box.height}px;transform:${box.transform};transform-origin:0 0;pointer-events:none`;
	if (name === "highlight" || name === "highlightWet") c.style.opacity = String(HIGHLIGHTER_ALPHA);
	c.width = Math.round(config.width * config.backing);
	c.height = Math.round(config.height * config.backing);
	return c;
}

function arm(label: string): Arm {
	const root = document.body.appendChild(document.createElement("div"));
	root.dataset.arm = label;
	root.style.cssText = `position:relative;overflow:hidden;width:${config.width}px;height:${config.height}px;background:white`;
	if (config.cssScale && config.cssScale < 1) {
		if (config.hostZoom) root.style.zoom = String(config.cssScale);
		else { root.style.transform = `scale(${config.cssScale})`; root.style.transformOrigin = "0 0"; }
	}
	const layers = names.map(name => canvas(root, name));
	const tail = new TailRenderer(layers[tailIndex]!) as CompactTail;
	tail.applyDpr(config.backing);
	if (label === "compact") tail.configureInlineBacking?.(config.width, config.height, config.backing, config.cssScale ?? 1, config.hostZoom ?? false);
	const result: Arm = { root, layers, tail, widthWrites: 0, heightWrites: 0 };
	for (const dimension of ["width", "height"] as const) {
		const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!;
		Object.defineProperty(layers[tailIndex]!, dimension, {
			get() { return d.get!.call(this); },
			set(value: number) { if (dimension === "width") result.widthWrites++; else result.heightWrites++; d.set!.call(this, value); },
		});
	}
	// Production order and overlap: the opaque tail sits over wet/committed ink;
	// highlight layers below them each carry their own flat CSS wash.
	const colors: Record<string, string> = { highlight: "#ffd60a", highlightWet: "#d98b00", committed: "#2f6de0", wet: "#df3550" };
	for (let i = 0; i < layers.length; i++) {
		if (i === tailIndex) continue;
		const ctx = layers[i]!.getContext("2d")!;
		ctx.fillStyle = colors[names[i]!]!;
		ctx.fillRect((45 + i * 5) * config.backing, (45 + i * 5) * config.backing, 70 * config.backing, 35 * config.backing);
	}
	return result;
}

function setup(next: Config): void {
	full?.root.remove(); compact?.root.remove();
	document.body.style.cssText = "margin:0;display:flex;align-items:flex-start";
	config = next;
	full = arm("full");
	compact = arm("compact");
}

function draw(target: Arm, head: Head | null, prediction: Prediction | null): void {
	const cam = { x: 0, y: 0, zoom: 1 };
	const style = head?.highlighter ? HIGHLIGHTER_PEN : DEFAULT_PEN;
	const h = head && { cam, style, from: head.from, to: head.to, pressure: head.pressure ?? 0.7, hwWorld: head.hw };
	const p = prediction && { fromX: prediction.fromX, fromY: prediction.fromY,
		points: prediction.points.map((point, i) => ({ ...point, pressure: 0.7, timestamp: i })) as PenSample[], lineWidthPx: prediction.width };
	target.tail.clear();
	if (target === compact) target.tail.prepareLive?.(h, p);
	if (h) target.tail.drawHead(h.cam, h.style, h.from, h.to, h.pressure, h.hwWorld);
	if (p) target.tail.draw(p.fromX, p.fromY, p.points, style.color, p.lineWidthPx);
}

function event(head: Head | null, prediction: Prediction | null): void {
	for (const target of [full, compact]) target.layers[tailIndex]!.style.opacity = head?.highlighter ? String(HIGHLIGHTER_ALPHA) : "1";
	draw(full, head, prediction);
	draw(compact, head, prediction);
}

function ui(): void {
	for (const target of [full, compact]) {
		target.layers[tailIndex]!.style.opacity = "1";
		target.tail.restoreFullSurface?.();
		target.tail.clearAll(config.width, config.height);
		target.tail.drawSelectionBox({ x: 0, y: 0, zoom: 1 }, { x: 45, y: 33, width: config.width - 70, height: config.height - 60 }, "#1264ac");
	}
}

function carry(x: number, y: number): void {
	full.tail.carry(x, y);
	compact.tail.carry(x, y);
}

function clear(): void {
	full.tail.clearAll(config.width, config.height);
	compact.tail.clearAll(config.width, config.height);
}

function rtl(): void {
	for (const target of [full, compact]) target.root.dir = "rtl";
}

function tailInlineStyle(): { left: string; top: string; right: string; bottom: string; translate: string } {
	const style = compact.layers[tailIndex]!.style;
	return { left: style.left, top: style.top, right: style.right, bottom: style.bottom, translate: style.translate };
}

function tailAlpha(): { full: number; compact: number } {
	const count = (target: Arm): number => {
		const canvas = target.layers[tailIndex]!;
		const pixels = canvas.getContext("2d", { willReadFrequently: true })!
			.getImageData(0, 0, canvas.width, canvas.height).data;
		let alpha = 0;
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) alpha++;
		return alpha;
	};
	return { full: count(full), compact: count(compact) };
}

function clearTailDirty(): { full: number; compact: number } {
	full.tail.clear();
	compact.tail.clear();
	return tailAlpha();
}

function layerOrigin(layer: HTMLCanvasElement): { x: number; y: number } {
	const translation = layer.style.translate;
	const [tx = "0", ty = "0"] = !translation || translation === "none" ? [] : translation.split(" ");
	return {
		x: parseFloat(layer.style.left || "0") + parseFloat(tx),
		y: parseFloat(layer.style.top || "0") + parseFloat(ty),
	};
}

function image(target: Arm): ImageData {
	const c = document.createElement("canvas");
	c.width = Math.round(config.width * config.backing);
	c.height = Math.round(config.height * config.backing);
	const ctx = c.getContext("2d", { willReadFrequently: true })!;
	for (const layer of target.root.querySelectorAll("canvas")) {
		const origin = layerOrigin(layer);
		const x = Math.round(origin.x * config.backing);
		const y = Math.round(origin.y * config.backing);
		ctx.globalAlpha = Number(layer.style.opacity || "1");
		ctx.drawImage(layer, x, y);
	}
	return ctx.getImageData(0, 0, c.width, c.height);
}

function read() {
	const a = image(full), b = image(compact);
	let mismatch = 0, ink = 0;
	for (let i = 0; i < a.data.length; i += 4) {
		if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) mismatch++;
		if (a.data[i + 3]! > 0) ink++;
	}
	const tailCanvas = full.layers[tailIndex]!;
	const tail = tailCanvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, tailCanvas.width, tailCanvas.height);
	let tailInk = 0;
	for (let i = 3; i < tail.data.length; i += 4) if (tail.data[i]! > 0) tailInk++;
	const state = (target: Arm) => ({ layers: Object.fromEntries(names.map((name, i) => [name, { width: target.layers[i]!.width, height: target.layers[i]!.height }])),
		origin: layerOrigin(target.layers[tailIndex]!),
		widthWrites: target.widthWrites, heightWrites: target.heightWrites });
	return { full: state(full), compact: state(compact), mismatch, ink, tailInk };
}

function teardown(): void { full?.root.remove(); compact?.root.remove(); }

function plantOrder(): void { compact.root.appendChild(compact.layers[2]!); }
function restoreOrder(): void { for (const layer of compact.layers) compact.root.appendChild(layer); }
function plantOpacity(): void { compact.layers[0]!.style.opacity = "1"; }
function restoreOpacity(): void { compact.layers[0]!.style.opacity = String(HIGHLIGHTER_ALPHA); }

const inlinePath = "scroll-anchor-tear.md";
let inlineX = 0, inlineY = 0;
let inlineLayers: HTMLCanvasElement[] = [];
function inlineOverlay(): any {
	const overlay = overlayForPath(inlinePath);
	if (!overlay) throw new Error("inline tail fixture has no mounted overlay");
	return overlay;
}
function readInline() {
	const o = inlineOverlay();
	const tail = o.tailCanvas as HTMLCanvasElement;
	const layers = [o.highlightCanvas, o.highlightWetCanvas, o.committedCanvas, o.wetCanvas, tail] as HTMLCanvasElement[];
	let tailInk = 0;
	if (tail.width > 0 && tail.height > 0) {
		const pixels = tail.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, tail.width, tail.height).data;
		for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) tailInk++;
	}
	return { mode: o.mode, active: o.builder !== null, head: !!o.activeWet?.head?.(), tailInk,
		layers: Object.fromEntries(names.map((name, i) => [name, { width: layers[i]!.width, height: layers[i]!.height }])),
		origin: layerOrigin(tail),
		visibility: tail.style.visibility,
		css: { width: o.cssWidth, height: o.cssHeight } };
}
async function mountInline() {
	const writes: { canvas: HTMLCanvasElement; dimension: "width" | "height"; value: number }[] = [];
	const dimensions = ["width", "height"] as const;
	const original = dimensions.map(dimension => Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!);
	for (const [index, dimension] of dimensions.entries()) {
		const descriptor = original[index]!;
		Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
			...descriptor,
			set(this: HTMLCanvasElement, value: number) {
				writes.push({ canvas: this, dimension, value });
				descriptor.set!.call(this, value);
			},
		});
	}
	try {
		await (window as any).scrollColumnAnchor.runTearMount(1, 0, { w: 800, h: 500 }, true, { fx: 0.5, fy: 0.5 });
	} finally {
		for (const [index, dimension] of dimensions.entries())
			Object.defineProperty(HTMLCanvasElement.prototype, dimension, original[index]!);
	}
	const o = inlineOverlay();
	const mountTailWrites = writes.filter(write => write.canvas === o.tailCanvas)
		.map(({ dimension, value }) => ({ dimension, value }));
	inlineLayers = [o.highlightCanvas, o.highlightWetCanvas, o.committedCanvas, o.wetCanvas, o.tailCanvas];
	const r = o.view.dom.getBoundingClientRect();
	inlineX = Math.round(r.left + r.width * 0.45);
	inlineY = Math.round(r.top + r.height * 0.45);
	if (!document.elementFromPoint(inlineX, inlineY)) throw new Error("inline pen target outside viewport");
	return { ...readInline(), mountTailWrites };
}
function inlineEvent(type: string, x: number, y: number, buttons: number): void {
	const target = document.elementFromPoint(x, y);
	if (!target) throw new Error(`no inline input target at ${x},${y}`);
	target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 914, isPrimary: true,
		clientX: x, clientY: y, buttons, pressure: buttons ? 0.7 : 0 }));
}
function inkInline() {
	inlineEvent("pointerdown", inlineX, inlineY, 1);
	inlineEvent("pointermove", inlineX + 12, inlineY + 8, 1);
	inlineEvent("pointermove", inlineX + 22, inlineY + 12, 1);
	return readInline();
}
function liftInline() { inlineEvent("pointerup", inlineX + 22, inlineY + 12, 0); return readInline(); }
/** A longer stroke with every tail width and height write counted, then its release. */
function strokeCounted() {
	const tail = inlineOverlay().tailCanvas as HTMLCanvasElement;
	const writes: { dimension: "width" | "height"; value: number; phase: string }[] = [];
	const dimensions = ["width", "height"] as const;
	const original = dimensions.map(dimension => Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!);
	let phase = "down";
	for (const [index, dimension] of dimensions.entries()) {
		const descriptor = original[index]!;
		Object.defineProperty(HTMLCanvasElement.prototype, dimension, {
			...descriptor,
			set(this: HTMLCanvasElement, value: number) {
				if (this === tail) writes.push({ dimension, value, phase });
				descriptor.set!.call(this, value);
			},
		});
	}
	const boxes: { width: number; height: number; origin: { x: number; y: number } }[] = [];
	try {
		inlineEvent("pointerdown", inlineX, inlineY, 1);
		boxes.push({ width: tail.width, height: tail.height, origin: layerOrigin(tail) });
		phase = "move";
		for (let i = 1; i <= 24; i++) {
			inlineEvent("pointermove", inlineX + i * 9, inlineY + i * 5, 1);
			boxes.push({ width: tail.width, height: tail.height, origin: layerOrigin(tail) });
		}
		const live = readInline();
		phase = "up";
		inlineEvent("pointerup", inlineX + 24 * 9, inlineY + 24 * 5, 0);
		return { writes, boxes, live, lifted: readInline() };
	} finally {
		for (const [index, dimension] of dimensions.entries())
			Object.defineProperty(HTMLCanvasElement.prototype, dimension, original[index]!);
	}
}
async function unmountInline() {
	await (window as any).scrollColumnAnchor.runTearTeardown();
	return Object.fromEntries(names.map((name, i) => [name, { width: inlineLayers[i]!.width, height: inlineLayers[i]!.height }]));
}

(window as any).tailBackingPage = { setup, rtl, tailInlineStyle, event, ui, carry, clear, tailAlpha, clearTailDirty, read, teardown, plantOrder, restoreOrder, plantOpacity, restoreOpacity,
	mountInline, inkInline, liftInline, strokeCounted, unmountInline };
