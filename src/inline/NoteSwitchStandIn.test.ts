/**
 * A note switch in the same editor: the committed layers still hold the last note's pixels when the new note's font size is
 * adopted (loadInk, adoptStoredFontRef), and that re-measure reallocates the layers, taking a stand-in first
 * (InkOverlayLayout.handleResize, InkOverlayExtent.takeStandIn). The stand-in's one content check is the painted stroke count
 * against the new note's free list, and the switch resets no painted count (InkOverlayReload.ts). With the same number of
 * strokes on both notes, the copy of the last note's pixels is stamped as the new note's picture, and the next paint shows it:
 * the last note's ink on the note just opened, until the next sharp paint. Here the new note's stored font size is smaller, so
 * its scale is larger and its view lies inside the picture the copy holds.
 *
 * Wanted: the layers' record names the note their last whole paint drew as well as its count, and takeStandIn copies the
 * layers only for that note. A rename of the open note asks no repaint, so the record follows the rename, or a note later
 * opened at the old path would match it.
 *
 * The rig is the repaint rig with `sized` at backing 2 (overlayRig.testutil.ts). The switch is modelled by the steps of the
 * switch branch that the stand-in reads: the editor names the new note, the switch asks a repaint, and loadInk runs for it.
 * The rename runs the real update and its rename branch, after the store's own rename (handleRename) as the vault's event.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type ParseResult } from "../model/PageData";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkStroke } from "../ink/Stroke";
import { openRepaintRig, type RepaintRig, type SizedCanvases } from "./overlayRig.testutil";

const noHooks = { onCommittedDraw: () => undefined, onPostDraw: () => undefined };

type Fields = Record<string, unknown>;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** What a constructed overlay starts with that the kept pictures' code reads and the rig leaves unset. */
function picturesReady(o: Fields): void {
	o.pinchRefScale = null;
	o.lastScrollAskAt = Number.NEGATIVE_INFINITY;
	o.standInSnapshots ??= 0;
	o.standInRetryTimer ??= 0;
}

/** A pen stroke of the new note, away from where the rig puts the last note's. */
function strokeOfB(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: DEFAULT_PEN.color, width: DEFAULT_PEN.baseWidth, createdAt: 0,
		points: [{ x: 400, y, pressure: 0.5, t: 0 }, { x: 440, y: y + 10, pressure: 0.5, t: 8 }, { x: 480, y, pressure: 0.5, t: 16 }],
		bbox: { x: 400, y, width: 80, height: 10 },
	};
}

let notes = 0;

/**
 * A note B of its own in the store (the store is shared by every cell), loaded: `count` pen strokes of its own and a stored
 * font size of 12 px, where the rig's editor reads 16 px: the switch's adoption re-measures the scale up to 4/3 and
 * reallocates the layers. At `at` when given (a path no record holds), else at a path of its own.
 */
async function loadNoteB(count: number, at?: string): Promise<string> {
	const n = ++notes;
	const NOTE_B = at ?? `another note ${n}.md`;
	const pageB = `page-b-${n}`;
	const host = (inlineInk as unknown as { host: InlineInkHost }).host;
	inlineInk.attachHost({
		...host,
		readPageId: (path) => (path === NOTE_B ? pageB : host.readPageId(path)),
		loadSidecar: async (pageId): Promise<ParseResult | null> => {
			if (pageId !== pageB) return host.loadSidecar(pageId) as Promise<ParseResult | null>;
			const data = emptyPage(pageB);
			data.surface = "inline";
			data.fontRefPx = 12;
			data.strokes = Array.from({ length: count }, (_, i) => strokeOfB("b" + i, 80 + i * 300));
			return { data, recovered: false };
		},
	});
	await inlineInk.ensureLoaded(NOTE_B);
	expect(inlineInk.strokes(NOTE_B).length, "precondition: note B is loaded with its strokes").toBe(count);
	expect(inlineInk.fontRefPx(NOTE_B), "precondition: note B keeps its own font size").toBe(12);
	return NOTE_B;
}

/** The switch's steps the stand-in reads: the editor names note B, the switch asks a repaint, then loadInk(B). */
function switchTo(o: Fields, path: string): void {
	o.filePath = () => path;
	o.lastPath = path;
	(o.scheduleRepaint as () => void)();
	(o.loadInk as (path: string) => void)(path);
}

/**
 * The open note renamed to `to`: the vault's rename reaches the store (handleRename re-keys its record and keeps the rename
 * for the editor), then the next editor update runs the real update. With no file object the rename is known by the store's
 * record (renamedFrom), and the rename branch runs, which asks no repaint.
 */
function renameTo(o: Fields, to: string): void {
	const from = (o.filePath as () => string)();
	// The note the view shows, as mount leaves it (the rig loads its note without a mount).
	o.lastPath = from;
	inlineInk.handleRename(from, to);
	o.filePath = () => to;
	o.currentFile = () => null;
	o.ownsMarkdownEditorRoot = () => true;
	o.updateLineAnchors = () => undefined;
	(o.update as (u: unknown) => void)({ transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false });
}

/** Note A open on the rig with three pen strokes, painted whole. */
async function noteA(): Promise<{ rig: RepaintRig; o: Fields; cs: SizedCanvases }> {
	const rig = await openRepaintRig(3, noHooks, { dpr: 2, sized: true });
	const o = rig.overlay;
	const cs = rig.canvases!;
	rig.deliverPaintCallbacks();
	picturesReady(o);
	expect(o.paintedStrokeCount, "precondition: note A's three strokes are painted").toBe(3);
	expect(o.committedBlank, "precondition: the committed layer holds note A's ink").toBe(false);
	return { rig, o, cs };
}

describe("a note switch with the last note's ink on the committed layer", () => {
	it("control: the new note has another number of strokes; no stand-in is taken, and the paint draws its strokes by path", async () => {
		const { rig, o, cs } = await noteA();
		const b = await loadNoteB(2);
		const s0 = o.standInSnapshots;
		const i0 = cs.committed.images.length;
		const d0 = cs.committed.drawScales.length;
		switchTo(o, b);
		expect(o.scale, "precondition: the adoption re-measured the scale").toBeCloseTo(4 / 3, 9);
		rig.deliverPaintCallbacks();
		expect(cs.committed.images.slice(i0), "a picture was copied onto the committed layer").toEqual([]);
		expect(o.standInSnapshots, "a stand-in was taken from the last note's pixels").toBe(s0);
		expect(cs.committed.drawScales.slice(d0), "note B's strokes drawn by path at the backing scale").toEqual([2, 2]);
	});

	// Before the fix the stand-in checked only the painted count, and the switch resets none, so the copy of the last note's
	// pixels was taken and shown as the new note's. Failed at its first want: that copy drawn on the layer.
	it("the new note has the same number of strokes: no stand-in is taken from the last note's pixels, and the paint draws its strokes by path", async () => {
		const { rig, o, cs } = await noteA();
		const b = await loadNoteB(3);
		const s0 = o.standInSnapshots;
		const i0 = cs.committed.images.length;
		const d0 = cs.committed.drawScales.length;
		switchTo(o, b);
		expect(o.scale, "precondition: the adoption re-measured the scale").toBeCloseTo(4 / 3, 9);
		rig.deliverPaintCallbacks();
		expect(cs.committed.images.slice(i0), "the last note's picture was copied onto the new note's committed layer").toEqual([]);
		expect(o.standInSnapshots, "a stand-in was taken from the last note's pixels").toBe(s0);
		expect(cs.committed.drawScales.slice(d0), "note B's strokes drawn by path at the backing scale").toEqual([2, 2, 2]);
	});

	// The rename asks no repaint, so the layers keep the renamed note's paint under its new path. A note with as many strokes,
	// then at the old path (made there, restored or synced), opened in this pane before any whole paint, is a switch: its
	// stand-in must not be the renamed note's pixels.
	it("the open note renamed, then a switch to another note now at the old path with the same number of strokes: no stand-in is taken from the renamed note's pixels", async () => {
		const { rig, o, cs } = await noteA();
		const p = (o.filePath as () => string)();
		const q = "renamed " + p;
		const r0 = inlineInk.pendingRenameCount;
		const i1 = cs.committed.images.length;
		const d1 = cs.committed.drawScales.length;
		renameTo(o, q);
		expect(inlineInk.pendingRenameCount, "precondition: the rename branch ran and took the store's rename").toBe(r0);
		expect(o.lastPath, "precondition: the view follows the renamed note").toBe(q);
		rig.deliverPaintCallbacks();
		expect(cs.committed.images.length + cs.committed.drawScales.length, "precondition: the rename painted nothing").toBe(i1 + d1);
		const b = await loadNoteB(3, p);
		const s0 = o.standInSnapshots;
		const i0 = cs.committed.images.length;
		const d0 = cs.committed.drawScales.length;
		switchTo(o, b);
		expect(o.scale, "precondition: the adoption re-measured the scale").toBeCloseTo(4 / 3, 9);
		rig.deliverPaintCallbacks();
		expect(cs.committed.images.slice(i0), "the renamed note's picture was copied onto the new note's committed layer").toEqual([]);
		expect(o.standInSnapshots, "a stand-in was taken from the renamed note's pixels").toBe(s0);
		expect(cs.committed.drawScales.slice(d0), "note B's strokes drawn by path at the backing scale").toEqual([2, 2, 2]);
	});
});
