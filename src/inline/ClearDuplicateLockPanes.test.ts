/**
 * A note and its copy carry the same page id, and only the copy is duplicate-locked. Both are open; the copy in an editor
 * pane. While the copy is locked the original draws and saves. When the copy's lock clears and its file is read again,
 * the pane on the copy is told, as after any outside reload: it takes the font size stored with the note, finds its
 * attached groups again in its own text, and repaints. A clear that changed nothing tells no pane. The pane is told when
 * the read lands, even when the copy was locked again meanwhile, and a lasso selection or a drag in hand on the copy is
 * kept.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter, the real delete handler on a plugin built without
 * its constructor; the pane is a bare overlay over a CodeMirror Text, registered as an open overlay is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { instances } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import type { InlineInkHost } from "./InlineInkStore";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const N = "Original.md";
const C = "Original 1.md";
const X = "shared-id";
const FILE = `.handwriting/${X}.json`;
const LH = 30;
const DOC = "One line.\nThe word benzene here.\nLast line.\n";

function stroke(id: string, x = 10, y = 40): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 10, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: y - 2, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);

function group(id: string, members: string[]): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id, strokeIds: members, target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: LH },
		layout: { width: 600, font: 16 }, probe: { id: members[0]!, x: 10, y: LH + 10 },
	};
}

/** Two notes on one id, the shared file holding p0 (and g0 on it with `groups`). `hold` keeps file reads waiting. */
function rig(opts: { groups?: boolean } = {}) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5)];
	if (opts.groups) shared.attachments = [group("g0", ["p0"])];
	fake.files.set(FILE, serializePage(shared));
	let holding = false;
	const waiting: Array<() => void> = [];
	const files = new Map<string, TFile>();
	for (const path of [N, C]) files.set(path, Object.assign(new TFile(), { path, extension: "md", basename: path.slice(0, -3) }));
	const listed = new Set([N, C]);
	const cache = (path: string) => (files.has(path) ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const saves: string[] = [];
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: {}, cameras: {} },
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getAbstractFileByPath: (p: string) => (listed.has(p) ? files.get(p)! : null),
				getMarkdownFiles: () => [...listed].map((p) => files.get(p)!),
				getFiles: () => [...listed].map((p) => files.get(p)!),
			},
			metadataCache: {
				getCache: (p: string) => cache(p),
				getFileCache: (f: { path: string }) => cache(f.path),
			},
		},
	});
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: (path, proposedId) => plugin.claimNotePageId(path, proposedId),
		loadSidecar: async (pageId) => {
			if (holding) await new Promise<void>((go) => waiting.push(go));
			return store.load(pageId);
		},
		scheduleSidecar: (pageId, page) => {
			saves.push(pageId);
			store.schedule(pageId, page);
		},
		scheduleSidecarNow: (pageId, page) => {
			saves.push(pageId);
			return store.saveNow(pageId, page);
		},
		sidecarLanded: (page) => store.hasLanded(page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const onDisk = (): string[] | null => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : ids(parsePage(t, X).data.strokes);
	};
	const hold = (): void => {
		holding = true;
	};
	const release = (): void => {
		holding = false;
		for (const go of waiting.splice(0)) go();
	};
	releaseHeld = release;
	const deleteOriginal = async (): Promise<void> => {
		listed.delete(N);
		const handled = plugin.onFileDeleted(files.get(N));
		inlineInk.handleDelete(N);
		await handled;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { store, fake, saves, onDisk, hold, release, deleteOriginal, drain };
}

let releaseHeld = (): void => undefined;
const opened: InkOverlayPlugin[] = [];

/**
 * An editor pane on the copy: a bare overlay over DOC, registered as an open overlay is, at font reference `refFontPx`.
 * What it is asked to do is counted: repaints, finds of its groups in its text, and selection clears.
 */
function copyPane(refFontPx = 16) {
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = {
		scaleY: 1, state,
		lineBlockAt: (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * LH, bottom: state.doc.lineAt(pos).number * LH }),
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const scheduleRepaint = vi.fn();
	const clearSelection = vi.fn(() => true);
	Object.assign(overlay, {
		view, filePath: () => C, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), frame: { locked: false }, refFontPx,
		selection: { clear: clearSelection }, redrawSelectionUI() {}, scheduleRepaint, requestFollowMeasure() {},
		lineAnchorsMoved() {}, followMoved() {},
	});
	const resolve = vi.spyOn(overlay, "resolveAttachedText");
	overlay.lineAnchors.follow.setList(inlineInk.attachments(C));
	instances.add(overlay);
	opened.push(overlay);
	const type = (changes: ChangeSet): void => {
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(C, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	/** Calls since `mark()`: repaints asked, group finds run for the copy, selection clears. */
	let at = { repaint: 0, resolve: 0, clear: 0 };
	const counts = () => ({
		repaint: scheduleRepaint.mock.calls.length - at.repaint,
		resolve: resolve.mock.calls.filter((c) => c[0] === C).length - at.resolve,
		clear: clearSelection.mock.calls.length - at.clear,
	});
	const mark = (): void => {
		at = { repaint: scheduleRepaint.mock.calls.length, resolve: resolve.mock.calls.filter((c) => c[0] === C).length, clear: clearSelection.mock.calls.length };
	};
	return { overlay, state, type, counts, mark };
}

async function lockedCopyOpen(): Promise<void> {
	inlineInk.markDuplicateLocked(C, N);
	await inlineInk.ensureLoaded(C);
	await inlineInk.ensureLoaded(N);
	for (const p of [C, N]) inlineInk.setAttachments(p, inlineInk.attachments(p), false);
	expect(inlineInk.isDuplicateLocked(C), "precondition: the copy is locked").toBe(true);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(async () => {
	releaseHeld();
	await vi.advanceTimersByTimeAsync(4000);
	for (const o of opened.splice(0)) instances.delete(o);
	vi.useRealTimers();
	inlineInk.handleDelete(N);
	inlineInk.handleDelete(C);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the pane on a copy is told when its lock clears and the file read again changed its ink", () => {
	it("the original drew a stroke: the pane finds its groups again and repaints", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen();
		const p = copyPane();
		inlineInk.commit(N, stroke("e", 80));
		await r.drain();
		expect(r.onDisk(), "precondition: the original's stroke reached the file").toEqual(["p0", "e"]);
		p.mark();

		await r.deleteOriginal();
		await r.drain();
		expect(ids(inlineInk.strokes(C)), "precondition: the copy holds the file's stroke").toEqual(["p0", "e"]);

		expect(p.counts().resolve, "the pane did not find its groups again in its text").toBeGreaterThan(0);
		expect(p.counts().repaint, "the pane was not asked to repaint").toBeGreaterThan(0);
	});

	it("a clear that changed nothing: the pane is not told", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen();
		const p = copyPane();
		p.mark();

		await r.deleteOriginal();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the delete cleared the copy's lock").toBe(false);

		expect(p.counts(), "a clear that changed nothing told the pane").toEqual({ repaint: 0, resolve: 0, clear: 0 });
	});

	it("the copy typed a line above its group: after the clear the group is found on its words in the copy's text, before any keystroke", async () => {
		const r = rig({ groups: true });
		await lockedCopyOpen();
		const p = copyPane();
		p.overlay.lineAnchors.follow.attached(inlineInk.attachments(C)[0] as AttachmentRecord, LH);
		p.type(ChangeSet.of([{ from: 0, insert: "A new line.\n" }], DOC.length));
		inlineInk.commit(N, stroke("e", 80));
		await r.drain();

		await r.deleteOriginal();
		await r.drain();

		const text = p.state.doc.toString();
		const g0 = inlineInk.attachments(C).find((g) => g.id === "g0") as AttachmentRecord | undefined;
		expect(g0?.target.from, "the group is not on its words in the copy's text").toBe(text.indexOf("benzene"));
	});

	it("a drag in hand on the copy: the selection is kept, and the dragged stroke stays where the drag left it", async () => {
		const r = rig();
		await lockedCopyOpen();
		const p = copyPane();
		inlineInk.moveStrokes(C, ["p0"], 7, 0);
		const x = inlineInk.strokes(C).find((s) => s.id === "p0")!.points[0]!.x;
		inlineInk.commit(N, stroke("e", 80));
		await r.drain();
		p.mark();

		await r.deleteOriginal();
		await r.drain();

		expect(p.counts().clear, "the clear dropped the selection in hand").toBe(0);
		expect(inlineInk.strokes(C).find((s) => s.id === "p0")?.points[0]?.x, "the dragged stroke moved back").toBe(x);
	});

	it("locked again while the file is read: the pane is told when the read lands, and nothing is written", async () => {
		const r = rig();
		await lockedCopyOpen();
		const p = copyPane();
		inlineInk.commit(N, stroke("e", 80));
		await r.drain();
		p.mark();
		r.hold();
		const before = r.saves.length;

		await r.deleteOriginal();
		await vi.advanceTimersByTimeAsync(10);
		inlineInk.markDuplicateLocked(C, "Original 2.md");
		r.release();
		await r.drain();
		expect(inlineInk.isDuplicateLocked(C), "precondition: the copy stayed locked").toBe(true);
		expect(ids(inlineInk.strokes(C)), "precondition: the read took the file's stroke").toEqual(["p0", "e"]);

		expect(p.counts().repaint, "the pane was not asked to repaint the stroke the read took").toBeGreaterThan(0);
		expect(r.saves.length - before, "a copy locked again was written").toBe(0);
	});

	it("the copy at another font size than the one the original stored: the pane takes the stored size, and the copy's stroke stays where it was drawn", async () => {
		const r = rig();
		await lockedCopyOpen();
		inlineInk.setFontRefPx(N, 16);
		inlineInk.setFontRefPx(C, 20);
		const p = copyPane(20);
		inlineInk.commit(C, stroke("c1", 70));
		inlineInk.commit(N, stroke("e", 80));
		await r.drain();
		expect(parsePage(r.fake.files.get(FILE)!, X).data.fontRefPx, "precondition: the original stored its size").toBe(16);
		const shownBefore = 70 / 20;

		await r.deleteOriginal();
		await r.drain();

		expect(p.overlay.refFontPx, "the pane kept a font size the copy's ink is no longer in").toBe(16);
		const c1 = inlineInk.strokes(C).find((s) => s.id === "c1")!;
		expect(c1.points[0]!.x / p.overlay.refFontPx, "the copy's stroke moved on screen").toBeCloseTo(shownBefore, 9);
	});
});
