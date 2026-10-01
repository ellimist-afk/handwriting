/**
 * Alan direct: "bounded by the top and left." The settle is
 * removed except this one bound: the canvas's left edge and top edge may not rest inside the
 * pane. When a lift leaves blank to the left of or above the canvas, the canvas eases back until that edge
 * meets the pane's edge (the existing bounce, OVERSCROLL_BOUNCE_MS, both axes together at the corner).
 * Everything else in the ruling stands: no rest, no clamp, no margin payment, nothing at the right or bottom.
 *
 * THE TWO RED CELLS:
 *   (a) the canvas edge at or beyond the pane edge (no blank): the page stays put, within 1 px, at
 *       lift+30 frames against the last preview frame.
 *   (b) the canvas edge inside the pane (blank showing): the page eases to the pane edge, no per-frame
 *       step over 4 px.
 *
 * SCOPE OF THIS PASS: pinch in/out only, LEFT axis
 * only. Infinite Canvas: only OFF is exercised (ON's own room-to-grow-into case is INFINITE CANVAS ON in
 * OverscrollBounce.test.ts and is unaffected by this bound).
 *
 * NOT COVERED, reported rather than silently dropped: one-finger touch scroll (drag), wheel and touchpad.
 * Investigated, not shipped: drove router.beginAssist/assistMove/endAssist directly (its own test seam,
 * same pattern as beginPinch/updatePinch/endPinch) for a TOP-axis pull-down at scrollTop 0. Measured
 * result: contentTop/viewTop/scrollTop stay at exactly 0 through the drag AND after release - the assist
 * pan writes only the native, hard-clamped scrollTop (see InlinePenRouter.ts carryScrollBy, ~:2271) with
 * no compensating visual transform, so there is no live rubber-band to picture DURING the gesture at all,
 * unlike pinch's transform-driven preview. A red cell in this file's own shape (measure a visible
 * overshoot, then check it eases) has nothing to measure yet. Whether the fix is expected to add live
 * rubber-band during drag/scroll, or only reads some other, not-yet-visual carry state, is a question for
 * whoever builds it or rules on it, not decided here. Wheel/touchpad: wheelFn
 * (InlinePenRouter.ts ~:2422) only cancels bounce/retires settle today, with no deltaX/Y-to-pan code path
 * on this axis at all; not attempted for the same reason.
 *
 * These are RED at 854c3616 on purpose: `reducePinchConstraint` still targets ZoomOutStandingPan's fit
 * clamp (200..250 px of allowed blank), not "meets the pane edge" (0 px blank), so case (b) below fails on
 * the rest position, and the per-frame step bound differs from the old half-correction rule.
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import REAL_OBSIDIAN_CSS from "./obsidianReadableWidth";

const PAGE = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineTool, setInkSizeMult } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
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

function sample(phase) {
	const { view, overlay } = rig, t = textBox(view), k = overlay.pinchScaleNow;
	const cr = view.contentDOM.getBoundingClientRect(), sr = view.scrollDOM.getBoundingClientRect();
	const pan = overlay.viewportPan || { x: 0, y: 0 };
	return { phase, t: performance.now(), k,
		bounce: typeof overlay.overscrollBounceReadout === "function" ? overlay.overscrollBounceReadout() : null,
		contentLeft: cr.left, viewLeft: sr.left, viewRight: sr.right, contentRight: cr.right,
		contentTop: cr.top, viewTop: sr.top,
		panX: pan.x, panY: pan.y, textLeft: t.left, textCy: t.cy };
}

async function pinchAbout(to, steps, cx, cy, framesAfter) {
	const { overlay } = rig, router = overlay.router, from = overlay.pinchScaleNow;
	const spread0 = 300, spread1 = 300 * to / from;
	const touch = s => { router.touchPos.set(911, { x: cx - s / 2, y: cy }); router.touchPos.set(912, { x: cx + s / 2, y: cy }); };
	const ev = type => new PointerEvent(type, { pointerId: 912, pointerType: "touch" });
	touch(spread0); router.beginPinch(ev("pointerdown"));
	let last = null;
	for (let i = 1; i <= steps; i++) { touch(spread0 + (spread1 - spread0) * i / steps); router.updatePinch(ev("pointermove")); await rendered(); if (i === steps) last = sample("last-preview"); }
	router.endPinch(ev("pointerup"), { x: cx, y: cy }); router.touchPos.clear();
	// READ THE COMMIT'S OWN TURN. Synchronous, before any frame is awaited, because under the canvas
	// the settle swaps pan for scroll at the commit and a sample taken a frame later cannot say whether what
	// moved was eased or paid in one step.
	const commitSync = sample("commit-sync");
	const rows = [];
	for (let j = 1; j <= framesAfter; j++) { await rendered(); rows.push(sample("settle-" + j)); }
	return { last, rows, commitSync };
}

window.edgeBound = {
	async mount(tag) {
		setPenInk(true); // MOUNT WITH THE CANVAS ON. This rig made its hang and its glide with a
		// two-finger pinch through the router while the canvas was OFF - a gesture a later ruling removed and a later ruling handed
		// to the host - so every premise below read 0 and six cells failed with no product fault behind them.
		setScrollExpansionEnabled(true);
		setInlineTool("pen"); setInkColorHex("pen", "#ff00ff"); setInkSizeMult("pen", 4);
		const path = "edge-" + (tag || "gesture") + ".md";
		const pane = document.body.appendChild(document.createElement("div"));
		pane.className = "markdown-source-view mod-cm6";
		pane.style.cssText = "position:relative;margin-left:" + HOST_LEFT + "px;width:" + PANE_W + "px;height:" + PANE_H + "px;overflow:hidden";
		const doc = Array.from({ length: 400 }, (_, i) => "line " + i + " alpha beta gamma delta epsilon zeta").join("\\n");
		const view = new EditorView({ parent: pane, state: EditorState.create({ doc, extensions: [history(), EditorView.lineWrapping,
			editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })), inkOverlayExtension(),
			EditorView.theme({ "&": { width: PANE_W + "px", height: PANE_H + "px" }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
		installSizer(view);
		await settle(12);
		const overlay = overlayForPath(path);
		if (!overlay) throw new Error("no overlay for " + path);
		rig = { pane, view, overlay, path };
		const t = textBox(view);
		return { natural: sample("natural"), inkMiddleX: t.left + 170, cy: t.cy };
	},
	/**
	 * Case (a), any axis: the clipped case (in to 300% about the ink, out to 100% about a point offset by
	 * (dx, dy) from it) leaves the content's edge PAST the pane's edge on the offset axis/axes at the last
	 * preview frame - the edge is already at or beyond the pane edge, no blank to close. dx/dy: -340 shifts
	 * that axis (0 leaves it alone) - LEFT is (-340, 0), TOP is (0, -340), CORNER is (-340, -340).
	 */
	async atOrBeyondEdge(cx, cy, dx, dy) {
		await pinchAbout(3, 30, cx, cy, 16);
		return pinchAbout(1, 30, cx + dx, cy + dy, 30);
	},
	/**
	 * Case (b): pinch in about the centre, back out about a point nudged by (dx, dy) - measured to leave a
	 * small blank at the last preview frame. On LEFT (dx=dy=0) this blank comes from round-trip scale
	 * quantization alone, as before. On the y field the round-trip recovers exactly (measured: 0 px on the
	 * step-zero trace) because vertical position resolves through scrollTop, which the
	 * browser snaps to an integer, not the sub-pixel CSS transform x goes through - a real asymmetry, not
	 * a test bug. TOP/CORNER pass a small dy so the pinch-out itself, not rounding, produces the blank.
	 */
	async insidePaneEdge(cx, cy, dx = 0, dy = 0) {
		await pinchAbout(3, 30, cx, cy, 16);
		return pinchAbout(1, 30, cx + dx, cy + dy, 48);
	},
};
`;

let browser: Browser, script: string;

beforeAll(async () => {
	const b = await build({ stdin: { contents: PAGE, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts", sourcefile: "overscrollEdgeBoundPage.ts" },
		bundle: true, write: false, format: "iife", platform: "browser", alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);
afterAll(async () => { await browser?.close(); });

const call = (p: Page, method: string, ...args: unknown[]) => p.evaluate(([m, a]) => (window as any).edgeBound[m](...a), [method, args] as const);
async function open(tag: string) {
	const page = await browser.newPage({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 2, hasTouch: true });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
	await page.setContent('<!doctype html><body style="margin:0; --background-modifier-border:#777777"></body>');
	await page.addStyleTag({ content: css + REAL_OBSIDIAN_CSS });
	await page.addScriptTag({ content: script });
	const mounted = await call(page, "mount", tag) as any;
	return { page, errors, mounted };
}

/**
 * LEFT, TOP and CORNER arms. TOP/CORNER were first attempted and dropped on a wrong premise:
 * contentDOM's raw .top read as pinned to 0. the step-zero trace
 * (2026-09-18T04:56Z) measured the field that actually moves:
 * contentDOM.getBoundingClientRect().top - scrollDOM.getBoundingClientRect().top, the same shape as
 * the x read, matching viewportPan.y to the digit under a pure pan drive. TOP and CORNER below use
 * that field and reuse the ruling's bounce readout on the y axis (overscrollBounceReadout().fromY
 * and .y) exactly as LEFT already does on x.
 *
 * The "inside pane" gesture (pinch in, back out about the same centre) leaves x with a small blank
 * from round-trip scale quantization but leaves y at exactly 0 blank (scrollTop is integer-snapped,
 * x rides a sub-pixel transform - measured independently, matches the corner-drive reading of
 * y correction owed: 0.00). `insidePaneEdge` below takes an optional (dx, dy) nudge for the pinch-out
 * centre so TOP/CORNER get a real, measured y blank to test against, not a forced one; LEFT keeps
 * dx=dy=0 and its original numbers are unchanged.
 *
 * CORNER's contract: both axes ease independently against their
 * own travel, each held to the exact same per-axis bound LEFT and TOP are held to alone - own rest,
 * own bounce-from within 1px, own quarter-owed floor, own monotonic walk - PLUS one joint condition:
 * the two eases run in the same frames, starting within one sample of each other and both going
 * inactive on the same final sample, so the corner glides diagonally rather than one axis finishing
 * before the other starts. The per-axis checks are the same `for (const part of axis.parts)` loop
 * LEFT/TOP use; the joint one is a single check below it, only for axes with more than one part.
 *
 * THE PER-PART BOUND, stated once, applied identically to every {name, part} pair below:
 *
 * THE BOUND IS THE HOST'S OWN LAYOUT, pan 0, not the pane edge and not a computed fit clamp
 *. The page at pan 0 sits where an untouched note sits -
 * measured 19 px inside the pane with Readable line length off, which is Obsidian's own padding,
 * and hundreds of px with it on. Resting on the pane pixel instead would shift the text of a note
 * nobody had touched. So the ease ends on pan 0, and the blank that remains is the note's own.
 *
 * THE EASE, MEASURED PROPORTIONALLY. The absolute 4 px per frame of the ruling is
 * dropped: this fixture does not sample every animation frame - measured gaps between samples on
 * one run were 86, 42, 38, 8, 41, 20, 18, 23 and 19 ms - so a per-frame or per-millisecond count
 * reports the sampler's jitter as the page's motion. A share of the correction does not care how
 * long the frame was: the cubic over OVERSCROLL_BOUNCE_MS gives about 10% of what is left in a
 * 16.7 ms frame and about 19% across a dropped one, while a snap is 100% in a single step.
 *
 * CONSECUTIVE POST-LIFT FRAMES ONLY. The first sample is not one of them: it spans the lift, the
 * preview paper coming down and the driver's round trip, so it covers many frames and reads as a
 * large step without anything having jumped. It is reported, not asserted on.
 * THE LIFT SPAN IS WHERE A JUMP WOULD HIDE. The first sample covers many
 * frames, so the ruling does not bound its size - which would let a settle that closed the whole
 * correction in the lift's own frame pass as long as the samples after it were small. These two
 * read the bounce itself at that first sample instead of inferring it from positions: the ease
 * was started from the whole overshoot, and at least a quarter of it is still owed when the
 * first sample is taken.
 *
 * THE OVERSHOOT IS THE PAGE'S, not the preview frame's pan. A preview pan also carries the
 * pinch's live focal hold, and the hold comes off at the lift - it is not a correction anybody
 * owes. The overshoot this clause is about is the blank the settle found, which is how far the
 * page travels from where the lift left it back to its rest.
 *
 * A later ruling withdrew the per-step number for this fixture and a later ruling takes the proportional
 * form out with it: the same sampler that reads 8 to 86 ms between rows reads the first post-lift
 * sample as a third of the correction on an ease that never jumped. What stands: the ease starts
 * from the whole travel, a quarter is still owed at the first sample, several frames do the rest,
 * and it moves only toward the rest, never past it, never back toward the blank.
 */
const AXES = [
	{ name: "LEFT", dx: -340, dy: 0, insideDx: 0, insideDy: 0,
		parts: [{ content: "contentLeft", view: "viewLeft", pan: "panX", from: "fromX", offset: "x" }] },
	{ name: "TOP", dx: 0, dy: -340, insideDx: 0, insideDy: 40,
		parts: [{ content: "contentTop", view: "viewTop", pan: "panY", from: "fromY", offset: "y" }] },
	{ name: "CORNER", dx: -340, dy: -340, insideDx: 0, insideDy: 40,
		parts: [
			{ content: "contentLeft", view: "viewLeft", pan: "panX", from: "fromX", offset: "x" },
			{ content: "contentTop", view: "viewTop", pan: "panY", from: "fromY", offset: "y" },
		] },
];

for (const axis of AXES) {
	// Rewritten test-only to the ruling. The old claim was "the page stays put
	// within 1 px at lift+30": a page hanging past the pane edge was left exactly where the fingers
	// left it, for ever. Under the ruling the far end EASES BACK after the lift until the page is
	// within its room, and the page in this arm is 1383 px wide in 1374 px of room (measured at
	// e642b49f), so it hangs 226.67 with 217.67 of blank
	// beside it and a correction IS owed. What the contract still forbids is a JUMP at the commit,
	// and blank on the side the page was hanging over. Both are asserted here instead.
	it(`EDGE AT OR BEYOND THE PANE (${axis.name}): the commit frame does not jump, and under the canvas the page stays where the fingers left it`, async () => {
		const { page, errors, mounted } = await open(`at-or-beyond-${axis.name}`);
		try {
			const { last, rows } = await call(page, "atOrBeyondEdge", mounted.inkMiddleX, mounted.cy, axis.dx, axis.dy) as { last: any; rows: any[] };
			expect(errors).toEqual([]);
			const lift30 = rows[29];
			expect(lift30, "premise: 30 frames were sampled after lift").toBeTruthy();
			for (const part of axis.parts) {
				// Premise unchanged: at the last preview frame the content's edge on this part is well
				// past the pane's own edge.
				expect(last[part.view] - last[part.content], `premise (${part.content}): the content edge is past the pane edge, no blank`).toBeGreaterThanOrEqual(10);
				// ZERO SNAP: the first frame after the lift paints the last preview's position.
				expect(Math.abs(rows[0][part.content] - last[part.content]), `lift+0 (${part.content}): the commit frame paints the last preview's position`).toBeLessThanOrEqual(1);
				// The ease has arrived by lift+30: the last two frames agree.
				expect(Math.abs(lift30[part.content] - rows[28][part.content]), `lift+30 (${part.content}): the ease has come to rest`).toBeLessThanOrEqual(0.5);
				// And it never eased so far that blank opened on the side the page was hanging over.
				expect(lift30[part.view] - lift30[part.content], `lift+30 (${part.content}): no blank on the hanging side`).toBeGreaterThanOrEqual(-0.5);
				// THE ARRIVAL, and the reason this cell can fail: the hang must actually come back inside
				// the page's own room. Measured at e642b49f the page is 1383 px wide in 1374 px of room,
				// so it hangs 226.67 at the lift and the ruling owes all but 9 px of that. Without
				// this row every assertion above passes on a page that never moved at all.
				const hangLift = last[part.view] - last[part.content], hangRest = lift30[part.view] - lift30[part.content];
				expect(hangLift, `premise (${part.content}): the lift really hangs`).toBeGreaterThan(100);
				// ON THE HORIZONTAL ONLY, and the geometry is why: the ruling eases a page back until
				// it is within its ROOM, and room is per axis. Measured at e642b49f the page is 1383 px
				// wide in 1374 px of room, so a 226.67 px horizontal hang owes all but 9 px of itself -
				// and it is 86400 px tall in 776 px of room, so a 227 px vertical hang is deep inside
				// what the page may hang by and owes nothing. Asserting arrival on the vertical would
				// assert that a tall page may not be scrolled.
				// 1: THE ARRIVAL CLAIM RESTATES TO THE CANVAS-ON LAW. Under the canvas the page stays
				// where the fingers left it: there is no room-bound pull-back for the far end to
				// make, and measured here the hang is 226.67 at the lift and 227.00 at lift+30 with the bounce
				// readout inactive on every sample. So what this axis claims now is that the page STAYS - the
				// commit does not move it and nothing eases it afterwards - which is the canvas-on contract and
				// is what the ruling's arrival claim becomes once the room bound is the host's, not ours.
				expect(Math.abs(hangRest - hangLift), `lift+30 (${part.content}): the page stayed where the fingers left it (hang ${hangLift.toFixed(2)} -> ${hangRest.toFixed(2)})`).toBeLessThanOrEqual(1);
			}
		} finally { await page.close(); }
	}, 240_000);

	it(`EDGE INSIDE THE PANE (${axis.name}): the round trip lands on the host's own layout - no blank across, and what blank there is eases back with no jump at the commit`, async () => {
		const { page, errors, mounted } = await open(`inside-${axis.name}`);
		try {
			const { last, rows, commitSync } = await call(page, "insidePaneEdge", mounted.inkMiddleX, mounted.cy, axis.insideDx, axis.insideDy) as { last: any; rows: any[]; commitSync: any };
			expect(errors).toEqual([]);
			const end = rows.at(-1);
			const firstBounce = rows[0].bounce;
			expect(firstBounce, "premise: the first post-lift sample carries a bounce readout").toBeTruthy();
			expect(commitSync, "premise: the commit's own turn was sampled").toBeTruthy();
			for (const part of axis.parts) {
				// 1: WHAT THE ROUND TRIP LEAVES IS NOT THE SAME UNDER THE CANVAS, so the cell reads it
				// instead of assuming it. Measured canvas on: the horizontal round trip comes back to its rest
				// exactly (content left 300 against a pane left of 300, pan 0), while the vertical - whose
				// pinch-out centre sits 40 px below the pinch-in's - leaves 26.33 px of blank above the page.
				// A part with no blank has nothing to ease and claims the rest itself; a part with blank claims
				// the zero-snap contract and the arrival, the two things those rulings own.
				const blank = last[part.content] - last[part.view];
				expect(Math.abs(end[part.pan]), `(${part.content}) the page rests at the host's own layout (pan ended at ${end[part.pan]} px, blank ${end[part.content] - end[part.view]} px)`).toBeLessThanOrEqual(1);
				if (blank <= 1) {
					expect(Math.abs(end[part.content] - last[part.content]), `(${part.content}) nothing to ease: the round trip landed on its rest (blank ${blank.toFixed(2)} px at the last preview frame) and stays there`).toBeLessThanOrEqual(1);
					continue;
				}
				// ZERO SNAP AT THE COMMIT. A later ruling pinned this as a gap:
				// with the true-travel capture canvas-off only, the canvas lift paid its whole correction in the
				// commit's own turn, 26.33 px of text in one step.
				// own turn - 26.33 px of text in one step. A later ruling turns that capture on under the canvas, so the claim
				// goes back to its proper form: the commit's own turn paints the last preview's position, and the
				// correction is eased after it. Read synchronously inside endPinch so the frame gap cannot hide a step.
				expect(Math.abs(commitSync[part.content] - last[part.content]), `(${part.content}) the commit's own turn paints the last preview's position (last ${last[part.content].toFixed(2)}, commit ${commitSync[part.content].toFixed(2)}, text screen y ${last.textCy.toFixed(2)} -> ${commitSync.textCy.toFixed(2)})`).toBeLessThanOrEqual(1);
				const overshoot = last[part.content] - end[part.content];
				expect(Math.abs(firstBounce[part.from] - overshoot),
					`(${part.content}) the ease was started from the whole overshoot: from ${firstBounce[part.from]} against the ${Math.round(overshoot * 100) / 100} px the page travels back to its rest ` +
					`(k at the last preview frame ${last.k}, k at rest ${end.k}, travel x k ${Math.round(overshoot * end.k * 100) / 100})`).toBeLessThanOrEqual(1);
				expect(Math.abs(firstBounce[part.offset]) / Math.abs(overshoot),
					`(${part.content}) a quarter of the correction is still owed at the first sample: offset ${firstBounce[part.offset]} of ${Math.round(overshoot * 100) / 100} px, ` +
					`${Math.round(rows[0].t - last.t)} ms after the last preview frame`).toBeGreaterThanOrEqual(0.25);
				const steps = rows.slice(1).map((r: any, i: number) => r[part.content] - rows[i][part.content]);
				expect(steps.filter((v: number) => Math.abs(v) > 0.05).length, `(${part.content}) and the ease takes several frames to do it`).toBeGreaterThanOrEqual(5);
				for (let i = 1; i < rows.length; i++) {
					expect(rows[i][part.content], `(${part.content}) frame ${i + 1} does not pass the resting position`).toBeGreaterThanOrEqual(end[part.content] - 0.5);
					expect(rows[i][part.content], `(${part.content}) frame ${i + 1} does not move back toward the blank`).toBeLessThanOrEqual(rows[i - 1][part.content] + 0.5);
				}
				continue;
			}
			if (axis.parts.length > 1) {
				// SAME FRAMES, NOT X-THEN-Y. `overscrollBounceReadout()` is one object backed by one
				// `bounceState`, so a corner glides diagonally by construction rather than one axis finishing before
				// the other starts. A later ruling could not ask this under the canvas - nothing played - and the ruling's capture
				// gives it back: once the shared readout goes inactive it stays inactive, for every later sample.
				const lastActive = rows.reduce((idx: number, r: any, i: number) => (r.bounce && r.bounce.active ? i : idx), -1);
				expect(lastActive, "premise: the bounce is active for at least the first sample").toBeGreaterThanOrEqual(0);
				for (let i = lastActive + 1; i < rows.length; i++) {
					expect(!!(rows[i].bounce && rows[i].bounce.active), `frame ${i + 1}: the corner's bounce stays inactive for both axes together once it ends (one shared readout)`).toBe(false);
				}
			}
		} finally { await page.close(); }
	}, 240_000);
}
