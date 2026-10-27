import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import * as overlayModule from "../../src/inline/InkOverlay";
import { SHRINK_SCROLL_IDLE_MS, surfaceExtents } from "../../src/inline/SurfaceExtent";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { setPenInk } from "../../src/inline/PenInk";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";
import type { InkStroke } from "../../src/ink/Stroke";

installObsidianDom();
const { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineLassoMode, setInlineTool } = overlayModule;
const ids = new Map<string, string>();
const sidecars = new Map<string, string>();
const save = (id: string, page: PageData) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({readPageId:path=>ids.get(path) ?? null,claimId:async (path,id)=>{ids.set(path,id);return{pageId:id};},loadSidecar:async id=>sidecars.has(id) ? parsePage(sidecars.get(id)!,id) : null,scheduleSidecar:save,scheduleSidecarNow:async(id,page)=>save(id,page),notify:()=>{}});
const frames = async (count = 5) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
/** Past the quiet a held shrink waits for after a scroll, and a few frames for its pass. */
const idle = async () => { await new Promise<void>(resolve => setTimeout(resolve, SHRINK_SCROLL_IDLE_MS + 150)); await frames(4); };

const stroke = (id: string, x: number, y: number): InkStroke => ({ id, tool: "pen", color: "#000000", width: 2, createdAt: 1,
	points: [{ x, y, pressure: .5, t: 0 }, { x: x + 40, y: y + 30, pressure: .5, t: 10 }], bbox: { x, y, width: 40, height: 30 } } as InkStroke);

/** Three short strokes well inside the pane, at the left. */
function seed(path: string) {
	const pageId = `page-${path}`;
	const data = emptyPage(pageId); data.surface = "inline";
	data.strokes = [stroke("seed-0", 40, 120), stroke("seed-1", 60, 170), stroke("seed-2", 80, 220)];
	ids.set(path, pageId); sidecars.set(pageId, serializePage(data));
}

/**
 * One note, Infinite Canvas off, the real overlay and scroller, every pen event through the real router. The page walks
 * one lasso lift through to a growth that has no lift of its own and writes down the band at each step.
 */
async function run() {
	const path = "band-lift-clear/note.md";
	surfaceExtents.handleDelete(path);
	setScrollExpansionEnabled(false);
	setPenInk(true); setInlineTool("pen");
	seed(path);
	const wrapper = document.body.appendChild(document.createElement("div"));
	wrapper.className = "markdown-source-view";
	wrapper.style.cssText = "position:relative;width:430px;height:720px;overflow:hidden";
	const view = new EditorView({parent:wrapper,state:EditorState.create({doc:"",extensions:[history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{height:"700px",width:"420px"},".cm-scroller":{overflow:"auto"},".cm-content":{fontFamily:"sans-serif",fontSize:"16px",lineHeight:"24px",minHeight:"100%"}})]})});
	await inlineInk.ensureLoaded(path);
	await frames(8);
	const overlay = overlayForPath(path) as any;
	if (!overlay) throw Error("real overlay missing");
	const scroller = view.scrollDOM;
	const snap = (label: string) => ({ label, scrollLeft: scroller.scrollLeft, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, clientHeight: scroller.clientHeight,
		scale: overlay.cssScale as number, band: overlay.band ? { ...overlay.band } : null, strokes: inlineInk.strokes(path).length,
		frontierX: inlineInk.strokes(path).reduce((m, s) => Math.max(m, s.bbox.x + s.bbox.width), 0), dpr: window.devicePixelRatio, mark: overlay.bandGrowthMayWait ?? null });
	let down = false;
	const pen = (type: string, x: number, y: number) => {
		const buttons = type === "pointerdown" || (type === "pointermove" && down) ? 1 : 0;
		view.contentDOM.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 83, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));
		if (type === "pointerdown") down = true; else if (type === "pointerup") down = false;
	};
	/** Where a note point is on the screen, as the erase arm of the sideways page places the pen. */
	const screenOf = (wx: number, wy: number) => {
		const cam = overlay.camera, a = cam.worldToScreen(wx, wy), k = overlay.cssScale as number;
		return { x: overlay.lastSyncRectLeft + a.x * k, y: overlay.lastSyncRectTop + a.y * k };
	};
	const out: ReturnType<typeof snap>[] = [];
	const events: string[] = [];
	try {
		await frames(8); await idle();
		out.push(snap("mounted"));
		// The lift: select the three strokes, grab one, drag them right until they reach past the pane's right edge, let go.
		overlay.selection.selectExactly(["seed-0", "seed-1", "seed-2"]);
		setInlineLassoMode(true);
		await frames(4);
		const grab = screenOf(60, 135);
		pen("pointerdown", grab.x, grab.y);
		const grabbed = !!overlay.dragFrom && !!overlay.dragTotal;
		const dx = scroller.clientWidth - 40;
		for (let i = 1; i <= 8; i++) { pen("pointermove", grab.x + dx * i / 8, grab.y); await frames(1); }
		pen("pointerup", grab.x + dx, grab.y);
		await frames(8);
		events.push(`grabbed ${grabbed}`);
		out.push(snap("lifted"));
		// The pane scrolls one css px right: it leaves the band, and the growth the lift waited on is taken.
		scroller.scrollLeft = 1;
		await frames(8);
		out.push(snap("scrolled"));
		// The ink is deleted and the pane goes home: the range narrows back to the pane and the band's margin goes.
		overlay.deleteSelectedInk();
		await frames(6);
		scroller.scrollLeft = 0;
		await idle();
		out.push(snap("emptied"));
		// A growth with no lift of its own, as a paste or a note arriving: a stroke added at the right, past the pane.
		inlineInk.applyAdd(path, [stroke("late-0", scroller.clientWidth - 30, 160)]);
		overlay.updateExtent(true);
		overlay.scheduleRepaint();
		await frames(10);
		out.push(snap("grown"));
		return { snaps: out, events };
	} finally {
		view.destroy(); wrapper.remove();
		setPenInk(false); setScrollExpansionEnabled(false);
	}
}
(window as any).bandLiftClear = run;
