/**
 * Ink attached to text when the note's ink file is replaced from outside the session: a synced copy adopted, a revision
 * restored, the file read again. The session's own list of attached groups belonged to the copy it replaced, so it goes
 * with that copy: the store answers and writes the incoming file's list, and the open note resolves that list against
 * its text again. The production store with in-memory host I/O; the overlay is a bare rig over a CodeMirror Text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { SelectionModel } from "../objects/SelectionModel";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";

const DOC = "One line of words.\nThe word benzene sits here, then toluene after it.\nLast line.";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(id: string, word: string, shift = 0, text = DOC): AttachmentRecord {
	const from = text.indexOf(word);
	const target = { ...targetAt(text, from, from + word.length, "range") };
	target.from += shift;
	target.to += shift;
	return { v: 1, id, strokeIds: ["s1"], target, ref: { x: 0, y: 40 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 45 } };
}

const ONE_STROKE = [strokeAt("s1", 10, 41)];
const page = (pageId: string, attachments: AttachmentData[], strokes = ONE_STROKE): PageData => ({ ...emptyPage(pageId), surface: "inline", strokes, attachments });

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

/** One note whose file holds group G, loaded and resolved as an open does; the session list pins G. */
async function rig(word = "benzene", strokes = ONE_STROKE) {
	const path = `attach-external-${++serial}.md`;
	paths.add(path);
	const pageId = `attach-external-id-${serial}`;
	const g = record("att-g", word);
	let disk = page(pageId, [g], strokes);
	let incoming: PageData | null = null;
	const written: PageData[] = [];
	inlineInk.attachHost({
		readPageId: (p: string) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => ({ data: disk, recovered: false }),
		scheduleSidecar(_id: string, snap: PageData) { written.push(snap); },
		prepareExternalAdoption: async () => ({ kind: "prepared", prepared: { pageId, data: incoming!, reused: false, mtime: 1, stamp: "s" } as never }),
		acceptExternalAdoption() {},
		notify() {},
	} as unknown as InlineInkHost);
	await inlineInk.ensureLoaded(path);
	// As load does: the resolved list is the session's.
	inlineInk.setAttachments(path, inlineInk.attachments(path), false);
	const state = { doc: Text.of(DOC.split("\n")) };
	const anchors = new LineAnchors(() => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 }));
	anchors.setSignature({ width: 600, fontPx: 16, charWidth: 9 });
	const win = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined };
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		filePath: () => path,
		view: { state, scaleY: 1, lineBlockAt: (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * 40 }), dom: { ownerDocument: { defaultView: win } } },
		fontZoom: 1,
		followMoved() {},
		lineAnchorState: anchors,
		lineAnchorPassTimer: 0,
		lineDrawnAt: 0,
		selection: { clear: () => false },
		adoptStoredFontRef() {},
		scheduleRepaint() {},
	});
	overlay.lineAnchorInkLoaded(path);
	expect(anchors.follow.groupOf("s1"), "premise: G is followed").toBe("att-g");
	return {
		path, pageId, g, anchors, overlay, written,
		setDisk(next: AttachmentData[]) { disk = page(pageId, next, strokes); },
		async adopt(next: AttachmentData[]) {
			incoming = page(pageId, next, strokes);
			expect((await inlineInk.adoptExternal(path, () => true)).outcome).toBe("adopted");
			overlay.noteExternallyReloaded(path);
		},
		/** As the live-reload poll adopts: the open note is told only when the strokes changed. */
		async adoptAsPoll(next: AttachmentData[]) {
			incoming = page(pageId, next, strokes);
			const result = await inlineInk.adoptExternal(path, () => true);
			expect(result.outcome).toBe("adopted");
			if (result.changed) overlay.noteExternallyReloaded(path);
			return result;
		},
		/**
		 * One tick of the real live-reload poll, its source run as written, adopting the incoming file and telling this
		 * note. What the poll told: one entry per tell, whether it said the strokes changed. Errors it logged are returned.
		 */
		async adoptByPoll(next: AttachmentData[], nextStrokes = strokes) {
			incoming = page(pageId, next, nextStrokes);
			let fire!: () => void;
			let pending: Promise<void> = Promise.resolve();
			const told: (boolean | undefined)[] = [];
			const errors: unknown[] = [];
			const host = {
				store: { externallyChanged: async () => true, hasQueuedWrite: () => false },
				pdfInk: new Map(), pdfIds: new Map(), pdfStore: {},
				pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
				registerInterval: (h: number) => h,
			};
			installLiveReloadPoll.call(
				host,
				{ setInterval(fn: () => void) { fire = fn; return 1; } },
				{ hidden: false },
				(p: Promise<void>) => { pending = p; },
				() => [path],
				inlineInk,
				(p: string, strokesChanged?: boolean) => { told.push(strokesChanged); overlay.noteExternallyReloaded(p, strokesChanged); },
				() => {},
				() => null,
				async () => false,
				{ error: (...e: unknown[]) => void errors.push(e) },
				(p: string) => (p === path ? () => true : null),
			);
			fire();
			await pending;
			return { told, errors };
		},
		/** The note's text changes in the editor (its .md arriving, or a keystroke): its document moves, then the follow hears it. */
		hear(changes: ChangeSet) {
			const startState = { doc: state.doc };
			state.doc = changes.apply(state.doc);
			overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc }, docChanged: true } as unknown as ViewUpdate);
		},
		doc: () => state.doc,
	};
}

/** A line typed at the top of the note on the other device, which saved its ink file with the targets on that text. */
const TYPED = "A line typed on the other device.\n";
const TYPED_DOC = TYPED + DOC;
const typedAtTop = () => ChangeSet.of([{ from: 0, insert: TYPED }], DOC.length);
const storedG = (path: string) => (inlineInk.attachments(path).find((a) => a.id === "att-g") as AttachmentRecord).target;

describe("a synced, restored or reloaded ink file brings its own attached groups", () => {
	it("a restored revision with no attached groups leaves none, on screen and in the file written", async () => {
		// Defect: restoreRevision sets the base page and strokes only, so the session's list outlives the copy it came with
		// and the next write puts the old group back.
		const r = await rig();
		expect(await inlineInk.restoreRevision(r.pageId, page(r.pageId, []))).toBe(r.path);
		expect(inlineInk.attachments(r.path)).toEqual([]);
		expect(r.written.at(-1)?.attachments).toEqual([]);
	});

	it("an adopted synced copy with no attached groups leaves none, on screen and in the file written", async () => {
		// Defect: the adoption replaces the base page and strokes only; the session's list still answers and is written.
		const r = await rig();
		await r.adopt([]);
		expect(inlineInk.attachments(r.path)).toEqual([]);
		inlineInk.setAttachments(r.path, inlineInk.attachments(r.path), true);
		const snap = inlineInk.snapshot(inlineInk.record(r.path));
		expect(snap?.attachments ?? []).toEqual([]);
	});

	it("the file read again with no attached groups leaves none", async () => {
		// Defect: reloadExternal keeps the record, and with it the session's list over the file just read.
		const r = await rig();
		r.setDisk([]);
		await inlineInk.reloadExternal(r.path);
		expect(inlineInk.attachments(r.path)).toEqual([]);
	});

	it("a synced copy that attached the group to other text follows that text, found again in this note", async () => {
		// Defect: the open note keeps following the target it resolved at open; or it takes the incoming offsets as
		// written, which were the other device's and sit off this note's words.
		const r = await rig();
		const incomingG = record("att-g", "toluene", 2);
		await r.adopt([incomingG]);
		const followed = r.anchors.follow.attachments.find((a) => a.id === "att-g") as AttachmentRecord;
		expect(followed.target.from).toBe(DOC.indexOf("toluene"));
		expect(followed.target.to).toBe(DOC.indexOf("toluene") + 7);
		expect(r.anchors.follow.followsText("att-g"), "resolved, no Needs reattachment tag").toBe(true);
	});

	it("a synced copy without the group frees its ink", async () => {
		// Defect: the follow keeps the group the incoming file no longer has; its ink keeps moving with text.
		const r = await rig();
		await r.adopt([]);
		expect(r.anchors.follow.groupOf("s1")).toBeUndefined();
		expect(r.anchors.follow.attachments).toEqual([]);
	});

	it("control: a synced copy with the same attached groups keeps them, every one resolved", async () => {
		const r = await rig();
		const before = r.anchors.follow.attachments;
		await r.adopt([record("att-g", "benzene")]);
		expect(r.anchors.follow.attachments).toEqual(before);
		expect(r.anchors.follow.groupOf("s1")).toBe("att-g");
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});
});

describe("a synced ink file that arrives before its note's text", () => {
	// The other device typed a line above the paragraph and saved both files. Its ink file, with the target at the words'
	// new place, is adopted here first; the note's text with the typed line arrives after it.
	it("a line typed far above the words: the group stands on its words once the text arrives", async () => {
		// Defect: the adopted target, already at the words' new place, is moved by the typed line a second time.
		const r = await rig("toluene");
		const from = DOC.indexOf("toluene");
		expect(from, "premise: the typed line ends outside the words' context").toBeGreaterThan(32);
		const result = await r.adoptAsPoll([record("att-g", "toluene", 0, TYPED_DOC)]);
		expect(result.changed, "premise: the same strokes, so the poll does not tell the note").toBe(false);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(from + TYPED.length);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to)).toBe("toluene");
		expect((r.anchors.follow.attachments.find((a) => a.id === "att-g") as AttachmentRecord).target).toEqual(storedG(r.path));
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});

	it("a line typed just above the words, inside their context: the group stands on its words once the text arrives", async () => {
		// Defect: the same second move; the other device's context already holds the typed line, so the words are not
		// found in this note's old text either.
		const r = await rig("benzene");
		const from = DOC.indexOf("benzene");
		expect(from, "premise: the typed line ends inside the words' context").toBeLessThan(32);
		const result = await r.adoptAsPoll([record("att-g", "benzene", 0, TYPED_DOC)]);
		expect(result.changed, "premise: the same strokes, so the poll does not tell the note").toBe(false);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(from + TYPED.length);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to)).toBe("benzene");
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});

	it("the same near line, the note told of the adoption first: the group stands on its words once the text arrives", async () => {
		// Defect: told first, the note looks for the words in its old text, does not find them and holds the group at the
		// adopted offsets; the arriving text then moves the held target by the typed line again.
		const r = await rig("benzene");
		const from = DOC.indexOf("benzene");
		await r.adopt([record("att-g", "benzene", 0, TYPED_DOC)]);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(from + TYPED.length);
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});

	it("control: the far line, the note told of the adoption first: the group stands on its words", async () => {
		const r = await rig("toluene");
		const from = DOC.indexOf("toluene");
		await r.adopt([record("att-g", "toluene", 0, TYPED_DOC)]);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(from + TYPED.length);
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});

	/** Two groups saved on the other device's text: G just below the typed line, inside its context, and H further down. */
	const nearAndFar = () => [
		record("att-g", "benzene", 0, TYPED_DOC),
		{ ...record("att-h", "toluene", 0, TYPED_DOC), strokeIds: ["s2"], probe: { id: "s2", x: 300, y: 45 } },
	];
	const TWO_STROKES = [strokeAt("s1", 10, 41), strokeAt("s2", 300, 41)];
	const storedH = (path: string) => (inlineInk.attachments(path).find((a) => a.id === "att-h") as AttachmentRecord).target;

	it("two groups, one near the typed line and one far, the note told first: both stand on their words once the text arrives", async () => {
		// Defect: told first, the note finds the far group in its old text and rewrites it, so the list is a new one; the
		// near group is held at the adopted offsets, and the arriving text moves it by the typed line a second time.
		const r = await rig("benzene", TWO_STROKES);
		await r.adopt(nearAndFar());
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(DOC.indexOf("benzene") + TYPED.length);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to), "near group").toBe("benzene");
		expect(storedH(r.path).from).toBe(DOC.indexOf("toluene") + TYPED.length);
		expect(r.doc().sliceString(storedH(r.path).from, storedH(r.path).to), "far group").toBe("toluene");
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
		expect(r.anchors.follow.followsText("att-h")).toBe(true);
	});

	it("the same two groups, the note not told: both stand on their words once the text arrives", async () => {
		const r = await rig("benzene", TWO_STROKES);
		const result = await r.adoptAsPoll(nearAndFar());
		expect(result.changed, "premise: the same strokes").toBe(false);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(DOC.indexOf("benzene") + TYPED.length);
		expect(storedH(r.path).from).toBe(DOC.indexOf("toluene") + TYPED.length);
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
		expect(r.anchors.follow.followsText("att-h")).toBe(true);
	});

	it("two groups, the note told first, the measure it asks for run before the text arrives: both stand on their words", async () => {
		// Defect: the far group, attached on the other device after the line was typed there, is read on another line here;
		// the measure's real followMoved stamps that correction into a new list with no edit, the adoption is no longer seen,
		// and the arriving text moves the near group by the typed line a second time.
		const r = await rig("benzene", TWO_STROKES);
		const [g, h] = nearAndFar();
		await r.adopt([g!, { ...h!, ref: { x: 0, y: 80 } }]);
		Object.assign(r.overlay, { followMoved: (InkOverlayPlugin.prototype as unknown as { followMoved: unknown }).followMoved, lineAnchorsMoved() {} });
		const listBefore = inlineInk.attachments(r.path), follow = r.anchors.follow, before = follow.snapshot();
		const lineTop = (pos: number) => (r.doc().lineAt(pos).number - 1) * 40;
		const m = follow.measure({ inView: () => true, refAt: (pos: number) => ({ x: 0, y: lineTop(pos) }), blockTop: lineTop }, Infinity);
		expect(m.changed, "premise: the far group read moved").toBe(true);
		r.overlay.followMoved(r.path, before);
		expect(inlineInk.attachments(r.path), "premise: the stamp wrote a new list").not.toBe(listBefore);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(DOC.indexOf("benzene") + TYPED.length);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to), "near group").toBe("benzene");
		expect(storedH(r.path).from).toBe(DOC.indexOf("toluene") + TYPED.length);
		expect(r.doc().sliceString(storedH(r.path).from, storedH(r.path).to), "far group").toBe("toluene");
	});

	it("a partial erase of an attached stroke before the text arrives: the group stands on its words once it does", async () => {
		// Defect: the erase's piece joins the group in a new list with no edit, the adoption is no longer seen, and the
		// arriving text moves the group by the typed line a second time.
		const r = await rig("benzene");
		const result = await r.adoptAsPoll([record("att-g", "benzene", 0, TYPED_DOC)]);
		expect(result.changed, "premise: the same strokes").toBe(false);
		const listBefore = inlineInk.attachments(r.path);
		const [taken] = inlineInk.takeLive(r.path, ["s1"]);
		inlineInk.reinsertLive(r.path, [{ index: taken!.index, pieces: [strokeAt("s1-a", 10, 41)], parent: "s1", fresh: true }]);
		expect(inlineInk.attachments(r.path), "premise: the piece wrote a new list").not.toBe(listBefore);
		expect((inlineInk.attachments(r.path)[0] as AttachmentRecord).strokeIds, "premise: the piece joined the group").toEqual(["s1-a"]);
		r.hear(typedAtTop());
		expect(storedG(r.path).from).toBe(DOC.indexOf("benzene") + TYPED.length);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to)).toBe("benzene");
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});

	it("the live-reload poll adopts a synced copy with the same strokes: a held lasso selection stays; with changed strokes it goes", async () => {
		// Defect: the poll now tells the note of every adoption, and telling it always let the selection go, though with
		// the same strokes every selected stroke is still there.
		const r = await rig("benzene");
		const selection = new SelectionModel();
		let redrawn = 0;
		Object.assign(r.overlay, { selection, redrawSelectionUI: () => void redrawn++ });
		selection.selectExactly(["s1"]);
		const same = await r.adoptByPoll([record("att-g", "benzene")]);
		expect(same.errors).toEqual([]);
		expect(same.told.length, "premise: the poll adopted and told the note").toBe(1);
		expect(selection.strokeIds, "same strokes: the selection is held").toEqual(["s1"]);
		expect(redrawn).toBe(0);
		const changed = await r.adoptByPoll([record("att-g", "benzene")], [strokeAt("s1", 10, 41), strokeAt("s3", 200, 41)]);
		expect(changed.errors).toEqual([]);
		expect(changed.told, "premise: the poll told the note its strokes changed").toEqual([true]);
		expect(selection.isEmpty, "changed strokes: the selection goes").toBe(true);
		expect(redrawn).toBe(1);
	});

	it("control: a copy adopted after its text, then a letter typed inside the words' context: the group follows the letter", async () => {
		// The ordinary order: the adopted targets stand on this note's text already, so a keystroke moves them as any
		// keystroke does, and a group is never put on hold for it.
		const r = await rig("benzene");
		const from = DOC.indexOf("benzene");
		const result = await r.adoptAsPoll([record("att-g", "benzene")]);
		expect(result.changed).toBe(false);
		r.hear(ChangeSet.of([{ from: from - 1, insert: "x" }], DOC.length));
		expect(storedG(r.path).from).toBe(from + 1);
		expect(r.doc().sliceString(storedG(r.path).from, storedG(r.path).to)).toBe("benzene");
		expect(r.anchors.follow.followsText("att-g")).toBe(true);
	});
});
