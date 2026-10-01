/**
 * The page side of WheelZoom.test.ts. Mounts through scrollColumnAnchorPage's
 * tear rig (the plain note, real overlay) and dispatches REAL WheelEvents with
 * `ctrlKey` on the scroller - the shape Chromium gives a Windows precision-touchpad
 * pinch - then reads the overlay's scale of record, the note's painted rect and the
 * editor font on the frame clock. Nothing here decides; it reports what each frame
 * showed.
 */
import "./scrollColumnAnchorPage";
import * as Overlay from "../../src/inline/InkOverlay";

const overlayForPath = Overlay.overlayForPath;
/**
 * Infinite Canvas is the gate, so this is the same switch the mode uses.
 * Every cell but the canvas-off row mounts with it on.
 */
const setCanvas = (on: boolean): void => Overlay.setScrollExpansionEnabled(on);

const PATH = "scroll-anchor-tear.md";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

type Rect = { left: number; top: number; width: number };
type Read = {
	k: number;
	preview: boolean;
	give: boolean;
	/** What the zoom counter renders from: MobileTools writes `${Number((zoom*100).toPrecision(3))}%` from this. */
	zoom: number;
	/** The counter's own text, formatted exactly as MobileTools formats it. The strip is not mounted in this rig. */
	counter: string;
	fontPx: string;
	rect: Rect;
};

function overlay(): any {
	const o = overlayForPath(PATH) as any;
	if (!o) throw new Error("no overlay mounted at " + PATH);
	return o;
}

function rectOf(o: any): Rect {
	const r = (o.view.contentDOM as HTMLElement).getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width };
}

function read(): Read {
	const o = overlay();
	const zoom = o.getNoteViewportState().zoom as number;
	return {
		k: o.pinchScaleNow,
		preview: !!o.pinchPreview,
		give: !!o.pinchGive,
		zoom,
		counter: `${Number((zoom * 100).toPrecision(3))}%`,
		fontPx: getComputedStyle(o.view.contentDOM as HTMLElement).fontSize,
		rect: rectOf(o),
	};
}

/** One ctrl+wheel event on the scroller, as the browser delivers a touchpad pinch. */
function wheel(dy: number, cx: number, cy: number, deltaMode = 0): boolean {
	const o = overlay();
	const e = new WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		ctrlKey: true,
		deltaY: dy,
		deltaMode,
		clientX: cx,
		clientY: cy,
	});
	(o.view.scrollDOM as HTMLElement).dispatchEvent(e);
	return e.defaultPrevented;
}

/** rAF samples until the preview is down and no give is running, or `maxFrames`. */
async function watch(maxFrames: number): Promise<Read[]> {
	const rows: Read[] = [];
	for (let j = 0; j < maxFrames; j++) {
		await frame();
		const r = read();
		rows.push(r);
		// A lift under the canvas now eases its measured travel, so "at rest" also means no ease is playing.
		const easing = !!(overlay().overscrollBounceReadout && overlay().overscrollBounceReadout().active);
		if (!r.preview && !r.give && !easing) break;
	}
	return rows;
}

(window as any).wheelZoom = {
	read,
	setCanvas: (on: boolean) => setCanvas(on),

	/**
	 * A run of ctrl+wheel events at one cursor, one per frame, then nothing -
	 * the quiet time is the only end a wheel gesture has. Reads the note point
	 * that sat under the cursor before the run and where it sits at the end.
	 */
	async run(totalDy: number, steps: number, cx: number, cy: number, maxFrames = 200) {
		const before = read();
		const noteX = (cx - before.rect.left) / before.k;
		const noteY = (cy - before.rect.top) / before.k;
		const prevented: boolean[] = [];
		const live: Read[] = [];
		for (let i = 0; i < steps; i++) {
			prevented.push(wheel(totalDy / steps, cx, cy));
			await frame();
			live.push(read());
		}
		const rows = await watch(maxFrames);
		const final = read();
		// Where the note point under the cursor ended up on screen.
		const heldX = final.rect.left + noteX * final.k;
		const heldY = final.rect.top + noteY * final.k;
		return { before, prevented, live, rows, final, noteX, noteY, heldX, heldY, cursor: { x: cx, y: cy } };
	},

	/** One ctrl+wheel event and the frames after it, with no second event: for the setting-off cell. */
	async one(dy: number, cx: number, cy: number) {
		const before = read();
		const prevented = wheel(dy, cx, cy);
		for (let j = 0; j < 4; j++) await frame();
		return { before, prevented, after: read() };
	},

	/**
	 * THE CONTROL: the same zoom, by two real touch contacts through the router,
	 * measured by the same reader. A wheel run and a finger pinch that end at the
	 * same scale must hold the same point under the same screen position; what
	 * the settle then does with the column is the pinch path's own contract and
	 * shows up identically in both.
	 */
	async fingers(to: number, steps: number, cx: number, cy: number, maxFrames = 200) {
		const o = overlay(), router = o.router, from = o.pinchScaleNow as number;
		const before = read();
		const noteX = (cx - before.rect.left) / before.k;
		const noteY = (cy - before.rect.top) / before.k;
		const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
		const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
		const startSpread = 300, endSpread = startSpread * to / from;
		const live: Read[] = [];
		setTouch(startSpread); router.beginPinch(ev("pointerdown"));
		for (let i = 1; i <= steps; i++) {
			setTouch(startSpread + (endSpread - startSpread) * i / steps);
			router.updatePinch(ev("pointermove"));
			await frame();
			live.push(read());
		}
		router.endPinch(ev("pointerup"), { x: cx, y: cy });
		router.touchPos.clear();
		const rows = await watch(maxFrames);
		const final = read();
		return {
			before, live, rows, final, noteX, noteY,
			heldX: final.rect.left + noteX * final.k,
			heldY: final.rect.top + noteY * final.k,
			cursor: { x: cx, y: cy },
		};
	},

	/** deltaMode 1 (lines): one run, same reader as `run`. */
	async lines(totalLines: number, steps: number, cx: number, cy: number, maxFrames = 200) {
		const before = read();
		for (let i = 0; i < steps; i++) {
			wheel(totalLines / steps, cx, cy, 1);
			await frame();
		}
		const rows = await watch(maxFrames);
		return { before, rows, final: read() };
	},
};
