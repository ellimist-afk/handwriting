/**
 * The zoom-out rest rig, for ZoomOutRest.test.ts. A note mounted at 100 percent in a 1174 x 710 pane (the device rig's
 * pane), zoomed in to 200 percent by 90 ctrl+wheel events replayed on the device's own profile, then out to 100 percent
 * the way the zoom bar's minus lands there: zoomNoteBy(next / zoom) with next 1. The pivot of the zoom in is either the device's pen
 * point (868, 495 px into the scroller) or the scroller's centre; the minus always zooms at the centre.
 *
 * Read at the start and after the minus: scrollLeft and scrollTop, scrollWidth, the content's left edge, the column
 * margin and its debt, the host's column margin variable and the sizer's offset.
 *
 * resetFrom zooms out to `from`, scrolls down, and presses the 100 percent button (resetNoteZoom).
 */
import "./scrollColumnAnchorPage";
import * as Overlay from "../../src/inline/InkOverlay";

const PATH = "scroll-anchor-tear.md";
const RIG = { w: 1174, h: 710, n: 90, dur: 1.5, gain: 0.003649637370829106, penX: 868, penY: 495 };
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
const overlay = (): any => {
	const o = Overlay.overlayForPath(PATH) as any;
	if (!o) throw new Error("no overlay mounted at " + PATH);
	return o;
};

function state(o: any) {
	const s = o.view.scrollDOM as HTMLElement, sr = s.getBoundingClientRect();
	const sizer = s.querySelector(".cm-sizer") as HTMLElement | null;
	const cs = getComputedStyle(o.view.dom as HTMLElement);
	return {
		k: o.pinchScaleNow as number, css: o.cssScale as number, rectH: sr.height, maxTop: s.scrollHeight - s.clientHeight,
		sl: s.scrollLeft, st: s.scrollTop, scrollWidth: s.scrollWidth,
		originX: (o.view.contentDOM as HTMLElement).getBoundingClientRect().left, originRel: (o.view.contentDOM as HTMLElement).getBoundingClientRect().left - sr.left,
		contentW: (o.view.contentDOM as HTMLElement).getBoundingClientRect().width, scrollerW: sr.width,
		rest: o.restingColumnMargin as number | null, debt: o.columnMarginDebt as number,
		marginVar: cs.getPropertyValue("--handwriting-column-margin-left").trim(),
		sizerOffsetLeft: sizer ? sizer.offsetLeft : null,
	};
}

async function settle(o: any): Promise<void> {
	for (let i = 0; i < 60; i++) {
		await frame();
		if (!o.pinchPreview && !o.pinchGive) break;
	}
	for (let i = 0; i < 30; i++) await frame();
}

async function mount(readable: boolean): Promise<void> {
	await (window as any).scrollColumnAnchor.runTearMount(1, 0, { w: RIG.w, h: RIG.h }, true, { fx: 0.5, fy: 0.5 }, readable);
	Overlay.setScrollExpansionEnabled(true);
	for (let i = 0; i < 10; i++) await frame();
}

/** The round trip. `scale` sizes the wheel total so the zoom in lands at 200 percent (calibrated on the device profile). */
async function roundTrip(pivot: "pen" | "centre", scale: number) {
	const o = overlay(), s = o.view.scrollDOM as HTMLElement, sr = s.getBoundingClientRect();
	const at = pivot === "centre" ? [Math.round(sr.left + sr.width / 2), Math.round(sr.top + sr.height / 2)] : [Math.round(sr.left + RIG.penX), Math.round(sr.top + RIG.penY)];
	const base = state(o);
	const total = (-Math.log(2) / RIG.gain) * scale;
	const prof: number[] = [];
	for (let i = 0; i < RIG.n; i++) prof.push(0.15 + Math.sin(Math.PI * ((i + 0.5) / RIG.n)) ** 2);
	const sum = prof.reduce((a, v) => a + v, 0);
	const t0 = performance.now();
	for (let i = 0; i < RIG.n; i++) {
		await sleep(t0 + (i * RIG.dur * 1000) / RIG.n - performance.now());
		s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: (total * prof[i]!) / sum, deltaMode: 0, clientX: at[0], clientY: at[1] }));
	}
	await settle(o);
	const zoomedIn = state(o);
	const minus = o.zoomNoteBy(1 / o.pinchScaleNow) as boolean;
	await settle(o);
	return { base, zoomedIn, minus, landed: state(o) };
}

/** The 100 percent button from far out: zoomNoteBy(`from`) at 100 percent, a scroll down by `down` px, then resetNoteZoom. */
async function resetFrom(from: number, down: number) {
	const o = overlay(), s = o.view.scrollDOM as HTMLElement;
	const base = state(o);
	const out = o.zoomNoteBy(from) as boolean;
	await settle(o);
	if (down > 0) { s.scrollTop = down; await settle(o); }
	const zoomedOut = state(o);
	const reset = o.resetNoteZoom() as boolean;
	await settle(o);
	return { base, out, zoomedOut, reset, landed: state(o) };
}

(window as any).zoomOutRest = { mount, roundTrip, resetFrom };
