/**
 * THE OVERSCROLL BOUNCE: a page the settle of a zoom brings back onto the pane springs back instead of jumping.
 *
 * What it looks like: pinch in, pinch back out somewhere else, and at 100% the page, which the last preview frame left
 * hanging a fifth of the pane off its left edge, used to snap inside in a single frame. Now it starts where the fingers
 * left it and eases onto the pane in half a second, one glide that never passes the rest - OneNote's overscroll as Alan
 * filmed it (release to rest about 0.53 s at 15 fps). It was a fifth of a second until that reference was measured.
 *
 * THE CONDITIONS, each read here rather than assumed:
 *   1. the rest is the settle's own: the clamp value, written on the settle frame and never moved by the bounce, and
 *      the frame after the bounce equals it exactly;
 *   2. text, ink and paper move together on every bounce frame (one pan write), and a pen that lands mid-bounce is
 *      mapped with the page at its rest - the bounce is cancelled before the contact is read;
 *   3. timed (500 ms, within one frame either way), eased out and monotonic - the offset toward the rest never grows
 *      after the release and the page never passes the rest - with nothing after it, and not where Infinite Canvas is on
 *      in the direction the page was pushed;
 *   4. a plant that leaves the offset at the overshoot turns the rest cell red (HW_BOUNCE_PLANT_LEAVE_AT_OVERSHOOT=1), one
 *      that carries the page 2 px past its rest before it ends turns the monotonic arm red (HW_BOUNCE_PLANT_OVERSHOOT=1),
 *      and one that never hands the pan to the paper turns condition 2's paper reading red (HW_PAPER_PAN_PLANT_NO_PAN=1).
 *      That last plant used to live in PaperStandingPan, whose subject - a pan standing at rest - no longer occurs: the
 *      glide is where a live pan is read now.
 *   5. the paper rides the bounce as the preview element - the bounce puts it up for its own frames, with the settled
 *      zoom's rules - and it comes down on the frame the bounce ends; a contact
 *      mid-bounce takes it down before the contact is read; and a bounce after a zoom change carries the settled zoom's
 *      rules. The bounce frames' raster is NOT counted here (no trace on this page); what is proven instead is that the
 *      invalidating write is absent: while the element is up the pan goes to its transform and the scroller's two pan
 *      properties are not written at all, so a bounce frame cannot re-raster the paper through them. Plants: HW_PAPER_PREVIEW_PLANT_BYPASS_BOUNCE_END=1 (THE BOUNCE red), HW_PAPER_PREVIEW_PLANT_BYPASS_INPUT=1
 *      (PEN DOWN MID-BOUNCE red), HW_PAPER_PREVIEW_PLANT_NO_BOUNCE_SWAP=1 (the bounce leaves the paper on the scroller: THE BOUNCE red),
 *      HW_PAPER_PREVIEW_PLANT_NO_BOUNCE_COPY=1 (that element carries no copy: A BOUNCE AFTER A ZOOM CHANGE red).
 *
 * THE GESTURE is ZoomOutStandingPan's clipped case: readable line length off, pinch in to 300% centred on the ink, then
 * out to 100% centred 340 client px to its left. The mount is that file's (pane offset 300 px, monospace 16/24,
 * Obsidian's sizer), with lined paper on so the paper's share of the pan is written and can be read.
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

declare const process: { env: Record<string, string | undefined> };

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { foldIntoPitch } from "../../src/inline/PaperPan";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { parsePage, serializePage } from "../../src/model/PageData";

installObsidianDom();
const ids = new Map(), sidecars = new Map();
const save = (id, page) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({ readPageId: p => ids.get(p) ?? null, claimId: async (p, id) => { ids.set(p, id); return { pageId: id }; },
	loadSidecar: async id => (sidecars.has(id) ? parsePage(sidecars.get(id), id) : null), scheduleSidecar: save, scheduleSidecarNow: async (id, p) => save(id, p), notify: () => {} });

const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const rendered = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const PANE_W = 1397.5, PANE_H = 800, HOST_LEFT = 300, TEXT_LINE = 6;
let rig = null;

function installSizer(view) {
	const sizer = document.createElement("div"); sizer.className = "cm-sizer";
	const container = document.createElement("div"); container.className = "cm-contentContainer";
	view.contentDOM.parentElement.insertBefore(sizer, view.contentDOM); sizer.appendChild(container); container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth; return sizer;
}
const lineEl = view => view.contentDOM.querySelectorAll(".cm-line")[TEXT_LINE];
const textBox = view => { const range = document.createRange(); range.selectNodeContents(lineEl(view)); const r = range.getBoundingClientRect(); return { left: r.left, cy: (r.top + r.bottom) / 2 }; };
const MAGENTA = (d, i) => d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200;

function backingInk() {
	const cc = rig.overlay.committedCanvas, w = cc.width, h = cc.height;
	if (!(w > 0 && h > 0)) return null;
	const d = cc.getContext("2d").getImageData(0, 0, w, h).data;
	let minY = Infinity, maxY = -1, minX = Infinity, n = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (MAGENTA(d, i)) { n++; if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; } }
	if (!n) return { n };
	const r = cc.getBoundingClientRect();
	return { n, cy: r.top + ((minY + maxY + 1) / 2) * r.height / h, left: r.left + minX * r.width / w };
}
const translateX = s => { const m = /translate\\(\\s*(-?[\\d.e+-]+)px/.exec(s || ""); return m ? Number(m[1]) : 0; };
/** A lined copy's rule thickness, layout px: its last two stops. */
function ruleOfImage(image) { const px = Array.from(image.matchAll(new RegExp("(-?[0-9.]+)px", "g"))).map(m => Number(m[1])); return px.length >= 2 ? px[px.length - 1] - px[px.length - 2] : null; }
/** The pan the preview paper carries on x, layout px folded by its pitch: its translate less its margin, plus the scroll. */
function previewPaperPanX(view, el, pitch) {
	const sc = view.scrollDOM, margin = sc.offsetLeft + sc.clientLeft - Number.parseFloat(getComputedStyle(el).left);
	return (((translateX(el.style.transform) - margin + sc.scrollLeft) % pitch) + pitch) % pitch;
}

/** One frame's reading. withInk reads the committed canvas's pixels too, which is slow; the bounce frames take it. */
function sample(phase, withInk) {
	const { view, overlay, pane, sizer } = rig, t = textBox(view), k = overlay.pinchScaleNow;
	const cr = view.contentDOM.getBoundingClientRect(), sr = view.scrollDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	const pitch = Number.parseFloat(view.dom.style.getPropertyValue("--handwriting-paper-pitch"));
	const ink = withInk ? backingInk() : null;
	// Through a preview and the bounce its settle starts, the paper is the preview element; at rest, the scroller's own.
	const paperEl = view.dom.querySelector(":scope > .handwriting-paper-preview");
	const paperReadout = typeof overlay.previewPaperReadout === "function" ? overlay.previewPaperReadout() : null;
	// What the swap-in reads before it decides: if the element is not up on a bounce frame, this says which gate refused.
	const scs = getComputedStyle(view.scrollDOM);
	const paperGate = { image: scs.backgroundImage.slice(0, 30), attach: scs.backgroundAttachment, dir: scs.direction,
		pitch: scs.getPropertyValue("--handwriting-paper-pitch"), previewing: view.scrollDOM.classList.contains("handwriting-paper-previewing"),
		parentIsHost: view.scrollDOM.parentElement === view.dom, swaps: paperReadout ? paperReadout.swaps : null };
	return { phase, t: performance.now(), k, preview: !!overlay.pinchPreview, restX: pan.x, restY: pan.y,
		bounce: typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null,
		contentLeft: cr.left, viewLeft: sr.left, viewRight: sr.right, contentRight: cr.right, textLeft: t.left, textCy: t.cy,
		// The vertical pair, so a cell can read the axis the canvas corrects (the origin edge) the same way
		// it has always read the horizontal one. Read-only, and the horizontal fields are untouched.
		contentTop: cr.top, viewTop: sr.top,
		sizerX: translateX(sizer.style.transform), sizerTransform: sizer.style.transform || "",
		inkLayerX: translateX(overlay.inkLayer ? overlay.inkLayer.style.transform : ""),
		paperX: paperEl ? previewPaperPanX(view, paperEl, paperReadout ? paperReadout.pitch : pitch) : Number.parseFloat(view.scrollDOM.style.getPropertyValue("--handwriting-paper-pan-x") || "0"), pitch,
		paperSource: paperEl ? "element" : "scroller", paperEnded: paperReadout ? paperReadout.ended : null, dpr: window.devicePixelRatio, paperGate,
		paperRule: paperEl ? ruleOfImage(getComputedStyle(paperEl).backgroundImage) : null, hostRule: Number.parseFloat(view.dom.style.getPropertyValue("--handwriting-paper-rule")),
		scrollerPan: view.scrollDOM.style.getPropertyValue("--handwriting-paper-pan-x") + "|" + view.scrollDOM.style.getPropertyValue("--handwriting-paper-pan-y"),
		paperDrift: overlay.paperColumnDrift || 0, cssScale: overlay.cssScale,
		fitReadout: typeof overlay.panFitReadout === "function" ? overlay.panFitReadout() : null,
		inkLeft: ink && ink.n ? ink.left : null, inkCy: ink && ink.n ? ink.cy : null };
}

async function pinchAbout(to, steps, cx, cy, framesAfter, withInk, travel) {
	const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
	const spread0 = 300, spread1 = 300 * to / from, drift = travel || 0;
	// The centroid may TRAVEL across the gesture, which is how a real two-finger drag makes
	// blank beside the page. Rounding alone leaves 19 px here, too small for the pen plant to
	// discriminate; a 60 px drag makes the correction by construction.
	const touch = (s, f) => { const c = cx + drift * (f === undefined ? 0 : f); router.touchPos.set(911, { x: c - s / 2, y: cy }); router.touchPos.set(912, { x: c + s / 2, y: cy }); };
	const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
	touch(spread0); router.beginPinch(ev("pointerdown"));
	let last = null;
	for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps, i / steps); router.updatePinch(ev("pointermove")); await rendered(); if (i === steps) last = sample("last-preview"); }
	router.endPinch(ev("pointerup"), { x: cx + drift, y: cy }); router.touchPos.clear();
	const rows = [];
	for (let j = 1; j <= framesAfter; j++) { await rendered(); rows.push(sample("settle-" + j, withInk)); }
	return { last, rows };
}

window.bounce = {
	async mount(infinite, tag) {
		setPenInk(true); setScrollExpansionEnabled(!!infinite);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		document.body.classList.add("handwriting-paper-lines");
		const path = "bounce-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		const sizer = installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, sizer, path };
		const t = textBox(view), x = t.left + 80, y = t.cy;
		rig.pen = (type, px, py, buttons) => document.elementFromPoint(px, py)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 901, isPrimary: true, clientX: px, clientY: py, buttons, pressure: buttons ? 0.5 : 0 }));
		rig.pen("pointerdown", x, y, 1); for (let i = 1; i <= 6; i++) rig.pen("pointermove", x + 30 * i, y, 1); rig.pen("pointerup", x + 180, y, 0);
		await settle(12);
		const first = inlineInk.strokes(path)[0];
		// Client x to note x at 100% with no pan: the mount stroke's own offset, used to predict where a later pen lands.
		rig.noteOffset = x - view.contentDOM.getBoundingClientRect().left - first.points[0].x;
		return { strokes: inlineInk.strokes(path).length, natural: sample("natural", true), inkMiddleX: t.left + 170 };
	},
	/**
	 * The round trip that leaves the canvas's edge INSIDE the pane - in to 300% about the
	 * ink and back out to 100% about the same point, the blank coming from the scale's own rounding.
	 * It used to zoom out 340 px to the left, which clipped the page instead and leaned on the fitting
	 * clamp a later ruling deleted; there was then no ease at all for these cells to read.
	 */
	/**
	 * THE DRIVE THAT OWES A CORRECTION UNDER THE CANVAS. The same-centre round trip above
	 * trip owes 1 px there - the canvas keeps the page where the fingers left it sideways, so rounding blank on x
	 * is all there is, and 1 px is no bounce to read. What the canvas DOES correct is the origin edge: zoom in
	 * about the ink, then out about a point 40 px below it, and the page ends with blank above its own top, which
	 * the settle owes back. This is the TOP drive, measured 26.33 px on that rig.
	 */
	async originEdgeOvershoot(inkMiddleX, cy) {
		await pinchAbout(3, 30, inkMiddleX, cy, 16, false);
		return pinchAbout(1, 30, inkMiddleX, cy + 40, 48, true);
	},
	async clippedZoomOut(inkMiddleX, cy) {
		await pinchAbout(3, 30, inkMiddleX, cy, 16, false);
		// NO DRIFT ON THIS ONE, measured: with the 60 px drag the zoom-out's focal hold and the drag very
		// nearly cancel and the settle owes 1 px, which is no bounce to read at all. The rounding blank of
		// the same-centre round trip is 19.00 px here, which this cell's claims are large enough to use.
		// The pen and frame-clock cells DO take the drag: their plants need a correction big enough to
		// discriminate, and 19 px left the pen plant at 14 px of displacement against a 20 px bar.
		return pinchAbout(1, 30, inkMiddleX, cy, 48, true);
	},
	/**
	 * The same round trip, and a pen lands while the bounce is between a quarter and three quarters of the way. The pen's
	 * contact point is chosen on the page as it is shown at that moment; the stroke's stored note x is returned with where
	 * the page's rest predicts it (the page after the cancel), and the page's position just after the contact.
	 */
	/** lateCatch: false catches the bounce a quarter to three quarters through (a real standing offset left to
	 * resume after the stroke); true waits for it to be within 1% of its rest first (nothing left to resume). */
	async penMidBounce(inkMiddleX, cy, lateCatch) {
		await pinchAbout(3, 30, inkMiddleX, cy, 16, false);
		const { overlay, view, pen, path } = rig, router = overlay.router, from = overlay.pinchScaleNow;
		const cx = inkMiddleX, spread0 = 300, spread1 = 300 * 1 / from, steps = 30, drift = 60;
		const touch = (s, f) => { const c = cx + drift * (f === undefined ? 0 : f); router.touchPos.set(911, { x: c - s / 2, y: cy }); router.touchPos.set(912, { x: c + s / 2, y: cy }); };
		const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
		touch(spread0); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps, i / steps); router.updatePinch(ev("pointermove")); await rendered(); }
		router.endPinch(ev("pointerup"), { x: cx + drift, y: cy }); router.touchPos.clear();
		let before = null;
		if (lateCatch) {
			// Wait for the bounce to finish on its own - a page already at rest when the pen lands, nothing
			// standing for the stroke's own lift to resume.
			let sawActive = false;
			for (let j = 0; j < 90; j++) {
				await rendered();
				const s = sample("wait-" + j, false), b = s.bounce;
				if (b && b.active) sawActive = true;
				if (sawActive && (!b || !b.active)) { before = s; break; }
			}
		} else {
			for (let j = 0; j < 40; j++) {
				await rendered();
				const s = sample("wait-" + j, false), b = s.bounce;
				if (b && b.active && Math.abs(b.fromX) > 0 && Math.abs(b.x) <= 0.75 * Math.abs(b.fromX) && Math.abs(b.x) >= 0.25 * Math.abs(b.fromX)) { before = s; break; }
			}
		}
		if (!before) return { before: null };
		const strokesBefore = inlineInk.strokes(path).length;
		const px = before.textLeft + 400, py = before.textCy + 48;
		pen("pointerdown", px, py, 1);
		const atContact = sample("at-contact", false);
		for (let i = 1; i <= 6; i++) pen("pointermove", px + 20 * i, py, 1);
		pen("pointerup", px + 120, py, 0);
		// Endpoint only, no per-frame sampling in this file (it reddens under seven-file load): the readout
		// right after the lift, before settle() runs a single frame, so a resumed ease reads mid-decay here
		// and a mere park (no ease at all) would read x:0 already - the two are not the same claim.
		const justAfterPenUp = sample("just-after-penup", false);
		// Settle(12) is ~200ms of frames and the ease is 500ms wall-clock, so a fixed frame
		// budget reads "after" while the resume is still playing - red by construction, not by defect. Wait
		// for the readout to go quiet instead, the same shape lateCatch above uses, then read the endpoint.
		for (let j = 0; j < 90; j++) {
			await rendered();
			const b = sample("wait-rest-" + j, false).bounce;
			if (!b || !b.active) break;
		}
		await settle(4);
		const after = sample("after", false);
		const stroke = inlineInk.strokes(path)[strokesBefore];
		return { before, atContact, justAfterPenUp, after, px, strokeX: stroke ? stroke.points[0].x : null,
			expectedAtRest: px - atContact.contentLeft - rig.noteOffset, expectedThroughBounce: px - before.contentLeft - rig.noteOffset };
	},
	/**
	 * THE GIVE AT AN END, THEN A SECOND GRAB WHILE IT SPRINGS BACK.
	 *
	 * One finger dragged DOWN at the top, far enough to reach the allowance; the lift
	 * releases the give; a second contact lands while it is still springing and lifts again without
	 * drawing. The claim is that BOTH lifts go home through the one return: the first through
	 * releaseOverscrollGive, which folds the give into the standing pan and hands it to
	 * resumeStrandedPan, the second through the same resumeStrandedPan reached from
	 * onAllContactsLifted after the regrab folded the running ease in.
	 *
	 * THE ROUTER IS CALLED, NOT DISPATCHED AT, which is how every other gesture in this file is
	 * driven: pinchAbout sets the contact map and calls beginPinch/updatePinch, and the pen helper is
	 * the one exception. A first attempt dispatched synthetic touch PointerEvents and the premise
	 * read a give of 0, so the drive is no longer the variable under test.
	 *
	 * No plant of its own: review plants this cell independently for the verdict, and an
	 * author's plant on an author's cell was ruled to add nothing here.
	 *
	 * Endpoint sampling only, no per-frame rows: this file goes red under seven-file load on timing.
	 */
	async giveRegrab() {
		// NO PINCH FIRST, and this is measured rather than assumed. A pinch was tried, to put the
		// note far taller than its pane; the drive readout then showed range 10297 with the pinch
		// and the same 10297 without it - four hundred lines are already far more page than pane at
		// this zoom - so the pinch bought no range. What it did buy was a guard the assist will not
		// open for: the two-finger drive sets the contact map and calls beginPinch directly, so the
		// guard's own touch bookkeeping never sees those contacts end, it stays in armed-assist, and
		// the next FIRST finger is taken for a second one. Measured: guard armed-assist, touches 1,
		// assistEngaged false, allowance 96, range 10297 - everything right except the one thing the
		// pinch broke. The gesture under test never needed it.
		const { view, overlay } = rig, router = overlay.router;
		const sd = view.scrollDOM;
		sd.scrollTop = 0;
		await settle(8);
		// THE GUARD HAS TO BE ARMED, and the pinch above left it open. assistThisGesture is true
		// only for the FIRST finger of a gesture while the guard is armed, and that is the gate the
		// assist pan is behind, so with the guard open the drag is not an assist pan at all and there
		// is no refused remainder to give. It re-arms a second after the last lift, on a real timer,
		// so this waits real time rather than frames. Measured twice without it: the premise read a
		// give of 0 with assistEngaged false, which is this and not the axis or the allowance.
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect();
		const x = r.left + r.width / 2, yTop = r.top + 40;
		// The router's own handlers, called directly with a plain event object, the way pinchAbout
		// calls beginPinch. The scroller's listeners are real here, but a dispatched touch event is
		// one more thing that can be the reason a cell reads nothing, and it already was once.
		const ev = (type, py, buttons) => ({ type, pointerType: "touch", pointerId: 921, isPrimary: true,
			clientX: x, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, py, buttons) => {
			const e = ev(type, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		// THE DRIVE IS INSTRUMENTED so a premise failure names its own cause instead of costing a
		// round. assistEngaged and assistOwns say whether the assist took the gesture at all;
		// pullX/pullY say whether anything was refused; allowance names the case the pull reading
		// cannot see on its own - the host answers 0 when scroll expansion is on, and a 0 allowance
		// makes accrueOverscrollPull return before any pull is reported, which looks identical to an
		// assist that never engaged. scrollTop and range say which regime the drag happened in.
		const probe = () => ({ assistEngaged: !!router.assistEngaged, assistOwns: router.assistPointerId !== null,
			pullX: router.overscrollPullX, pullY: router.overscrollPullY, scrollTop: sd.scrollTop,
			range: sd.scrollHeight - sd.clientHeight,
			allowance: router.cb && router.cb.overscrollAllowancePx ? router.cb.overscrollAllowancePx() : null,
			// The gate itself, so a premise failure says which side of it the drag died on.
			guard: router.manip ? router.manip.state : null, touches: router.touchPos ? router.touchPos.size : null });
		const atDown = [];
		// 1. PULL DOWN AT THE TOP, TO THE CAP. 12 steps of 20 px is 240 px of hand against a 96 px
		// allowance, so the give is at its cap well before the lift and the cap is exercised.
		finger("pointerdown", yTop, 1);
		atDown.push(probe());
		// One small move first to clear the assist's slop, then the run, which is the shape the
		// the fling probe drives a real one-finger drag with.
		finger("pointermove", yTop + 10, 1);
		for (let i = 1; i <= 12; i++) { finger("pointermove", yTop + 10 + 20 * i, 1); if (i === 6) atDown.push(probe()); }
		await rendered();
		atDown.push(probe());
		const held = sample("give-held", false);
		// 2. LIFT. The give leaves the offset and becomes the way home the resume has to spend.
		finger("pointerup", yTop + 250, 0);
		const justAfterLift = sample("give-just-after-lift", false);
		// 3. GRAB MID-SPRING: the first frame whose offset is between a quarter and three quarters of
		// where it started, the same window the pen cell catches its bounce in.
		let midSpring = null;
		for (let j = 0; j < 40; j++) {
			await rendered();
			const s2 = sample("give-wait-" + j, false), b = s2.bounce;
			if (b && b.active && Math.abs(b.fromY) > 0 && Math.abs(b.y) <= 0.75 * Math.abs(b.fromY) && Math.abs(b.y) >= 0.25 * Math.abs(b.fromY)) { midSpring = s2; break; }
		}
		if (!midSpring) return { held, justAfterLift, midSpring: null, atDown };
		finger("pointerdown", yTop + 250, 1);
		const atRegrab = sample("give-at-regrab", false);
		// 4. LIFT AGAIN, without drawing and without moving: nothing but the fold is left to return.
		finger("pointerup", yTop + 250, 0);
		const justAfterSecondLift = sample("give-just-after-second-lift", false);
		for (let j = 0; j < 90; j++) {
			await rendered();
			const b = sample("give-rest-wait-" + j, false).bounce;
			if (!b || !b.active) break;
		}
		await settle(4);
		return { held, justAfterLift, midSpring, atRegrab, justAfterSecondLift, atDown, atRest: sample("give-at-rest", false) };
	},
	/**
	 * THE RATCHET (Alan, device, 2026-09-20, vault test 2, Untitled 2: "repeatedly left scroll, lift, left
	 * scroll" walks the page way out of bounds). One finger pulled to the allowance at the top, lifted,
	 * grabbed again EARLY in the spring and pulled to the allowance again, five times over. The grab folds
	 * what the spring still owed into the standing pan (so nothing jumps), and the next pull is
	 * measured from zero again, so the page stands the allowance PLUS the fold past the top - and further
	 * on every grab. Each cycle reports the page's total past the top while held (standing pan plus give).
	 */
	async giveRatchet() {
		const { view, overlay } = rig, router = overlay.router;
		const sd = view.scrollDOM;
		sd.scrollTop = 0;
		// PEN INK OFF FOR THE DRIVE. With it on, this rig's finger is claimed as finger ink before the
		// assist gate is ever reached (measured: fingerInk true, activePen 931, took false), which is the
		// pinned gap one cell up. A finger that scrolls is what Alan's report is about.
		setPenInk(false);
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect();
		const x = r.left + r.width / 2, yTop = r.top + 40;
		const ev = (type, py, buttons) => ({ type, pointerType: "touch", pointerId: 931, isPrimary: true,
			clientX: x, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, py, buttons) => {
			const e = ev(type, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		// The page's total past the top: the standing pan plus the held give, both painted px.
		const total = () => { const b = overlay.overscrollBounceReadout(); return b.restY + b.y; };
		const cycles = [];
		for (let n = 0; n < 5; n++) {
			finger("pointerdown", yTop, 1);
			const atDown = { total: total(), guard: router.manip ? router.manip.state : null, gate: router.assistGateReadout, scrollTop: sd.scrollTop, palms: router.palmsBlocked, swallowed: router.swallowedTouches.size, blocks: router.gate.blocksNewTouch(performance.now()), activePen: router.activePenId, fingerInk: !!(router.cb.fingerInk && router.cb.fingerInk()), edge: router.dragBeginsAgainstAnEnd(), touches: router.touchPos.size, momentumOff: router.canvasMomentumDisabled };
			finger("pointermove", yTop + 10, 1);
			for (let i = 1; i <= 12; i++) finger("pointermove", yTop + 10 + 20 * i, 1);
			await rendered();
			const held = { total: total(), pullY: router.overscrollPullY, engaged: !!router.assistEngaged };
			finger("pointerup", yTop + 250, 0);
			// Grab again early in the spring: the first frame with the bounce active and at least half its way still to go.
			let regrabAt = null;
			for (let j = 0; j < 40; j++) {
				await rendered();
				const b = overlay.overscrollBounceReadout();
				if (b.active && Math.abs(b.fromY) > 0 && Math.abs(b.y) >= 0.5 * Math.abs(b.fromY)) { regrabAt = { total: total(), y: b.y, fromY: b.fromY, frame: j }; break; }
				if (!b.active && j > 2) break;
			}
			cycles.push({ atDown, held, regrabAt });
			if (!regrabAt) break;
		}
		for (let j = 0; j < 90; j++) { await rendered(); if (!overlay.overscrollBounceReadout().active) break; }
		await settle(4);
		return { cycles, atRest: total(), allowance: router.cb.overscrollAllowancePx() };
	},
	/**
	 * A FLICK INTO AN END (Alan, device, 2026-09-20: "it takes too long for the bounce to happen, when i
	 * scroll left multiple times, especially if i do with momentum, it will hang for a bit too long").
	 * One finger flicked LEFT on a note with no sideways range, from the middle of a tall note so the
	 * small vertical residual every real flick carries still has range to glide in. The frames after the
	 * lift are read on the frame clock: whether the glide is still running, whether the spring is, and
	 * how far past the left edge the page stands.
	 */
	/**
	 * direction check: which way a finger has to drag, at scrollLeft 0, to push the page against its
	 * OWN left edge, and what sign the pull carries there. Read on both directions and in both modes, so the
	 * sideways give's ceiling side can be named from a measurement rather than from the sign convention.
	 */
	/**
	 * A flick into the open room. Canvas mode disables the fling today, so this reads whether a
	 * glide runs at all after the lift, how far the page travels once the finger is gone, and whether the
	 * room grows to meet it. Driven leftward from the middle, which the direction check measured as the
	 * way into the room rather than against the origin edge.
	 */
	async flickIntoRoom() {
		const { view, overlay } = rig, router = overlay.router;
		const sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 600;
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect();
		const x0 = r.left + r.width * 0.75, y0 = r.top + r.height / 2;
		const ev = (type, px, py, buttons) => ({ type, pointerType: "touch", pointerId: 961, isPrimary: true,
			clientX: px, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, px, py, buttons) => {
			const e = ev(type, px, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		const read = () => ({ fling: router.flingRaf !== 0, vx: router.flingVx, active: overlay.overscrollBounceReadout().active,
			pullX: router.overscrollPullX, scrollLeft: sd.scrollLeft, rangeX: sd.scrollWidth - sd.clientWidth });
		const before = read();
		finger("pointerdown", x0, y0, 1);
		for (let i = 1; i <= 8; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", x0 - 30 * i, y0 + 2 * i, 1); }
		const held = { ...read(), engaged: !!router.assistEngaged, momentumOff: router.canvasMomentumDisabled };
		finger("pointerup", x0 - 240, y0 + 16, 0);
		const atLift = read();
		const frames = [];
		for (let j = 0; j < 150; j++) {
			await rendered();
			const f = read();
			frames.push(f);
			if (j > 2 && !f.fling) break;
		}
		await settle(4);
		const after = read();
		// What the glide alone carried: the lift's position against where the page came to rest.
		return { before, held, atLift, after, frames, glideTravel: after.scrollLeft - atLift.scrollLeft,
			gildeFrames: frames.filter(f => f.fling).length };
	},
	async directionCheck(axis, dir, farEnd) {
		const { view, overlay } = rig, router = overlay.router;
		const sd = view.scrollDOM;
		setPenInk(false);
		if (axis === "y") sd.scrollTop = 0; else { sd.scrollLeft = 0; sd.scrollTop = 600; }
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		// SEEK TO THE FAR END AFTER THE SETTLE, NOT BEFORE IT. The expansion grows the range
		// while the rig settles - measured 9697 before and 10977 after - so a seek taken from the earlier
		// number leaves the finger 1280 px INSIDE the range, and the drag then scrolls because it has room
		// rather than because an end refused it. Seek, let the growth that the seek itself triggers settle,
		// and repeat until the position stops moving, so the contact really is against the end.
		if (farEnd) {
			for (let i = 0; i < 6; i++) {
				const end = axis === "y" ? sd.scrollHeight - sd.clientHeight : sd.scrollWidth - sd.clientWidth;
				const at = axis === "y" ? sd.scrollTop : sd.scrollLeft;
				if (at >= end - 0.5) break;
				if (axis === "y") sd.scrollTop = end; else sd.scrollLeft = end;
				await settle(6);
				await new Promise(res => setTimeout(res, 400));
				await settle(4);
			}
		}
		const before = { scrollTop: sd.scrollTop, scrollLeft: sd.scrollLeft, rangeX: sd.scrollWidth - sd.clientWidth, rangeY: sd.scrollHeight - sd.clientHeight };
		const roomLeftAtContact = axis === "y" ? before.rangeY - before.scrollTop : before.rangeX - before.scrollLeft;
		const r = sd.getBoundingClientRect();
		const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
		const ev = (type, px, py, buttons) => ({ type, pointerType: "touch", pointerId: 951, isPrimary: true,
			clientX: px, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, px, py, buttons) => {
			const e = ev(type, px, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		const at = d => axis === "y" ? [x0, y0 + dir * d] : [x0 + dir * d, y0];
		const read = () => { const b = overlay.overscrollBounceReadout(); return { active: b.active,
			offset: axis === "y" ? b.y : b.x, from: axis === "y" ? b.fromY : b.fromX,
			rest: axis === "y" ? b.restY : b.restX, total: (axis === "y" ? b.restY + b.y : b.restX + b.x),
			pull: axis === "y" ? router.overscrollPullY : router.overscrollPullX,
			scrollTop: sd.scrollTop, scrollLeft: sd.scrollLeft }; };
		finger("pointerdown", ...at(0), 1);
		const atDown = { ...read(), edge: router.dragBeginsAgainstAnEnd(), engaged: !!router.assistEngaged };
		finger("pointermove", ...at(10), 1);
		for (let i = 1; i <= 12; i++) finger("pointermove", ...at(10 + 20 * i), 1);
		await rendered();
		const held = { ...read(), engaged: !!router.assistEngaged, took: router.assistGateReadout.took };
		finger("pointerup", ...at(250), 0);
		const frames = [];
		let sawSpring = false;
		for (let j = 0; j < 90; j++) {
			await rendered();
			const f = read();
			frames.push(f);
			if (f.active) sawSpring = true;
			if (sawSpring && !f.active) break;
		}
		await settle(4);
		const after = { scrollTop: sd.scrollTop, scrollLeft: sd.scrollLeft, rangeX: sd.scrollWidth - sd.clientWidth, rangeY: sd.scrollHeight - sd.clientHeight };
		return { axis, dir, farEnd: !!farEnd, allowance: router.cb.overscrollAllowancePx(), before, after, roomLeftAtContact, atDown, held,
			sawSpring, springFrom: frames.find(f => f.active)?.from ?? null, atRest: read() };
	},
	async flickIntoEnd(dirX) {
		const { view, overlay } = rig, router = overlay.router;
		const sd = view.scrollDOM;
		setPenInk(false);
		sd.scrollTop = 600;
		await settle(8);
		await new Promise(res => setTimeout(res, 1200));
		await settle(4);
		const r = sd.getBoundingClientRect();
		// The flick starts on the side it comes FROM, so a rightward drive begins left of centre.
		const d = dirX === undefined ? -1 : dirX;
		const x0 = r.left + r.width * (d < 0 ? 0.75 : 0.25), y0 = r.top + r.height / 2;
		const ev = (type, px, py, buttons) => ({ type, pointerType: "touch", pointerId: 941, isPrimary: true,
			clientX: px, clientY: py, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
			timeStamp: performance.now(), tiltX: 0, tiltY: 0, width: 0, height: 0,
			target: sd, preventDefault() {}, stopPropagation() {} });
		const finger = (type, px, py, buttons) => {
			const e = ev(type, px, py, buttons);
			if (type === "pointerdown") router.pointerDown(e);
			else if (type === "pointermove") router.pointerMove(e);
			else router.pointerUpOrCancel(e);
		};
		const read = () => { const b = overlay.overscrollBounceReadout(); return { fling: router.flingRaf !== 0, vx: router.flingVx, active: b.active, total: b.restX + b.x, pullX: router.overscrollPullX, scrollTop: sd.scrollTop, scrollLeft: sd.scrollLeft }; };
		// Eight moves 16 ms apart, 30 px left and 2 px down each: about 1.9 px/ms leftward with the
		// small downward residual a real hand always carries.
		finger("pointerdown", x0, y0, 1);
		for (let i = 1; i <= 8; i++) { await new Promise(res => setTimeout(res, 16)); finger("pointermove", x0 + d * 30 * i, y0 + 2 * i, 1); }
		const held = { ...read(), engaged: !!router.assistEngaged, took: router.assistGateReadout.took, rangeX: sd.scrollWidth - sd.clientWidth };
		finger("pointerup", x0 + d * 240, y0 + 16, 0);
		const frames = [];
		let sawSpring = false;
		for (let j = 0; j < 150; j++) {
			await rendered();
			const f = read();
			frames.push(f);
			if (f.active) sawSpring = true;
			if (sawSpring && !f.active && !f.fling) break;
		}
		const flingEnd = frames.findIndex(f => !f.fling), springStart = frames.findIndex(f => f.active), home = frames.findIndex(f => Math.abs(f.total) <= 0.5 && !f.active && !f.fling);
		return { held, frames, flingEnd, springStart, home, final: read() };
	},
	/** In to 300% about the ink, out to 30% about points toward the pane's right until a settle bounces; 30 frames read after. */
	async zoomChangeBounce(inkMiddleX, cy) {
		for (const cx of [inkMiddleX + 600, inkMiddleX + 400, inkMiddleX - 340, inkMiddleX + 800]) {
			await pinchAbout(3, 30, inkMiddleX, cy, 16, false);
			const before = sample("before-out", false);
			const run = await pinchAbout(0.3, 40, cx, cy, 30, false);
			if (run.rows.some(r => r.bounce && r.bounce.active)) return { cx, before, ...run };
		}
		return null;
	},
	async later(ms) { await new Promise(r => setTimeout(r, ms)); await settle(4); return sample("later", true); },
	/**
	 * The same round trip, then the bounce read on the FRAME CLOCK: one requestAnimationFrame callback a frame, registered
	 * after the bounce's own so it runs after the bounce's step in every frame, reading only the overlay's readout. No
	 * pixels are read here - a frame that reads the committed canvas lands its reading late and would time the reader.
	 */
	async timedBounce(inkMiddleX, cy) {
		await pinchAbout(3, 30, inkMiddleX, cy, 16, false);
		await pinchAbout(1, 30, inkMiddleX, cy, 0, false, 60);
		const overlay = rig.overlay, frames = [];
		await new Promise(resolve => {
			const tick = ts => {
				const b = overlay.overscrollBounceReadout();
				frames.push({ ts, active: b.active, x: b.x, fromX: b.fromX, startedAt: b.startedAt });
				if (frames.length >= 120 || (!b.active && frames.some(f => f.active))) resolve(); else requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		return frames;
	},
};
`;

let browser: Browser, script: string;
const record: unknown[] = [];

const CHOKE = "\t\tconst el = this.previewPaperEl;\n\t\tif (!el) return;\n\t\tthis.previewPaperEl = null;";
const bypass = (reason: string) => `\t\tconst el = this.previewPaperEl;\n\t\tif (!el || reason === "${reason}") return;\n\t\tthis.previewPaperEl = null;`;
const PLANTS: { env: string; from: string; to: string }[] = [
	{ env: "HW_BOUNCE_PLANT_LEAVE_AT_OVERSHOOT", from: "const left = t >= 1 ? 0 : (1 - t) ** 3;", to: "const left = 1;" },
	// The ease runs 2 painted px past the rest before it ends: a spring, not a glide.
	{ env: "HW_BOUNCE_PLANT_OVERSHOOT", from: "const left = t >= 1 ? 0 : (1 - t) ** 3;", to: "const left = t >= 1 ? 0 : (1 - t) ** 3 - t * 2 / Math.max(2, Math.abs(bx || by));" },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_BOUNCE_END", from: CHOKE, to: bypass("bounce-end") },
	{ env: "HW_PAPER_PREVIEW_PLANT_BYPASS_INPUT", from: CHOKE, to: bypass("input") },
	// A bounce the settle itself started keeps the element: this plant leaves it carrying the gesture's zoom, not the settled one.
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_RECOPY_AT_SETTLE", from: "\t\t\tif (this.bounceState) this.rebasePreviewPaper();\n", to: "\t\t\tif (this.bounceState) {}\n" },
	// The bounce must carry the paper on the element: this plant leaves it on the scroller's background, as the prototype did.
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_BOUNCE_SWAP", from: "\t\tthis.beginPreviewPaper();\n", to: "" },
	// And the copy the bounce takes must be the settled zoom's: this plant leaves that element with no background at all.
	{ env: "HW_PAPER_PREVIEW_PLANT_NO_BOUNCE_COPY", from: "\t\tcopyPreviewPaperBackground(el, cs);\n", to: "\t\tif (!this.bounceState) copyPreviewPaperBackground(el, cs);\n" },
	// The pan writer never hands the pan to the paper: condition 2's paper reading on the glide frames goes red.
	// It lives here now because the glide is where a live pan is read - a resting page carries none. Carried into this
	// table on the route(e) merge: the loop above only applies plants that are entries here.
	{ env: "HW_PAPER_PAN_PLANT_NO_PAN", from: "\t\tthis.writePaperPan();\n\t\tthis.writeInkLayerTransform();\n", to: "\t\tthis.writeInkLayerTransform();\n" },
];

beforeAll(async () => {
	const active = PLANTS.filter(pl => process.env[pl.env]);
	let planted = 0;
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "overscrollBouncePage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: active.length ? [{ name: "bounce-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlay\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8").replace(/\r\n/g, "\n");
				for (const pl of active) {
					if (text.split(pl.from).length !== 2) throw new Error(`${pl.env}: anchor not found once`);
					text = text.replace(pl.from, pl.to);
					planted++;
				}
				return { loader: "ts", contents: text };
			});
		} }] : [] });
	if (planted !== active.length) throw new Error(`plants requested ${active.length}, applied ${planted}`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => {
	await browser?.close();
	if (process.env.HW_BOUNCE_OUT) writeFileSync(process.env.HW_BOUNCE_OUT, JSON.stringify(record, null, 1));
});

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).bounce[m](...a), [method, args] as const);
async function open(tag: string, infinite = false) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	// The rule colour, without which the paper's gradients are invalid and the scroller paints no paper at all: this page
	// asserted the pan PROPERTIES, which are written either way, so it never needed it until the paper became an element.
	await page.setContent('<!doctype html><body style="margin:0; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", infinite, tag) as any;
	return { page, errors, mounted };
}
const BOUNCE_MS = 500;
/** One frame at 60 Hz: the timing's tolerance. */
const FRAME_MS = 1000 / 60;
const show = (v: unknown) => JSON.stringify(v);

it("THE BOUNCE, ON THE ORIGIN EDGE: the settle springs the page back off its own top edge, eased, within the bound, onto the settle's own rest", async () => {
	// class A: MOUNTED WITH THE CANVAS ON. This arm drives its gesture through
	// router.beginPinch, the canvas-ON pinch since then; mounted canvas off it pinched nothing at all and
	// the cell failed on its own premise, with no product fault behind it.
	const { page, errors, mounted } = await open("shape", true);
	try {
		expect(mounted.strokes, "premise: the stroke committed").toBe(1);
		// THE DRIVE CHANGES, THE CLAIMS DO NOT. Under the canvas the same-centre round trip owes
		// 1 px sideways - the page stays where the fingers left it, so there is nothing to ease and the >= 15
		// premise below cannot be met by any claim this cell makes. What the canvas does correct is the ORIGIN
		// EDGE: zoom in about the ink, then out about a point 40 px below it, and the page ends with blank above
		// its own top which the settle owes back - the TOP drive, 26.33 px there. Every claim below is the
		// same claim, read on the axis the canvas actually corrects.
		const { last, rows } = await call(page, "originEdgeOvershoot", mounted.inkMiddleX, mounted.natural.textCy) as { last: any; rows: any[] };
		const later = await call(page, "later", 400) as any;
		record.push({ cell: "shape", natural: mounted.natural, last, rows, later });
		const end = rows.at(-1);
		expect(errors).toEqual([]);
		expect(end.k, "premise: back at 100%").toBeCloseTo(1, 6);
		// The premise is that the settle owed a correction at all, not the old fitting clamp's
		// 200..250 px. That clamp is gone with the settle, and the drive is the same-centre round trip that
		// leaves the canvas's edge inside the pane - the one thing the bound still corrects. Measured on
		// this drive: 19.00 px, the same correction the trace reads at the settle.

		// THE PREMISE READS THE CORRECTION THIS CELL ASSERTS ON, TWICE, FROM TWO SOURCES THAT
		// MUST AGREE. Under the canvas the origin-edge correction is the scroll commit's true-travel share
		// (by rule), not a pan-bound hit, so `boundMaxPx` stays at 1 by design and cannot stand for it -
		// measured on this drive: boundMaxPx 1, boundHits 3, while the page travels 26.33 px over 23 eased frames.
		// The bar is unchanged at 15. What changes is where it is read: the bounce's own fromY is the product
		// grading itself, so the page's painted travel - the content box's top between the last preview frame and
		// the rest - is read beside it as the witness, and the two must agree within a pixel.
		const travelled = Math.abs(last.contentTop - end.contentTop), eased = Math.abs(rows[0].bounce?.fromY ?? 0);
		expect(travelled, `premise: the settle owed a correction (painted travel ${travelled.toFixed(2)} px, boundMaxPx ${end.fitReadout.boundMaxPx} - under the canvas the bound is not what corrects here)`).toBeGreaterThanOrEqual(15);
		expect(eased, `premise: and the ease was given that correction to run (fromY ${eased.toFixed(2)} px)`).toBeGreaterThanOrEqual(15);
		expect(Math.abs(travelled - eased), `premise: the two readings agree - painted travel ${travelled.toFixed(2)} px against the ease's own ${eased.toFixed(2)} px`).toBeLessThanOrEqual(1);
		const correction = end.contentTop - last.contentTop;
		// CONDITION 1, THE REST: the page ends exactly where the settle's bound put it - the overlay's own
		// correction. MAGNITUDE, because the direction reversed with the contract. The old
		// fitting clamp pulled a clipped page RIGHT, back onto the pane; the bound that replaced it closes
		// blank at the LEFT, so the page travels left and `correction` is negative where it used to be
		// positive. Measured here: moved -19.00 px against a bound of 19.00. Comparing signed values
		// reddens a page that moved exactly as far as it should, in the only direction a later ruling allows.
		// THE SAME CLAIM, AGAINST THE QUANTITY THAT CORRECTS HERE. The page rests where the settle said it
		// would; under the canvas what the settle hands the ease is the true-travel share, read as the bounce's
		// own from-offset, and `boundMaxPx` (1 px) is the pan bound, which is not what moved the page. The two
		// sources were required to agree within a pixel in the premise above, so this compares against the pair.
		expect(Math.abs(Math.abs(correction) - eased), `the page rests where the settle put it: moved ${correction} px against the ${eased.toFixed(2)} px the ease was given (pan bound ${end.fitReadout.boundMaxPx} px, which is not what corrects under the canvas)`).toBeLessThanOrEqual(0.05);
		// It animates: no single frame carries more than half of the correction (a jump carries all of it in one frame).
		const steps = rows.map((r, i) => r.contentTop - (i === 0 ? last.contentTop : rows[i - 1].contentTop));
		// HALF THE CORRECTION'S SIZE. `correction` is negative under the new bound (the page
		// travels left to close blank), so the old `correction / 2` was a negative ceiling on a positive
		// maximum and could never hold.
		expect(Math.max(...steps.map(Math.abs)), `no frame jumps: per-frame steps ${show(steps.map(s => Math.round(s * 10) / 10))}`).toBeLessThanOrEqual(Math.abs(correction) / 2);
		const bouncing = rows.filter(r => r.bounce && r.bounce.active);
		expect(bouncing.length, "the bounce played over several frames").toBeGreaterThanOrEqual(4);
		const first = bouncing[0];
		expect(Math.abs(first.bounce.fromY + correction), `it starts from the overshoot: offset ${first.bounce.fromY} against a correction of ${correction}`).toBeLessThanOrEqual(2);
		// Toward the rest, never past it, never back toward the overshoot.
		for (let i = 1; i < rows.length; i++) {
			// The page now travels LEFT to close blank, so contentLeft falls toward the rest.
			// The pair is the same claim with its inequalities the other way round.
			expect(rows[i].contentTop, `frame ${i + 1} does not pass the rest`).toBeGreaterThanOrEqual(end.contentTop - 0.5);
			expect(rows[i].contentTop, `frame ${i + 1} does not move back toward the overshoot`).toBeLessThanOrEqual(rows[i - 1].contentTop + 0.5);
		}
		// Bounded: over within the bound (one frame's slack), and long enough to be seen.
		const done = rows.find(r => r.bounce && !r.bounce.active && r.t > first.t)!;
		expect(done, "the bounce ends").toBeTruthy();
		const startedAt = first.bounce.startedAt as number;
		// It glides for the whole half second. When it ends is timed on the frame clock by the TIMED arm below: these frames
		// read the committed canvas's pixels, which lands each reading late (measured 570 ms for a 500 ms glide).
		expect(bouncing.at(-1).t - startedAt, `and glides until within a frame of ${BOUNCE_MS} ms`).toBeGreaterThanOrEqual(BOUNCE_MS - FRAME_MS);
		// MONOTONIC: the offset toward the rest never grows once the page is released.
		for (let i = 1; i < bouncing.length; i++) expect(Math.abs(bouncing[i].bounce.x), `frame ${i + 1} of the glide: the offset does not grow`).toBeLessThanOrEqual(Math.abs(bouncing[i - 1].bounce.x) + 1e-9);
		// CONDITION 1: the rest is the settle's own and the bounce never moves it.
		for (const r of bouncing) expect(r.restX, "the rest pan does not move while the page bounces").toBe(end.restX);
		expect(end.bounce.x, "the offset ends at exactly zero").toBe(0);
		expect(end.sizerX, "the text's translate at the end is the rest's own").toBeCloseTo(end.restX / end.cssScale, 9);
		expect(Math.abs(later.contentTop - end.contentTop), "nothing moves afterwards").toBeLessThanOrEqual(0.01);
		// THE REST IS THE HOST'S OWN LAYOUT, not inside the pane. The old fitting
		// clamp landed a clipped page back within the viewport; the bound that replaced it only forbids
		// blank at the left and top, and a page hanging past the pane's edge is where Alan asked for it to
		// be left. Measured on this drive: the canvas rests 19 px past the pane's left edge, at pan 0.
		expect(Math.abs(end.restX), `the page rests at the host's own layout, pan ${end.restX}`).toBeLessThanOrEqual(1);
		// CONDITION 2: text, ink and paper move together on every bounce frame.
		const ref = bouncing[0];
		for (const r of bouncing) {
			expect(r.sizerX - r.inkLayerX, "the ink layer takes the same translate as the text").toBeCloseTo(ref.sizerX - ref.inkLayerX, 6);
			if (Number.isFinite(r.pitch) && r.pitch > 0) {
				const want = ((((r.sizerX + r.paperDrift / r.cssScale) % r.pitch) + r.pitch) % r.pitch);
				const got = ((r.paperX % r.pitch) + r.pitch) % r.pitch;
				// The preview element's rules land on whole device px: half a device px, in layout px, more.
				const tol = r.paperSource === "element" ? 0.5 / (r.cssScale * r.dpr) + 1 / 32 : 1 / 32;
				expect(Math.min(Math.abs(got - want), r.pitch - Math.abs(got - want)), `the paper takes the same pan, folded by its pitch (${r.paperSource})`).toBeLessThanOrEqual(tol);
			}
			if (r.inkLeft !== null && ref.inkLeft !== null) expect(Math.abs((r.inkLeft - r.textLeft) - (ref.inkLeft - ref.textLeft)), "the ink stays on its words on screen, px").toBeLessThanOrEqual(1);
		}
		expect(bouncing.some(r => Number.isFinite(r.pitch) && r.pitch > 0), "premise: the paper's pitch is written, so the paper reading is live").toBe(true);
		// THE PAPER RIDES THE BOUNCE: the preview element stays up on every bounce frame and comes down on the frame the bounce
		// ends, by the bounce's own end, never before it.
		expect(bouncing.filter(r => r.paperSource !== "element").map(r => r.phase), "every bounce frame's paper is the preview element").toEqual([]);
		expect([done.paperSource, done.paperEnded], "on the frame the bounce has ended, the preview element is down, taken down by the bounce's end").toEqual(["scroller", "bounce-end"]);
		// THE INVALIDATING WRITE IS ABSENT: the scroller's pan properties, which re-raster the whole background when they
		// change, are not written on any bounce frame; the element's transform carries the pan instead.
		expect(bouncing.filter(r => r.scrollerPan !== last.scrollerPan).map(r => ({ phase: r.phase, pan: r.scrollerPan })),
			`the scroller's pan properties are untouched through the bounce (last preview frame ${last.scrollerPan})`).toEqual([]);
		// Read against the bounce's own state, never a duration: the recovery constant is free to be retuned.
		if (later.bounce && !later.bounce.active) expect(later.paperSource, "and the paper at rest is the scroller's own").toBe("scroller");
		expect(bouncing.filter(r => r.inkLeft !== null).length, "premise: the ink is on screen on the bounce frames").toBeGreaterThanOrEqual(2);
	} finally { await page.close(); }
}, 240_000);

it("PEN DOWN MID-BOUNCE: the bounce is cancelled before the contact is read, the stroke lands where the page rests, and a page standing past its bound resumes to it after the lift", async () => {
	// class A: MOUNTED WITH THE CANVAS ON. This arm drives its gesture through
	// router.beginPinch, the canvas-ON pinch since then; mounted canvas off it pinched nothing at all and
	// the cell failed on its own premise, with no product fault behind it.
	const { page, errors, mounted } = await open("pen", true);
	try {
		const r = await call(page, "penMidBounce", mounted.inkMiddleX, mounted.natural.textCy, false) as any;
		record.push({ cell: "pen", ...r });
		expect(errors).toEqual([]);

		expect(r.before, "premise: a pen landed while the bounce was a quarter to three quarters of the way").not.toBeNull();
		// Test-only. The old premise asked the two mappings to differ by 20 px, which held
		// while a cancelled ease dropped its offset and the page jumped to its rest under the pen. Under
		// The cancel FOLDS that offset into the pan, so the page is already where the pen sees it
		// and the two mappings agree - measured 0 against a demanded 20. What the cell is really about
		// survives and is asserted instead: the page does not move when the contact cancels the ease.
		// That fails the moment the fold is removed, by the whole remaining offset.
		expect(Math.abs(r.atContact.contentLeft - r.before.contentLeft),
			`premise: the contact does not move the page (mid-bounce ${r.before.contentLeft}, at contact ${r.atContact.contentLeft})`).toBeLessThanOrEqual(1);
		expect(r.atContact.bounce.active, "the contact cancelled the bounce").toBe(false);
		expect(r.atContact.bounce.x, "the page is at its rest when the contact is read").toBe(0);
		// Test-only, same reason as the premise above: the cancel no longer throws the
		// remaining offset away, it folds it into the pan, so the page's REST carries it - measured
		// 36.39 against a rest of 0 with 36.39 still standing on the ease. The page on screen has not
		// moved, which is the row above. What is asserted here now is that the fold is exact: the new
		// rest is the settle's rest plus what the ease still had, to the pixel.
		expect(Math.abs(r.atContact.restX - (r.before.restX + r.before.bounce.x)),
			`the cancel folds the ease's remainder into the rest, exactly (rest ${r.before.restX} + standing ${r.before.bounce.x} against ${r.atContact.restX})`).toBeLessThanOrEqual(1);
		expect(r.before.paperSource, "premise: mid-bounce the paper is the preview element").toBe("element");
		expect([r.atContact.paperSource, r.atContact.paperEnded], "the contact took the preview element down, through its input path, before the contact was read").toEqual(["scroller", "input"]);
		expect(r.strokeX, "the stroke committed").not.toBeNull();
		expect(Math.abs(r.strokeX - r.expectedAtRest), `the stroke lands where the resting page puts it (through the bounce would be ${r.expectedThroughBounce})`).toBeLessThanOrEqual(3);
		// DURING the stroke nothing moves - the row above (`atContact` vs `before`) already covers that,
		// unchanged. Alan: nothing moves unless the page is past its bound, then it eases back - no
		// infinite blank standing forever. This pen catch folded a real standing offset into the pan
		// (`atContact.restX` above, nonzero), so AFTER the pen lifts that offset is exactly what the ruling's
		// resume has to spend: the old row here asked for zero further motion, which was the earlier law
		// for a page whose only rest is 0. What survives is that the page reaches its bound and stops there,
		// not that it never moves - the paired "already at rest" row below is the case with nothing to spend.
		//
		// THE EASE ITSELF, not just where it ends up: a mere park - the page silently placed at
		// its bound with no ease at all - would satisfy a rest-only check but is not what the ruling does. Two
		// endpoints, no per-frame sampling (this file reddens under seven-file load on timing): right after
		// the lift the resumed bounce has just started (offset non-zero, decay not yet run a frame), and at
		// rest it has finished (offset back to 0).
		expect(Math.abs(r.justAfterPenUp.bounce.x), "the resume actually started an ease: offset non-zero right after the lift, not already at rest").toBeGreaterThan(0.5);
		expect(r.after.bounce.active, "the ease finished by the time the page is read at rest").toBe(false);
		expect(Math.abs(r.after.bounce.x), "the offset decayed to 0, not left standing").toBeLessThanOrEqual(0.5);
		expect(Math.abs(r.after.restX), "the page resumed to its bound (0, no floor on this fixture) after the pen lifted").toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 240_000);

it("PEN DOWN AFTER THE BOUNCE HAS SETTLED: a page already at its bound has nothing to resume, so a caught-and-drawn stroke does not move it (the paired control)", async () => {
	// class A: MOUNTED WITH THE CANVAS ON. This arm drives its gesture through
	// router.beginPinch, the canvas-ON pinch since then; mounted canvas off it pinched nothing at all and
	// the cell failed on its own premise, with no product fault behind it.
	const { page, errors, mounted } = await open("pen", true);
	try {
		const r = await call(page, "penMidBounce", mounted.inkMiddleX, mounted.natural.textCy, true) as any;
		record.push({ cell: "pen-late", ...r });
		expect(errors).toEqual([]);

		expect(r.before, "premise: the bounce ran to completion before the pen landed").not.toBeNull();
		expect(r.before.bounce.active, "premise: the bounce is not still playing").toBe(false);
		expect(Math.abs(r.before.restX), "premise: the page really is at its bound (0) already, nothing standing to resume").toBeLessThanOrEqual(0.5);
		// THE ABSENCE OF AN EASE, the paired control to the row above's presence check: nothing to resume
		// means resumeStrandedPan is a no-op, not a park - no bounce starts at all, right after the lift.
		expect(r.justAfterPenUp.bounce.active, "no ease started - there was nothing standing to resume").toBe(false);
		expect(Math.abs(r.justAfterPenUp.bounce.x), "offset stayed at 0 right after the lift, no ease to decay").toBeLessThanOrEqual(0.5);
		expect(r.strokeX, "the stroke committed").not.toBeNull();
		expect(Math.abs(r.after.contentLeft - r.atContact.contentLeft), "and the page does not move again after the stroke - nothing was standing past the bound to resume").toBeLessThanOrEqual(0.01);
	} finally { await page.close(); }
}, 240_000);

/**
 * A PINNED GAP, not a covered claim. This rig does not hand a one-finger drag to the assist pan, so
 * line 7's give is never made here and the mid-spring return below cannot be exercised at all.
 *
 * WHY IT IS PINNED RATHER THAN MARKED FAILING. `it.fails` passes whenever the cell fails for ANY
 * reason: it would stay green if the give broke outright, if the ease stopped running, if the page
 * parked past its end. That turns a red naming one gap into a green hiding every break in the
 * gesture. This cell instead asserts what IS true today, so it passes for a stated reason and goes
 * RED the day the rig starts delivering the drag - which is the day the claims below can be written.
 *
 * WHAT IS MEASURED, and pinned: everything the give needs is in place except the gesture reaching
 * the assist. The host offers its allowance, the scroller has far more page than pane, one contact
 * is live, and still nothing is engaged and nothing is refused, so the page never leaves its end.
 *
 * WHAT IS NOT ESTABLISHED: why. Three readings died against this drive - that the events never
 * reached the router, that the axis was wrong, that a pinch beforehand left the guard stuck - and
 * the readout cannot settle the guard, because it samples AFTER the contact and `touchStart` moves
 * armed to armed-assist whether it grants the assist or refuses it. A field consistent with both
 * answers is not evidence. Closing this needs the decision captured AT the gate
 * (InlinePenRouter.ts:2711): `d.assistThisGesture` and `guardEnabled`, not the guard's name after.
 *
 * THE CLAIMS THIS CELL IS FOR, when the drag lands: a finger pulls the page past the top to the
 * allowance and lifts, and a second finger lands while it springs back and lifts again without
 * drawing. Both lifts go home through the one return - the first through `releaseOverscrollGive`,
 * which folds the give into the standing pan and hands it to `resumeStrandedPan`, the second
 * through that same method from `onAllContactsLifted`. The rows: the give was really non-zero
 * (the premise that stops a clamp satisfying a rest-only check), an ease started after EACH lift
 * rather than the page being parked silently, the offset reaches 0, and the page rests at the top
 * within a pixel.
 */
it("PINNED GAP: a one-finger drag never reaches the assist pan in this rig, so no give is made and the page does not leave its end (driven with the canvas ON, which is where the give now lives)", async () => {
	const { page, errors } = await open("give-regrab", true);
	try {
		const r = await call(page, "giveRegrab") as any;
		record.push({ cell: "give-regrab-pinned", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify(r.atDown);
		// THE INPUTS ARE RIGHT. If one of these ever goes wrong the gap has a different shape and this
		// cell must not keep quiet about it.
		expect(r.atDown.length, "the drive was read at pointerdown, mid-drag and after the last move").toBe(3);
		for (const row of r.atDown) {
			expect(row.allowance, `the host offers its allowance (drive ${drive})`).toBe(96);
			expect(row.range, `the scroller has far more page than pane (drive ${drive})`).toBeGreaterThan(5000);
			expect(row.touches, `exactly one contact is live (drive ${drive})`).toBe(1);
		}
		// THE GAP ITSELF. Red the day the rig delivers the drag - at which point the claims in the
		// header can be written as rows and this cell retired.
		for (const row of r.atDown) {
			expect(row.assistEngaged, `the assist never engages (drive ${drive})`).toBe(false);
			expect(row.assistOwns, `and never owns the pointer (drive ${drive})`).toBe(false);
			expect(row.pullX, `so nothing is refused on x (drive ${drive})`).toBe(0);
			expect(row.pullY, `and nothing on y (drive ${drive})`).toBe(0);
		}
		// AND THE CONSEQUENCE ON THE PAGE, which is what makes this a gap and not a preference: with no
		// give made, there is nothing to spring back and the page never left the top at all.
		expect(Math.abs(r.held.bounce.y), `no give is held while the finger drags (offset ${r.held.bounce.y})`).toBeLessThanOrEqual(0.5);
		expect(r.midSpring, "and no spring back follows the lift, because nothing was held").toBeNull();
	} finally { await page.close(); }
}, 240_000);

it("INFINITE CANVAS ON: the give measures from the rest - grabbed mid-spring and pulled again, the page stands no further past its own top than the one allowance, and comes home (Alan, device, 2026-09-20; the ruling moves this into canvas mode)", async () => {
	const { page, errors } = await open("give-ratchet", true);
	try {
		const r = await call(page, "giveRatchet") as any;
		record.push({ cell: "give-ratchet", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify(r.cycles.map((c: any) => ({ atDown: c.atDown, held: c.held, regrabAt: c.regrabAt })));
		// THE INPUTS ARE RIGHT: every grab reached the assist and pulled to the allowance, and at least three
		// of them landed while the spring was still at least half way out.
		expect(r.allowance, `the host offers its allowance (${drive})`).toBe(96);
		expect(r.cycles.length, `at least three grabs (${drive})`).toBeGreaterThanOrEqual(3);
		for (let i = 0; i < r.cycles.length; i++) {
			const c = r.cycles[i];
			expect(c.held.engaged, `grab ${i + 1}: the assist carries the drag (${drive})`).toBe(true);
			expect(Math.abs(c.held.pullY), `grab ${i + 1}: the hand pulled to the allowance (${drive})`).toBeCloseTo(r.allowance, 0);
			if (i < r.cycles.length - 1) expect(c.regrabAt, `grab ${i + 1}: the next grab landed mid-spring (${drive})`).not.toBeNull();
		}
		// THE CLAIM: while held, the page is never further past the top than the allowance itself, whatever the
		// spring still owed when the finger landed; and the last lift brings it all the way home.
		for (let i = 0; i < r.cycles.length; i++) {
			expect(r.cycles[i].held.total, `grab ${i + 1}: held no further past the top than the allowance (${drive})`).toBeLessThanOrEqual(r.allowance + 1);
		}
		expect(Math.abs(r.atRest), `the page comes home after the last lift (rest ${r.atRest}; ${drive})`).toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 240_000);

it("INFINITE CANVAS ON: a flick into the page's own left edge - the glide ends at the end it hits and the spring starts at once, whatever residual the flick carried across it (Alan, device, 2026-09-20; the ruling moves this into canvas mode)", async () => {
	const { page, errors } = await open("flick-into-end", true);
	try {
		const r = await call(page, "flickIntoEnd", 1) as any;
		record.push({ cell: "flick-into-end", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify({ held: r.held, flingEnd: r.flingEnd, springStart: r.springStart, home: r.home, first: r.frames.slice(0, 6) });
		// THE INPUTS ARE RIGHT: the assist carried the flick, the page had no sideways range, the give was held.
		expect(r.held.engaged, `the assist carries the flick (${drive})`).toBe(true);
		// Canvas mode GRANTS sideways range (measured 1690 px), so "no range" is not what makes this
		// an end. The scroller sitting at 0 is: a rightward flick there is refused by the origin edge.
		expect(r.held.scrollLeft, `premise: the page is on its own left edge (${drive})`).toBe(0);
		expect(r.held.pullX, `the flick pulled at the left edge, on the ceiling side (${drive})`).toBeGreaterThan(10);
		// A glide that ends inside the lift's own frame leaves its velocity behind; the raf alone would miss it.
		expect(r.frames[0].fling || Math.abs(r.frames[0].vx) > 0, `a glide started at the lift (${drive})`).toBe(true);
		// THE CLAIM: the glide is over and the spring is running within three frames of the lift, and the page
		// is home within the spring's own half second plus slack.
		expect(r.flingEnd, `the glide ends within three frames of the lift (${drive})`).toBeGreaterThanOrEqual(0);
		expect(r.flingEnd, `the glide ends within three frames of the lift (${drive})`).toBeLessThanOrEqual(3);
		expect(r.springStart, `the spring starts within three frames of the lift (${drive})`).toBeGreaterThanOrEqual(0);
		expect(r.springStart, `the spring starts within three frames of the lift (${drive})`).toBeLessThanOrEqual(3);
		expect(r.home, `the page is home within 45 frames (${drive})`).toBeGreaterThanOrEqual(0);
		expect(r.home, `the page is home within 45 frames (${drive})`).toBeLessThanOrEqual(45);
	} finally { await page.close(); }
}, 240_000);

it("CANVAS OFF: the page does not give at its top edge - no pull, no spring, the scroller stays inside its range", async () => {
	const { page, errors } = await open("give-ratchet-off");
	try {
		const r = await call(page, "giveRatchet") as any;
		record.push({ cell: "give-ratchet-off", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify(r.cycles.map((c: any) => ({ atDown: c.atDown, held: c.held })));
		// THE HOST OFFERS NOTHING, which is the whole of the change at this site.
		expect(r.allowance, `the host offers no allowance with the canvas off (${drive})`).toBe(0);
		// AND THE CONSEQUENCE ON THE PAGE: no pull accrues while the finger drags, and nothing springs after it.
		for (let i = 0; i < r.cycles.length; i++) {
			expect(r.cycles[i].held.pullY, `grab ${i + 1}: no pull accrues (${drive})`).toBe(0);
			expect(Math.abs(r.cycles[i].held.total), `grab ${i + 1}: the page does not leave its top (${drive})`).toBeLessThanOrEqual(0.5);
			expect(r.cycles[i].regrabAt, `grab ${i + 1}: no spring to grab (${drive})`).toBeNull();
		}
		expect(Math.abs(r.atRest), `and the page is at its top at rest (${drive})`).toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 240_000);

it("CANVAS OFF: a flick into an end neither gives nor springs", async () => {
	const { page, errors } = await open("flick-into-end-off");
	try {
		const r = await call(page, "flickIntoEnd") as any;
		record.push({ cell: "flick-into-end-off", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify({ held: r.held, first: r.frames.slice(0, 6), final: r.final });
		// THE INPUT IS THE SAME FLICK the canvas-on cell drives: the assist still carries it, the page still has no
		// sideways range. Only the give is gone.
		expect(r.held.rangeX, `premise: no sideways range (${drive})`).toBeLessThanOrEqual(0);
		expect(r.held.pullX, `no pull at the end (${drive})`).toBe(0);
		expect(r.frames.every((f: any) => !f.active), `no spring plays at any frame (${drive})`).toBe(true);
		expect(Math.abs(r.final.total), `and the page stands on its end (${drive})`).toBeLessThanOrEqual(0.5);
	} finally { await page.close(); }
}, 240_000);

it("INFINITE CANVAS ON: a flick into the open room glides on after the lift, with room still ahead of it", async () => {
	const { page, errors } = await open("flick-into-room", true);
	try {
		const r = await call(page, "flickIntoRoom") as any;
		record.push({ cell: "flick-into-room", ...r });
		expect(errors).toEqual([]);
		const drive = JSON.stringify({ before: r.before, held: r.held, atLift: r.atLift, after: r.after, travel: r.glideTravel, glideFrames: r.gildeFrames });
		// THE INPUT IS RIGHT: the assist carried the flick into the room, not against an end.
		expect(r.held.engaged, `the assist carries the flick (${drive})`).toBe(true);
		expect(r.held.pullX, `nothing is refused on the way in, so no pull (${drive})`).toBe(0);
		// THE CLAIM, item 12: the glide RUNS in canvas mode - it is disabled there today - and the page keeps
		// travelling after the hand is gone. The room grows to hold it and no spring plays.
		expect(r.atLift.fling || Math.abs(r.atLift.vx) > 0, `a glide starts at the lift (${drive})`).toBe(true);
		expect(r.gildeFrames, `and it runs for more than one frame (${drive})`).toBeGreaterThanOrEqual(2);
		expect(r.glideTravel, `the page travels after the lift (${drive})`).toBeGreaterThan(20);
		// NOT "the range grew": measured, this flick covers a few hundred px inside 1690 px of room already
		// granted, so the frontier never comes within EXTENT_MARGIN and no chunk is granted. What matters
		// here is that the glide had room to run in and was never pinned against an end.
		expect(r.after.scrollLeft, `the page is still inside its room, not pinned at an end (${drive})`).toBeLessThan(r.after.rangeX);
		expect(r.frames.every((f: any) => !f.active), `and no spring plays on the way in (${drive})`).toBe(true);
	} finally { await page.close(); }
}, 240_000);

it("A BOUNCE AFTER A ZOOM CHANGE: the preview element rides it with the settled zoom's rules, not the gesture's", async () => {
	// class A: MOUNTED WITH THE CANVAS ON. This arm drives its gesture through
	// router.beginPinch, the canvas-ON pinch since then; mounted canvas off it pinched nothing at all and
	// the cell failed on its own premise, with no product fault behind it.
	const { page, errors, mounted } = await open("zoom-change", true);
	try {
		const r = await call(page, "zoomChangeBounce", mounted.inkMiddleX, mounted.natural.textCy) as any;
		record.push({ cell: "zoom-change", ...r });
		expect(errors).toEqual([]);

		expect(r, "premise: a settle at 30 percent bounced from one of the focal points tried").not.toBeNull();
		const bouncing = r.rows.filter((row: any) => row.bounce && row.bounce.active);
		expect(r.before.hostRule, "premise: at 300 percent the rule is its one px literal").toBeCloseTo(1, 3);
		expect(bouncing[0].hostRule, "premise: at 30 percent the rule is floored past its literal, so the gesture's copy is not the settled one").toBeGreaterThan(1.5);
		expect(bouncing.filter((row: any) => row.paperSource !== "element").map((row: any) => row.phase), "every bounce frame's paper is the preview element").toEqual([]);
		const off = bouncing.filter((row: any) => !(row.paperRule !== null && Math.abs(row.paperRule - row.hostRule) <= 1 / 64)).map((row: any) => ({ phase: row.phase, paperRule: row.paperRule, hostRule: row.hostRule }));
		expect(off, "on every bounce frame the preview element's rule is the settled zoom's rule").toEqual([]);
		expect(bouncing.filter((row: any) => row.scrollerPan !== bouncing[0].scrollerPan).map((row: any) => row.phase),
			"and the scroller's pan properties are untouched through it").toEqual([]);
	} finally { await page.close(); }
}, 240_000);

it("MEASUREMENT: which way a drag pushes the page against its own origin edge, and what the far end does in canvas mode", async () => {
	const ROWS = [
		{ tag: "off-right", infinite: false, axis: "x", dir: 1, farEnd: false },
		{ tag: "off-left", infinite: false, axis: "x", dir: -1, farEnd: false },
		{ tag: "on-right", infinite: true, axis: "x", dir: 1, farEnd: false },
		{ tag: "on-left", infinite: true, axis: "x", dir: -1, farEnd: false },
		{ tag: "on-far-end-y", infinite: true, axis: "y", dir: -1, farEnd: true },
		// Again: y's far end RECEDES (the grow rule keeps headroom ahead of the frontier), so the
		// x axis is the one whose far end can actually be reached - measured range 1690 there, unchanged
		// across a drag. This row is where the far-end pull risk can fire at all.
		{ tag: "on-far-end-x", infinite: true, axis: "x", dir: -1, farEnd: true },
	];
	const out = [];
	for (const row of ROWS) {
		const { page, errors } = await open("dir-" + row.tag, row.infinite);
		try {
			const r = await call(page, "directionCheck", row.axis, row.dir, row.farEnd) as any;
			out.push({ tag: row.tag, infinite: row.infinite, ...r, errors });
		} finally { await page.close(); }
	}
	record.push({ cell: "direction-check", out });
	console.log("DIRECTION CHECK " + JSON.stringify(out, null, 1));
	expect(out.length).toBe(6);
}, 600_000);

it("INFINITE CANVAS ON: a page pushed toward the room it grows into does not bounce", async () => {
	const { page, errors, mounted } = await open("infinite", true);
	try {
		const { last, rows } = await call(page, "clippedZoomOut", mounted.inkMiddleX, mounted.natural.textCy) as { last: any; rows: any[] };
		record.push({ cell: "infinite", last, rows });
		expect(errors).toEqual([]);
		const end = rows.at(-1);
		expect(end.k, "premise: back at 100%").toBeCloseTo(1, 6);
		expect(rows.every(r => !r.bounce || !r.bounce.active), `no bounce plays (clamp ${show(end.fitReadout)}; moved ${end.contentLeft - last.contentLeft} px)`).toBe(true);
	} finally { await page.close(); }
}, 240_000);

it("TIMED: the glide lasts half a second on the frame clock, within one frame, and its offset only ever shrinks", async () => {
	// class A: MOUNTED WITH THE CANVAS ON. This arm drives its gesture through
	// router.beginPinch, the canvas-ON pinch since then; mounted canvas off it pinched nothing at all and
	// the cell failed on its own premise, with no product fault behind it.
	const { page, errors, mounted } = await open("timed", true);
	try {
		const frames = await call(page, "timedBounce", mounted.inkMiddleX, mounted.natural.textCy) as any[];
		record.push({ cell: "timed", frames });
		expect(errors).toEqual([]);
		const active = frames.filter(f => f.active), end = frames.find((f, i) => !f.active && frames.slice(0, i).some(g => g.active));

		expect(active.length, "premise: the bounce played").toBeGreaterThanOrEqual(4);
		expect(end, "premise: the bounce ended inside the reading").toBeTruthy();
		const startedAt = active[0].startedAt as number;
		// The bounce ends in the first frame whose clock reaches 500 ms past its start, so that frame is the first read at rest.
		expect(end.ts - startedAt, `it ends no earlier than ${BOUNCE_MS} ms`).toBeGreaterThanOrEqual(BOUNCE_MS);
		expect(end.ts - startedAt, `and within a frame of it`).toBeLessThanOrEqual(BOUNCE_MS + FRAME_MS);
		expect(active.at(-1).ts - startedAt, "the last gliding frame is before the end").toBeLessThan(BOUNCE_MS);
		expect(end.x, "the offset ends at exactly zero").toBe(0);
		for (let i = 1; i < active.length; i++) expect(Math.abs(active[i].x), `frame ${i + 1}: the offset toward the rest does not grow`).toBeLessThanOrEqual(Math.abs(active[i - 1].x) + 1e-9);
		for (const f of active) expect(Math.sign(f.x) === 0 || Math.sign(f.x) === Math.sign(active[0].fromX), "and never crosses the rest").toBe(true);
	} finally { await page.close(); }
}, 240_000);
