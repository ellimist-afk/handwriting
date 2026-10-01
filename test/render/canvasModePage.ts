/**
 * Slice B: the page side of CanvasModeZoom.test.ts. Mounts through scrollColumnAnchorPage's
 * tear rig and drives the REAL router (beginPinch / updatePinch / endPinch with two touch contacts),
 * with the note's canvas answer set either globally or per note through the override module's test
 * seam. Reports what each frame showed; decides nothing.
 */
import "./scrollColumnAnchorPage";
import { overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setCanvasNoteOverrideForTest, type CanvasNoteOverride } from "../../src/inline/CanvasNoteOverride";

const PATH = "scroll-anchor-tear.md";
const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

type Read = { k: number; preview: boolean; busy: boolean; canvas: boolean; scrollLeft: number; scrollTop: number; allowance: number };

function overlay(): any {
	const o = overlayForPath(PATH) as any;
	if (!o) throw new Error("no overlay mounted at " + PATH);
	return o;
}

function read(): Read {
	const o = overlay();
	return { k: o.pinchScaleNow, preview: !!o.pinchPreview, busy: !!o.getNoteViewportState().busy, canvas: !!o.canvasModeOn?.(), scrollLeft: o.view.scrollDOM.scrollLeft, scrollTop: o.view.scrollDOM.scrollTop, allowance: o.router?.cb?.overscrollAllowancePx?.() ?? Number.NaN };
}

/**
 * A stand-in for the started override module: a map of path to choice, and the same two entry points
 * the overlay reads (`canvasForNote`, `onChanged`). Duck-typed on purpose: the module's own class
 * needs a vault to write, and this rig has none; the read/listen half is what the overlay depends on.
 */
const overrides = new Map<string, boolean>();
const listeners = new Set<(path: string) => void>();
const fake = {
	canvasForNote: (path: string | null, globalDefault: boolean) => (path !== null && overrides.has(path) ? overrides.get(path)! : globalDefault),
	onChanged: (l: (path: string) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

/** Two touch contacts spread from 300 px to 300 * to / from over `steps` frames, then lifted; one read per frame. */
async function pinchTo(to: number, steps: number, cx: number, cy: number): Promise<Read[]> {
	const o = overlay(), router = o.router, from = o.pinchScaleNow as number;
	const setTouch = (spread: number) => { router.touchPos.set(861, { x: cx - spread / 2, y: cy }); router.touchPos.set(862, { x: cx + spread / 2, y: cy }); };
	const ev = (type: string) => new PointerEvent(type, { pointerId: 862, pointerType: "touch" });
	const startSpread = 300, endSpread = startSpread * to / from;
	const rows: Read[] = [];
	setTouch(startSpread); router.beginPinch(ev("pointerdown"));
	for (let i = 1; i <= steps; i++) {
		setTouch(startSpread + (endSpread - startSpread) * i / steps);
		router.updatePinch(ev("pointermove"));
		await frame();
		rows.push(read());
	}
	router.endPinch(ev("pointerup"), { x: cx, y: cy });
	router.touchPos.clear();
	for (let j = 0; j < 40; j++) { await frame(); rows.push(read()); if (!rows[rows.length - 1]!.preview) break; }
	return rows;
}

/**
 * THE CLAIM, NOT THE ZOOM. `pinchTo` above calls `router.beginPinch` directly, so it can
 * never see whether the router would have claimed the contacts in the first place - which is the
 * whole of the canvas-off defect Alan reported ("it should stay obsidian stock behavior"). This
 * driver puts two real `pointerdown` events on the surface the router listens to and reports what
 * the router did with them.
 */
function twoFingerContacts(cx: number, cy: number): { touches: number; guarded: number; watched: number; touchAction: string; pinchCalls: number } {
	const o = overlay(), router = o.router;
	const el: HTMLElement = router.scrollEl;
	let pinchCalls = 0;
	// The cell drives `pinchTo` before this, and that leaves the LAST gesture's spread standing in
	// `pinchStartSpread` (300 px). Zeroed here so the number this driver reports can only have been
	// written by the contacts it dispatches itself.
	router.pinchStartSpread = 0;
	const realOnPinch = router.cb.onPinch;
	router.cb.onPinch = (...args: unknown[]) => { pinchCalls++; return realOnPinch.apply(router.cb, args); };
	try {
		const down = (pointerId: number, x: number) => el.dispatchEvent(new PointerEvent("pointerdown", {
			pointerId, pointerType: "touch", isPrimary: pointerId === 861, clientX: x, clientY: cy,
			bubbles: true, cancelable: true, pressure: 0,
		}));
		down(861, cx - 150);
		down(862, cx + 150);
		return {
			touches: router.touchPos.size, guarded: router.guardTouches.size,
			watched: router.pinchStartSpread, touchAction: el.style.touchAction, pinchCalls,
		};
	} finally {
		router.cb.onPinch = realOnPinch;
		router.touchPos.clear();
		router.guardTouches.clear();
	}
}


(window as any).canvasMode = {
	read,
	/** The global setting, the way main.ts writes it. */
	setGlobal(on: boolean) { setScrollExpansionEnabled(on); return read(); },
	/** Install the fake override module (before any mount reads it). */
	install() { setCanvasNoteOverrideForTest(fake as unknown as CanvasNoteOverride); return true; },
	/** This note's own choice: true, false, or null for "use the default"; announces the change as the module would. */
	setOverride(choice: boolean | null) {
		if (choice === null) overrides.delete(PATH); else overrides.set(PATH, choice);
		for (const l of listeners) l(PATH);
		return read();
	},
	/** Re-read the mode on the mounted overlay, as the host does after a toggle. */
	apply() { overlay().applyCanvasMode(); return read(); },
	pinchTo,
	twoFingerContacts,
	zoomBy(factor: number) { const accepted = overlay().zoomNoteBy(factor); return { accepted, after: read() }; },
	async settle(n: number) { for (let i = 0; i < n; i++) await frame(); return read(); },
};
