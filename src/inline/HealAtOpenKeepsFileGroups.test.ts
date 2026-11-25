/**
 * A note's ink file holds stroke p0 and one attached group, g0 (p0 on "benzene"). The file cannot be read when the note
 * opens (a busy disk or a sync client mid-write): the note is held, with no page loaded. The user draws s1 on it and
 * attaches s1 to the text with the lasso's Attach, as the app runs it. Then the file reads again (the note opened again)
 * and the note heals.
 *
 * After the heal the file's groups stand and the group made here joins them: g0 and the new group, in the file and in the
 * note, with p0 and s1 both kept.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter; the Attach on a bare overlay over a CodeMirror
 * Text, through the selection's own Attach answer, the measure's read and write, and the step just after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { Text } from "@codemirror/state";
import { BlockType } from "@codemirror/view";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { selectionChips } from "./AttachDecoration";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import type { InlineInkHost } from "./InlineInkStore";
import { invertInkOp, type InkOp } from "./InkHistory";
import { PageIdIndex } from "../model/PageIdIndex";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const P = "Note.md";
const X = "note-id";
const FILE = `.handwriting/${X}.json`;
/** Line height of the bare pane's height map, px. */
const LH = 30;

const DOC = "One line.\nThe word benzene here.\nAnd toluene below, benzene again.\n";

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id, color: "#000", width: 2, tool: "pen",
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 10, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: y - 2, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);
/** Each group as "id:member,member", sorted by id. */
const groupNames = (list: readonly AttachmentData[]): string[] =>
	list.map((a) => `${a.id}:${(a as AttachmentRecord).strokeIds.join(",")}`).sort();

/** g0: p0 attached to the first "benzene" (line 2), its reference point on that line. */
function g0(): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id: "g0", strokeIds: ["p0"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: LH },
		layout: { width: 600, font: 16 }, probe: { id: "p0", x: 5, y: 40 },
	};
}

/**
 * One note on X, the file holding p0 and g0, or as `edit` leaves the file's JSON. `throwNext` makes the next read of the
 * file throw in the adapter; `removeFile` takes the file away.
 */
function rig(edit?: (raw: { strokes: unknown[]; attachments?: unknown[] }) => void) {
	const fake = new FakeAdapter();
	let throwing = false;
	const read = fake.read.bind(fake);
	fake.read = async (path: string): Promise<string> => {
		if (throwing && path === FILE) {
			throwing = false;
			throw new Error("EBUSY: the ink file is being written");
		}
		return read(path);
	};
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const shared = emptyPage(X);
	shared.surface = "inline";
	shared.strokes = [stroke("p0", 5, 40)];
	shared.attachments = [g0()];
	fake.files.set(FILE, serializePage(shared));
	if (edit) {
		const raw = JSON.parse(fake.files.get(FILE)!) as { strokes: unknown[]; attachments?: unknown[] };
		edit(raw);
		fake.files.set(FILE, JSON.stringify(raw));
	}
	const file = Object.assign(new TFile(), { path: P, extension: "md", basename: "Note" });
	const cache = (path: string) => (path === P ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : null);
	const plugin: any = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		pageIdWatchReady: false,
		pageIds: new PageIdIndex(),
		ambiguousIds: new Map<string, string[]>(),
		settings: { pageOwners: {}, cameras: {} },
		store,
		app: {
			vault: {
				adapter: fake,
				getFileByPath: (p: string) => (p === P ? file : null),
				getAbstractFileByPath: (p: string) => (p === P ? file : null),
				getMarkdownFiles: () => [file],
				getFiles: () => [file],
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
		loadSidecar: async (pageId) => store.load(pageId),
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const page = () => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : parsePage(t, X).data;
	};
	const onDisk = (): string[] => ids(page()?.strokes ?? []);
	const groupsOnDisk = (): string[] => groupNames(page()?.attachments ?? []);
	const throwNext = (): void => {
		throwing = true;
	};
	const removeFile = (): void => {
		fake.files.delete(FILE);
	};
	/** Each group's id in the file, sorted (a newer build's group has no members this build reads). */
	const groupIdsOnDisk = (): string[] => ids(page()?.attachments ?? []).sort();
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return { onDisk, groupsOnDisk, groupIdsOnDisk, throwNext, removeFile, drain };
}

/**
 * An editor pane on P over DOC that runs the lasso's Attach as the app does: the selection's own Attach answer (the one
 * the palette command and the Attach button read), the selection's box, the measure's read and write in one frame, then
 * the step just after. Each character is 8 px wide, its letters 16 px high in a 30 px line.
 */
function attachPane() {
	const state = { doc: Text.of(DOC.split("\n")) };
	const block = (n: number) => {
		const l = state.doc.line(n);
		return { from: l.from, to: l.to, top: (n - 1) * LH, bottom: n * LH, height: LH, type: BlockType.Text };
	};
	const view = {
		scaleY: 1, defaultLineHeight: LH, state,
		get viewport() {
			return { from: 0, to: state.doc.length };
		},
		lineBlockAt: (pos: number) => block(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => block(Math.min(state.doc.lines, Math.max(1, Math.floor(h / LH) + 1))),
		coordsAtPos: (pos: number) => {
			const l = state.doc.lineAt(pos), x = (pos - l.from) * 8, top = (l.number - 1) * LH + 7;
			return { left: x, right: x, top, bottom: top + 16 };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature({ width: 600, fontPx: 16, charWidth: 8 });
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	anchors.tracks(P, inlineInk.strokes(P));
	const selection = new SelectionModel();
	let box: { x: number; y: number; width: number; height: number } | null = null;
	/** The steps the pane handed to the editor's history, in order. */
	const steps: InkOp[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		view, filePath: () => P, fontZoom: 1, lineAnchorState: anchors, selection, selectionBounds: () => box,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }) },
		inkInputPanX: () => 0, inkInputPanY: () => 0, cssScale: 1, scale: 1, pinchScaleNow: 1, pinchRefScale: null, pinchPreview: false,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		lineAnchorsMoved() {}, followMoved() {}, retakeLineAnchors() {}, requestFollowMeasure() {}, redrawSelectionUI() {},
		dispatchInk(op: InkOp) {
			steps.push(op);
		},
		endLiveGestureForHistory() {}, scheduleRepaint() {}, repaintPath() {},
	});
	anchors.follow.setList(inlineInk.attachments(P));
	/** The lasso's Attach on the strokes `chosen`: whether it is offered, and whether it ran to its step. */
	const attach = async (chosen: string[]): Promise<{ offered: boolean; ran: boolean }> => {
		selection.selectExactly(chosen);
		const held = inlineInk.strokes(P).filter((s) => chosen.includes(s.id)).map((s) => s.bbox);
		const x = Math.min(...held.map((b) => b.x)), y = Math.min(...held.map((b) => b.y));
		box = { x, y, width: Math.max(...held.map((b) => b.x + b.width)) - x, height: Math.max(...held.map((b) => b.y + b.height)) - y };
		const offered = selectionChips(overlay, inlineInk.attachments(P)).attach;
		if (!offered || !overlay.attachSelected()) return { offered, ran: false };
		await vi.advanceTimersByTimeAsync(0);
		return { offered, ran: true };
	};
	/** The editor's undo of the last step the pane handed to history, then its redo, as the history applies them. */
	const undo = (): void => overlay.applyInkOp(invertInkOp(steps[steps.length - 1]!));
	const redo = (): void => overlay.applyInkOp(steps[steps.length - 1]!);
	return { attach, undo, redo };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	inlineInk.handleDelete(P);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a note whose ink file could not be read when it opened keeps the file's groups when it heals", () => {
	it("a stroke drawn and attached while the file could not be read: after the heal the file's group and the new one both stand, in the file and in the note, and no stroke is lost", async () => {
		const r = rig();
		r.throwNext();
		await inlineInk.ensureLoaded(P).catch(() => false);
		expect(inlineInk.isDamagedLocked(P), "precondition: the read at open threw and holds the note").toBe(true);
		expect(ids(inlineInk.attachments(P)), "precondition: the held note has no group loaded").toEqual([]);

		inlineInk.commit(P, stroke("s1", 60, 70));
		await r.drain();
		expect(ids(inlineInk.strokes(P)), "precondition: the note holds the stroke drawn").toEqual(["s1"]);

		const pane = attachPane();
		const done = await pane.attach(["s1"]);
		expect(done.offered, "precondition: Attach is offered on the held note").toBe(true);
		expect(done.ran, "precondition: the Attach found text and ran").toBe(true);
		const made = ids(inlineInk.attachments(P));
		expect(made.length, "precondition: the Attach made one group").toBe(1);
		await r.drain();
		expect(r.groupsOnDisk(), "precondition: nothing was written while the file could not be read").toEqual(["g0:p0"]);
		expect(r.onDisk(), "precondition: nothing was written while the file could not be read").toEqual(["p0"]);

		await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the read healed").toBe(false);
		const want = ["g0:p0", `${made[0]}:s1`].sort();
		expect.soft(r.groupsOnDisk(), "the heal's save dropped the file's group, or the one made here").toEqual(want);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the file's group, or the one made here").toEqual(want);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
		expect.soft(ids(inlineInk.strokes(P)), "the note lost a stroke").toEqual(["p0", "s1"]);
	});
});

/**
 * The same note held at open, s1 drawn and attached the app's way, and then: the Attach undone before the heal, the file
 * removed before the heal, a first heal whose read throws again, a file holding only a newer build's group, a file holding
 * nothing. Each time the file's groups stand beside what this note made, once, or the note starts fresh when the file is
 * gone; and the heal tells the panes only when what they show changed.
 */
describe("a note held at open whose Attach is undone, whose file goes, or whose next read throws, at the heal", () => {
	/** Held at open, s1 drawn and attached; nothing written. The new group's id and the pane. */
	async function heldWithAttach(r: ReturnType<typeof rig>): Promise<{ made: string; pane: ReturnType<typeof attachPane> }> {
		r.throwNext();
		await inlineInk.ensureLoaded(P).catch(() => false);
		expect(inlineInk.isDamagedLocked(P), "precondition: the read at open threw and holds the note").toBe(true);
		inlineInk.commit(P, stroke("s1", 60, 70));
		await r.drain();
		const pane = attachPane();
		const done = await pane.attach(["s1"]);
		expect(done, "precondition: Attach is offered on the held note and ran").toEqual({ offered: true, ran: true });
		const made = ids(inlineInk.attachments(P));
		expect(made.length, "precondition: the Attach made one group").toBe(1);
		await r.drain();
		return { made: made[0]!, pane };
	}

	it("the Attach undone before the heal: after it the file's group alone, in the file and the note, both strokes kept; a redo then puts the new group back beside it", async () => {
		const r = rig();
		const { made, pane } = await heldWithAttach(r);
		pane.undo();
		await r.drain();
		expect(ids(inlineInk.attachments(P)), "precondition: the undo took the new group away").toEqual([]);

		await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the read healed").toBe(false);
		expect.soft(r.groupsOnDisk(), "the heal's save dropped the file's group, or wrote the undone one").toEqual(["g0:p0"]);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the file's group, or holds the undone one").toEqual(["g0:p0"]);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
		expect.soft(ids(inlineInk.strokes(P)), "the note lost a stroke").toEqual(["p0", "s1"]);

		pane.redo();
		await r.drain();

		const want = ["g0:p0", `${made}:s1`].sort();
		expect.soft(r.groupsOnDisk(), "after the redo the file lost the file's group, or lacks the new one").toEqual(want);
		expect.soft(groupNames(inlineInk.attachments(P)), "after the redo the note lost the file's group, or lacks the new one").toEqual(want);
	});

	it("the file removed before the heal: the note starts fresh with what it made, in the note and the new file, and nothing of the old file comes back", async () => {
		const r = rig();
		const { made } = await heldWithAttach(r);
		r.removeFile();

		await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the lock lifted").toBe(false);
		expect.soft(r.groupsOnDisk(), "the new file lacks the group made here, or holds the old file's").toEqual([`${made}:s1`]);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lacks the group made here, or holds the old file's").toEqual([`${made}:s1`]);
		expect.soft(r.onDisk(), "the new file lacks the stroke drawn here, or holds the old file's").toEqual(["s1"]);
		expect.soft(ids(inlineInk.strokes(P)), "the note lacks the stroke drawn here, or holds the old file's").toEqual(["s1"]);
	});

	it("the first heal's read throws again and the second lands: the file's group and the new one, each once, in the file and the note, no stroke lost", async () => {
		const r = rig();
		const { made } = await heldWithAttach(r);
		r.throwNext();
		await inlineInk.ensureLoaded(P);
		await r.drain();
		expect(inlineInk.isDamagedLocked(P), "precondition: the first heal's read threw and still holds the note").toBe(true);
		expect(r.groupsOnDisk(), "precondition: nothing was written while the file could not be read").toEqual(["g0:p0"]);

		await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the second read healed").toBe(false);
		const want = ["g0:p0", `${made}:s1`].sort();
		expect.soft(r.groupsOnDisk(), "the heal's save dropped a group, or wrote one twice").toEqual(want);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost a group, or holds one twice").toEqual(want);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
		expect.soft(ids(inlineInk.strokes(P)), "the note lost a stroke").toEqual(["p0", "s1"]);
	});

	it("the file holds a newer build's group and no stroke: the heal answers that the note changed, and that group stays beside the new one", async () => {
		const future = { v: 2, id: "gx", strokeIds: [], kind: "a newer build's" };
		const r = rig((raw) => {
			raw.strokes = [];
			raw.attachments = [future];
		});
		const { made } = await heldWithAttach(r);

		const changed = await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the read healed").toBe(false);
		expect.soft(changed, "the heal changed the note's groups and did not say so").toBe(true);
		expect.soft(r.groupIdsOnDisk(), "the heal's save dropped the newer build's group, or the one made here").toEqual(["gx", made].sort());
		expect.soft(ids(inlineInk.attachments(P)).sort(), "the note lost the newer build's group, or the one made here").toEqual(["gx", made].sort());
		expect.soft(r.onDisk(), "the file lost the stroke drawn here").toEqual(["s1"]);
	});

	it("the file holds no stroke and no group: the heal answers that nothing changed, and the note keeps the group it made", async () => {
		const r = rig((raw) => {
			raw.strokes = [];
			delete raw.attachments;
		});
		const { made } = await heldWithAttach(r);

		const changed = await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the read healed").toBe(false);
		expect.soft(changed, "the heal said the note changed when nothing it shows did").toBe(false);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the group made here").toEqual([`${made}:s1`]);
		expect.soft(r.groupsOnDisk(), "the heal's save lacks the group made here").toEqual([`${made}:s1`]);
	});
});

/**
 * The same note held at open, s1 drawn and attached the app's way, and then healed by the sync poll instead of a reopen:
 * the poll finds the file readable again and adopts it. The file's groups stand beside the one made here, in the file and
 * the note, and the poll's answer says the note changed only when what it shows did.
 */
describe("a note held at open, healed by the sync poll", () => {
	/** Held at open, s1 drawn and attached; the host given the two adoption steps the poll calls. The new group's id. */
	async function heldForPoll(r: ReturnType<typeof rig>): Promise<string> {
		Object.assign((inlineInk as unknown as { host: Record<string, unknown> }).host, {
			prepareExternalAdoption: async () => ({ kind: "unavailable", reason: "not used here" }),
			acceptExternalAdoption: () => undefined,
		});
		r.throwNext();
		await inlineInk.ensureLoaded(P).catch(() => false);
		expect(inlineInk.isDamagedLocked(P), "precondition: the read at open threw and holds the note").toBe(true);
		inlineInk.commit(P, stroke("s1", 60, 70));
		await r.drain();
		const pane = attachPane();
		expect(await pane.attach(["s1"]), "precondition: Attach is offered on the held note and ran").toEqual({ offered: true, ran: true });
		const made = ids(inlineInk.attachments(P));
		expect(made.length, "precondition: the Attach made one group").toBe(1);
		await r.drain();
		return made[0]!;
	}

	it("the poll adopts the readable file: it answers adopted and changed, the file's group and the new one stand in the file and the note, and no stroke is lost", async () => {
		const r = rig();
		const made = await heldForPoll(r);

		const res = await inlineInk.adoptExternal(P, () => true);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the poll's read healed").toBe(false);
		const want = ["g0:p0", `${made}:s1`].sort();
		expect.soft(res, "the poll's heal did not answer adopted and changed").toEqual({ outcome: "adopted", changed: true });
		expect.soft(r.groupsOnDisk(), "the heal's save dropped the file's group, or the one made here").toEqual(want);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the file's group, or the one made here").toEqual(want);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
	});

	it("the poll adopts a file holding no stroke and no group: it answers adopted and not changed, and the new group stays in the file and the note", async () => {
		const r = rig((raw) => {
			raw.strokes = [];
			delete raw.attachments;
		});
		const made = await heldForPoll(r);

		const res = await inlineInk.adoptExternal(P, () => true);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the poll's read healed").toBe(false);
		expect.soft(res, "the poll's heal said changed when nothing the note shows did").toEqual({ outcome: "adopted", changed: false });
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the group made here").toEqual([`${made}:s1`]);
		expect.soft(r.groupsOnDisk(), "the heal's save lacks the group made here").toEqual([`${made}:s1`]);
	});
});
