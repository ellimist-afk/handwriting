import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import * as overlayModule from "../../src/inline/InkOverlay";
import { SHRINK_SCROLL_IDLE_MS, surfaceExtents } from "../../src/inline/SurfaceExtent";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { setPenInk } from "../../src/inline/PenInk";
import { emptyPage, parsePage, serializePage, type PageData } from "../../src/model/PageData";

installObsidianDom();
const { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled, setInlineEraserMode, deleteAllInkOn } = overlayModule;
const ids = new Map<string, string>();
const sidecars = new Map<string, string>();
const save = (id: string, page: PageData) => { sidecars.set(id, serializePage(page)); };
inlineInk.attachHost({readPageId:path=>ids.get(path) ?? null,claimId:async (path,id)=>{ids.set(path,id);return{pageId:id};},loadSidecar:async id=>sidecars.has(id) ? parsePage(sidecars.get(id)!,id) : null,scheduleSidecar:save,scheduleSidecarNow:async(id,page)=>save(id,page),notify:()=>{}});
const frames = async (count = 5) => { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
/** Past the quiet a held shrink waits for after a scroll, and a few frames for its pass. */
const idle = async () => { await new Promise<void>(resolve => setTimeout(resolve, SHRINK_SCROLL_IDLE_MS + 150)); await frames(4); };

type Scenario = "near-edge-100" | "near-edge-200" | "ic-on-fresh" | "far-ic-on-delete-all" | "far-ic-on-erase" | "far-ic-on-undo-delete" | "far-ic-on-delete-all-then-off" | "edge-off" | "edge-on" | "zoom-out-edge-ink" | "narrowed-pane-edge-ink" | "canvas-off-scrolled" | "far-held-scroll-left" | "canvas-off-far-ink" | "far-delete-all" | "far-band-plant" | "far-erase" | "far-lasso-delete" | "far-undo-delete" | "chunked-growth-on" | "chunked-growth-off";

/** One stroke per entry, `[x, y]` in note px, a short diagonal of pen width 2. */
function seed(path: string, at: readonly (readonly [number, number])[]) {
	const pageId = `page-${path}`;
	const data = emptyPage(pageId); data.surface = "inline";
	data.strokes = at.map(([x, y], i) => ({ id: `seed-${i}`, tool: "pen" as const, color: "#000000", width: 2, createdAt: 1,
		points: [{ x, y, pressure: .5, t: 0 }, { x: x + 40, y: y + 30, pressure: .5, t: 10 }], bbox: { x: 0, y: 0, width: 0, height: 0 } }));
	ids.set(path, pageId); sidecars.set(pageId, serializePage(data));
}

async function run(scenario: Scenario) {
	const path = `sideways/${scenario}.md`;
	surfaceExtents.handleDelete(path);
	const infinite = scenario === "edge-on" || scenario === "chunked-growth-on" || scenario.startsWith("canvas-off") || scenario.includes("ic-on");
	setScrollExpansionEnabled(infinite);
	if (scenario.startsWith("far-") || scenario === "canvas-off-far-ink") seed(path, [[120, 120], [1500, 160]]);
	const wrapper = document.body.appendChild(document.createElement("div"));
	wrapper.className = "markdown-source-view";
	wrapper.style.cssText = "position:relative;width:430px;height:720px;overflow:hidden";
	const view = new EditorView({parent:wrapper,state:EditorState.create({doc:"",extensions:[history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{height:"700px",width:"420px"},".cm-scroller":{overflow:"auto"},".cm-content":{fontFamily:"sans-serif",fontSize:"16px",lineHeight:"24px",minHeight:"100%"}})]})});
	await inlineInk.ensureLoaded(path);
	await frames(8);
	const overlay = overlayForPath(path);
	if (!overlay) throw Error("real overlay missing");
	const scroller = view.scrollDOM;
	let extentWrites = 0;
	const watcher = new MutationObserver(records => { extentWrites += records.filter(r => (r.target as Element).classList.contains("handwriting-surface-extent")).length; });
	watcher.observe(scroller, { subtree: true, attributes: true, attributeFilter: ["style"] });
	/** Whatever reaches past the pane's right edge in the scroller's content, for the evidence. */
	const wide = () => { const sr = scroller.getBoundingClientRect(); return [...scroller.querySelectorAll("*")].map(el => ({ el, r: el.getBoundingClientRect() }))
		.filter(({ r }) => r.right - sr.left + scroller.scrollLeft > scroller.clientWidth + 1)
		.map(({ el, r }) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} right=${(r.right - sr.left + scroller.scrollLeft).toFixed(1)} style=${el.getAttribute("style") ?? ""}`).slice(0, 8); };
	const snap = (label: string) => ({ label, left: scroller.scrollLeft, width: scroller.scrollWidth, clientWidth: scroller.clientWidth, range: scroller.scrollWidth - scroller.clientWidth,
		grant: { ...surfaceExtents.get(path) }, strokes: inlineInk.strokes(path).length, extentWrites, wide: wide(), band: (overlay as any).band ? { ...(overlay as any).band } : null,
		frontierX: inlineInk.strokes(path).reduce((m, s) => Math.max(m, s.bbox.x + s.bbox.width), 0),
		originLeft: (overlay as any).columnLeft() - scroller.getBoundingClientRect().left + scroller.scrollLeft, fontZoom: (overlay as any).fontZoom });
	const pen = (type: string, x: number, y: number, buttons: number) =>
		view.contentDOM.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 71, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));
	const draw = async (x: number, y: number, dx: number, dy: number) => {
		pen("pointerdown", x, y, 1);
		for (let i = 1; i <= 4; i++) pen("pointermove", x + dx * i / 4, y + dy * i / 4, 1);
		pen("pointerup", x + dx, y + dy, 0);
		await frames();
	};
	const rect = () => scroller.getBoundingClientRect();
	const out: ReturnType<typeof snap>[] = [snap("mounted")];
	/** Every scrollLeft the scroller reports on each frame between two snaps. */
	const lefts: number[] = [];
	const onScroll = () => lefts.push(scroller.scrollLeft);
	scroller.addEventListener("scroll", onScroll);
	try {
		if (scenario === "near-edge-100" || scenario === "near-edge-200") {
			// One short stroke whose bbox ends 100 (or 200) note px inside the pane's right edge, within 10 px. The pen's
			// own allowance around the stroke is measured from a first stroke, and the stroke is placed from it. The moves
			// go a frame apart. A placement that lands more than 10 px off is deleted, the note reset, and the stroke
			// placed again from what that placement showed, five placements at most; every one is logged.
			setPenInk(true);
			const inset = scenario === "near-edge-100" ? 100 : 200;
			out.push(snap("before"));
			const r = rect(), y = r.top + 200;
			const drawPaced = async (x: number, yAt: number, dx: number) => {
				pen("pointerdown", x, yAt, 1);
				for (let i = 1; i <= 4; i++) { pen("pointermove", x + dx * i / 4, yAt, 1); await frames(1); }
				pen("pointerup", x + dx, yAt, 0);
				await frames();
			};
			const withPoints = (s: ReturnType<typeof snap>) => ({ ...s, points: inlineInk.strokes(path).map(stroke => stroke.points.length) });
			const insetOf = (s: ReturnType<typeof snap>) => (s.clientWidth - (s.originLeft + s.frontierX * s.fontZoom)) / s.fontZoom;
			let aim = 40 + 30;
			await drawPaced(r.left + aim - 30, y, 30);
			let last = withPoints(snap("probe"));
			out.push(last);
			const attempts: { reset: { strokes: number; width: number; clientWidth: number; grantX: number }; aim: number; inset: number; points: number[]; grantX: number }[] = [];
			for (;;) {
				const allowance = last.frontierX - (aim - last.originLeft);
				(overlay as any).selection.selectExactly(inlineInk.strokes(path).map(stroke => stroke.id));
				(overlay as any).deleteSelectedInk();
				await frames(8);
				surfaceExtents.handleDelete(path);
				(overlay as any).updateExtent(true);
				await frames(8);
				const reset = snap("reset");
				if (!attempts.length) out.push(reset);
				aim = scroller.clientWidth - inset - allowance;
				await drawPaced(r.left + aim - 30, y + 60, 30);
				last = withPoints(snap("drawn"));
				attempts.push({ reset: { strokes: reset.strokes, width: reset.width, clientWidth: reset.clientWidth, grantX: reset.grant.x }, aim, inset: insetOf(last), points: last.points, grantX: last.grant.x });
				if (Math.abs(insetOf(last) - inset) <= 10 || attempts.length === 5) break;
			}
			out.push({ ...last, attempts } as any);
			await frames(12);
			out.push(snap("still"));
		} else if (scenario === "edge-off" || scenario === "edge-on") {
			setPenInk(true);
			// Near the pane's right edge, still inside it.
			await draw(rect().left + scroller.clientWidth - 40, rect().top + 200, 24, 18);
			out.push(snap("drawn near the right edge"));
			await frames(12);
			out.push(snap("still"));
		} else if (scenario === "zoom-out-edge-ink" || scenario === "narrowed-pane-edge-ink") {
			// The two ways a device lands ink past the pane's right edge with Infinite Canvas off: a pen can only draw
			// where the pane shows, so the pane has to show more of the note while it draws, or less of it afterwards.
			const inkRight = () => {
				const s = inlineInk.strokes(path)[0];
				if (!s) return null;
				const k = (overlay as any).cssScale as number, f = (overlay as any).fontZoom as number;
				return (view.contentDOM.getBoundingClientRect().left - scroller.getBoundingClientRect().left) / k + scroller.scrollLeft + (s.bbox.x + s.bbox.width) * f;
			};
			const zoom = () => (overlay as any).pinchScaleNow as number;
			setPenInk(true);
			if (scenario === "zoom-out-edge-ink") {
				const pinchBy = async (ratio: number) => {
					const r = rect(), c = { x: r.left + r.width / 2, y: r.top + 200 };
					(overlay as any).pinch("start", 1, c); (overlay as any).pinch("move", ratio, c); (overlay as any).pinch("end", ratio, c);
					await frames(8); await new Promise<void>(resolve => setTimeout(resolve, 700)); await frames(4);
				};
				await pinchBy(0.5);
				out.push({ ...snap("at 50%"), zoom: zoom() } as any);
				const r = rect();
				// At the pane's visible right edge, as a pen would.
				await draw(r.right - 40, r.top + 200, 24, 18);
				out.push({ ...snap("drawn at the pane's right edge at 50%"), zoom: zoom(), inkRight: inkRight() } as any);
				await pinchBy(2);
				out.push({ ...snap("back at 100%"), zoom: zoom(), inkRight: inkRight() } as any);
			} else {
				wrapper.style.width = "760px"; view.dom.style.width = "750px"; view.requestMeasure();
				await frames(10);
				await draw(rect().left + scroller.clientWidth - 40, rect().top + 200, 24, 18);
				out.push({ ...snap("drawn near the right edge of a wide pane"), zoom: zoom(), inkRight: inkRight() } as any);
				wrapper.style.width = "430px"; view.dom.style.width = "420px"; view.requestMeasure();
				await frames(10); await idle();
				out.push({ ...snap("back at 100%"), zoom: zoom(), inkRight: inkRight() } as any);
			}
			scroller.scrollLeft = scroller.scrollWidth;
			await idle();
			out.push({ ...snap("scrolled right to the end"), zoom: zoom(), inkRight: inkRight() } as any);
		} else if (scenario === "far-held-scroll-left") {
			// Delete all ink scrolled out, then scroll left a frame at a time through what the view held back.
			scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2);
			await frames(8);
			out.push(snap("scrolled out"));
			if (deleteAllInkOn(path) !== 2) throw Error("delete all did not remove both strokes");
			await frames(8);
			out.push(snap("removed, still scrolled out"));
			const start = scroller.scrollLeft, perFrame: unknown[] = [];
			for (let i = 1; i <= 20; i++) {
				const sent = start - i * 20;
				scroller.scrollLeft = sent;
				await frames(1);
				perFrame.push({ sent, t: performance.now(), ...snap(`scroll frame ${i}`) });
			}
			out.push({ ...snap("scrolled left, frame by frame"), perFrame } as any);
			await idle();
			out.push(snap("scroll quiet"));
			scroller.scrollLeft = 0;
			await idle();
			out.push(snap("home, still"));
		} else if (scenario === "canvas-off-scrolled") {
			// Infinite Canvas on, no ink: the room comes from scrolling into it.
			out.push(snap("infinite canvas on"));
			for (let i = 0; i < 3; i++) {
				scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth - 40;
				await frames(8);
			}
			scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2);
			await frames(8);
			out.push(snap("scrolled out"));
			lefts.length = 0;
			setScrollExpansionEnabled(false);
			await frames(8);
			out.push({ ...snap("infinite canvas off, still scrolled out"), lefts: [...lefts] } as any);
			const target = Math.round(scroller.scrollLeft / 2);
			lefts.length = 0;
			scroller.scrollLeft = target;
			await idle();
			out.push({ ...snap("partway home"), lefts: [...lefts], target } as any);
			scroller.scrollLeft = 0;
			await idle();
			out.push(snap("scrolled home"));
			await frames(12);
			out.push(snap("home, still"));
		} else if (scenario === "canvas-off-far-ink") {
			// Infinite Canvas on, ink far past the pane: turning it off keeps the ink's own room.
			scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2);
			await frames(8);
			scroller.scrollLeft = 0;
			await frames(8);
			out.push(snap("infinite canvas on"));
			setScrollExpansionEnabled(false);
			await frames(8);
			out.push(snap("infinite canvas off"));
			scroller.scrollLeft = scroller.scrollWidth;
			await frames(8);
			out.push(snap("scrolled to the far ink"));
		} else if (scenario === "ic-on-fresh") {
			// A note Infinite Canvas has just started, no ink: the room a cleared note returns to while it is on.
			await frames(12);
			out.push(snap("fresh"));
		} else if (scenario === "far-ic-on-delete-all-then-off") {
			// At home: clear the page with Infinite Canvas on, then turn it off.
			if (deleteAllInkOn(path) !== 2) throw Error("delete all did not remove both strokes");
			await idle();
			out.push(snap("cleared, infinite canvas on"));
			setScrollExpansionEnabled(false);
			await idle();
			out.push(snap("infinite canvas off"));
			await frames(12);
			out.push(snap("off, still"));
		} else if (scenario.startsWith("chunked-growth")) {
			setPenInk(true);
			for (let i = 0; i < 12; i++) {
				await draw(rect().left + 20 + i * 30, rect().top + 120 + i * 20, 20, 10);
				out.push(snap(`stroke ${i + 1}`));
			}
		} else {
			out.push(snap("seeded far right"));
			// Out to the middle of the range: part of the grant is on screen, part is off to the right.
			scroller.scrollLeft = Math.round((scroller.scrollWidth - scroller.clientWidth) / 2);
			await frames(8);
			out.push(snap("scrolled out"));
			lefts.length = 0;
			// PLANT: the band keeps its sideways margin after the shrink, as it did before the release existed.
			if (scenario === "far-band-plant") (overlay as any).releaseBandMargin = () => {};
			if (scenario.endsWith("delete-all") || scenario === "far-band-plant" || scenario.endsWith("undo-delete")) {
				const removed = deleteAllInkOn(path);
				if (removed !== 2) throw Error(`delete all removed ${removed}`);
			} else if (scenario === "far-lasso-delete") {
				// The lassoed selection, set directly; the delete is the one the lasso's delete command runs.
				(overlay as any).selection.selectExactly(["seed-1"]);
				const outcome = (overlay as any).deleteSelectedInk();
				if (inlineInk.strokes(path).length !== 1) throw Error(`lasso delete: ${JSON.stringify(outcome)}`);
			} else {
				// Erase the far stroke: it is on screen at this scroll.
				setPenInk(true); setInlineEraserMode(true);
				const s = inlineInk.strokes(path).find(k => k.bbox.x > 1000)!;
				const cam = (overlay as any).camera;
				const a = cam.worldToScreen(s.points[0]!.x, s.points[0]!.y), b = cam.worldToScreen(s.points[1]!.x, s.points[1]!.y);
				const ox = (overlay as any).lastSyncRectLeft, oy = (overlay as any).lastSyncRectTop, k = (overlay as any).cssScale;
				const x0 = ox + a.x * k, y0 = oy + a.y * k, x1 = ox + b.x * k, y1 = oy + b.y * k;
				pen("pointerdown", x0, y0, 1);
				for (let i = 1; i <= 8; i++) pen("pointermove", x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, 1);
				pen("pointerup", x1, y1, 0);
				setInlineEraserMode(false);
			}
			await frames(8);
			out.push({ ...snap("removed, still scrolled out"), lefts: [...lefts] } as any);
			if (scenario.endsWith("undo-delete")) {
				undo(view);
				await frames(8);
				out.push(snap("undone"));
			} else {
				// Halfway home: the view has left part of what the shrink was holding.
				const target = Math.round(scroller.scrollLeft / 2);
				lefts.length = 0;
				scroller.scrollLeft = target;
				await idle();
				out.push({ ...snap("partway home"), lefts: [...lefts], target } as any);
			}
			scroller.scrollLeft = 0;
			await idle();
			out.push(snap("scrolled home"));
			await frames(12);
			out.push(snap("home, still"));
			if (scenario === "far-ic-on-delete-all" || scenario === "far-ic-on-undo-delete") {
				// Scroll right as far as it goes, a few times: Infinite Canvas still extends the page.
				for (let i = 0; i < 3; i++) { scroller.scrollLeft = scroller.scrollWidth; await frames(8); }
				await idle();
				out.push(snap("scrolled right again"));
			}
		}
	} finally {
		scroller.removeEventListener("scroll", onScroll);
		watcher.disconnect(); view.destroy(); wrapper.remove();
		setPenInk(false); setScrollExpansionEnabled(false);
	}
	return { scenario, infinite, snaps: out };
}
/**
 * Two panes on one note, Infinite Canvas off, far ink. Pane `home` is made first
 * and stays at the left edge; pane `out` is scrolled into the range. Delete all
 * ink runs in the first editor showing the note, which is `home`, whose own view
 * would let the whole grant go: the grant is the note's, so `out` must keep its view.
 */
async function twoPanes() {
	const path = "sideways/two-panes.md";
	surfaceExtents.handleDelete(path);
	setScrollExpansionEnabled(false);
	seed(path, [[120, 120], [1500, 160]]);
	const mount = () => {
		const wrapper = document.body.appendChild(document.createElement("div"));
		wrapper.className = "markdown-source-view";
		wrapper.style.cssText = "position:relative;width:430px;height:360px;overflow:hidden";
		const view = new EditorView({parent:wrapper,state:EditorState.create({doc:"",extensions:[history(),editorInfoField.init(()=>({app:{commands:{executeCommandById:()=>false}},file:{path},editor:{}})),inkOverlayExtension(),EditorView.theme({"&":{height:"340px",width:"420px"},".cm-scroller":{overflow:"auto"},".cm-content":{fontFamily:"sans-serif",fontSize:"16px",lineHeight:"24px",minHeight:"100%"}})]})});
		return { wrapper, view };
	};
	const home = mount();
	await inlineInk.ensureLoaded(path);
	await frames(8);
	const out = mount();
	await frames(8);
	const s = (label: string, pane: { view: EditorView }, lefts?: number[]) => ({ label, left: pane.view.scrollDOM.scrollLeft, width: pane.view.scrollDOM.scrollWidth, clientWidth: pane.view.scrollDOM.clientWidth,
		range: pane.view.scrollDOM.scrollWidth - pane.view.scrollDOM.clientWidth, grant: { ...surfaceExtents.get(path) }, strokes: inlineInk.strokes(path).length, extentWrites: 0, lefts });
	const lefts: number[] = [];
	const onScroll = () => lefts.push(out.view.scrollDOM.scrollLeft);
	const snaps: unknown[] = [];
	try {
		out.view.scrollDOM.scrollLeft = Math.round((out.view.scrollDOM.scrollWidth - out.view.scrollDOM.clientWidth) / 2);
		await frames(8);
		snaps.push(s("out: scrolled out", out), s("home: at the left edge", home));
		out.view.scrollDOM.addEventListener("scroll", onScroll);
		const removed = deleteAllInkOn(path);
		if (removed !== 2) throw Error(`delete all removed ${removed}`);
		await frames(10);
		snaps.push(s("out: removed, still scrolled out", out, [...lefts]), s("home: removed", home));
		out.view.scrollDOM.removeEventListener("scroll", onScroll);
		out.view.scrollDOM.scrollLeft = 0;
		await idle();
		snaps.push(s("out: scrolled home", out), s("home: after out went home", home));
	} finally {
		for (const pane of [out, home]) { pane.view.destroy(); pane.wrapper.remove(); }
	}
	return { scenario: "two-panes", snaps };
}
(window as any).sidewaysRun = run;
(window as any).sidewaysTwoPanes = twoPanes;
