/**
 * A bare overlay for the finger tap and the link icon on attached ink: the real InkOverlayPlugin prototype (the tap, the
 * selection redraw, the committed repaint), the real selection model, line anchors and follow, a fake view whose every
 * layout read throws, a recording tail and a recording committed layer. No DOM, no layout.
 *
 * The note: lines 40 world units tall from 0. Group g1 is a ring round line 3's words (stroke c1) and a tick under them
 * (c2); group g2 a ring round line 10's words (d1) and a tick (d2); "free" is a free line on line 20. Each group is read
 * 6 right and 12 down of its record, so it shows at its stored points plus (6, 12); free ink shows where it is stored.
 *
 * Not a test file: the name does not end in `.test.ts`, so vitest does not collect it, and the `.test.` in it keeps the
 * plugin checker off it. Nothing that ships imports this module.
 */
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type BBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
export const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** Each group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };
/** Where every group shows, over its stored points. */
export const SHOWN = { dx: 6, dy: 12 };

type Pt = { x: number; y: number };

export function strokeOf(id: string, pts: readonly Pt[], width = 1): InkStroke {
	const points = pts.map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A closed ring round the box (x, y, w, h): its four sides, a point every 10 units. */
export function ring(id: string, x: number, y: number, w: number, h: number): InkStroke {
	const pts: Pt[] = [];
	for (let i = 0; i <= w; i += 10) pts.push({ x: x + i, y });
	for (let i = 10; i <= h; i += 10) pts.push({ x: x + w, y: y + i });
	for (let i = w - 10; i >= 0; i -= 10) pts.push({ x: x + i, y: y + h });
	for (let i = h - 10; i >= 0; i -= 10) pts.push({ x, y: y + i });
	return strokeOf(id, pts);
}

/** A straight line from (x, y), `w` long, a point every 10 units. */
export function line(id: string, x: number, y: number, w: number): InkStroke {
	const pts: Pt[] = [];
	for (let i = 0; i <= w; i += 10) pts.push({ x: x + i, y });
	return strokeOf(id, pts);
}

export function record(id: string, strokeIds: string[], word: string): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id, strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 89 } };
}

/** The two groups and the free line, stored. g1's ring spans x 10..170, y 70..106; g2's x 10..170, y 340..376. */
export function noteStrokes(): InkStroke[] {
	return [ring("c1", 10, 70, 160, 36), line("c2", 40, 100, 60), ring("d1", 10, 340, 160, 36), line("d2", 40, 370, 60), line("free", 10, 780, 160)];
}

export function noteGroups(): AttachmentRecord[] {
	return [record("g1", ["c1", "c2"], "line 3 words"), record("g2", ["d1", "d2"], "line 10 words")];
}

export interface RigOpts {
	strokes?: InkStroke[];
	attachments?: AttachmentData[];
	held?: string[];
	zoom?: number;
}

const layoutRead = () => {
	throw new Error("a layout read");
};

export function tapRig(path: string, opts: RigOpts = {}) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: opts.attachments ?? noteGroups() };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = opts.strokes ?? noteStrokes();
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const status = new Map((opts.held ?? []).map((id) => [id, "needs-reattachment" as const]));
	anchors.follow.setList(inlineInk.attachments(path), status);
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const calls: string[] = [], sent: TransactionSpec[] = [];
	let refreshes = 0;
	const tail = {
		inlineGrid: null,
		restoreFullSurface: () => void calls.push("full"),
		drawAttachButton: (_c: unknown, _b: unknown, attached: boolean) => void calls.push(`button ${attached ? "attached" : "loose"}`),
		clearAll: () => void calls.push("clear"),
		prepareLive: () => void calls.push("live"),
		drawLasso: () => void calls.push("lasso"),
		drawHead: () => void calls.push("head"),
		drawSelectionBox: (_c: unknown, b: BBox) => void calls.push(`box ${b.x},${b.y},${b.width},${b.height}`),
		drawGroupTag: (_c: unknown, b: Pt, label: string) => void calls.push(`tag ${label} @${b.x},${b.y}`),
		drawAttachPin: (_c: unknown, at: Pt) => void calls.push(`pin ${at.x},${at.y}`),
	};
	const dom = { isConnected: true, getBoundingClientRect: layoutRead };
	const view = {
		state: { doc }, dom, dispatch: (spec: TransactionSpec) => void sent.push(spec),
		get scrollDOM() { return layoutRead(); }, get contentDOM() { return layoutRead(); },
		lineBlockAt: layoutRead, lineBlockAtHeight: layoutRead, coordsAtPos: layoutRead, posAtCoords: layoutRead,
	};
	const zoom = opts.zoom ?? 1;
	const camera = {
		snapshot: { x: 0, y: 0, zoom },
		screenToWorld: (x: number, y: number) => ({ x: x / zoom, y: y / zoom }),
		worldToScreen: (x: number, y: number) => ({ x: x * zoom, y: y * zoom }),
	};
	const committed: string[] = [], damage: BBox[] = [];
	let repaints = 0;
	const recordingCtx = () => new Proxy({} as Record<string, unknown>, {
		get: (t, k) => k in t ? t[k as string] : k === "measureText" ? (text: string) => ({ width: text.length * 7 })
			: (...a: unknown[]) => void committed.push(`${String(k)} ${a.map((v) => typeof v === "number" ? Math.round(v * 100) / 100 : String(v)).join(",")}`),
		set: (t, k, v) => {
			t[k as string] = v;
			if (k === "strokeStyle") committed.push(`strokeStyle ${String(v)}`);
			return true;
		},
	});
	const selection = new SelectionModel();
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors, view, tail, camera, selection,
		filePath: () => path,
		refreshStrip: () => void refreshes++,
		dressTail: () => {}, queueTailShrink: () => {}, showLassoCursor: () => {}, sayIfPageEmpty: () => {},
		beginLassoSnapshot: () => {}, captureHistoryIdentity: () => null,
		spaceTime: null, spacePreview: null, spacePlan: null, spaceSnapshot: null, spaceLineY: null,
		spaceRowsCache: { get: () => null },
		builder: null, lassoActive: false, lassoPts: [], dragBox: null, dragTotal: null,
		cssWidth: 800, cssHeight: 600, cssScale: 1, scale: zoom,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		committedCtx: recordingCtx(), highlightCtx: recordingCtx(), committedCanvas: { width: 800, height: 600 },
		committedBacking: 1, dpr: 1, extentMayBuild: false, extentArmAsked: false, standIn: null, extentBuild: null,
		highlightPairDeferred: true, indexDirty: false, paintMoving: false, strokeIndex: { query: () => [] },
		markCommittedPaint: () => {}, usableExtent: () => null, armExtentBuild: () => {}, paintAttached: () => {}, attachedLayer: null,
		damage: { addRect: (r: BBox) => void damage.push({ ...r }), addAll: () => void damage.push({ x: -Infinity, y: -Infinity, width: Infinity, height: Infinity }) },
		scheduleRepaint: () => void repaints++,
	});
	const redraw = () => {
		calls.length = 0;
		(overlay as unknown as { redrawSelectionUI(): void }).redrawSelectionUI();
		return [...calls];
	};
	const paint = (work: "all" | BBox[]) => {
		committed.length = 0;
		(overlay as unknown as { paintCommittedWork(c: object, w: unknown, s: readonly InkStroke[]): boolean }).paintCommittedWork(camera.snapshot, work, inlineInk.strokes(path));
		return [...committed];
	};
	/** A finger tap's lift at world (x, y), as the router reports it, with the lift event when given; the overlay's answer. */
	const tapAt = (x: number, y: number, ev?: object): unknown => {
		const p = camera.worldToScreen(x, y);
		return (overlay as unknown as { tapReleasesSelection(s: object, ev?: object): unknown }).tapReleasesSelection({ x: p.x, y: p.y, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, ev);
	};
	const selected = () => [...selection.strokeIds].sort();
	/** A group's shown box: its members' stored union moved by the group's correction (SHOWN for a group that follows). */
	const shownBox = (ids: string[]): BBox => {
		const bs = inlineInk.strokes(path).filter((s) => ids.includes(s.id)).map((s) => s.bbox);
		const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
		const r = Math.max(...bs.map((b) => b.x + b.width)), b = Math.max(...bs.map((b) => b.y + b.height));
		const g = anchors.follow.memberMap.get(ids[0]!), o = (g !== undefined ? anchors.follow.groupOffset(g) : null) ?? SHOWN;
		return { x: x + o.dx, y: y + o.dy, width: r - x, height: b - y };
	};
	return { overlay, anchors, selection, redraw, paint, tapAt, selected, shownBox, damage, committed, calls, sent,
		repaints: () => repaints, refreshes: () => refreshes, camera };
}
