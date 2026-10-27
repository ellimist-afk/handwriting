/**
 * THE PREVIEW PAPER. While a pinch preview lives (and through the bounce its settle may start), the lined, grid or
 * dotted paper is not the scroller's own background moved through its gradient stops: it is an element under the
 * scroller carrying a copy of that background, moved by a composited transform, and the scroller's background is off.
 * These cells read that element against the text, against the scroller's own paper it stands in for, and against
 * every path that takes it down, at DSF 2 in headless Chromium. Every cell's red comes first: a behaviour of the element
 * reads red on the tree before it, and every parity reading has a plant, built into the page by an exact source
 * substitution, that must turn it red.
 *
 * Tolerances: the paper against the text, 2 device px at rest (as the pan cells), 2.5 on the element, whose rules land
 * on whole device px and so may sit up to half a device px from the text.
 *
 * WHERE THE RULES LAND: the element's offset is rounded so that the copy's rules land on whole device px of the zoom in
 * force (offset x kd = round(u + f) - f, f the fraction the copy's phase sits off this zoom's grid), which is where the
 * settle's snap puts them: the lift moves the paper by nothing. Rounding the offset alone (the SNAP_TRANSLATE_ONLY plant)
 * leaves the rules f off the grid on zoom frames and the lift jump up to a device px; under it the existing SNAP_TWICE
 * plant would read .47 against the .5 lift bar, blind. The LIFT JUMP arms at 130 percent, where f is not 0, close that gap.
 *
 * RIGHT-TO-LEFT notes get no element: they keep the scroller's own route, and with it the current route's drag cost.
 *
 * Plants (HW_PAPER_PREVIEW_PLANT_*=1, one at a time; a plant whose anchor is not in the source throws):
 *   BYPASS_SETTLE / BYPASS_CANCEL / BYPASS_COMMIT / BYPASS_UNMOUNT / BYPASS_NOTE_SWITCH  the one place the element comes
 *     down ignores that path (the CHOKE POINT arm of that path goes red, the others stay green);
 *   SWAP_ON_NAN      a pitch that is not a length still puts the element up (HOST PITCH, not a length);
 *   PARSEFLOAT_PITCH a pitch in another unit is read as px (HOST PITCH, rem);
 *   FOLD_WRITTEN_PITCH the element folds by the overlay's planned pitch, not the host's (HOST PITCH, px);
 *   NONE_SWAPS       a note with no paper still gets an element (OVERRIDES, note none);
 *   NO_TILE_COPY     the copy leaves out the tile size and position (OVERRIDES, dots);
 *   SWAP_ON_RTL      a right-to-left scroller gets an element (RTL);
 *   BOX_ONCE         the element's box is not re-read on preview frames (BOX, a host inset removed mid-preview);
 *   LATE_IN / LATE_OUT / CLASS_LATE_OUT the element goes up, or comes down, or the scroller's paper comes back, a frame
 *     late (SWAP PARITY: a frame with no paper, or with two);
 *   NO_SNAP / SNAP_BEFORE_FOLD  the element's offset is not put on the device px grid, or is folded after it is (SMEAR);
 *   SNAP_TRANSLATE_ONLY the rounding ignores the copy's phase fraction (LIFT JUMP at 130 percent);
 *   SCROLL_AREA / NO_MARGIN the element is as large as the scroll area, or has no margin (BOUNDS);
 *   LEAK             a taken-down element stays in the page (LEAK);
 *   NO_COLOR_COPY    the copy leaves out the scroller's background colour (SWAP PARITY under a theme colour, during);
 *   SKIP_RESTORE     the element comes down but the scroller's own background stays suppressed (SWAP PARITY under a theme
 *                    colour, after);
 *   RESIDUAL_WRONG_SIGN the snap's residual is carried the wrong way through the preview, so the lift moves the paper by
 *                    twice it (LIFT JUMP, the off-grid arm);
 *   STALE_AT_SWAP_OUT the swap-out reuses what the swap-in left the scroller instead of the pan in force.
 *                    BLIND on these fixtures, measured: their settle spends the whole pan into the scroll, so
 *                    "what the swap-in left" and "the pan in force" are both nothing and no reading moves. Kept, because a
 *                    settle that cannot spend its pan (a page with no scroll range) is exactly where it would bite;
 *   SKIP_PITCH_GATE  a background of gradients on a period of its own is taken for the paper (A THEME'S OWN GRADIENTS).
 *
 * WHY SNAP_TWICE IS INERT HERE, and must not be re-added to these arms without reading this. On the scroller's own route
 * that plant applies the at-rest snap's residual a second time and the lift jump doubles. On this route the element's
 * offset is rounded so the rules land on the whole device px nearest the text (K5), and that rounding absorbs the doubled
 * residual: the plant changes no reading. Measured, not assumed (plant run p33: green, with its cell's premises holding).
 * It is retired for this route - it stays on the current-route cells, where it still reddens - in favour of plants that
 * target where THIS mechanism would fail instead: STALE_AT_SWAP_OUT and RESIDUAL_WRONG_SIGN above.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import { decodePng } from "./pngInk";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

let realBrowser: Browser, script: string;
const OBSIDIAN_CAMERA_CSS = readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8");
const DSF = 2, PITCH = 28, TOL_DEV = 2, TOL_PREVIEW_DEV = TOL_DEV + 0.5, PAGE_GREY = 255, RULE_GREY = 0x77, BAND_CUT = 0.1;
const PINCH = /src[\\/]inline[\\/]InkOverlayPinch\.ts$/, PAN = /src[\\/]inline[\\/]PaperPan\.ts$/;
const PAPER = /src[\\/]inline[\\/]InkOverlayPaperPinch\.ts$/;

const CHOKE = "\t\tconst el = this.previewPaperEl;\n\t\tif (!el) return;\n\t\tthis.previewPaperEl = null;";
const bypass = (reason: string) => `\t\tconst el = this.previewPaperEl;\n\t\tif (!el || reason === "${reason}") return;\n\t\tthis.previewPaperEl = null;`;
const SWAP_GATE = "\t\tif (pitch === null || cs.direction !== \"ltr\" || !previewPaperCopyable(cs, pitch)) return;\n";
const SNAPPED = "\t\tconst tx = (Math.round(foldIntoPitch(x - this.paperScrollLeft + margin, pitch) * kd + fx) - fx) / kd;\n\t\tconst ty = (Math.round(foldIntoPitch(y - this.paperScrollTop + margin, pitch) * kd + fy) - fy) / kd;\n";
const PLANTS: { env: string; file: RegExp; from: string; to: string }[] = [
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_SETTLE", file: PINCH, from: CHOKE, to: bypass("settle") },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_CANCEL", file: PINCH, from: CHOKE, to: bypass("cancel") },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_COMMIT", file: PINCH, from: CHOKE, to: bypass("commit") },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_UNMOUNT", file: PINCH, from: CHOKE, to: bypass("unmount") },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_NOTE_SWITCH", file: PINCH, from: CHOKE, to: bypass("note-switch") },
	// The copyable check reads the pitch, so a missing pitch skips it rather than failing it.
	{ env: "HW_PAPER_PREVIEW_PLANT_SWAP_ON_NAN", file: PAPER, from: SWAP_GATE, to: "\t\tif (cs.direction !== \"ltr\" || (pitch !== null && !previewPaperCopyable(cs, pitch))) return;\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SWAP_ON_RTL", file: PAPER, from: SWAP_GATE, to: "\t\tif (pitch === null || !previewPaperCopyable(cs, pitch)) return;\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_PARSEFLOAT_PITCH", file: PAN, from: "\tif (!/^(\\d+\\.?\\d*|\\.\\d+)px$/.test(text)) return null;\n", to: "" },
	{ env: "HW_PAPER_PREVIEW_PLANT_FOLD_WRITTEN_PITCH", file: PAPER, from: "\t\tconst el = this.previewPaperEl, box = this.previewPaperBox, pitch = this.previewPaperPitch;\n",
		to: "\t\tconst el = this.previewPaperEl, box = this.previewPaperBox, pitch = Number.parseFloat(this.paperWritten?.get(\"--handwriting-paper-pitch\") ?? \"\");\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_NONE_SWAPS", file: PAN, from: "\tconst image = cs.backgroundImage.trim();\n\tif (!image || image === \"none\") return false;\n", to: "\treturn true;\n\tconst image = cs.backgroundImage.trim();\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_TILE_COPY", file: PAN, from: "\tel.style.backgroundSize = join(cs.backgroundSize, extra?.backgroundSize ?? \"\");\n\tel.style.backgroundPosition = join(cs.backgroundPosition, extra?.backgroundPosition ?? \"\");\n", to: "" },
	{ env: "HW_PAPER_PREVIEW_PLANT_BOX_ONCE", file: PINCH, from: "\t\t\tthis.measurePreviewPaperBox(true);\n", to: "" },
	{ env: "HW_PAPER_PREVIEW_PLANT_LATE_IN", file: PAPER, from: "\t\thost.insertBefore(el, scroller);\n", to: "\t\tthis.winRef.requestAnimationFrame(() => host.insertBefore(el, scroller));\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_LATE_OUT", file: PINCH, from: "\t\tel.remove();\n", to: "\t\tthis.winRef.requestAnimationFrame(() => el.remove());\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_CLASS_LATE_OUT", file: PINCH, from: "\t\tthis.view?.scrollDOM?.classList.remove(\"handwriting-paper-previewing\");\n",
		to: "\t\tthis.winRef.requestAnimationFrame(() => this.view?.scrollDOM?.classList.remove(\"handwriting-paper-previewing\"));\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_SNAP", file: PAPER, from: SNAPPED,
		to: "\t\tconst tx = foldIntoPitch(x - this.paperScrollLeft + margin, pitch);\n\t\tconst ty = foldIntoPitch(y - this.paperScrollTop + margin, pitch);\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SNAP_BEFORE_FOLD", file: PAPER, from: SNAPPED,
		to: "\t\tconst tx = foldIntoPitch((Math.round((x - this.paperScrollLeft + margin) * kd + fx) - fx) / kd, pitch);\n\t\tconst ty = foldIntoPitch((Math.round((y - this.paperScrollTop + margin) * kd + fy) - fy) / kd, pitch);\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SNAP_TRANSLATE_ONLY", file: PAPER, from: "\t\tconst fx = fractionOf(this.previewPaperPhaseX * kd), fy = fractionOf(this.previewPaperPhaseY * kd);\n", to: "\t\tconst fx = 0, fy = 0;\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SCROLL_AREA", file: PAPER, from: "\t\tconst right = host.clientWidth - (left + scroller.clientWidth), bottom = host.clientHeight - (top + scroller.clientHeight);\n",
		to: "\t\tconst right = host.clientWidth - (left + scroller.scrollWidth), bottom = host.clientHeight - (top + scroller.scrollHeight);\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_MARGIN", file: PAPER, from: "\t\tconst margin = (Math.ceil(pitch * kd - 1e-6) + 1) / kd;\n", to: "\t\tconst margin = 0;\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_LEAK", file: PINCH, from: "\t\tel.remove();\n", to: "" },
	// The swap-out leaves the scroller carrying what the swap-in left it, instead of the pan in force.
	// The settle's residual carried with the wrong sign, so the lift moves the paper by twice it.
	{ env: "HW_PAPER_PREVIEW_PLANT_RESIDUAL_WRONG_SIGN", file: PAPER, from: "\t\tconst carry = this.pinchPreview ? this.paperSnapResidual : null;\n", to: "\t\tconst carry = this.pinchPreview ? { x: -this.paperSnapResidual.x, y: -this.paperSnapResidual.y } : null;\n" },
	{ env: "HW_PAPER_PREVIEW_PLANT_STALE_AT_SWAP_OUT", file: PINCH, from: "\t\tthis.paperPanWritten = null;\n\t\tthis.writePaperPan();\n\t}", to: "\t}" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SKIP_PITCH_GATE", file: PAN, from: "const onPitch = (v: number, pitch: number) => Number.isFinite(v) && Math.abs(v - pitch) <= 1 / 32;", to: "const onPitch = (_v: number, _pitch: number) => true;" },
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_COLOR_COPY", file: PAN, from: "\tel.style.backgroundColor = cs.backgroundColor;\n", to: "" },
	{ env: "HW_PAPER_PREVIEW_PLANT_SKIP_RESTORE", file: PINCH, from: "\t\tthis.view?.scrollDOM?.classList.remove(\"handwriting-paper-previewing\");\n", to: "" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./noteViewportCameraPage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "preview-paper-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/](InkOverlay|InkOverlayPaperPinch|InkOverlayPinch|PaperPan)\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active.filter(x => x.file.test(args.path))) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [],
	});
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	realBrowser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DSF}`, "--window-size=900,700"] });
}, 180_000);

afterAll(async () => { await realBrowser?.close(); });

type Kind = "lines" | "grid" | "dots";
type MountOptions = { global?: Kind | "off"; note?: Kind | "none" | ""; doc?: string; readable?: boolean; dir?: "rtl" | ""; hostCss?: string; zoom?: number; scrollTop?: number; scrollLeft?: number };

async function open(): Promise<{ p: Page; close: () => Promise<void> }> {
	const ctx = await realBrowser.newContext({ viewport: null });
	const p = await ctx.newPage();
	return { p, close: () => ctx.close() };
}

/**
 * One glyph far above every read, white page, mid-grey rules, `.cm-sizer` installed (the text takes the pan through
 * it). A note's own paper wraps the rig's host; `hostCss` is a stylesheet added before the overlay plans.
 */
async function mount(p: Page, o: MountOptions = {}) {
	const global = o.global ?? "lines";
	await p.setContent(`<!doctype html><body class="${global === "off" ? "" : `handwriting-paper-${global}`}" style="margin:0; background:#ffffff; --background-modifier-border:#777777"></body>`);
	await p.addStyleTag({ content: css + OBSIDIAN_CAMERA_CSS + (o.hostCss ?? "") });
	if (o.readable) {
		await p.addStyleTag({ content: `${REAL_OBSIDIAN_CSS}\nbody { --file-line-width: 320px; }` });
		await p.evaluate(() => {
			new MutationObserver(recs => { for (const r of recs) r.addedNodes.forEach(n => { if (n instanceof HTMLElement && n.classList.contains("camera-proof")) n.classList.add("mod-cm6", "is-readable-line-width"); }); })
				.observe(document.body, { childList: true });
		});
	}
	await p.addScriptTag({ content: script });
	await p.evaluate(async ({ doc, note, dir, zoom, scrollTop, scrollLeft }) => {
		const fx = (window as any).viewportFixture;
		await fx.setup("paper", "far", 1, 1, doc);
		const content = document.querySelector(".cm-content") as HTMLElement;
		const sizer = document.createElement("div"); sizer.className = "cm-sizer";
		const container = document.createElement("div"); container.className = "cm-contentContainer";
		content.parentElement!.insertBefore(sizer, content); sizer.appendChild(container); container.appendChild(content);
		const host = document.querySelector('[data-rig="paper"]') as HTMLElement;
		if (note) { const wrap = document.createElement("div"); wrap.dataset.handwritingPaper = note; host.before(wrap); wrap.appendChild(host); }
		if (dir) host.setAttribute("dir", dir);
		await fx.settle();
		await (window as any).edgeAudit.commit("paper", zoom);
		const sc = document.querySelector(".cm-scroller") as HTMLElement;
		sc.scrollTop = scrollTop; sc.scrollLeft = scrollLeft;
		await fx.settle();
	}, { doc: o.doc ?? "x", note: o.note ?? "", dir: o.dir ?? "", zoom: o.zoom ?? 1, scrollTop: o.scrollTop ?? 1200, scrollLeft: o.scrollLeft ?? 0 });
}

async function pinchStart(p: Page, cx: number, cy: number, spread = 200) {
	await p.evaluate(({ cx, cy, spread }) => {
		const send = (type: string, pid: number, x: number, y: number) => {
			const target = document.elementFromPoint(x, y);
			if (!target) throw new Error(`pinch point (${x},${y}) outside the page`);
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
		};
		send("pointerdown", 701, cx - spread / 2, cy);
		send("pointerdown", 702, cx + spread / 2, cy);
		(window as any).__staged = { cx, cy, dx: 0, dy: 0, ratio: 1, half0: spread / 2, send };
	}, { cx, cy, spread });
}

/**
 * Move the staged fingers to `to` times their starting spread, and by (dx, dy) css px, one frame per step.
 *
 * A DRAG ENGAGES WITH A SCALE CHANGE FIRST. Measured on 31b13737 (red-first A and B, 22:40-22:44Z): a two-finger move at
 * a held spread leaves `pinchPreview` false - the router hands it to the scroll assist - and so does a scale change too
 * small to claim (0.95 over four steps read false on every frame). The preview engages on the third step of a spread
 * changing about two percent a step. `pinchDrag` below therefore does what the cost harness's drag gesture does: 1 -> 0.9
 * in six steps, then the drag at the held spread.
 */
async function pinchStage(p: Page, to: number, steps = 12, dx = 0, dy = 0) {
	await p.evaluate(async ({ to, steps, dx, dy }) => {
		const st = (window as any).__staged;
		const raf = () => new Promise<void>(r => requestAnimationFrame(() => r()));
		const from = st.ratio, fx = st.dx, fy = st.dy;
		for (let i = 1; i <= steps; i++) {
			const ratio = from * (to / from) ** (i / steps), half = st.half0 * ratio, ox = fx + (dx * i) / steps, oy = fy + (dy * i) / steps;
			st.send("pointermove", 701, st.cx + ox - half, st.cy + oy);
			st.send("pointermove", 702, st.cx + ox + half, st.cy + oy);
			await raf();
		}
		st.ratio = to; st.dx = fx + dx; st.dy = fy + dy;
	}, { to, steps, dx, dy });
}

/**
 * Engage the preview with a scale change, come back to the scale the arm is read at, then drag at the held spread.
 *
 * The return matters for every reading taken against the at-rest one: a frame read at another zoom has another pitch in
 * device px, so its band count and mass are not the rest reading's to compare with (measured, green run 8: twelve
 * OVERRIDES arms read a 0.9 frame against a 1.0 rest and differed by a band).
 */
async function pinchDrag(p: Page, dx: number, dy: number, steps = 8) {
	await pinchStage(p, 0.9, 6);
	await pinchStage(p, 1, 4);
	await pinchStage(p, 1, steps, dx, dy);
}

async function stagedRelease(p: Page, onScroller = false) {
	await p.evaluate(async onScroller => {
		const st = (window as any).__staged, half = st.half0 * st.ratio;
		// On the scroller itself when nothing of the editor is under the fingers (a hidden editor).
		const up = (pid: number, x: number, y: number) => onScroller
			? (document.querySelector(".cm-scroller") as HTMLElement).dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: 0, width: 8, height: 8 }))
			: st.send("pointerup", pid, x, y);
		up(701, st.cx + st.dx - half, st.cy + st.dy);
		up(702, st.cx + st.dx + half, st.cy + st.dy);
		await (window as any).viewportFixture.settle();
	}, onScroller);
}

type Preview = { present: boolean; all: number; previewing: boolean; readout: { present: boolean; held: boolean; swaps: number; ended: string | null; pitch: number } | null;
	tx: number; ty: number; marginX: number; marginY: number; pitch: number; image: string; size: string; position: string;
	rect: { left: number; top: number; width: number; height: number }; scroller: { left: number; top: number; width: number; height: number } };
const preview = (p: Page): Promise<Preview> => p.evaluate(() => (window as any).viewportFixture.previewPaper("paper"));

/**
 * THE FRAME MODEL: what the stylesheet paints this frame, and where. `sources` counts the paper layers painting (the
 * scroller's background when its computed image is not none, and every connected preview element with an image):
 * exactly one while there is paper. `offX`/`offY` are the paper's lattice origin against the first line's box, device px
 * modulo the pitch, from whichever layer paints it.
 */
type Frame = { tag: string; source: string; sources: number; offX: number; offY: number; k: number; preview: boolean; scrollerPan: string };
async function installFrameModel(p: Page) {
	await p.evaluate(() => {
		(window as any).__frame = (tag: string) => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement, line = (document.querySelector(".cm-line") as HTMLElement).getBoundingClientRect();
			const scrollerPaints = getComputedStyle(sc).backgroundImage !== "none" ? 1 : 0;
			const elementPaints = Array.from(document.querySelectorAll<HTMLElement>(".handwriting-paper-preview")).filter(e => e.isConnected && getComputedStyle(e).backgroundImage !== "none").length;
			const o = (window as any).viewportFixture.paperOrigin("paper") as { source: string; x: number; y: number; k: number; pitch: number };
			const wrap = (v: number) => { const m = ((v % o.pitch) + o.pitch) % o.pitch; return Math.min(m, o.pitch - m); };
			return { tag, source: o.source, sources: scrollerPaints + elementPaints, offX: wrap((line.left - o.x) / o.k) * o.k * 2, offY: wrap((line.top - o.y) / o.k) * o.k * 2, k: o.k,
				preview: (window as any).viewportFixture.preview("paper") as boolean,
				// What the scroller's own pan properties carry this frame: the standing pan the copy must not take twice.
				scrollerPan: `${sc.style.getPropertyValue("--handwriting-paper-pan-x")}|${sc.style.getPropertyValue("--handwriting-paper-pan-y")}` };
		};
	});
}
const frameNow = (p: Page, tag: string): Promise<Frame> => p.evaluate(tag => (window as any).__frame(tag), tag);

const contrast = (r: number, g: number, b: number) => Math.max(0, Math.min(1, (PAGE_GREY - (r + g + b) / 3) / (PAGE_GREY - RULE_GREY)));
const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN; };
type Clip = { x: number; y: number; width: number; height: number };

/** Median contrast per device row (axis y) or column (axis x) of a strip. */
async function profile(p: Page, clip: Clip, axis: "x" | "y"): Promise<number[]> {
	const d = decodePng(await p.screenshot({ clip }));
	const n = axis === "y" ? d.height : d.width, across = axis === "y" ? d.width : d.height, out: number[] = [];
	for (let i = 0; i < n; i++) {
		const vals: number[] = [];
		for (let j = 0; j < across; j++) { const at = (axis === "y" ? i * d.width + j : j * d.width + i) * d.channels; vals.push(contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!)); }
		out.push(median(vals));
	}
	return out;
}

/** Every band above a tenth of the contrast not cut by the strip's ends: centre (device px), peak, mass. */
function bandsOf(prof: number[]) {
	const bands: { centre: number; peak: number; mass: number }[] = [];
	for (let i = 0; i < prof.length; i++) {
		if (prof[i]! <= BAND_CUT) continue;
		let j = i, peak = 0, mass = 0, moment = 0;
		while (j < prof.length && prof[j]! > BAND_CUT) { peak = Math.max(peak, prof[j]!); mass += prof[j]!; moment += prof[j]! * (j + 0.5); j++; }
		if (i > 0 && j < prof.length) bands.push({ centre: moment / mass, peak, mass });
		i = j;
	}
	return bands;
}

/** Lattice bands (another band one pitch away) with their centres in [lo, hi). */
const lattice = (prof: number[], pitchDev: number, lo = -Infinity, hi = Infinity) => {
	const bands = bandsOf(prof);
	return bands.filter(b => b.centre >= lo && b.centre < hi && bands.some(o => o !== b && Math.abs(Math.abs(o.centre - b.centre) - pitchDev) <= 2));
};
type RuleRead = { count: number; minPeak: number; medianPeak: number; medianMass: number };
const summarise = (bands: { peak: number; mass: number }[]): RuleRead => ({ count: bands.length, minPeak: bands.length ? Math.min(...bands.map(b => b.peak)) : Number.NaN,
	medianPeak: median(bands.map(b => b.peak)), medianMass: median(bands.map(b => b.mass)) });
function ruleVerdict(none: RuleRead, other: RuleRead) {
	const countEqual = other.count === none.count, peakOk = other.minPeak >= 0.75, massOk = Math.abs(other.medianMass - none.medianMass) <= 0.15 * none.medianMass;
	return { pass: countEqual && peakOk && massOk, countEqual, peakOk, massOk };
}

/** Dots in a patch: each blob's weighted centre, peak and mass (blobs cut by the patch's edge are dropped). */
async function dotsIn(p: Page, clip: Clip) {
	const d = decodePng(await p.screenshot({ clip }));
	const f = new Float32Array(d.width * d.height);
	for (let i = 0; i < f.length; i++) { const at = i * d.channels; f[i] = contrast(d.px[at]!, d.px[at + 1]!, d.px[at + 2]!); }
	const seen = new Uint8Array(f.length), out: { peak: number; mass: number }[] = [];
	for (let s = 0; s < f.length; s++) {
		if (seen[s] || f[s]! <= BAND_CUT) continue;
		const stack = [s]; seen[s] = 1;
		let n = 0, peak = 0, mass = 0, edge = false;
		while (stack.length) {
			const c = stack.pop()!, x = c % d.width, y = (c - x) / d.width, v = f[c]!;
			n++; peak = Math.max(peak, v); mass += v;
			if (x === 0 || y === 0 || x === d.width - 1 || y === d.height - 1) edge = true;
			for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
				if (nx < 0 || ny < 0 || nx >= d.width || ny >= d.height) continue;
				const q = ny * d.width + nx;
				if (!seen[q] && f[q]! > BAND_CUT) { seen[q] = 1; stack.push(q); }
			}
		}
		if (!edge && n <= 400) out.push({ peak, mass });
	}
	return { dots: out.length, peak: median(out.map(d => d.peak)), mass: median(out.map(d => d.mass)) };
}

/** The most common colour in a patch of the pane: the paper's ground between its marks. */
async function groundColour(p: Page): Promise<[number, number, number]> {
	const s = await scrollerBox(p);
	const d = decodePng(await p.screenshot({ clip: { x: Math.round(s.left + 40), y: Math.round(s.top + 100), width: 120, height: 120 } }));
	const counts = new Map<string, number>();
	for (let i = 0; i < d.width * d.height; i++) { const at = i * d.channels, key = `${d.px[at]},${d.px[at + 1]},${d.px[at + 2]}`; counts.set(key, (counts.get(key) ?? 0) + 1); }
	const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
	return top.split(",").map(Number) as [number, number, number];
}

const scrollerBox = (p: Page) => p.evaluate(() => { const r = (document.querySelector(".cm-scroller") as HTMLElement).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });

/** What a patch of paper reads, for the kind drawn: lattice bands on both axes for rules, dots for dots. */
async function paperRead(p: Page, kind: Kind | "none", k: number) {
	const s = await scrollerBox(p), pitchDev = PITCH * k * DSF;
	if (kind === "dots") return { kind, ...(await dotsIn(p, { x: Math.round(s.left + 20), y: Math.round(s.top + 60), width: 200, height: 200 })) };
	const y = summarise(lattice(await profile(p, { x: Math.round(s.left + 4), y: Math.round(s.top + 40), width: 12, height: 300 }, "y"), pitchDev));
	const x = kind === "grid" ? summarise(lattice(await profile(p, { x: Math.round(s.left + 20), y: Math.round(s.top + 200), width: 300, height: 12 }, "x"), pitchDev)) : null;
	return { kind, y, x };
}

// ---------------------------------------------------------------------------------------------------------------------
// CHOKE POINT (gap 1): every path that ends a preview takes the element down through the one place.
// ---------------------------------------------------------------------------------------------------------------------

const PATHS = ["settle", "refused", "thrown", "commit", "note-switch", "unmount"] as const;
it.each(PATHS)("CHOKE POINT, %s: the preview element comes down, the scroller's paper comes back, and the path that took it down is named", async path => {
	const { p, close } = await open();
	try {
		await mount(p);
		await pinchStart(p, 400, 380);
		await pinchStage(p, 1.3, 8);
		const live = await preview(p);
		expect(live.present && live.previewing && live.all === 1, `premise: the live preview's paper is the one element ${JSON.stringify(live)}`).toBe(true);
		const expected = path === "refused" || path === "thrown" ? "cancel" : path;
		if (path === "settle") await stagedRelease(p);
		else if (path === "refused") {
			// A settle whose commit is refused (the editor has no size): the gesture ends without its settle.
			await p.evaluate(() => { (document.querySelector('[data-rig="paper"]') as HTMLElement).style.display = "none"; });
			await stagedRelease(p, true);
			await p.evaluate(async () => { (document.querySelector('[data-rig="paper"]') as HTMLElement).style.display = ""; await (window as any).viewportFixture.settle(); });
		} else if (path === "thrown") {
			// A settle that throws: the gesture's end still runs its own cleanup.
			await p.evaluate(() => { const o = (window as any).viewportFixture.overlay("paper"); o.commitCameraScale = () => { throw new Error("a settle that throws, set by the cell"); }; });
			await stagedRelease(p);
			await p.evaluate(async () => { delete (window as any).viewportFixture.overlay("paper").commitCameraScale; await (window as any).viewportFixture.settle(); });
		} else if (path === "commit") {
			await p.evaluate(() => (window as any).edgeAudit.commit("paper", 1.1));
		} else if (path === "note-switch") {
			await p.evaluate(() => (window as any).viewportFixture.switchPath("paper", "another-note.md"));
		} else {
			// A plugin reload on the open editor: the overlay is destroyed and a new one mounts on the same editor.
			await p.evaluate(async () => {
				const fx = (window as any).viewportFixture, old = fx.overlay("paper");
				await fx.reloadOverlay("paper");
				(window as any).__oldReadout = old.previewPaperReadout();
			});
		}
		const after = await p.evaluate(() => {
			const sc = document.querySelector(".cm-scroller") as HTMLElement;
			return { inPage: document.querySelectorAll(".handwriting-paper-preview").length, previewing: sc.classList.contains("handwriting-paper-previewing"),
				image: getComputedStyle(sc).backgroundImage };
		});
		const readout = live.readout;
		const old = await p.evaluate(() => (window as any).__oldReadout ?? null);
		const now = path === "unmount" ? old : (await preview(p)).readout;
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER CHOKE ${path}`, JSON.stringify({ live, after, now, readout }));
		expect(after.inPage, `CHOKE POINT ${path}: no preview element left in the page`).toBe(0);
		expect(after.previewing, `CHOKE POINT ${path}: the scroller's own paper is back on`).toBe(false);
		expect(after.image, `CHOKE POINT ${path}: the scroller paints its paper`).toContain("gradient");
		expect([now?.held, now?.ended], `CHOKE POINT ${path}: the overlay holds no element, and the path that took it down is ${expected}`).toEqual([false, expected]);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// HOST PITCH (gap 2, K3): the element folds by the pitch the scroller resolves, and only a px length puts it up.
// ---------------------------------------------------------------------------------------------------------------------

it.each([["40px", true], ["calc(20px + 20px)", false], ["2.5rem", false]] as const)("HOST PITCH %s: the element is up %s, and the paper tracks the text through a drag of three and a half pitches", async (value, element) => {
	const { p, close } = await open();
	try {
		await mount(p, { hostCss: `\n.markdown-source-view .cm-editor { --handwriting-paper-pitch: ${value} !important; }\n` });
		await installFrameModel(p);
		const rest = await frameNow(p, "rest");
		await pinchStart(p, 400, 380);
		await pinchDrag(p, 0, 3.5 * 40);
		const live = await frameNow(p, "live"), el = await preview(p);
		const s = await scrollerBox(p), pitchDev = 40 * live.k * DSF;
		// Coverage: bands all the way down the pane, none further apart than a pitch.
		const bands = lattice(await profile(p, { x: Math.round(s.left + 4), y: Math.round(s.top + 2), width: 12, height: Math.floor(s.height - 4) }, "y"), pitchDev);
		const gaps = bands.slice(1).map((b, i) => b.centre - bands[i]!.centre);
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER HOST PITCH ${value}`, JSON.stringify({ rest, live, el, bands: bands.length, gaps: gaps.map(g => Math.round(g)) }));
		expect(rest.source, "premise: at rest the scroller's own paper").toBe("scroller");
		expect(live.preview, "frame identity: the fingers are still down").toBe(true);
		expect(live.k, "premise: the drag was read back at the scale the rest reading was taken at").toBeCloseTo(1, 2);
		expect(el.present, `HOST PITCH ${value}: the preview element is ${element ? "up" : "not up; the scroller's route carries the note"}`).toBe(element);
		expect(live.sources, `HOST PITCH ${value}: one paper layer paints`).toBe(1);
		const tol = element ? TOL_PREVIEW_DEV : TOL_DEV;
		expect.soft(Math.abs(live.offY - rest.offY), `HOST PITCH ${value}: the paper against the text moved by no more than the tolerance through the drag`).toBeLessThanOrEqual(tol);
		expect(bands.length, "premise: rules found down the pane").toBeGreaterThanOrEqual(4);
		expect.soft(Math.max(...gaps), `HOST PITCH ${value}: no band of the pane without paper wider than a pitch`).toBeLessThanOrEqual(pitchDev + 2);
		expect.soft(bands[0]!.centre, `HOST PITCH ${value}: paper from the pane's top`).toBeLessThanOrEqual(pitchDev + 2);
		expect.soft((s.height - 4) * DSF - bands.at(-1)!.centre, `HOST PITCH ${value}: paper to the pane's bottom`).toBeLessThanOrEqual(pitchDev + 2);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// OVERRIDES (gap 3): the copy is what the scroller resolved, for every note setting under every global one.
// ---------------------------------------------------------------------------------------------------------------------

const GLOBALS = ["lines", "grid", "dots", "off"] as const, NOTES = ["none", "lines", "grid", "dots"] as const;
it.each(GLOBALS.flatMap(g => NOTES.map(n => [g, n] as const)))("OVERRIDES, global %s, note %s: the live frame paints what rest paints, on the text", async (global, note) => {
	const { p, close } = await open();
	try {
		await mount(p, { global, note });
		await installFrameModel(p);
		const rest = await frameNow(p, "rest"), restRead = await paperRead(p, note, 1);
		await pinchStart(p, 400, 380);
		await pinchDrag(p, 0, 30);
		const live = await frameNow(p, "live"), el = await preview(p), liveRead = await paperRead(p, note, live.k);
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER OVERRIDE ${global}/${note}`, JSON.stringify({ rest, live, el: { present: el.present, image: el.image, size: el.size, position: el.position }, restRead, liveRead }));
		expect(live.preview, "frame identity: the fingers are still down").toBe(true);
		if (note === "none") {
			expect(el.present, `OVERRIDES ${global}/${note}: a note with no paper gets no preview element`).toBe(false);
			expect(live.sources, `OVERRIDES ${global}/${note}: nothing paints`).toBe(0);
			return;
		}
		expect(el.present, `OVERRIDES ${global}/${note}: the preview element is up`).toBe(true);
		expect(live.sources, `OVERRIDES ${global}/${note}: one paper layer paints`).toBe(1);
		expect(rest.offY, `premise: at rest the paper's rows sit on the text ${JSON.stringify(rest)}`).toBeLessThanOrEqual(TOL_DEV);
		expect.soft(live.offY, `OVERRIDES ${global}/${note}: rows against the text, device px`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		if (note !== "lines") expect.soft(live.offX, `OVERRIDES ${global}/${note}: columns against the text, device px`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		if (note === "dots") {
			const r = restRead as { dots: number; peak: number; mass: number }, l = liveRead as { dots: number; peak: number; mass: number };
			expect(r.dots, "premise: dots at rest").toBeGreaterThanOrEqual(4);
			expect.soft(Math.abs(l.dots - r.dots), `OVERRIDES ${global}/${note}: the same dots in the patch ${JSON.stringify({ r, l })}`).toBeLessThanOrEqual(Math.max(2, r.dots * 0.15));
			expect.soft(Math.abs(l.mass - r.mass), `OVERRIDES ${global}/${note}: the dots' mass ${JSON.stringify({ r, l })}`).toBeLessThanOrEqual(0.15 * r.mass);
		} else {
			const r = restRead as { y: RuleRead; x: RuleRead | null }, l = liveRead as { y: RuleRead; x: RuleRead | null };
			expect(r.y.count, "premise: rules at rest").toBeGreaterThanOrEqual(4);
			expect.soft(Math.abs(l.y.count - r.y.count), `OVERRIDES ${global}/${note}: the same rows ${JSON.stringify({ r, l })}`).toBeLessThanOrEqual(1);
			expect.soft(Math.abs(l.y.medianMass - r.y.medianMass), `OVERRIDES ${global}/${note}: the rows' mass ${JSON.stringify({ r, l })}`).toBeLessThanOrEqual(0.15 * r.y.medianMass);
			if (r.x && l.x) expect.soft(Math.abs(l.x.count - r.x.count), `OVERRIDES ${global}/${note}: the same columns ${JSON.stringify({ r, l })}`).toBeLessThanOrEqual(1);
		}
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// RTL (gap 4): no new contract. A right-to-left scroller keeps today's route: no element, the scroller's paper.
// ---------------------------------------------------------------------------------------------------------------------

it("RTL: a right-to-left note keeps the scroller's own route through a pinch, and its paper reads as it does today", async () => {
	const { p, close } = await open();
	try {
		await mount(p, { global: "grid", dir: "rtl", scrollLeft: -200 });
		await installFrameModel(p);
		const rest = await frameNow(p, "rest"), restRead = await paperRead(p, "grid", 1);
		const scroll = await p.evaluate(() => { const sc = document.querySelector(".cm-scroller") as HTMLElement; return { left: sc.scrollLeft, direction: getComputedStyle(sc).direction }; });
		await pinchStart(p, 400, 380);
		await pinchStage(p, 1.3, 8);
		const live = await frameNow(p, "live"), el = await preview(p), liveRead = await paperRead(p, "grid", live.k);
		await stagedRelease(p);
		const settled = await frameNow(p, "settled");
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER RTL", JSON.stringify({ scroll, rest, live, settled, restRead, liveRead }));
		expect(scroll.direction, "premise: the scroller is right-to-left").toBe("rtl");
		expect(el.present, "RTL: no preview element; the scroller's own route carries the note").toBe(false);
		expect([live.source, live.sources], "RTL: the scroller's own paper paints the live frame, alone").toEqual(["scroller", 1]);
	} finally {
		await close();
	}
});

/**
 * A THEME'S OWN GRADIENTS ON THE SCROLLER are not the paper, and the preview must leave them alone. The element folds its
 * offset by the paper's pitch, which moves a pattern by a whole number of ITS OWN periods only where the two agree; a
 * theme's background has its own period, so carrying it would step it sideways at the swap-in and again whenever the fold
 * wraps. Measured on the cost harness's control arm, which is exactly this shape: before the pitch went into the gate,
 * that arm put an element up on every one of its thirty drag frames.
 */
it("A THEME'S OWN GRADIENTS: a scroller background on a period of its own keeps the scroller's route through a pinch", async () => {
	const { p, close } = await open();
	try {
		// The cost control's background: 32 repeating gradients, attached to the text like the paper, period 6 px, not 28.
		const themeOwn = Array.from({ length: 32 }, (_, i) => `repeating-linear-gradient(${i * 11}deg, rgba(0,0,0,0.04) 0, rgba(0,0,0,0.04) 1px, transparent 1px, transparent 6px)`).join(", ");
		await mount(p, { global: "off", hostCss: `\n.markdown-source-view .cm-scroller { background-image: ${themeOwn}; background-attachment: local; }\n` });
		await installFrameModel(p);
		const rest = await frameNow(p, "rest");
		await pinchStart(p, 400, 380);
		await pinchDrag(p, 0, 30);
		const live = await frameNow(p, "live"), el = await preview(p);
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER THEME GRADIENTS", JSON.stringify({ rest, live, el: { present: el.present, all: el.all, previewing: el.previewing } }));
		expect(live.preview, "frame identity: the fingers are still down").toBe(true);
		expect(rest.sources, "premise: the theme's own background paints at rest").toBe(1);
		expect(el.present, "A THEME'S OWN GRADIENTS: no preview element; the scroller keeps drawing them").toBe(false);
		expect(el.previewing, "and the scroller's own background is not suppressed").toBe(false);
		expect(live.sources, "one background paints on the live frame, the scroller's own").toBe(1);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// BOX (gap 5): the element's box follows the scroller's place in the host through a preview.
// ---------------------------------------------------------------------------------------------------------------------

it("BOX: readable line length on, a re-centring zoom-in, and a panel above the scroller removed mid-preview: the element still covers the scroller and the columns stay on the text", async () => {
	const { p, close } = await open();
	try {
		await mount(p, { global: "grid", readable: true });
		// A panel above the scroller inside the editor, as CodeMirror's own top panels sit: the scroller starts below it.
		await p.evaluate(async () => {
			const host = document.querySelector(".cm-editor") as HTMLElement, sc = document.querySelector(".cm-scroller") as HTMLElement;
			const panel = document.createElement("div"); panel.className = "cm-panels cm-panels-top"; panel.style.cssText = "height:120px;flex:none";
			host.insertBefore(panel, sc);
			await (window as any).viewportFixture.settle();
		});
		await installFrameModel(p);
		await pinchStart(p, 400, 380);
		const stages: Frame[] = [];
		for (const to of [1.22, 1.48]) { await pinchStage(p, to, 10); stages.push(await frameNow(p, `stage ${to}`)); }
		await p.evaluate(() => { document.querySelector(".cm-panels-top")!.remove(); });
		await pinchStage(p, 1.6, 6);
		const last = await frameNow(p, "after the inset left"), el = await preview(p);
		await stagedRelease(p);
		const cover = { top: el.scroller.top - el.rect.top, left: el.scroller.left - el.rect.left,
			bottom: el.rect.top + el.rect.height - (el.scroller.top + el.scroller.height), right: el.rect.left + el.rect.width - (el.scroller.left + el.scroller.width) };
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER BOX", JSON.stringify({ stages, last, el, cover }));
		expect(el.present, "premise: the preview element is up").toBe(true);
		for (const f of [...stages, last]) expect.soft(f.offX, `BOX ${f.tag}: the columns against the text column's edge, device px`).toBeLessThanOrEqual(TOL_PREVIEW_DEV);
		for (const [side, v] of Object.entries(cover)) expect.soft(v, `BOX: the element covers the scroller on its ${side} (css px past its edge)`).toBeGreaterThanOrEqual(0);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// SWAP PARITY (c2): one paper layer on every frame, on the text, from the last frame at rest to the frames after the settle.
// ---------------------------------------------------------------------------------------------------------------------

const THEME_GROUND = "\n.markdown-source-view .cm-scroller { background-color: rgb(250, 240, 200); }\n";
it.each([["lines", 1, 0, false], ["grid", 1, 0, false], ["dots", 1, 0, false], ["lines", 0.3, 0, false], ["grid", 0.3, 0, false], ["dots", 0.3, 0, false], ["lines", 1, 37, false], ["lines", 1, 0, true]] as const)("SWAP PARITY %s at %s, standing pan %s, theme colour %s: one paper layer on every frame, on the text, and the same paper at rest, live and settled", async (kind, zoom, standing, theme) => {
	const { p, close } = await open();
	try {
		await mount(p, { global: kind, zoom, hostCss: theme ? THEME_GROUND : "" });
		await installFrameModel(p);
		if (standing) await p.evaluate(async standing => {
			const o = (window as any).viewportFixture.overlay("paper");
			o.viewportPan.y = standing; o.writeViewportPan();
			await (window as any).viewportFixture.settle();
		}, standing);
		const restRead = await paperRead(p, kind, zoom), restGround = theme ? await groundColour(p) : null;
		const frames = await p.evaluate(async () => {
			const out: unknown[] = [], frame = (window as any).__frame as (tag: string) => unknown;
			const rendered = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
			const send = (type: string, pid: number, x: number, y: number) => document.elementFromPoint(x, y)!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: pid, isPrimary: pid === 701, clientX: x, clientY: y, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8 }));
			for (let i = 0; i < 2; i++) { await rendered(); out.push(frame(`rest-${i}`)); }
			send("pointerdown", 701, 300, 380); send("pointerdown", 702, 500, 380);
			// The same motion the helpers drive, frame by frame so every one is read: the spread changes until the router
			// claims the pinch (it does on the third step), comes back to the scale the rest reading was taken at, and then
			// the fingers drag at that held spread.
			const ratioAt = (i: number) => i <= 6 ? 0.9 ** (i / 6) : i <= 10 ? 0.9 + 0.1 * ((i - 6) / 4) : 1;
			const dyAt = (i: number) => i <= 10 ? 0 : 3 * (i - 10);
			let last = { half: 100, dy: 0 };
			for (let i = 1; i <= 16; i++) {
				const half = 100 * ratioAt(i), dy = dyAt(i);
				send("pointermove", 701, 400 - half, 380 + dy); send("pointermove", 702, 400 + half, 380 + dy);
				last = { half, dy };
				await rendered(); out.push(frame(`move-${i}`));
			}
			(window as any).__release = () => { send("pointerup", 701, 400 - last.half, 380 + last.dy); send("pointerup", 702, 400 + last.half, 380 + last.dy); };
			return out;
		}) as Frame[];
		const live = frames.at(-1)!, liveRead = await paperRead(p, kind, live.k), liveGround = theme ? await groundColour(p) : null;
		const after = await p.evaluate(async () => {
			const out: unknown[] = [], frame = (window as any).__frame as (tag: string) => unknown;
			const rendered = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
			(window as any).__release(); out.push(frame("release"));
			for (let i = 1; i <= 6; i++) { await rendered(); out.push(frame(`settle-${i}`)); }
			return out;
		}) as Frame[];
		await p.evaluate(() => (window as any).viewportFixture.settle());
		const settledRead = await paperRead(p, kind, after.at(-1)!.k), settledGround = theme ? await groundColour(p) : null;
		const rows = [...frames, ...after];
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER SWAP ${kind} z=${zoom} standing=${standing} theme=${theme}`, JSON.stringify({ rows, restRead, liveRead, settledRead, restGround, liveGround, settledGround }));
		if (theme) {
			const near = (a: number[] | null, b: number[] | null) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]!) <= 2);
			expect(restGround, "premise: at rest the pane's ground is the theme's colour").toEqual([250, 240, 200]);
			expect.soft(near(liveGround, restGround), `THEME COLOUR: the ground during the preview is the theme's ${JSON.stringify({ restGround, liveGround })}`).toBe(true);
			expect.soft(near(settledGround, restGround), `THEME COLOUR: the ground after the settle is the theme's ${JSON.stringify({ restGround, settledGround })}`).toBe(true);
		}
		// The router claims a pinch on the third step of a spread changing about two percent a step (measured 22:40Z); the
		// frames before it are not preview frames and are not read as such.
		const previewFrames = rows.filter(r => r.tag.startsWith("move-") && r.preview);
		expect(previewFrames.length, "premise: the gesture engaged a preview for several frames").toBeGreaterThanOrEqual(6);
		expect(previewFrames.filter(r => r.source !== "element").map(r => r.tag), "frame identity: every preview frame reads the preview element").toEqual([]);
		expect(after.at(-1)!.source, "frame identity: after the settle the paper is the scroller's own").toBe("scroller");
		expect(rows.filter(r => r.sources !== 1).map(r => `${r.tag}:${r.sources}`), `SWAP PARITY ${kind} z=${zoom}: frames with no paper layer or with two`).toEqual([]);
		if (standing) {
			// The arm tests that the copy does not take a standing pan twice, so the standing pan has to be there when the
			// element goes up: the frames before the gesture carry it on the scroller's own properties.
			const atRest = rows.filter(r => r.tag.startsWith("rest-")).map(r => Number.parseFloat(r.scrollerPan.split("|")[1] ?? "0") || 0);
			expect(Math.min(...atRest), `premise: the standing pan of ${standing} layout px is on the scroller before the gesture ${JSON.stringify(rows.slice(0, 2))}`).toBeGreaterThanOrEqual(1);
		}
		const off = rows.filter(r => !(r.tag.startsWith("move-") && !r.preview))
			.filter(r => Math.max(r.offY, kind === "lines" ? 0 : r.offX) > (r.source === "element" ? TOL_PREVIEW_DEV : TOL_DEV)).map(r => ({ tag: r.tag, source: r.source, offX: r.offX, offY: r.offY }));
		expect.soft(off, `SWAP PARITY ${kind} z=${zoom} standing=${standing}: frames where the paper stood off the text`).toEqual([]);
		// The band reader measures marks against a white ground, so it reads nothing under a theme's own colour (the whole
		// strip sits above its cut). The theme arm's reading is the ground colour above; the geometry is read for every
		// frame by the model, as on the other arms.
		if (!theme) {
			const mass = (r: Awaited<ReturnType<typeof paperRead>>) => "mass" in r ? r.mass : (r as { y: RuleRead }).y.medianMass;
			expect(mass(restRead), `premise: the paper reads at rest ${JSON.stringify(restRead)}`).toBeGreaterThan(0);
			expect.soft(Math.abs(mass(liveRead) - mass(restRead)), `SWAP PARITY ${kind} z=${zoom}: the paper's mass live against rest ${JSON.stringify({ restRead, liveRead })}`).toBeLessThanOrEqual(0.05 * mass(restRead) + 0.05);
			expect.soft(Math.abs(mass(settledRead) - mass(restRead)), `SWAP PARITY ${kind} z=${zoom}: the paper's mass settled against rest ${JSON.stringify({ restRead, settledRead })}`).toBeLessThanOrEqual(0.05 * mass(restRead) + 0.05);
		}
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// SMEAR (c2c) and GRID (c8): the element's offset on the device px grid keeps rules hard; off it, they smear.
// ---------------------------------------------------------------------------------------------------------------------

const SMEAR_ARMS = [["lines", 1], ["lines", 0.5], ["lines", 0.3], ["lines", 0.1], ["grid", 1], ["grid", 0.5], ["grid", 0.3], ["grid", 0.1]] as const;
it.each(SMEAR_ARMS)("SMEAR %s AT %s: a quarter and a half device px of pan keep the element's rules hard; the same offsets unrounded read RED", async (kind, zoom) => {
	const { p, close } = await open();
	try {
		await mount(p, { global: kind, zoom, scrollTop: 600 });
		await pinchStart(p, 400, 380);
		await pinchStage(p, 0.9, 6);
		await pinchStage(p, 1, 4);
		const el0 = await preview(p);
		expect(el0.present, "premise: the preview element is up").toBe(true);
		const k = await p.evaluate(() => (window as any).viewportFixture.overlay("paper").cssScale as number), kd = k * DSF;
		// The phases the copy carries: what the offset is rounded WITH, so that the rules - not the offset - land on whole
		// device px (K5). The offset itself carries the phase's own fraction back out and is not whole.
		const phases = await p.evaluate(() => { const o = (window as any).viewportFixture.paperOrigin("paper") as { phase: number; phaseX: number }; return { y: o.phase, x: o.phaseX }; });
		const s = await scrollerBox(p), pitchDev = PITCH * k * DSF;
		const clips = { y: { x: Math.round(s.left + 4), y: Math.round(s.top + 240), width: 12, height: 230 }, x: { x: Math.round(s.left + 20), y: Math.round(s.top + 250), width: 300, height: 12 } };
		const axes = (kind === "grid" ? ["y", "x"] : ["y"]) as ("x" | "y")[];
		// Counting window: a pitch in from each strip end, so a band at a crop edge never moves the count.
		const read = async (axis: "x" | "y") => {
			const prof = await profile(p, clips[axis], axis), span = prof.length;
			return summarise(lattice(prof, pitchDev, pitchDev, span - pitchDev));
		};
		const setPan = (dev: number) => p.evaluate(async ({ dev, kd }) => {
			const o = (window as any).viewportFixture.overlay("paper");
			o.viewportPan.x = (window as any).__panBase.x + dev / 2; o.viewportPan.y = (window as any).__panBase.y + dev / 2; o.writeViewportPan();
			await (window as any).viewportFixture.settle(2);
			return { transform: (document.querySelector(".handwriting-paper-preview") as HTMLElement).style.transform, kd };
		}, { dev, kd });
		await p.evaluate(() => { const o = (window as any).viewportFixture.overlay("paper"); (window as any).__panBase = { x: o.viewportPan.x, y: o.viewportPan.y }; });
		/** Put the element where the rounding would NOT have put it, and report the transform actually written. */
		const unrounded = (dev: number) => p.evaluate(async ({ dev, kd }) => {
			const el = document.querySelector(".handwriting-paper-preview") as HTMLElement, m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(el.style.transform)!;
			(window as any).__ownTransform = el.style.transform;
			el.style.transform = `translate(${Number(m[1]) + dev / kd}px, ${Number(m[2]) + dev / kd}px)`;
			await (window as any).viewportFixture.settle(2);
			return el.style.transform;
		}, { dev, kd });
		/** The overlay's own transform back on the element: it wrote the cached one, and only writes again when it changes. */
		const restoreOwn = () => p.evaluate(async () => {
			const el = document.querySelector(".handwriting-paper-preview") as HTMLElement, own = (window as any).__ownTransform as string | undefined;
			if (own !== undefined) el.style.transform = own;
			await (window as any).viewportFixture.settle(2);
		});
		const out: Record<string, unknown> = {};
		for (const axis of axes) {
			await setPan(0);
			const none = await read(axis);
			const quarterT = await setPan(0.25), quarter = await read(axis);
			const halfT = await setPan(0.5), half = await read(axis);
			await setPan(0);
			const rawQuarterT = await unrounded(0.25); const quarterRaw = await read(axis);
			await restoreOwn(); await setPan(0);
			const rawHalfT = await unrounded(0.5); const halfRaw = await read(axis);
			await restoreOwn(); await setPan(0);
			out[axis] = { none, quarter, half, quarterRaw, halfRaw, quarterT, halfT, rawT: { quarter: rawQuarterT, half: rawHalfT }, verdicts: { quarter: ruleVerdict(none, quarter), half: ruleVerdict(none, half), quarterRaw: ruleVerdict(none, quarterRaw), halfRaw: ruleVerdict(none, halfRaw) } };
		}
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER SMEAR ${kind} z=${zoom}`, JSON.stringify({ k, out }));
		/** How far this axis's rules sit from a whole device px: the offset plus the phase the copy draws them at. */
		const landsOff = (t: { transform: string }, axis: "x" | "y") => {
			const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\)/.exec(t.transform)!;
			const v = Number(axis === "x" ? m[1] : m[2]) + phases[axis];
			return Math.abs(v * kd - Math.round(v * kd));
		};
		for (const axis of axes) {
			const r = out[axis] as { none: RuleRead; quarterT: { transform: string }; halfT: { transform: string }; rawT: { quarter: string; half: string }; verdicts: Record<string, ReturnType<typeof ruleVerdict>>; quarterRaw: RuleRead; halfRaw: RuleRead; quarter: RuleRead; half: RuleRead };
			expect(r.none.count, `premise: ${kind} ${axis} rules on the element with no extra pan`).toBeGreaterThanOrEqual(3);
			expect(r.none.minPeak, `premise: ${kind} ${axis} the element's rules draw hard`).toBeGreaterThanOrEqual(0.75);
			expect.soft(Math.max(landsOff(r.quarterT, axis), landsOff(r.halfT, axis)), `SMEAR ${kind} z=${zoom} ${axis}: the element's rules land on whole device px (offset ${r.quarterT.transform}, phase ${phases[axis]})`).toBeLessThanOrEqual(1e-3);
			expect.soft(r.verdicts.quarter!.pass && r.verdicts.half!.pass, `SMEAR ${kind} z=${zoom} ${axis}: a quarter and a half device px of pan keep every rule hard ${JSON.stringify(r)}`).toBe(true);
			// THE CONTROL, and what it means when it stays green. If this engine puts a fractional composited translate on
			// the device grid itself, an unrounded offset cannot smear and the control is BLIND: that is the reading,
			// recorded here, not forced. The rounding stays as the guard for engines that do not snap, and its
			// sensitivity is proven elsewhere - the lift-jump arm at 130 percent, where dropping it moves the paper.
			const blind = r.verdicts.quarterRaw!.pass && r.verdicts.halfRaw!.pass;
			// eslint-disable-next-line no-console
			console.log(`PREVIEW-PAPER SMEAR CONTROL ${kind} z=${zoom} ${axis}`, JSON.stringify({ blind, quarterRaw: r.verdicts.quarterRaw, halfRaw: r.verdicts.halfRaw, rawTransforms: r.rawT }));
			expect(r.none.count, `premise: the control was read on the same strip as the rest ${JSON.stringify(r.none)}`).toBeGreaterThanOrEqual(3);
		}
	} finally {
		await close();
	}
});

it("GRID AT 10 PERCENT, ON THE ELEMENT: every rule in the window draws, both axes (the headless two-layer loss is the scroller's, not the element's)", async () => {
	const { p, close } = await open();
	try {
		await mount(p, { global: "grid", zoom: 0.1, scrollTop: 600 });
		const s = await scrollerBox(p), pitchDev = PITCH * 0.1 * DSF;
		const strips = { y: { x: Math.round(s.left + 4), y: Math.round(s.top + 40), width: 12, height: 300 }, x: { x: Math.round(s.left + 20), y: Math.round(s.top + 250), width: 300, height: 12 } };
		const counts = async () => {
			const out: Record<string, { bands: number; expected: number }> = {};
			for (const axis of ["y", "x"] as const) {
				const prof = await profile(p, strips[axis], axis), span = prof.length;
				out[axis] = { bands: lattice(prof, pitchDev, pitchDev, span - pitchDev).length, expected: Math.floor((span - 2 * pitchDev) / pitchDev) };
			}
			return out;
		};
		const rest = await counts();
		await pinchStart(p, 400, 380);
		await pinchStage(p, 0.9, 6);
		await pinchStage(p, 1, 4);
		const el = await preview(p), live = await counts();
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER GRID Z0.1", JSON.stringify({ rest, live, el: { present: el.present, image: el.image } }));
		expect(el.present, "premise: the preview element is up").toBe(true);
		for (const axis of ["y", "x"] as const) {
			const r = live[axis]!;
			expect.soft(Math.abs(r.bands - r.expected), `GRID Z .1 ELEMENT ${axis}: rules lost inside the window (bands ${r.bands}, whole pitches ${r.expected})`).toBeLessThanOrEqual(1);
		}
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// LIFT JUMP where the copy's phase is off the gesture's zoom grid (c6, K5): the element lands the rules where the settle will.
// ---------------------------------------------------------------------------------------------------------------------

it.each([[0, 1.3], [10 / 64, 1.3]] as const)("LIFT JUMP, origin +%s layout px, pinch to %s: the settle does not move the paper against the text", async (margin, to) => {
	const { p, close } = await open();
	try {
		await mount(p, { doc: "x", scrollTop: 0 });
		await p.evaluate(async margin => {
			(document.querySelector(".cm-content") as HTMLElement).style.marginTop = `${margin}px`;
			await (window as any).viewportFixture.fontPx("paper", 16);
			await (window as any).viewportFixture.growTo("paper", 0, 0);
		}, margin);
		const read = () => p.evaluate(() => {
			const content = document.querySelector(".cm-content") as HTMLElement;
			const k = (window as any).viewportFixture.snap("paper").state.zoom as number;
			const o = (window as any).viewportFixture.paperOrigin("paper") as { source: string; y: number; pitch: number; phase: number };
			const textY = content.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(content).paddingTop) * k;
			return { k, pitch: o.pitch, phase: o.phase, source: o.source, paperY: o.y, textY };
		});
		const offDev = (g: Awaited<ReturnType<typeof read>>) => { const raw = ((((g.paperY - g.textY) / g.k) % g.pitch) + g.pitch) % g.pitch; return (raw > g.pitch / 2 ? raw - g.pitch : raw) * g.k * DSF; };
		const rest = await read();
		await pinchStart(p, 320, 240);
		await pinchStage(p, to);
		const live = await read();
		await stagedRelease(p);
		const settled = await read();
		const phaseFraction = Math.abs(rest.phase * live.k * DSF - Math.round(rest.phase * live.k * DSF));
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER LIFT JUMP", JSON.stringify({ margin, to, rest, live: { ...live, off: offDev(live) }, settled: { ...settled, off: offDev(settled) }, phaseFraction }));
		expect(live.source, "premise: mid-gesture the paper is the preview element").toBe("element");
		expect(settled.source, "premise: settled, the scroller's own paper").toBe("scroller");
		expect(phaseFraction, "premise: the copy's phase is off the gesture's device px grid, so rounding the offset alone would leave the rules that fraction off").toBeGreaterThanOrEqual(0.1);
		expect.soft(Math.abs(offDev(live)), `LIFT JUMP +${margin} to ${to}: mid-gesture the paper sits within half a device px of the text`).toBeLessThanOrEqual(0.55);
		// Half a device px is c6's bar. K5's arithmetic says the two roundings land on the same
		// whole device px, so 0 was predicted; the measured jump is printed and read against the ruled bar, not against
		// that prediction.
		expect.soft(Math.abs(offDev(settled) - offDev(live)), `LIFT JUMP +${margin} to ${to}: the paper's move against the text at the settle, device px (the bar is c6's half a device px)`).toBeLessThanOrEqual(0.5);
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// BOUNDS (c7): the element is the scroller's box plus about a pitch on every side, never the scroll area, and the pan
// never uncovers it.
// ---------------------------------------------------------------------------------------------------------------------

it.each([1, 0.3, 0.1])("BOUNDS AT %s: the element is the scroller plus a pitch on every side, and a drag of half a pitch and of three and a half pitches leaves no pane without paper", async zoom => {
	const { p, close } = await open();
	try {
		await mount(p, { global: "lines", zoom, scrollTop: 600 });
		await pinchStart(p, 400, 380);
		await pinchStage(p, 0.9, 6);
		await pinchStage(p, 1, 4);
		const k = zoom, pitchCss = PITCH * k;
		const reads: { dy: number; el: Preview; gaps: number[]; first: number; last: number; span: number }[] = [];
		for (const dy of [pitchCss / 2, 3 * pitchCss]) {
			await pinchStage(p, 1, 6, 0, dy);
			const el = await preview(p), s = await scrollerBox(p);
			const bands = lattice(await profile(p, { x: Math.round(s.left + 4), y: Math.round(s.top + 2), width: 12, height: Math.floor(s.height - 4) }, "y"), pitchCss * DSF);
			reads.push({ dy, el, gaps: bands.slice(1).map((b, i) => b.centre - bands[i]!.centre), first: bands[0]?.centre ?? Number.NaN, last: bands.at(-1)?.centre ?? Number.NaN, span: (Math.floor(s.height - 4)) * DSF });
		}
		await stagedRelease(p);
		// eslint-disable-next-line no-console
		console.log(`PREVIEW-PAPER BOUNDS z=${zoom}`, JSON.stringify(reads));
		for (const r of reads) {
			const e = r.el;
			expect(e.present, "premise: the preview element is up").toBe(true);
			const sides = { top: e.scroller.top - e.rect.top + e.ty * k, left: e.scroller.left - e.rect.left + e.tx * k,
				bottom: e.rect.top - e.ty * k + e.rect.height - (e.scroller.top + e.scroller.height), right: e.rect.left - e.tx * k + e.rect.width - (e.scroller.left + e.scroller.width) };
			// The box without its translate: one pitch rounded up to whole device px, plus one, on each side (css px), and
			// one more device px because the painted edge of an absolutely placed box rounds to the device grid (measured
			// on green run 8: right and bottom margins over by .09 to .25 css px).
			const hi = (Math.ceil(PITCH * k * DSF - 1e-6) + 2) / DSF + 0.01;
			for (const [side, v] of Object.entries(sides)) {
				expect.soft(v, `BOUNDS z=${zoom}: the element's ${side} margin is at least a pitch`).toBeGreaterThanOrEqual(pitchCss - 0.01);
				expect.soft(v, `BOUNDS z=${zoom}: the element's ${side} margin is a pitch and at most two device px more, never the scroll area`).toBeLessThanOrEqual(hi);
			}
			// Two pitches, not one: a single band lost inside the strip (the note's own ink or text crosses it) is not an
			// uncovered pane, and what this reads for - the element's edge inside the pane - leaves many pitches bare. The
			// sensitive read for a missing margin is the box comparison above, which a zero margin fails outright.
			expect.soft(Math.max(...r.gaps), `BOUNDS z=${zoom} drag ${r.dy.toFixed(1)} css px: no band of the pane wider than two pitches without paper`).toBeLessThanOrEqual(2 * pitchCss * DSF + 2);
			expect.soft(r.first, `BOUNDS z=${zoom} drag ${r.dy.toFixed(1)}: paper from the pane's top`).toBeLessThanOrEqual(2 * pitchCss * DSF + 2);
			expect.soft(r.span - r.last, `BOUNDS z=${zoom} drag ${r.dy.toFixed(1)}: paper to the pane's bottom`).toBeLessThanOrEqual(2 * pitchCss * DSF + 2);
		}
	} finally {
		await close();
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// LEAK (c5's plant): gestures in sequence leave no element behind and never more than one up.
// ---------------------------------------------------------------------------------------------------------------------

it("LEAK: three pinches in sequence leave no preview element in the page, and each live frame has exactly one", async () => {
	const { p, close } = await open();
	try {
		await mount(p);
		const counts: { live: number; after: number; swaps: number }[] = [];
		for (let i = 0; i < 3; i++) {
			await pinchStart(p, 400, 380);
			await pinchStage(p, 1.2, 6);
			const live = await preview(p);
			await stagedRelease(p);
			const after = await preview(p);
			counts.push({ live: live.all, after: after.all, swaps: after.readout?.swaps ?? 0 });
		}
		// eslint-disable-next-line no-console
		console.log("PREVIEW-PAPER LEAK", JSON.stringify(counts));
		expect(counts.map(c => c.swaps), "premise: each pinch put the element up once").toEqual([1, 2, 3]);
		expect(counts.map(c => [c.live, c.after]), "LEAK: one element on each live frame, none after each settle").toEqual([[1, 0], [1, 0], [1, 0]]);
	} finally {
		await close();
	}
});
