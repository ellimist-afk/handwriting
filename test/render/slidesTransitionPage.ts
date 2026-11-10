/**
 * A real SlidesDeck over a three-slide deck laid out by Reveal's own transition rules (the test injects them), for the
 * slide-change follow. Reveal's script is not loaded: `go` does what Reveal's slide() does to the DOM - the past,
 * present and future classes, then `slidechanged` on `.reveal` - and the CSS transitions that starts are Reveal's
 * own. They are paused and seeked through `document.getAnimations()`, so a mid-move frame is exact, not timed.
 *
 * Slide 1: a magenta pen stroke and a yellow highlighter wash. Slide 2: a cyan pen stroke and a yellow wash. Slide 3:
 * a green pen stroke. Strokes are put straight into the deck's map (persistence is not under test) and painted by the
 * deck's own repaint.
 */
import { SlidesDeck, type SlideNib, type SlidesInkHost } from "../../src/slides/SlidesInkSurface";
import { emptyPage, type PageData } from "../../src/model/PageData";
import type { InkStroke } from "../../src/ink/Stroke";
import { setPenToolsMode } from "../../src/inline/PenToolsMode";
import { frames, gesture, installHostDom, line, type Pt } from "./penMarks";

installHostDom();
let deck: SlidesDeck, reveal: HTMLElement, slides: HTMLElement, container: HTMLElement;
let anims: Animation[] = [];
let nib: SlideNib = { tool: "pen", color: "#ff8000", width: 10 };
let pointer = 4100;
let refuse = false;
let throwDraw = false;
let followWrites: Array<{ transform: string; opacity: string }> = [];
let watcher: MutationObserver | null = null;

const BG = "#191919";

/** A straight stroke in slide-logical units (the deck's 960x700 space). */
function stroke(id: string, tool: "pen" | "highlighter", color: string, y: number, width: number): InkStroke {
	const points = Array.from({ length: 19 }, (_, j) => ({ x: 300 + j * 20, y, pressure: 0.5, t: j * 8 }));
	return { id, tool, color, width, createdAt: 0, points, bbox: { x: 300 - width, y: y - width, width: 360 + 2 * width, height: 2 * width } };
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
// The follow pair's canvases carry "follow" in their class; refusing them is WebKit's silent refusal. A throwing
// draw gives them a context whose setTransform throws, the first call of the pair's draw block.
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
	if (refuse && this.className.includes("follow")) return null;
	const ctx = (origGetContext as (...a: unknown[]) => unknown).apply(this, args);
	if (throwDraw && ctx && this.className.includes("follow")) {
		(ctx as CanvasRenderingContext2D).setTransform = () => { throw new Error("fixture: follow pair draw throws"); };
	}
	return ctx;
} as typeof HTMLCanvasElement.prototype.getContext;

function build(transition: string) {
	container = document.body.createDiv({ cls: "slides-container" });
	container.style.cssText = `position:absolute;left:0;top:0;width:1000px;height:760px;background:${BG}`;
	reveal = container.createDiv({ cls: `reveal ${transition}` });
	reveal.style.background = BG;
	slides = reveal.createDiv({ cls: "slides" });
	// What Reveal's layout() writes: the deck size, centred, scaled by k.
	slides.style.cssText = "width:960px;height:700px;left:50%;top:50%;bottom:auto;right:auto;transform:translate(-50%, -50%) scale(0.9)";
	for (let i = 0; i < 3; i++) {
		const section = slides.createEl("section", { cls: i === 0 ? "present" : "future" });
		// Reveal shows every slide in its view distance with an inline display, and sizes it to the deck.
		section.style.cssText = "display:block;top:0;height:100%";
		const text = section.createDiv({ cls: "transition-title", text: `Slide ${i + 1}` });
		text.style.cssText = "position:absolute;left:40px;top:40px;font:bold 40px/40px sans-serif;color:#dddddd";
	}
	const host: SlidesInkHost = {
		activeFilePath: () => "transition.md", readSource: async () => "# 1\n---\n# 2\n---\n# 3",
		readPageId: () => "transition-fixture", claimId: async () => ({ pageId: "transition-fixture" }), newPageId: () => "transition-fixture",
		loadSidecar: async () => ({ data: emptyPage("transition-fixture.slides") as PageData, recovered: false }),
		scheduleSidecar: () => {}, saveSidecarNow: async () => {},
		nib: () => nib, eraserRadiusPx: () => 8, eraseWholeStrokes: () => true,
		notify: () => {}, buildId: "slides-transition-fixture",
	};
	deck = new SlidesDeck(container, reveal, slides, host);
	// A paused transition is held across screenshots; the timeout has its own case.
	(deck as unknown as { followTimeoutMs?: number }).followTimeoutMs = 60_000;
}

async function open(transition = "slide", opts: { refuse?: boolean; throwDraw?: boolean } = {}) {
	watcher?.disconnect();
	for (const a of anims) a.cancel();
	anims = [];
	deck?.dispose();
	container?.remove();
	refuse = opts.refuse === true;
	throwDraw = opts.throwDraw === true;
	document.body.className = "theme-dark";
	setPenToolsMode("show");
	build(transition);
	await frames(4);
	const start = performance.now();
	while (!deck.status().mutable && performance.now() - start < 5000) await frames(1);
	deck.strokes.set(0, [stroke("m", "pen", "#ff00ff", 200, 14), stroke("y1", "highlighter", "#ffd60a", 420, 30)]);
	deck.strokes.set(1, [stroke("c", "pen", "#00ffff", 300, 14), stroke("y2", "highlighter", "#ffd60a", 520, 30)]);
	deck.strokes.set(2, [stroke("g", "pen", "#00e000", 360, 14)]);
	deck.repaint();
	await frames(2);
	followWrites = [];
	watcher = new MutationObserver(records => {
		for (const r of records) {
			const c = r.target as HTMLCanvasElement;
			if (c.className.includes("follow")) followWrites.push({ transform: c.style.transform, opacity: c.style.opacity });
		}
	});
	watcher.observe(reveal, { subtree: true, attributes: true, attributeFilter: ["style"] });
	return state();
}

/** What Reveal's slide() does to the DOM, then pause every transition it started at its first frame. */
async function go(to: number) {
	const sections = [...slides.querySelectorAll(":scope > section")] as HTMLElement[];
	sections.forEach((s, i) => {
		s.classList.remove("past", "present", "future");
		s.classList.add(i < to ? "past" : i === to ? "present" : "future");
	});
	reveal.dispatchEvent(new Event("slidechanged", { bubbles: true }));
	anims = document.getAnimations();
	for (const a of anims) { a.pause(); a.currentTime = 0; }
	await frames(2);
	return state();
}

/** Every running transition to `fraction` of its own duration. */
async function seek(fraction: number) {
	for (const a of document.getAnimations()) {
		a.pause();
		const d = Number(a.effect?.getComputedTiming().duration ?? 0);
		a.currentTime = d * fraction;
	}
	await frames(3);
	return state();
}

/** Let the paused transitions run on in real time to their ends. */
async function play() {
	for (const a of document.getAnimations()) a.play();
	const start = performance.now();
	while (document.getAnimations().some(a => a.playState === "running") && performance.now() - start < 3000) await frames(1);
	await frames(4);
	return state();
}

async function finish() {
	for (const a of document.getAnimations()) a.finish();
	await frames(4);
	return state();
}

function fnv(data: Uint8ClampedArray): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) { h ^= data[i]!; h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16);
}

/** The main pair's pixels, then again after a plain repaint of the present slide: byte-same means no snap. */
function arrivedVsPlain() {
	const l = deck.layers;
	if (!l) return { arrived: "", plain: "" };
	const read = () => [l.committed, l.highlight].map(c => fnv(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data)).join(",");
	const arrived = read();
	deck.repaint();
	return { arrived, plain: read() };
}

function rect(el: Element) {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function state() {
	const sections = [...slides.querySelectorAll(":scope > section")] as HTMLElement[];
	return {
		following: (deck as unknown as { follow: unknown }).follow != null,
		mode: (deck as unknown as { follow: { mode: string } | null }).follow?.mode ?? null,
		disposed: (deck as unknown as { disposed: boolean }).disposed,
		slides: rect(slides),
		sections: sections.map(s => ({ ...rect(s), opacity: Number(getComputedStyle(s).opacity), cls: s.className })),
		canvases: [...reveal.querySelectorAll("canvas")].map(c => ({
			cls: c.className, parent: c.parentElement?.className ?? "",
			transform: c.style.transform, opacity: c.style.opacity, visibility: c.style.visibility,
		})),
		groups: reveal.querySelectorAll(".handwriting-slides-highlight-group").length,
		strokes: [0, 1, 2].map(i => (deck.strokes.get(i) ?? []).map(s => s.id)),
		followWrites: followWrites.slice(),
	};
}

async function pen(a: Pt, b: Pt) {
	nib = { tool: "pen", color: "#ff8000", width: 10 };
	await gesture(line(a, b), ++pointer, 0.8);
	await frames(2);
	return state();
}

/**
 * Each shown slide title's box on screen, moved and faded with its slide; the test never reads ink there. A title its
 * slide hides (Reveal's zoom past and future are visibility:hidden, and scaled 16 times or a fifth) paints nothing and
 * is left out. `present` marks the present slide's title.
 */
function titles() {
	return ([...slides.querySelectorAll(".transition-title")] as HTMLElement[])
		.filter(el => getComputedStyle(el).visibility !== "hidden")
		.map(el => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, present: el.parentElement?.classList.contains("present") === true };
		});
}

/**
 * Every stroke's box on screen, its slide-logical bbox mapped through its own section's box, for each section whose
 * computed transform is a translation only (a rotated section's box is not a linear map of the deck).
 */
function inkBoxes() {
	const sections = [...slides.querySelectorAll(":scope > section")] as HTMLElement[];
	const out: Array<{ id: string; box: { left: number; top: number; right: number; bottom: number } }> = [];
	sections.forEach((sec, i) => {
		const t = getComputedStyle(sec).transform;
		const m = new DOMMatrixReadOnly(t === "none" ? undefined : t);
		const translateOnly = m.m11 === 1 && m.m12 === 0 && m.m21 === 0 && m.m22 === 1 &&
			m.m13 === 0 && m.m14 === 0 && m.m23 === 0 && m.m24 === 0 && m.m31 === 0 && m.m32 === 0 && m.m33 === 1 && m.m34 === 0 && m.m44 === 1;
		if (!translateOnly) return;
		const r = sec.getBoundingClientRect(), kx = r.width / sec.offsetWidth, ky = r.height / sec.offsetHeight;
		for (const s of deck.strokes.get(i) ?? []) {
			const b = s.bbox;
			out.push({ id: `${i}:${s.id}`, box: { left: r.left + b.x * kx, top: r.top + b.y * ky, right: r.left + (b.x + b.width) * kx, bottom: r.top + (b.y + b.height) * ky } });
		}
	});
	return out;
}

async function resize() { window.dispatchEvent(new Event("resize")); await frames(2); return state(); }
function dispose() { deck.dispose(); return state(); }
/** The production land timeout back, for the case that waits it out in real time. */
function timeout(ms: number) { (deck as unknown as { followTimeoutMs: number }).followTimeoutMs = ms; }

const api = { open, go, seek, play, finish, arrivedVsPlain, state, titles, inkBoxes, pen, resize, dispose, timeout, frames };
declare global { interface Window { slidesTransition: typeof api } }
window.slidesTransition = api;
