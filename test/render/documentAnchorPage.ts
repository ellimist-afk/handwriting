/**
 * The document anchor ladder's surface checks, in a real browser.
 *
 * WHY THIS IS ITS OWN PAGE. The question is not what the camera computes - the
 * unit tests own the algebra - but what the ANCHOR DOES TO THE SURFACE: whether
 * anything is written inside `contentDOM` while the reader scrolls, whether the
 * widget's install can move `scrollTop`, and whether the ladder adds scroll
 * range. None of that is visible without a real CodeMirror, a real scroller and
 * a real MutationObserver, and all of it has already gone wrong once: a probe
 * that wrote `style.top` collapsed scrollTop from 114820 to 9630, twice,
 * independently (the first attempt, and a second, independent replication).
 *
 * `scrollColumnAnchorPage.ts` is the fixture for the camera's NUMBERS and is
 * owned by other work right now. This page is deliberately small and asks
 * only the anchor's surface questions.
 */

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { surfaceExtents } from "../../src/inline/SurfaceExtent";
import { setPenInk } from "../../src/inline/PenInk";
import { anchorRefusals, documentAnchorLadder, impliedDocumentTop, ladderShape, refuseDocumentAnchor, rungIndexFor, RUNG_SPACING } from "../../src/inline/DocumentAnchor";
import { anchorPaddingTop, anchorTop } from "../../src/inline/DocumentTop";
import { editorInfoField } from "./iphoneObsidianStub";
import { installObsidianDom } from "./obsidianDom";

// The overlay builds its band with Obsidian's own DOM helpers (`createDiv`,
// `setCssStyles`), so without these the attach throws and no overlay exists.
installObsidianDom();

const PANE_W = 900, PANE_H = 700, HOST_LEFT = 300;

const settle = async (frames: number): Promise<void> => {
	for (let i = 0; i < frames; i++) await new Promise(r => requestAnimationFrame(() => r(null)));
};

/**
 * THE PLANTS, reshaped for the variant. The anchor is no longer a CodeMirror
 * decoration, so a widget's `estimatedHeight` is not a thing that exists; what
 * CAN still go wrong is the wrapper taking height (which would move everything
 * below it, including a restored scroll) or losing its clip (which would let
 * the rungs extend the scroller's range).
 *
 * "height" inserts a SECOND wrapper of the anchor's exact shape but 1 px tall,
 * as the first child of the same container and at the same moment - so the
 * plant differs from the shipped anchor in height and in nothing else.
 */
function plantHeight(view: EditorView, px: number): HTMLElement | null {
	const host = view.contentDOM.parentElement;
	if (!host || host === view.scrollDOM) return null;
	const el = document.createElement("div");
	// Its OWN class: mount clears any `.handwriting-document-anchor` sibling it
	// does not know about, so a plant wearing the shipped class would be removed
	// at the very moment it is supposed to be measured.
	el.className = "handwriting-document-anchor-plant plant-height";
	el.style.cssText = `position:relative;width:0;height:${px}px;overflow:hidden;pointer-events:none`;
	host.insertBefore(el, host.firstChild);
	return el;
}

async function mount(tag: string, plant?: "height" | "heightBig", startScrollTop = 0, bare = false) {
	setPenInk(true);
	setScrollExpansionEnabled(true);
	const path = `document-anchor-${tag}.md`;
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6 is-readable-line-width";
	// Offset from the viewport, for the same reason the sibling fixture is: a
	// host at x = 0 cancels terms that a real pane does not.
	pane.style.cssText = `position:relative;margin-left:${HOST_LEFT}px;width:${PANE_W}px;height:${PANE_H}px;overflow:hidden`;
	const doc = Array.from({ length: 400 }, (_, i) => `line ${i} alpha beta gamma delta epsilon zeta`).join("\n");
	const overlayCompartment = new Compartment();
	const view = new EditorView({
		parent: pane,
		state: EditorState.create({
			doc,
			extensions: [
				history(), EditorView.lineWrapping,
				editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} })),
				// `bare` is the CONTROL for the install check: no ink overlay and therefore no
				// anchor widget, so what CodeMirror does to a restored scroll on its
				// own can be measured and subtracted.
				bare ? [] : overlayCompartment.of(inkOverlayExtension() as never),
				EditorView.theme({
					"&": { width: `${PANE_W}px`, height: `${PANE_H}px` },
					".cm-scroller": { overflowY: "auto", overflowX: "hidden" },
					".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" },
				}),
			],
		}),
	});
	// `.cm-sizer` / `.cm-contentContainer`, which Obsidian puts around the
	// content and the plugin's geometry reads through.
	const sizer = document.createElement("div");
	sizer.className = "cm-sizer";
	const container = document.createElement("div");
	container.className = "cm-contentContainer";
	view.contentDOM.parentElement!.insertBefore(sizer, view.contentDOM);
	sizer.appendChild(container);
	container.appendChild(view.contentDOM);
	void view.scrollDOM.clientWidth;
	// The plant goes in BEFORE the scroll is restored, which is the moment it
	// could move anything.
	if (plant) plantHeight(view, plant === "heightBig" ? 200 : 1);
	// THE REOPEN PATH: the scroll is restored BEFORE CodeMirror's first measure
	// cycle, which is the moment a widget with an unknown height can move it.
	if (startScrollTop) view.scrollDOM.scrollTop = startScrollTop;
	await settle(12);
	const overlay = bare ? null : (overlayForPath(path) as any);
	if (!bare && !overlay) throw new Error("no overlay for " + path);
	return { pane, view, overlay, path, overlayCompartment };
}

/** Grow the surface the way drawing far out does, then let the plugin apply it. */
async function growSurface(rig: { overlay: any; path: string }, y: number): Promise<void> {
	surfaceExtents.grow(rig.path, { x: 4000, y });
	rig.overlay.updateExtent(true);
	await settle(8);
}

/** Every mutation observed anywhere inside `.cm-content`, which is the thing
 * the design forbids on the scroll path. Observes the whole subtree: attributes
 * (a `style.top` write) and childList alike. */
function watchContent(view: EditorView) {
	const records: { type: string; target: string; attr: string | null }[] = [];
	const observer = new MutationObserver(list => {
		for (const m of list) {
			const el = m.target instanceof Element ? m.target : (m.target.parentElement as Element | null);
			records.push({ type: m.type, target: el ? el.className || el.nodeName : "?", attr: m.attributeName });
		}
	});
	observer.observe(view.contentDOM, { attributes: true, childList: true, subtree: true, characterData: true });
	return { records, stop: () => { observer.takeRecords(); observer.disconnect(); } };
}

/**
 * Scroll check: scroll across several rung boundaries and watch three things - what was
 * written inside `contentDOM` (must be nothing), whether the camera stayed
 * continuous, and whether a rung switch caused a full redraw.
 *
 * `plantStyleWrites` reinstates the ruled-out mechanism: a `style.top` write on
 * a rung per frame. The mutation count must go nonzero, which is what proves
 * the observer is watching the thing that would have failed.
 */
async function runScroll(opts: boolean | { plant?: boolean; surface?: number; noAnchor?: boolean }) {
	const plantStyleWrites = typeof opts === 'boolean' ? opts : !!opts.plant;
	const surface = typeof opts === 'boolean' ? 60000 : (opts.surface ?? 60000);
	const noAnchor = typeof opts === 'boolean' ? false : !!opts.noAnchor;
	const rig = await mount(`scroll-${plantStyleWrites}-${surface}-${noAnchor}`);
	// The anchor-absent arm uses the SHIPPED refusal path, not a test seam:
	// `refuseDocumentAnchor` is what the parity gate calls, and it is the only
	// thing that keeps the anchor down for the view's lifetime. Removing the
	// wrapper by hand would not - the next `updateExtent` re-mounts it, which is
	// exactly how an earlier control here was silently invalidated.
	if (noAnchor) refuseDocumentAnchor(rig.view, { implied: 0, shipped: 0, bar: 0, reason: "cost-control" });
	const { view, overlay } = rig;
	await growSurface(rig, surface);
	const scroller = view.scrollDOM;
	scroller.scrollTop = 20000;
	await settle(8);

	const proto = Object.getPrototypeOf(overlay);
	const realRepaint = proto.repaint, realSyncBand = proto.syncBand, realSync = proto.syncCamera;
	let repaints = 0, bandMoves = 0;
	// TASK 2: what the ladder costs per frame. `syncCamera` is timed
	// end to end and every forced layout is counted, because 34 zero-size
	// clipped absolutely positioned boxes SHOULD cost nothing - so a difference
	// here is a latency finding that blocks landing, not a footnote.
	let syncMs = 0, syncs = 0, rectReads = 0;
	const realRect = Element.prototype.getBoundingClientRect;
	(Element.prototype as { getBoundingClientRect: unknown }).getBoundingClientRect = function countedRect(this: Element) { rectReads++; return realRect.call(this); };
	proto.syncCamera = function timedSync(this: unknown, ...a: unknown[]) {
		const t0 = performance.now();
		try { return realSync.apply(this, a); } finally { syncMs += performance.now() - t0; syncs++; }
	};
	proto.syncBand = function patched(this: unknown, ...a: unknown[]) {
		const out = realSyncBand.apply(this, a);
		if (String(out) !== "none") bandMoves++;
		return out;
	};
	proto.repaint = function patched(this: unknown, ...a: unknown[]) { repaints++; return realRepaint.apply(this, a); };

	let plantProbe: HTMLElement | null = null;
	const watch = watchContent(view);
	const steps: { scrollTop: number; camY: number; rung: number; ladderLen: number; docTop: number; repaints: number }[] = [];
	const spacing = documentAnchorLadder(view)?.spacing ?? RUNG_SPACING;
	const sample = () => {
		const layout = overlay.anchorCameraYLayout as number;
		steps.push({
			scrollTop: scroller.scrollTop, camY: overlay.camera.snapshot.y,
			rung: Number.isFinite(layout) ? Math.round(layout / spacing) : -1,
			ladderLen: documentAnchorLadder(view)?.rungs.length ?? 0,
			docTop: overlay.lastSyncDocumentTop,
			repaints,
		});
	};
	sample();
	// 12 steps of 700 layout px covers 8400 px, four rung boundaries at 2048.
	for (let i = 0; i < 12; i++) {
		scroller.scrollTop += 700;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(2);
		if (plantStyleWrites) {
			// THE RULED-OUT MECHANISM, reinstated WHERE IT USED TO LIVE. The
			// variant's rungs are outside `contentDOM`, so moving one of them
			// would prove nothing about an observer watching `contentDOM` - a
			// zero there would be the zero of watching an empty room. The plant
			// is therefore a probe inside `contentDOM` written on every frame,
			// which is exactly what the first construction did.
			if (!plantProbe) {
				plantProbe = document.createElement("div");
				(plantProbe as any).cmIgnore = true;
				plantProbe.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none";
				view.contentDOM.appendChild(plantProbe);
			}
			plantProbe.style.top = `${i}px`;
			await settle(1);
		}
		sample();
	}
	watch.stop();
	proto.repaint = realRepaint; proto.syncBand = realSyncBand; proto.syncCamera = realSync;
	(Element.prototype as { getBoundingClientRect: unknown }).getBoundingClientRect = realRect;

	// The camera must have tracked the scroll exactly: each step moved the
	// surface by a known number of layout px at scale 1, so the camera's own
	// move is that number and anything else is a jump.
	const jumps: { i: number; expected: number; actual: number; error: number }[] = [];
	for (let i = 1; i < steps.length; i++) {
		const a = steps[i - 1]!, b = steps[i]!;
		const expected = (b.scrollTop - a.scrollTop) * overlay.cssScale / (overlay.cssScale * overlay.fontZoom);
		const actual = b.camY - a.camY;
		jumps.push({ i, expected, actual, error: Math.abs(actual - expected) });
	}
	// PER STEP, AND SPLIT BY WHETHER THE RUNG CHANGED. "Zero redraws
	// attributable to a switch" is only meaningful against what a step that did
	// NOT switch cost, so both are reported and the test compares them.
	const perStep = steps.slice(1).map((s, i) => ({
		switched: s.rung !== steps[i]!.rung, repaints: s.repaints - steps[i]!.repaints,
	}));
	const onSwitch = perStep.filter(x => x.switched).map(x => x.repaints);
	const onHold = perStep.filter(x => !x.switched).map(x => x.repaints);
	const switches = onSwitch.length;
	const result = {
		plantStyleWrites, surface, noAnchor, steps, switches, repaints, bandMoves,
		syncs, syncMs, msPerSync: syncs ? syncMs / syncs : -1, rectReads, rectReadsPerSync: syncs ? rectReads / syncs : -1,
		repaintsOnSwitchSteps: onSwitch, repaintsOnHoldSteps: onHold,
		maxRepaintsOnSwitch: onSwitch.length ? Math.max(...onSwitch) : -1,
		maxRepaintsOnHold: onHold.length ? Math.max(...onHold) : -1,
		contentMutations: watch.records.length,
		mutationSample: watch.records.slice(0, 6),
		maxCameraError: jumps.length ? Math.max(...jumps.map(j => j.error)) : -1,
		worstJump: jumps.slice().sort((x, y) => y.error - x.error)[0] ?? null,
		cssScale: overlay.cssScale, fontZoom: overlay.fontZoom,
		scrollTopStart: steps[0]!.scrollTop, scrollTopEnd: steps.at(-1)!.scrollTop,
		ladderLen: documentAnchorLadder(view)?.rungs.length ?? 0, spacing,
	};
	view.destroy(); rig.pane.remove();
	return result;
}

/**
 * Install check: the reopen path. The scroll is restored far down before CodeMirror's
 * first measure; the widget must not let anything move it.
 */
async function runInstall(mode: "shipped" | "control" | "plant" | "plantBig" = "shipped") {
	const target = 9000;
	// CodeMirror clamps a scroll restored before its first measure to whatever
	// scrollHeight it has rendered by then - that happens with or without any
	// widget, so the CONTROL is what "unchanged" means here, not the target.
	const rig = await mount(`install-${mode}`, mode === "plant" ? "height" : mode === "plantBig" ? "heightBig" : undefined, target, mode === "control");
	const { view } = rig;
	const scroller = view.scrollDOM;
	const afterMount = scroller.scrollTop;
	// A second measure cycle, explicitly, because the first one is the one the
	// height map changes under.
	view.requestMeasure();
	await settle(10);
	const afterMeasure = scroller.scrollTop;
	const held = documentAnchorLadder(view);
	const result = {
		mode, target, afterMount, afterMeasure,
		movedOnMount: Math.abs(afterMount - target), movedOnMeasure: Math.abs(afterMeasure - afterMount),
		scrollHeight: scroller.scrollHeight, docLength: view.state.doc.length,
		ladderLen: held?.rungs.length ?? 0,
		wrapperHeight: held ? held.wrapper.getBoundingClientRect().height : null,
		wrapperOverflow: held ? getComputedStyle(held.wrapper).overflow : null,
	};
	view.destroy(); rig.pane.remove();
	return result;
}

/**
 * Growth check: growing the extent appends rungs. The surface must not move, and the
 * ladder must add no scroll range of its own - which is what `overflow: hidden`
 * on the wrapper is for. The plant drops that rule.
 */
async function runExtent(plant?: "noOverflowHidden") {
	const rig = await mount(`extent-${plant ?? "shipped"}`);
	// The plant is applied to the REAL wrapper, which is the plugin's own now.
	if (plant === "noOverflowHidden") documentAnchorLadder(rig.view)!.wrapper.style.overflow = "visible";
	const { view, overlay } = rig;
	const scroller = view.scrollDOM;
	await growSurface(rig, 8000);
	scroller.scrollTop = 5000;
	await settle(6);
	const before = {
		scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
		ladderLen: documentAnchorLadder(view)?.rungs.length ?? 0, camY: overlay.camera.snapshot.y,
		spacerTop: overlay.spacerTop,
	};
	// The frontier moves out, exactly as drawing far out moves it.
	await growSurface(rig, 60000);
	await settle(6);
	const after = {
		scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
		ladderLen: documentAnchorLadder(view)?.rungs.length ?? 0, camY: overlay.camera.snapshot.y,
		spacerTop: overlay.spacerTop,
	};
	// The scroll range the SPACER alone asks for. The ladder must not exceed it.
	const spacerDemand = overlay.spacerTop + 1;
	const plantWrapper = plant ? documentAnchorLadder(view)!.wrapper : null;
	const result = {
		plant: plant ?? null, before, after,
		appended: after.ladderLen - before.ladderLen,
		scrollMoved: Math.abs(after.scrollTop - before.scrollTop),
		cameraMoved: Math.abs(after.camY - before.camY),
		spacerDemand, scrollHeightOverSpacer: after.scrollHeight - spacerDemand,
		plantRungs: plantWrapper ? plantWrapper.childElementCount : 0,
		wrapperInContent: view.contentDOM.contains(documentAnchorLadder(view)?.wrapper ?? null),
		wrapperParent: documentAnchorLadder(view)?.wrapper.parentElement?.className ?? null,
		plantOverflow: plantWrapper ? getComputedStyle(plantWrapper).overflow : null,
		shippedLadderRungs: documentAnchorLadder(view)?.rungs.length ?? 0,
	};
	view.destroy(); rig.pane.remove();
	return result;
}

/**
 * Parity check: the document top the ladder IMPLIES against `anchorTop`,
 * the formula it replaces.
 *
 * THE BAR IS NOT A FLAT 2.5e-5 AND CANNOT BE. `anchorTop` reads the
 * `.cm-content` rect, which is the noisy operand E exists to remove, so at any
 * distance the two must differ by that rect's own rounding. The design sets the
 * bar at `2.5e-5 + 2 x ulp32(|contentDOM rect top|) + ulp32(T) x cssScale`, and
 * this computes it from the numbers the arm actually read rather than quoting
 * the ruling's worked example.
 *
 * THE PLANT is the ruling's: the rung's offset off by one integer layout px.
 * That is an error of 1 x cssScale, which must exceed the bar by a wide margin
 * - otherwise the bar is loose enough to hide a real mistake.
 */
async function runParity(scrollTop: number) {
	const rig = await mount(`parity-${scrollTop}`);
	const { view, overlay } = rig;
	await growSurface(rig, 60000);
	view.scrollDOM.scrollTop = scrollTop;
	await settle(8);
	const ulp32 = (x: number) => { const a = Math.abs(x); return a > 0 ? 2 ** (Math.floor(Math.log2(a)) - 23) : 0; };
	const samples: { implied: number; shipped: number; error: number; plantError: number; bar: number; contentTop: number; rung: number; rungTop: number }[] = [];
	for (let i = 0; i < 6; i++) {
		view.scrollDOM.scrollTop += 137;
		view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
		await settle(2);
		const held = documentAnchorLadder(view);
		if (!held) break;
		const k = rungIndexFor(overlay.anchorCameraYLayout, held.spacing, held.rungs.length);
		const rungTop = k * held.spacing;
		const rungRectTop = held.rungs[k]!.getBoundingClientRect().top;
		const cssScale = overlay.cssScale as number;
		const pad = anchorPaddingTop(view as never, getComputedStyle(view.contentDOM).paddingTop, cssScale) ?? 0;
		const implied = impliedDocumentTop(rungTop, rungRectTop, cssScale, pad);
		// THE PLANT, computed beside the real one in the same layout: the rung's
		// offset off by one integer layout px.
		const plant = impliedDocumentTop(rungTop + 1, rungRectTop, cssScale, pad);
		const shipped = anchorTop(view as never, getComputedStyle(view.contentDOM).paddingTop, cssScale);
		const contentTop = view.contentDOM.getBoundingClientRect().top;
		samples.push({
			implied, shipped, error: Math.abs(implied - shipped), plantError: Math.abs(plant - shipped),
			bar: 2.5e-5 + 2 * ulp32(contentTop) + ulp32(rungTop) * cssScale,
			contentTop, rung: k, rungTop,
		});
	}
	const result = {
		scrollTop, samples, cssScale: overlay.cssScale,
		maxError: samples.length ? Math.max(...samples.map(x => x.error)) : -1,
		minPlantError: samples.length ? Math.min(...samples.map(x => x.plantError)) : -1,
		bar: samples.length ? Math.max(...samples.map(x => x.bar)) : -1,
		ladderLen: documentAnchorLadder(view)?.rungs.length ?? 0,
	};
	view.destroy(); rig.pane.remove();
	return result;
}

/**
 * Reflow check: reflow above `contentDOM`'s parent must move the anchor and the
 * content TOGETHER, so the camera sees it and adopts it.
 *
 * This is the plant that caught the first construction of all: a probe anchored
 * to the SCROLLER read 0.000 here while a document-anchored one moved by
 * 1 x cssScale. The wrapper is a sibling of `.cm-content` inside the container,
 * and the growth is applied above the container, so both move.
 */
async function runReflow() {
	const rig = await mount("reflow");
	const { view, overlay } = rig;
	await growSurface(rig, 60000);
	view.scrollDOM.scrollTop = 20000;
	await settle(8);
	const sizer = view.contentDOM.parentElement!.parentElement as HTMLElement;
	const held = documentAnchorLadder(view)!;
	const rd = () => {
		const k = rungIndexFor(overlay.anchorCameraYLayout, held.spacing, held.rungs.length);
		return { rung: held.rungs[k]!.getBoundingClientRect().top, content: view.contentDOM.getBoundingClientRect().top,
			docTop: overlay.lastSyncDocumentTop, scrollTop: view.scrollDOM.scrollTop, k };
	};
	const prior = sizer.style.marginTop;
	const at0 = rd();
	sizer.style.marginTop = "1px";
	view.requestMeasure();
	await settle(8);
	overlay.scheduleRepaint("scroll"); await settle(2);
	const at1 = rd();
	sizer.style.marginTop = prior;
	view.requestMeasure();
	await settle(8);
	overlay.scheduleRepaint("scroll"); await settle(2);
	const back = rd();
	const fix = (a: { scrollTop: number }, b: { scrollTop: number }, av: number, bv: number) =>
		av - bv + (a.scrollTop - b.scrollTop) * overlay.cssScale;
	const result = {
		at0, at1, back, cssScale: overlay.cssScale, expected: overlay.cssScale,
		rungMoved: fix(at1, at0, at1.rung, at0.rung),
		contentMoved: fix(at1, at0, at1.content, at0.content),
		docTopMoved: fix(at1, at0, at1.docTop, at0.docTop),
		rungRestored: Math.abs(fix(back, at0, back.rung, at0.rung)),
		live: { isConnected: held.wrapper.isConnected, nextIsContent: held.wrapper.nextSibling === view.contentDOM,
			sameParent: held.wrapper.parentNode === view.contentDOM.parentNode },
	};
	view.destroy(); rig.pane.remove();
	return result;
}

/**
 * TEARDOWN. The anchor sits in the editor's DOM, which outlives the overlay, so
 * removing the overlay must remove the anchor, and mounting again must leave
 * exactly one. "staleBeforeRemount" plants a wrapper a previous plugin load
 * left behind and expects the next mount to clear it. "staleAfterRemount"
 * plants one the mount cannot have seen, to show the count can read 2.
 */
async function runTeardown(plant?: "staleBeforeRemount" | "staleAfterRemount") {
	const rig = await mount(`teardown-${plant ?? "shipped"}`);
	const { view } = rig;
	const host = view.contentDOM.parentElement!;
	const count = () => host.querySelectorAll(":scope > .handwriting-document-anchor").length;
	const staleWrapper = () => {
		const stale = document.createElement("div");
		stale.className = "handwriting-document-anchor";
		stale.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
		host.insertBefore(stale, view.contentDOM);
	};
	await growSurface(rig, 8000);
	await settle(4);
	const mounted = count();
	view.dispatch({ effects: rig.overlayCompartment.reconfigure([]) });
	await settle(6);
	const afterTeardown = count();
	const liveAfterTeardown = !!documentAnchorLadder(view);
	if (plant === "staleBeforeRemount") staleWrapper();
	view.dispatch({ effects: rig.overlayCompartment.reconfigure(inkOverlayExtension() as never) });
	await settle(12);
	const remounted = overlayForPath(rig.path) as any;
	if (remounted) await growSurface({ ...rig, overlay: remounted }, 8000);
	await settle(4);
	if (plant === "staleAfterRemount") staleWrapper();
	const afterRemount = count();
	const result = { plant: plant ?? null, mounted, afterTeardown, liveAfterTeardown, afterRemount, remountedOverlay: !!remounted,
		liveAfterRemount: !!documentAnchorLadder(view) };
	view.destroy(); rig.pane.remove();
	return result;
}

(window as unknown as Record<string, unknown>).documentAnchor = { runScroll, runInstall, runExtent, runParity, runReflow, runTeardown, inlineInk };

/**
 * The three arms that make the placement fixes measured rather than
 * argued.
 *
 * Block above: something ABOVE `.cm-content` in the flow, so the static position and
 *       the scroller's own origin no longer coincide. Parity must be exactly 0
 *       with auto offsets and NONZERO with `top: 0` - the half the reflow plant
 *       could not reach, because in a fixture with nothing above the content
 *       those two positions are the same point.
 * Centred container: a flex ROW with `align-items: center`. The wrapper's `align-self: flex-start`
 *       pins the cross axis, parity is 0, and the ladder is USED.
 * Unpinnable: something the wrapper's align-self CANNOT pin - `align-self: center !important` on the
 *       wrapper itself. The gate must refuse: no ladder, the camera back on
 *       `anchorTop`, a refusal recorded, and the document top the camera used
 *       exactly equal to the shipped formula.
 */
async function runE2(mode: "above" | "aboveTop0" | "center" | "unpinnable") {
	if (mode === "unpinnable") {
		const style = document.createElement("style");
		// !important so the wrapper's inline `align-self` cannot win: this is the case
		// the gate exists for, not one the style fix can absorb.
		style.textContent = ".handwriting-document-anchor{align-self:center !important}";
		document.head.appendChild(style);
	}
	const before = { count: anchorRefusals.count };
	const rig = await mount(`e2-${mode}`);
	const { view, overlay } = rig;
	const container = view.contentDOM.parentElement as HTMLElement;
	if (mode === "center" || mode === "unpinnable") {
		container.style.display = "flex";
		container.style.flexDirection = mode === "unpinnable" ? "column" : "row";
		container.style.alignItems = "center";
		container.style.justifyContent = mode === "unpinnable" ? "center" : "flex-start";
	}
	if (mode === "above" || mode === "aboveTop0") {
		// Obsidian's inline title and properties block live here, above the
		// content's own parent; this stands in for them.
		const title = document.createElement("div");
		title.className = "inline-title-stand-in";
		title.style.cssText = "height:37px;margin:0;padding:0";
		container.parentElement!.insertBefore(title, container);
	}
	await growSurface(rig, 60000);
	view.scrollDOM.scrollTop = 20000;
	await settle(8);
	const held0 = documentAnchorLadder(view);
	// The `top: 0` half of the block-above arm, applied from the test rather than by a
	// production switch: it is the same element, moved to the position the design
	// rejected.
	if (mode === "aboveTop0" && held0) { held0.wrapper.style.top = "0px"; await settle(6); }
	view.scrollDOM.scrollTop += 137;
	view.scrollDOM.dispatchEvent(new Event("scroll", { bubbles: true }));
	await settle(6);

	const held = documentAnchorLadder(view);
	const cssScale = overlay.cssScale as number;
	const shipped = anchorTop(view as never, getComputedStyle(view.contentDOM).paddingTop, cssScale);
	let implied = Number.NaN, rung = -1;
	if (held) {
		rung = rungIndexFor(overlay.anchorCameraYLayout, held.spacing, held.rungs.length);
		const pad = anchorPaddingTop(view as never, getComputedStyle(view.contentDOM).paddingTop, cssScale) ?? 0;
		implied = impliedDocumentTop(rung * held.spacing, held.rungs[rung]!.getBoundingClientRect().top, cssScale, pad);
	}
	const result = {
		mode, ladderUsed: !!held, rungs: held?.rungs.length ?? 0, rung,
		implied, shipped, parity: held ? Math.abs(implied - shipped) : null,
		// With the ladder refused the camera IS the shipped formula, so this is
		// an exact equality and not a tolerance.
		cameraDocTop: overlay.lastSyncDocumentTop + overlay.panY(),
		cameraEqualsShipped: Math.abs((overlay.lastSyncDocumentTop + overlay.panY()) - shipped) === 0,
		refusalsAdded: anchorRefusals.count - before.count,
		refusal: anchorRefusals.last,
		containerDisplay: getComputedStyle(container).display,
		containerFlexDirection: getComputedStyle(container).flexDirection,
		containerAlignItems: getComputedStyle(container).alignItems,
		wrapperAlignSelf: held ? getComputedStyle(held.wrapper).alignSelf : null,
		contentTop: view.contentDOM.getBoundingClientRect().top,
		cssScale,
	};
	view.destroy(); rig.pane.remove();
	if (mode === "unpinnable") document.head.querySelectorAll("style").forEach(el => { if (el.textContent?.includes("handwriting-document-anchor")) el.remove(); });
	return result;
}

(window as unknown as Record<string, unknown>).documentAnchorE2 = { runE2 };
