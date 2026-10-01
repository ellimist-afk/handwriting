/**
 * Line 6: the page side of ZoomGive.test.ts. Mounts through scrollColumnAnchorPage's
 * tear rig (the plain note, real router) and drives the REAL router - beginPinch / updatePinch /
 * endPinch with two touch contacts - past the cap, then reads the overlay's scale of record on the
 * frame clock after the lift. Nothing here decides; it reports what each frame showed.
 */
import "./scrollColumnAnchorPage";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";

const PATH = "scroll-anchor-tear.md";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

type Read = { k: number; preview: boolean; raster: number; css: number; give: boolean; bounce: boolean };

function overlay(): any {
	const o = overlayForPath(PATH) as any;
	if (!o) throw new Error("no overlay mounted at " + PATH);
	return o;
}

function read(): Read {
	const o = overlay();
	return { k: o.pinchScaleNow, preview: !!o.pinchPreview, raster: o.pinchRasterScale, css: o.cssScale, give: !!o.pinchGive, bounce: !!o.bounceState };
}

/** Two touch contacts spread from 300 px to 300 * to / from over `steps` frames; the lift is NOT awaited here. */
async function drive(to: number, steps: number, cx: number, cy: number): Promise<number[]> {
	const o = overlay(), router = o.router, from = o.pinchScaleNow as number;
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const startSpread = 300, endSpread = startSpread * to / from;
	const scales: number[] = [];
	setTouch(startSpread); router.beginPinch(ev("pointerdown"));
	for (let i = 1; i <= steps; i++) {
		setTouch(startSpread + (endSpread - startSpread) * i / steps);
		router.updatePinch(ev("pointermove"));
		await frame();
		scales.push(o.pinchScaleNow);
	}
	router.endPinch(ev("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	return scales;
}

/** One rAF sample per frame after the lift until the preview is down and no give is running, or `maxFrames`. */
async function watch(maxFrames: number): Promise<Read[]> {
	const rows: Read[] = [];
	for (let j = 0; j < maxFrames; j++) {
		await frame();
		const r = read();
		rows.push(r);
		if (!r.preview && !r.give) break;
	}
	return rows;
}

(window as any).zoomGive = {
	read,
	/** Pinch from the current scale to `to`, lift, then watch the frames after the lift. */
	async liftPast(to: number, steps: number, cx: number, cy: number, maxFrames: number) {
		const atLift = read();
		const scales = await drive(to, steps, cx, cy);
		const justAfterLift = read();
		const rows = await watch(maxFrames);
		return { atLift, scales, justAfterLift, rows, final: read() };
	},
	/**
	 * Pinch past the cap, lift, let a few frames of the ease run, then a new two-finger contact lands as REAL
	 * touch pointer events on the scroller (the router's own pointerdown is what ends the ease on the device,
	 * before it knows what the contact is) and pinches to `then`.
	 */
	async grabMidEase(to: number, then: number, steps: number, cx: number, cy: number) {
		const scales = await drive(to, steps, cx, cy);
		const easing: Read[] = [];
		for (let j = 0; j < 4; j++) { await frame(); easing.push(read()); }
		const o = overlay(), dom = o.view.scrollDOM as HTMLElement;
		const pev = (type: string, id: number, x: number, y: number, buttons: number) =>
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: "touch", clientX: x, clientY: y, isPrimary: id === 861, buttons });
		const rect = () => { const r = (o.view.contentDOM as HTMLElement).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; };
		const beforeContact = { ...read(), rect: rect() };
		dom.dispatchEvent(pev("pointerdown", 861, cx - 150, cy, 1));
		dom.dispatchEvent(pev("pointerdown", 862, cx + 150, cy, 1));
		const atNewContact = { ...read(), rect: rect() };
		// The pinch engages on the first move past the router's slop; the scale on screen at that moment is the
		// gesture's start, so the spread is planned from it.
		const from = o.pinchScaleNow as number, endSpread = 300 * then / from;
		const engaged: (Read & { rect: { left: number; top: number; width: number } })[] = [];
		for (let i = 1; i <= steps; i++) {
			const s = 300 + (endSpread - 300) * i / steps;
			dom.dispatchEvent(pev("pointermove", 861, cx - s / 2, cy, 1));
			dom.dispatchEvent(pev("pointermove", 862, cx + s / 2, cy, 1));
			await frame();
			// The router engages the pinch only past its slop; until then the fingers rest and the ease runs on.
			if (o.router.pinchLive && engaged.length < 3) engaged.push({ ...read(), rect: rect() });
		}
		const endS = endSpread;
		dom.dispatchEvent(pev("pointerup", 861, cx - endS / 2, cy, 0));
		dom.dispatchEvent(pev("pointerup", 862, cx + endS / 2, cy, 0));
		const rows = await watch(200);
		return { scales, easing, beforeContact, atNewContact, engaged, rows, final: read() };
	},
	/**
	 * Pinch past the cap, lift, let a few frames of the ease run, then a PEN lands as real pointer events, draws a short
	 * stroke and lifts. Read: the scale and the page's painted rect at pen-down and at pen-up (nothing may move under the
	 * pen), the frames after the lift (the ease resumes to the cap), and where the stroke landed on the note against a
	 * control stroke drawn at rest through the same note point.
	 */
	async penMidEase(to: number, steps: number, cx: number, cy: number) {
		const scales = await drive(to, steps, cx, cy);
		const easing: Read[] = [];
		for (let j = 0; j < 4; j++) { await frame(); easing.push(read()); }
		const o = overlay(), dom = o.view.scrollDOM as HTMLElement;
		const rect = () => { const r = (o.view.contentDOM as HTMLElement).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; };
		const penAt = (type: string, x: number, y: number, buttons: number) =>
			new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 977, pointerType: "pen", clientX: x, clientY: y, isPrimary: true, buttons, pressure: buttons ? 0.5 : 0 });
		const px = cx + 60, py = cy + 40;
		const strokesBefore = inlineInk.strokes(PATH).length;
		dom.dispatchEvent(penAt("pointerdown", px, py, 1));
		const atPenDown = { ...read(), rect: rect() };
		for (let i = 1; i <= 6; i++) { dom.dispatchEvent(penAt("pointermove", px + 12 * i, py, 1)); await frame(); }
		const beforePenUp = { ...read(), rect: rect() };
		dom.dispatchEvent(penAt("pointerup", px + 72, py, 0));
		const justAfterPenUp = read();
		const rows = await watch(200);
		const final = read();
		const stroke = inlineInk.strokes(PATH)[strokesBefore];
		const strokeX = stroke ? stroke.points[0]!.x : null, strokeY = stroke ? stroke.points[0]!.y : null;
		// CONTROL: at rest, a stroke through the same note point, placed by the rest's own rect and scale. Both strokes
		// are read against the same naive mapping (screen - rect.left) / scale: a constant note offset cancels in the
		// difference, so the two residuals agree only if the mid-ease mapping honoured the live preview.
		let control: { x: number; y: number; expX: number; expY: number } | null = null;
		if (stroke) {
			const r = rect(), k = final.css;
			const sx = r.left + strokeX! * k, sy = r.top + strokeY! * k;
			const n = inlineInk.strokes(PATH).length;
			dom.dispatchEvent(penAt("pointerdown", sx, sy, 1));
			for (let i = 1; i <= 6; i++) { dom.dispatchEvent(penAt("pointermove", sx + 12 * i, sy, 1)); await frame(); }
			dom.dispatchEvent(penAt("pointerup", sx + 72, sy, 0));
			await frame();
			const c = inlineInk.strokes(PATH)[n];
			control = c ? { x: c.points[0]!.x, y: c.points[0]!.y, expX: (sx - r.left) / k, expY: (sy - r.top) / k } : null;
		}
		const expMid = { x: (px - atPenDown.rect.left) / atPenDown.css, y: (py - atPenDown.rect.top) / atPenDown.css };
		return { scales, easing, atPenDown, beforePenUp, justAfterPenUp, rows, final, strokeX, strokeY, expMid, control };
	},
	/**
	 * A pinch to `to` about the pane's centre, then, spread held, the two fingers travel by (dx, dy) over
	 * `dragSteps` frames, then lift. Reads the committed pan and the page's painted rect on every drag frame.
	 */
	async zoomThenDrag(to: number, dx: number, dy: number, zoomSteps: number, dragSteps: number, cx: number, cy: number) {
		const o = overlay(), router = o.router, from = o.pinchScaleNow as number;
		const rect = () => { const r = (o.view.contentDOM as HTMLElement).getBoundingClientRect(); return { left: r.left, top: r.top }; };
		const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
		const setTouch = (spread: number, x: number, y: number) => { router.touchPos.set(861, { x: x - spread / 2, y }); router.touchPos.set(862, { x: x + spread / 2, y }); };
		const s0 = 300, s1 = 300 * to / from;
		setTouch(s0, cx, cy); router.beginPinch(ev("pointerdown"));
		const zoom: any[] = [];
		for (let i = 1; i <= zoomSteps; i++) { setTouch(s0 + (s1 - s0) * i / zoomSteps, cx, cy); router.updatePinch(ev("pointermove")); await frame(); zoom.push({ ...read(), pan: { ...o.viewportPan }, rect: rect() }); }
		const drag: any[] = [];
		for (let i = 1; i <= dragSteps; i++) { setTouch(s1, cx + dx * i / dragSteps, cy + dy * i / dragSteps); router.updatePinch(ev("pointermove")); await frame(); drag.push({ ...read(), pan: { ...o.viewportPan }, rect: rect(), band: o.boundReadout ? { rawX: o.boundReadout.rawX, cx: o.boundReadout.cx, rawY: o.boundReadout.rawY, cy: o.boundReadout.cy } : null }); }
		router.endPinch(ev("pointerup"), { x: cx + dx, y: cy + dy }); router.touchPos.clear();
		const rows = await watch(200);
		return { zoom, drag, rows, final: { ...read(), pan: { ...o.viewportPan }, rect: rect() } };
	},
	/** The zoom button's multiply at the current scale, then a settle; the reader after. */
	async button(factor: number) {
		const o = overlay();
		const accepted = o.zoomNoteBy(factor);
		for (let j = 0; j < 4; j++) await frame();
		return { accepted, final: read() };
	},
};
