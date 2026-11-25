/**
 * A note's ink file holds stroke p0 and one attached group, g0 (p0 on "benzene"). The note opens before its file has been
 * read. The user draws s1 and attaches it to the text with the lasso's Attach, as the app runs it. Then the file is read:
 * the claim refused on frontmatter Obsidian cannot read, then the frontmatter fixed; the id unreadable at open, the claim
 * answering it while the Attach is made; or a slow first read.
 *
 * Whichever read lands, it lands on a note with no page loaded before: the file's groups stand and the group made here
 * joins them, in the file and in the note, with p0 and s1 both kept. The pane on the note follows the file's group once
 * the read lands, before any keystroke: a line typed above moves p0 with its word, as it moves s1 with its own. An Attach
 * undone before the read leaves the file's groups standing; an undo and a redo after the read keep them through both. The
 * heal of a note held at open, the same.
 *
 * Real InlineInkStore (the plugin's), real PageStore over FakeAdapter; the Attach on a bare overlay over a CodeMirror
 * Text, through the selection's own Attach answer, the measure's read and write, and the step just after. The pane is
 * registered as an open pane is, so what the store tells the open panes reaches it; the follow's measure and the editor's
 * update are the pane's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { instances } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { selectionChips } from "./AttachDecoration";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import type { InlineInkHost } from "./InlineInkStore";
import { UnreadableFrontmatterError } from "./InlineClaim";
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

/**
 * g0: p0 attached to the first "benzene" (line 2), its reference point where the pane reads that word: 8 px a character
 * from the line's start, its letters 7 px below the line's top.
 */
function g0(): AttachmentRecord {
	const from = DOC.indexOf("benzene");
	return {
		v: 1, id: "g0", strokeIds: ["p0"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: (from - DOC.indexOf("The word")) * 8, y: LH + 7 },
		layout: { width: 600, font: 16 }, probe: { id: "p0", x: 5, y: 40 },
	};
}

type ClaimMode = "plain" | "refuse-first" | "gated";

/**
 * One note on X, the file holding p0 and g0. `coldId`: the note's id cannot be read at open (it reads once `idNowReadable`
 * is called). `claim`: the claim answers X; refused once first on frontmatter Obsidian cannot read; or held until
 * `releaseClaim`. `gateLoad`: every read of the file waits for `releaseLoad`. `throwNext` makes the next read throw.
 */
function rig(opts: { coldId?: boolean; claim?: ClaimMode; gateLoad?: boolean } = {}) {
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
	let idReadable = !opts.coldId;
	const file = Object.assign(new TFile(), { path: P, extension: "md", basename: "Note" });
	const cache = (path: string) =>
		path === P ? (idReadable ? { frontmatter: { "handwriting-page-id": X }, sections: [{ type: "yaml" }] } : { sections: [{ type: "yaml" }] }) : null;
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
	let claims = 0;
	let releaseClaim: (() => void) | null = null;
	let releaseLoad: (() => void) | null = null;
	const loadGate = opts.gateLoad ? new Promise<void>((resolve) => { releaseLoad = resolve; }) : null;
	const host: InlineInkHost = {
		readPageId: (path) => plugin.notePageId(path),
		claimId: async () => {
			claims++;
			const mode = opts.claim ?? "plain";
			if (mode === "refuse-first" && claims === 1) throw new UnreadableFrontmatterError();
			if (mode === "gated") await new Promise<void>((resolve) => { releaseClaim = resolve; });
			// The note carried X all along: the claim answers the id it finds.
			return { pageId: X };
		},
		loadSidecar: async (pageId) => {
			if (loadGate) await loadGate;
			return store.load(pageId);
		},
		scheduleSidecar: (pageId, page) => store.schedule(pageId, page),
		scheduleSidecarNow: (pageId, page) => store.saveNow(pageId, page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const page = () => {
		const t = fake.files.get(FILE);
		return t === undefined ? null : parsePage(t, X).data;
	};
	const drain = async (): Promise<void> => {
		for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2000);
		await store.flush();
		for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(2000);
	};
	return {
		drain,
		onDisk: (): string[] => ids(page()?.strokes ?? []),
		groupsOnDisk: (): string[] => groupNames(page()?.attachments ?? []),
		throwNext: (): void => {
			throwing = true;
		},
		idNowReadable: (): void => {
			idReadable = true;
		},
		claims: (): number => claims,
		releaseClaim: (): void => {
			const release = releaseClaim as (() => void) | null;
			releaseClaim = null;
			release?.();
		},
		releaseLoad: (): void => {
			const release = releaseLoad as (() => void) | null;
			release?.();
		},
	};
}

/**
 * An editor pane on P over DOC that runs the lasso's Attach as the app does: the selection's own Attach answer, the
 * selection's box, the measure's read and write in one frame, then the step just after. Each character is 8 px wide, its
 * letters 16 px high in a 30 px line. `undo` and `redo` apply the last step the pane handed to history, as the history does.
 * Registered as an open pane: the store's word to the open panes reaches it. `measure` is the editor's next measure;
 * `typeAbove` a line typed at the top, heard as the editor's update hands it on; `loadAnswered` what the pane's own load
 * runs once its read lands. Its window gives frames that never come, as no frame runs here.
 */
function attachPane() {
	const state = { doc: Text.of(DOC.split("\n")) };
	const block = (n: number) => {
		const l = state.doc.line(n);
		return { from: l.from, to: l.to, top: (n - 1) * LH, bottom: n * LH, height: LH, type: BlockType.Text };
	};
	const win = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined };
	const view = {
		scaleY: 1, defaultLineHeight: LH, state, dom: { ownerDocument: { defaultView: win } },
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
		frame: { locked: false }, refFontPx: 0, handleResize() {},
	});
	anchors.follow.setList(inlineInk.attachments(P));
	instances.add(overlay);
	opened.push(overlay);
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
	const undo = (): void => overlay.applyInkOp(invertInkOp(steps[steps.length - 1]!));
	const redo = (): void => overlay.applyInkOp(steps[steps.length - 1]!);
	const measure = (): void => InkOverlayPlugin.prototype.requestFollowMeasure.call(overlay);
	const typeAbove = (): void => {
		const changes = ChangeSet.of([{ from: 0, insert: "A new line.\n" }], state.doc.length);
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(P, { changes, startState, state: { doc: state.doc }, docChanged: true } as unknown as ViewUpdate);
	};
	const loadAnswered = (): void => overlay.lineAnchorInkLoaded(P);
	return { attach, undo, redo, measure, typeAbove, loadAnswered, follow: anchors.follow };
}

const opened: InkOverlayPlugin[] = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
});

afterEach(() => {
	for (const o of opened.splice(0)) instances.delete(o);
	vi.useRealTimers();
	inlineInk.handleDelete(P);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The file's group and the one made here, in the file and in the note; p0 and s1 in both. */
function bothStand(r: ReturnType<typeof rig>, made: string): void {
	const want = ["g0:p0", `${made}:s1`].sort();
	expect.soft(r.groupsOnDisk(), "the file lost the file's group, or the one made here").toEqual(want);
	expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the file's group, or the one made here").toEqual(want);
	expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
	expect.soft(ids(inlineInk.strokes(P)), "the note lost a stroke").toEqual(["p0", "s1"]);
}

/**
 * The pane follows the file's group as it follows the one made here: told of it once the read lands, before any keystroke;
 * then a line typed above moves p0 with its word, as it moves s1 with its own.
 */
function paneFollows(pane: ReturnType<typeof attachPane>): void {
	expect.soft(pane.follow.groupOf("p0"), "the pane was not told of the file's group: p0 follows no words").toBe("g0");
	expect.soft(pane.follow.followsText("g0"), "the pane does not follow the file's group's words").toBe(true);
	pane.measure();
	pane.typeAbove();
	pane.measure();
	expect(pane.follow.offsetOf("s1"), "precondition: the group made here moved with the line typed above").toEqual({ dx: 0, dy: LH });
	expect.soft(pane.follow.offsetOf("p0"), "the file's attached stroke did not move with its word").toEqual({ dx: 0, dy: LH });
}

/** Drawn s1 and attached it the app's way; the new group's id and the pane. */
async function drawAndAttach(): Promise<{ made: string; pane: ReturnType<typeof attachPane> }> {
	inlineInk.commit(P, stroke("s1", 60, 70));
	await vi.advanceTimersByTimeAsync(0);
	const pane = attachPane();
	expect(await pane.attach(["s1"]), "precondition: Attach is offered and ran").toEqual({ offered: true, ran: true });
	const made = ids(inlineInk.attachments(P));
	expect(made.length, "precondition: the Attach made one group").toBe(1);
	return { made: made[0]!, pane };
}

describe("a group attached before the note's file is first read stands beside the file's groups when the read lands", () => {
	it("the claim refused on frontmatter Obsidian cannot read, s1 attached, the frontmatter fixed: the claim's read keeps the file's group beside the new one, in the file and the note, and the pane follows it", async () => {
		const r = rig({ coldId: true, claim: "refuse-first" });
		await inlineInk.ensureLoaded(P);
		expect(ids(inlineInk.strokes(P)), "precondition: no id readable, nothing loaded").toEqual([]);
		inlineInk.commit(P, stroke("s1", 60, 70));
		await r.drain();
		expect(r.claims(), "precondition: the claim was asked and refused").toBe(1);
		const pane = attachPane();
		expect(await pane.attach(["s1"]), "precondition: Attach is offered and ran").toEqual({ offered: true, ran: true });
		const made = ids(inlineInk.attachments(P));
		expect(made.length, "precondition: the Attach made one group").toBe(1);
		await r.drain();
		expect(r.groupsOnDisk(), "precondition: nothing was written while the claim was refused").toEqual(["g0:p0"]);

		r.idNowReadable();
		inlineInk.retryRefusedClaim(P);
		await r.drain();

		expect(r.claims(), "precondition: the claim ran again").toBe(2);
		bothStand(r, made[0]!);
		paneFollows(pane);
	});

	it("the id unreadable at open, s1 attached while the claim is out, the claim answering the note's id: the claim's read keeps the file's group beside the new one, in the file and the note, and the pane follows it", async () => {
		const r = rig({ coldId: true, claim: "gated" });
		await inlineInk.ensureLoaded(P);
		const { made, pane } = await drawAndAttach();
		expect(r.claims(), "precondition: the claim is out").toBe(1);

		r.idNowReadable();
		r.releaseClaim();
		await r.drain();

		bothStand(r, made);
		paneFollows(pane);
	});

	it("a slow first read, s1 drawn and attached while it is out: the read keeps the file's group beside the new one, in the file and the note, and the pane follows it", async () => {
		const r = rig({ gateLoad: true });
		const loading = inlineInk.ensureLoaded(P);
		const { made, pane } = await drawAndAttach();

		r.releaseLoad();
		await loading;
		pane.loadAnswered();
		await r.drain();

		bothStand(r, made);
		paneFollows(pane);
	});

	it("a slow first read, s1 attached and the Attach undone while it is out: after the read the file's group stands alone, in the file and the note, both strokes kept", async () => {
		const r = rig({ gateLoad: true });
		const loading = inlineInk.ensureLoaded(P);
		const { pane } = await drawAndAttach();
		pane.undo();
		await vi.advanceTimersByTimeAsync(0);
		expect(ids(inlineInk.attachments(P)), "precondition: the undo took the new group away").toEqual([]);

		r.releaseLoad();
		await loading;
		await r.drain();

		expect.soft(r.groupsOnDisk(), "the read's save dropped the file's group, or wrote the undone one").toEqual(["g0:p0"]);
		expect.soft(groupNames(inlineInk.attachments(P)), "the note lost the file's group, or holds the undone one").toEqual(["g0:p0"]);
		expect.soft(r.onDisk(), "the file lost a stroke").toEqual(["p0", "s1"]);
		expect.soft(ids(inlineInk.strokes(P)), "the note lost a stroke").toEqual(["p0", "s1"]);
	});

	it("a slow first read, s1 attached while it is out, then after the read the Attach undone and redone: the file's group stands through both, in the file and the note", async () => {
		const r = rig({ gateLoad: true });
		const loading = inlineInk.ensureLoaded(P);
		const { made, pane } = await drawAndAttach();
		r.releaseLoad();
		await loading;
		await r.drain();

		pane.undo();
		await r.drain();
		expect.soft(r.groupsOnDisk(), "after the undo the file lost the file's group, or kept the undone one").toEqual(["g0:p0"]);
		expect.soft(groupNames(inlineInk.attachments(P)), "after the undo the note lost the file's group, or kept the undone one").toEqual(["g0:p0"]);

		pane.redo();
		await r.drain();
		bothStand(r, made);
	});

	it("the note held at open after a read that threw, s1 attached, then healed by a reopen: the file's group stands beside the new one, in the file and the note", async () => {
		const r = rig();
		r.throwNext();
		await inlineInk.ensureLoaded(P).catch(() => false);
		expect(inlineInk.isDamagedLocked(P), "precondition: the read at open threw and holds the note").toBe(true);
		const { made } = await drawAndAttach();
		await r.drain();

		await inlineInk.ensureLoaded(P);
		await r.drain();

		expect(inlineInk.isDamagedLocked(P), "precondition: the read healed").toBe(false);
		bothStand(r, made);
	});
});
