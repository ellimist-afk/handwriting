/**
 * The note surface's line anchors: the signature and window reads, the update that follows the editor, the old-ink pass, the
 * shown strokes and the retake. They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { type BlockInfo, BlockType, EditorView, ViewUpdate } from "@codemirror/view";
import { type ChangeDesc, type Text } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { inkApplied, inkEffect, type InkOp } from "./InkHistory";
import { ATTACHMENT_CONTEXT, alignShown, attachGroup, attachmentSelection, cellEdgeReached, cellStart, cellWords, detachGroup, insertSpaceMembers, isOpaqueAttachment, refindCollapsed, refindInTables, refreshTarget, resolveAttachments, resolveTarget, sameFileLinkSwaps, startsUndrawn, tableAround, tableCellIn, tableRows, targetAt, wordRangeUnder, wordsIn, type AttachmentData, type AttachmentRecord, type AttachmentStatus, type AttachmentTarget, type AttachStep, type TableCell, type TableRows, type WordPlace } from "./InkAttachments";
import { GROUP_READS_PER_MEASURE, shownList, type AttachFollow, type FollowSnapshot } from "./AttachFollow";
import { newId } from "../model/PageData";
import { InkStroke, type BBox } from "../ink/Stroke";
import { editorLineLayout, type LineLayout, type LineRange, type LineSignature, strokeById } from "./LineAnchor";
import { installMethods } from "./InstallMethods";
import { attachStands } from "./InkOverlayOps";
import { inlineInk, instances, type InkOverlayPlugin } from "./InkOverlay";
import { visualToNote } from "./ZoomScale";
import { Notice } from "obsidian";
import { ATTACH_STRINGS } from "./AttachDecoration";
import type { Point2 } from "../ink/Smoothing";
import { anchorTop } from "./DocumentTop";
import { embedInkChanged } from "./EmbedInk";
import { SPRITE_PAD, type AttachedGroup } from "./InkOverlayAttachedLayer";
import { committedFloorFor } from "./InkOverlayRegistry";
import type { InkReach } from "./FrontierCache";
import type { CameraState } from "../camera/coordinates";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		lineWindowMeasured(): void;
		readLineSignature(view: EditorView): LineSignature;
		lineSignatureMeasured(sig: LineSignature, readAtZoom?: number): void;
		requestLineSignature(): void;
		requestLineBoxes(fresh?: boolean): void;
		updateLineAnchors(u: ViewUpdate): void;
		lineAnchorsDrawn(path: string, doc: Text, src: readonly InkStroke[], measure: boolean, only?: LineRange): void;
		lineAnchorInkLoaded(path: string): void;
		resolveAttachedText(path: string, doc?: Text): void;
		armLineAnchorPass(path: string, ms: number): void;
		lineAnchorsMoved(path: string, read?: boolean): void;
		followMoved(path: string, before: FollowSnapshot): void;
		/** First reads told while the camera moved: their index edits, made at the next still paint. */
		firstsWaiting?: { old: InkStroke; now: InkStroke }[] | null;
		placeFirstsWaiting(): void;
		followMeasureNow(): void;
		/** The rows cache re-place at idle after a follow move; its handle while pending. */
		scheduleRowsIdle(): void;
		rowsIdleRun(): void;
		rowsIdle?: number | null;
		lineOnScreen(): boolean;
		lineLayout(): LineLayout | null;
		noteStrokes(path: string): readonly InkStroke[];
		freeStrokes(path: string): readonly InkStroke[];
		inkReach(path: string): InkReach;
		attachedGroups(path: string): AttachedGroup[];
		paintAttached(cam: CameraState, all: boolean): void;
		exportStrokes(path: string): readonly InkStroke[];
		lineAnchorDy(stroke: InkStroke): number;
		retakeLineAnchors(path: string, ids: readonly string[], dys?: readonly number[]): void;
		applyAttachSettle(op: AttachStep & { path: string }, docChanged?: boolean, live?: boolean): boolean;
		attachSelected(): boolean;
		attachAt(path: string, id: string, ids: readonly string[], target: AttachmentTarget, ref: { x: number; y: number }): void;
		followDocChanged(path: string, u: ViewUpdate): void;
		followRefAt(pos: number, reader?: TableReader, legacy?: (t: TableRows, pos: number) => boolean): { x: number; y: number } | null;
		requestFollowMeasure(): void;
		detachAttachment(path: string, id: string): boolean;
		detachSelected(): boolean;
		/**
		 * A pin dropped at world point `w`: group `id` attaches to the word under the drop, or to the line's paragraph on a
		 * blank part of a text line, with the same id and strokes, each member settled to where it is shown, one step, no ink
		 * moved (attachAt). A drop on no text line says so and changes nothing. False when nothing was asked.
		 */
		dropAttachPin(id: string, w: Point2): boolean;
		expandToAttachedGroups(): void;
		dispatchDrop(path: string, ids: readonly string[], dx: number, dy: number): void;
		spaceGroups(seam: number, rows?: object): { move: Set<string>; hold: Set<string> } | undefined;
		spaceGroupSides(a: number, b: number, rows?: object): boolean;
		spaceStoreIds(ids: string[]): string[];
		spaceHeldShift(path: string, ids: readonly string[], dy: number): InkOp[];
	}
}

/** Each surface's follow measure request: one object, so CodeMirror runs it once per measure however often asked. */
type FollowRead = { changed: boolean; more: boolean; before: FollowSnapshot };
/** A Live Preview table widget as one read phase meets it: its source rows and each shown row's cells, as drawn. */
interface TableDom {
	src: TableRows;
	cells: Element[][];
	/** Each cell's drawn text matched to its source, built at its first read in this read phase; by row * ncol + col. */
	texts: Map<number, CellText | null>;
}
/** One cell's drawn text, matched to its source text. */
interface CellText {
	cell: TableCell;
	/** Each source character's index in the resting drawing (-1: not drawn). A word is placed one to one when all match. */
	rest: Int32Array;
	/** Each source character's index in the text shown now (the nested editor's while the cell is under edit), or -1. */
	map: Int32Array;
	/** The shown text's nodes, each with the index of its first character in the shown text. */
	nodes: { node: CharacterData; start: number }[];
}
/**
 * The table widgets one read phase meets, by their block's start: one walk of each table's DOM per read phase. And the
 * note's whole text, built at most once per read phase (no document change within one).
 */
type TableReader = { table(block: { from: number; to: number }): TableDom | null; text(): string };
/** The drag snapshot each surface's attached layer last painted under. */
const attachedSnaps = new WeakMap<InkOverlayPlugin, object | null>();
const followRequests = new WeakMap<InkOverlayPlugin, { key: object; read: () => FollowRead; write: (m: FollowRead) => void }>();
/** The records list each surface's paint take last checked for a group it has not read: one check per list, not per frame. */
const checkedLists = new WeakMap<InkOverlayPlugin, readonly AttachmentData[]>();
/** The pending adoption each pane last met at a document change: each is looked at once per pane, at the first change after it came. */
const adoptedMet = new WeakMap<InkOverlayPlugin, number>();
/** The text each attached list written by a document change was mapped into: a pane on that text already has the change. */
const mappedInto = new WeakMap<readonly AttachmentData[], Text>();
const NO_SEARCH = { flat: "", starts: [], ends: [] };
/** A line box read that waited on the painted scale tries again at the next frame: its handle while pending. */
const boxRetries = new WeakMap<InkOverlayPlugin, number>();
/** How many line box reads in a row have waited on the painted scale, per surface: past BOX_WAIT_FRAMES no frame is asked. */
const boxWaits = new WeakMap<InkOverlayPlugin, number>();
/**
 * How many frames in a row a waiting line box read tries again. The wait is for a zoom's lift, where CodeMirror measured
 * before the overlay adopted the scale; a mismatch that never clears (an editor inside a scaled container) would read the boxes
 * every frame at rest, so after this many the read waits for the next layout update, which counts again from none.
 */
const BOX_WAIT_FRAMES = 8;
/** A line box read at the next frame, outside CodeMirror's measure (readLineBoxesAtFrame): its handle while pending. */
const boxFrames = new WeakMap<InkOverlayPlugin, number>();
type BoxRead = { path: string; tops: Map<number, number>; reads: number; wait: boolean } | null;
/** Each surface's line box measure request (requestLineBoxes): one object, so CodeMirror runs it once per measure. */
const boxRequests = new WeakMap<InkOverlayPlugin, { key: object; read: () => BoxRead; write: (m: BoxRead) => void }>();

/** How long after the last editor update that drew lines before old ink on the measured lines is anchored, in ms (LineAnchor.ts). */
const LINE_ANCHOR_QUIET_MS = 300;
/** A stroke in no readable group, in the anchor pass's note of members' anchors before it ran. */
const NOT_A_MEMBER = Symbol("not a member");
/**
 * How far the content's painted scale (its box width over its layout width) may sit from the overlay's before the line box read
 * waits, relative. The layout width is an integer, so at a 107 px content box (600 percent) the quotient alone is good to 0.5
 * percent; a zoom step the overlay has not adopted yet is a quarter or more.
 */
const BOX_SCALE_SLACK = 0.01;

/** The lines of each selection range of `u`'s state, 1-based and inclusive, as the anchors take them (LineAnchors.selected). */
function selectionLines(u: ViewUpdate): LineRange[] {
	// A unit rig's update may carry a state with no selection.
	const { doc, selection } = u.state as Partial<ViewUpdate["state"]>;
	if (!doc || !selection) return [];
	return selection.ranges.map((r) => ({ from: doc.lineAt(r.from).number, to: doc.lineAt(r.to).number }));
}

/**
 * An update whose transactions move the selection and do nothing else: no document change, no effect, no reconfiguration.
 * The heights it brings are the lines' own (a block drawn once the cursor leaves it); a fold, an unfold or a mode switch
 * carries an effect or a reconfiguration, and its heights move ink as any layout change's do.
 */
function selectionAlone(u: ViewUpdate): boolean {
	return u.selectionSet && u.transactions.length > 0 && u.transactions.every((tr) => !tr.docChanged && (tr.effects?.length ?? 0) === 0 && !tr.reconfigured);
}

	/** The write of the measure after a document change (lineWindowMeasure). */
	function lineWindowMeasured(this: InkOverlayPlugin): void {
		const path = this.filePath();
		if (path && this.lineAnchors.closeWindow(path, inlineInk.strokes(path))) this.lineAnchorsMoved(path);
	}
	/**
	 * The layout as it is now: the content width, the font size and CodeMirror's character width. Plain reads, made only where
	 * layout is done: a measure's read, the content's resize observer.
	 */
	function readLineSignature(this: InkOverlayPlugin, view: EditorView): LineSignature {
		const charWidth = view.defaultCharacterWidth;
		return {
			width: view.contentDOM.clientWidth,
			fontPx: Number.parseFloat((this.contentStyle ?? this.winRef.getComputedStyle(view.contentDOM)).fontSize),
			charWidth: charWidth > 0 ? charWidth : 0,
		};
	}
	/**
	 * A signature a measure read. A new one reads every correction again, and the record of heights starts again under it from
	 * the lines CodeMirror shows now, marked measured at its next measure or by the old-ink pass. `readAtZoom` is the zoom
	 * the signature was read at; a caller that reads and writes in one step leaves it to the zoom now.
	 */
	function lineSignatureMeasured(this: InkOverlayPlugin, sig: LineSignature, readAtZoom: number = this.pinchScaleNow): void {
		// HELD WHILE THE ZOOM OWNS THE VIEWPORT. Away from 100 percent the content box is the plugin's own counter-sizing, not a
		// re-wrap: the wrap under zoom is the 100 percent wrap. Measured on the round-trip cell, the width read 99, 141, 199, 306,
		// 405 and 519 at the 600 to 120 percent rests and 620 from a preview frame at the release, so no anchor was honoured
		// while zoomed and the release took a preview's signature. The 100 percent signature stands; the read at 100 percent
		// confirms it. The test is on the zoom the read was taken at: a reopened note's read is at 100 percent even when its
		// camera restore committed the saved zoom before this write.
		if (readAtZoom !== 1) return;
		if (!(sig.width > 0) || !(sig.fontPx > 0) || !this.lineAnchors.setSignature(sig)) return;
		const path = this.filePath();
		if (!path) return;
		if (this.lineAnchors.layoutChanged(path, inlineInk.strokes(path), "signature")) this.lineAnchorsMoved(path);
		// After the measure loop's own update: the lines shown may have moved in it, unread, so none is marked here.
		this.lineAnchorsDrawn(path, this.view.state.doc, inlineInk.strokes(path), false);
	}
	/**
	 * Asks for the signature in the next measure. Only where the font can have changed, and at the mount. Never from a layout
	 * update, which the measure loop itself makes, so a request there would cost a second measure on every frame whose heights
	 * changed; never from the content's resize observer, which reads the signature itself (a measure asked for there moved a
	 * recreated note's pending scroll). A view with no measure loop is not asked.
	 */
	function requestLineSignature(this: InkOverlayPlugin): void {
		this.view.requestMeasure?.(this.lineSignatureMeasure);
	}

	/**
	 * Ink that remembers its line (LineAnchor.ts). A document change goes on the anchors' shift log (or, off the drawn lines,
	 * re-takes the anchors at and below it from where their strokes are shown), so typing moves no ink, and opens the rebase
	 * window until a measure has read its lines. A layout update with no document change reads every correction again; when
	 * one changed, the note's ink repaints whole where it now shows. An update from the measure loop carries no transaction:
	 * its measure read the lines the update before it drew, which are marked first, and the window's ranges those complete
	 * close before any correction is read.
	 */
	function updateLineAnchors(this: InkOverlayPlugin, u: ViewUpdate): void {
		const path = this.filePath();
		if (!path) return;
		const anchors = this.lineAnchors, src = inlineInk.strokes(path), measure = u.transactions.length === 0;
		const tracked = anchors.tracks(path, src);
		// `?.`: a unit rig's anchors may be a stand-in without it.
		anchors.selected?.(selectionLines(u));
		// A fold, an unfold or a mode switch whose own update changed no layout brings its heights at the next measure: the
		// settling lines end at the transaction, so those heights move ink as today.
		if (!measure && !u.docChanged && !selectionAlone(u)) anchors.transactionRead?.();
		// The heights of the lines this update drew go on record, from the mount on, whether or not the ink has loaded: lines
		// drawn before it lands are measured all the same. A height drawn in an update is the editor's estimate until its next
		// measure, so the measured prefix takes it only once marked: an update from the measure loop carries no transaction,
		// and marks the lines the update before it drew, before the window is judged. A record with nothing in it (the mount,
		// another note, a new signature) takes the lines drawn now from the first update that brings no document change. A
		// document change alone moved no height but the changed lines', so only those are read, after the change is taken. Ink
		// on the prefix with no anchor this surface honours (an older build's, or one another width or font left) is anchored
		// once the editor has gone quiet, never per scroll frame.
		if (measure && (u.viewportChanged || u.heightChanged || u.geometryChanged || anchors.unseeded)) this.lineAnchorsDrawn(path, this.view.state.doc, src, true);
		if (tracked) {
			if (u.docChanged) {
				anchors.docChanged(path, src, u.startState.doc, u.changes, u.state.doc);
				if (anchors.windowOpen) this.view.requestMeasure(this.lineWindowMeasure);
			} else if (u.geometryChanged) {
				if (anchors.layoutChanged(path, src, measure ? "measure" : selectionAlone(u) ? "selection" : "transaction")) this.lineAnchorsMoved(path);
			} else if (measure && anchors.windowOpen && anchors.windowViewed(path, src)) this.lineAnchorsMoved(path);
		} else if (u.geometryChanged) {
			// No anchored ink and no window open: nothing to re-take or read again, but what was read is now old, and the measured
			// heights move with their lines.
			if (u.docChanged) anchors.skipped(u.startState.doc, u.changes, u.state.doc);
			else anchors.skipped();
		}
		// Ink attached to text (AttachFollow.ts): a document change moves groups by their line block's top now; a layout change
		// or a scroll leaves them for the next measure's read, the last correction held.
		if (u.docChanged) this.followDocChanged(path, u);
		else if (u.geometryChanged || u.heightChanged) anchors.follow.layoutChanged();
		if (anchors.follow.any && (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged)) this.requestFollowMeasure();
		// The drawn anchored lines' boxes are read again in the next measure: until then each keeps the top last read.
		if (tracked && (u.docChanged || u.geometryChanged || u.heightChanged || u.viewportChanged)) this.requestLineBoxes(true);
		if (measure) return;
		if (u.viewportChanged || u.heightChanged || (!u.docChanged && (u.geometryChanged || anchors.unseeded))) this.lineAnchorsDrawn(path, this.view.state.doc, src, false);
		else if (u.docChanged) this.lineAnchorsDrawn(path, this.view.state.doc, src, false, anchors.changedLines);
	}

	/**
	 * Records the heights of the lines CodeMirror has drawn now (LineAnchors.drawn), or of those of them in `only`; `measure`
	 * marks those the update before drew. Arms the old-ink pass when that grew the prefix under ink, or when the lines drawn may
	 * grow it once a measure reads them.
	 */
	function lineAnchorsDrawn(this: InkOverlayPlugin, path: string, doc: Text, src: readonly InkStroke[], measure: boolean, only?: LineRange): void {
		const drawn = this.view.viewport;
		if (!drawn) return;
		this.lineDrawnAt = performance.now();
		let from = doc.lineAt(drawn.from).number, to = doc.lineAt(drawn.to).number;
		if (only) {
			from = Math.max(from, only.from);
			to = Math.min(to, only.to);
		}
		const anchors = this.lineAnchors;
		if (from <= to && (anchors.drawn(from, to, !only, measure) || anchors.markable || this.lineAnchorPassWaits) &&
			// `> 0`, not `=== 0`: a unit rig built with Object.create never runs the field's initialiser.
			src.length > 0 && !(this.lineAnchorPassTimer > 0)) this.armLineAnchorPass(path, LINE_ANCHOR_QUIET_MS);
	}

	/**
	 * The note's ink has loaded: ink landing on lines already measured, or on lines shown that the next measure reads, is anchored
	 * once the editor is quiet, as at a draw.
	 */
	function lineAnchorInkLoaded(this: InkOverlayPlugin, path: string): void {
		const anchors = this.lineAnchors;
		this.resolveAttachedText(path);
		if (inlineInk.strokes(path).length > 0 && (anchors.measuredFor(path) > 0 || anchors.markable) && !(this.lineAnchorPassTimer > 0))
			this.armLineAnchorPass(path, LINE_ANCHOR_QUIET_MS);
		if (inlineInk.strokes(path).length > 0) readLineBoxesAtFrame(this);
	}

	/**
	 * Attached groups are resolved against the text (spec 5.3): a target found elsewhere is rewritten in the session's list
	 * with no write; one not found holds its group at its stored points. Resolving never moves ink. Runs when the ink loads
	 * and again when the ink file is replaced from outside (a synced copy adopted, a revision restored), whose list replaced
	 * the session's: a follow left holding groups the new list lacks lets them go. `doc`: the text to resolve against, when
	 * an update's new text is not yet the view's.
	 */
	function resolveAttachedText(this: InkOverlayPlugin, path: string, doc?: Text): void {
		const follow = this.lineAnchors.follow;
		// A group this resolve holds is checked again against this pane's text when its record changes.
		follow.paneText = () => this.view?.state.doc ?? null;
		const stored = inlineInk.attachments(path);
		if (stored.length === 0) {
			if (follow.attachments.length > 0) follow.setList(stored, new Map());
			return;
		}
		const { list, status } = resolveAttachments(stored as AttachmentData[], (doc ?? this.view.state.doc).toString());
		inlineInk.setAttachments(path, list, false);
		follow.setList(list, status);
		// Its groups are pending until read: the next measure reads those in view, with no editor change to ask for it.
		if (follow.any) this.requestFollowMeasure();
	}

	/**
	 * Anchors the note's ink that has no honoured anchor, on the measured prefix, once LINE_ANCHOR_QUIET_MS have passed since the
	 * last editor update that drew lines; a later update, a pen, a pinch or a fling still running puts it off again. One timer,
	 * re-armed only when it fires early: a scroll costs it nothing per frame. The anchors reach the file at the next ordinary
	 * save; nothing here asks for one.
	 */
	function armLineAnchorPass(this: InkOverlayPlugin, path: string, ms: number): void {
		this.lineAnchorPassWaits = false;
		this.lineAnchorPassTimer = this.winRef.setTimeout(() => {
			this.lineAnchorPassTimer = 0;
			if (this.filePath() !== path) return;
			const wait = this.lineDrawnAt + LINE_ANCHOR_QUIET_MS - performance.now();
			if (wait > 1) {
				this.armLineAnchorPass(path, wait);
				return;
			}
			if (this.frame.locked || this.builder !== null || (this.router?.isStroking ?? false) || (this.router?.hasActiveNavigation ?? false) ||
				this.pinchRefScale !== null) {
				this.armLineAnchorPass(path, LINE_ANCHOR_QUIET_MS);
				return;
			}
			// Off screen no measure reads the lines. The pass waits with no timer for the next lines drawn (the shown editor's
			// measure, a scroll), which arm it again, so a pane hidden for hours costs nothing.
			if (!this.lineOnScreen()) {
				this.lineAnchorPassWaits = true;
				return;
			}
			// Old ink taken on its measured line shows on its words at once: where the editor's estimates hold those words away
			// from the page position, the note's ink repaints where it now shows.
			const gen = this.lineAnchors.generation;
			// Each attached member's anchor before the pass. A read-only view (Reading view, an embed) draws a member by its
			// anchor, and one painted while lines were typed above drew it with none, at its stored place.
			const src = inlineInk.strokes(path), follow = this.lineAnchors.follow;
			const wasAnchor = follow.any ? src.map((s) => (follow.offsetOf(s.id) ? s.lineAnchor : NOT_A_MEMBER)) : null;
			// A note whose file carried no column width takes it from the first anchors taken here (ColumnRef.ts): the hold asked
			// at open found none, and nothing else asks again. Asked before the repaint, so the ink is painted under the held width.
			if (this.lineAnchors.anchorMeasured(path, src) > 0) this.applyColumnHold();
			if (this.lineAnchors.generation !== gen) this.lineAnchorsMoved(path);
			// A member's anchor set or changed: the note's read-only views paint again, once, so they show it on its line at
			// rest. Told to the views alone: the editors' ink-changed listeners would apply a column hold in another pane.
			// Free ink anchored alone tells nothing.
			let membersTook = 0;
			if (wasAnchor) for (let i = 0; i < src.length; i++) if (wasAnchor[i] !== NOT_A_MEMBER && src[i]!.lineAnchor !== wasAnchor[i]) membersTook++;
			if (membersTook > 0) embedInkChanged(path);
			// Lines anchored now are read from their boxes from the next measure on.
			this.requestLineBoxes();
		}, ms);
	}

	/** Shown corrections changed: the copies, the index, the rasters and the frontier all describe the old places. */
	function lineAnchorsMoved(this: InkOverlayPlugin, path: string, read = true): void {
		// Every kept picture of the ink now shows the old places (usableExtent, usableStandIn and standInMarkHolds compare this).
		this.shownMoves++;
		// The move's size, from the line anchors' step. A move no read reported (a membership change, a detach, an attach) has none:
		// a read may have landed before it in the same window, and its step closes with this move, never counted as known.
		const bound = this.lineAnchors.takeStep();
		this.shownSteps[this.shownMoves & 15] = { step: this.shownMoves, bound: read ? bound : null };
		this.frontierCache.invalidate(path);
		this.scheduleRepaint();
	}

	/**
	 * Attached groups moved since `before`: each moved group's swept
	 * rectangle, its members' old and new boxes, is cleared on the attached layer and every sprite it touches is copied
	 * again; each member leaves the index and goes back in at its new place at the same depth. A move between two
	 * corrections moves the shown copies in place and the index entry with them. Free ink, the committed
	 * layers and the extent raster are untouched. An index already waiting for a rebuild (a note just opened) is left to
	 * that rebuild, which reads every member where it is shown then, and the layer still takes the swept rectangles: the
	 * index's state says nothing of where the groups were painted. Where the move cannot be told exactly (a first read, a
	 * member whose old shown object is not known) the attached layer paints whole and the index is rebuilt; a membership
	 * change repaints the committed layers whole, as the free list changed.
	 */
	function followMoved(this: InkOverlayPlugin, path: string, before: FollowSnapshot): void {
		const follow = this.lineAnchors.follow, layer = this.attachedLayer;
		// The members' anchors go with their group's new dy, so Reading view and PDF draw them where the editor shows them; a
		// member whose anchor was carried (no measure read its line) is taken again from a measure by the old-ink pass once
		// the editor is quiet.
		if (this.lineAnchors.retakeMembers(path, inlineInk.strokes(path), before) > 0 && !(this.lineAnchorPassTimer > 0))
			this.armLineAnchorPass(path, LINE_ANCHOR_QUIET_MS);
		// The store's list keeps the correction each group shows now, a move only the measure found too, so the page's next
		// write of any kind (a stroke, an erase) holds where each group was last shown. Not an edit: nothing is written now.
		if (this.lineAnchors.writesAttachments) {
			const stored = inlineInk.attachments(path), stamped = shownList(follow, stored);
			if (stamped !== stored) {
				inlineInk.setAttachments(path, stamped, false);
				follow.setList(stamped);
			}
		}
		// Membership changed: the free list did too, and the committed layers repaint whole.
		if (!layer || before.members !== follow.memberMap) {
			this.lineAnchorsMoved(path, false);
			return;
		}
		// A first read is told exactly too: its members were never painted and are not in the index, so they go in
		// at their shown place and the layer paints their rectangle; the whole index is rebuilt only for an unknown move.
		const list = inlineInk.strokes(path);
		if (follow.onTime) follow.storedCounts[this.lineAnchors.freeHeld(path, list) ? "freeHeld" : "freeMiss"]++;
		const step = follow.movesAndFirsts(before, true, (id) => strokeById(list, id, follow.storedCounts));
		if (!step) {
			// Free ink did not move: only the attached layer paints whole, and the index is rebuilt at its next read.
			this.indexDirty = true;
			layer.invalidate("follow");
			this.scheduleRepaint("partial");
			this.scheduleRowsIdle();
			return;
		}
		const { moves, groups, firsts } = step;
		if (moves.length === 0 && groups.length === 0 && firsts.length === 0) return;
		// A sprite reaches SPRITE_PAD css px past its members' boxes; the cleared rectangle covers it, a pixel to spare.
		const zoom = this.camera.snapshot.zoom, pad = zoom > 0 ? (SPRITE_PAD + 1) / zoom : 0;
		const swept: BBox[] = [];
		// The rebuild puts every member in at its shown place: an edit of an index about to be thrown away is wasted.
		let editIndex = !this.indexDirty;
		// A first read while the camera moves (a fling into pending groups) waits for the still paint to go in the index.
		const waitFirsts = !layer.stillAt(this.camera.snapshot);
		// A told move: the swept rectangle from the group's two boxes; each copy, already moved in place,
		// moves in the index as the same object. A copy the index does not hold leaves it to a rebuild.
		for (const g of groups) {
			const a = g.before, b = g.after, x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
			const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
			swept.push({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad });
			if (!editIndex) continue;
			for (let i = 0; i < g.shown.length; i++) {
				if (this.strokeIndex.moveInPlace(g.shown[i]!, g.boxesBefore[i]!)) continue;
				this.indexDirty = true;
				editIndex = false;
				break;
			}
		}
		for (const group of moves) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const { old, now } of group) {
				for (const b of [old.bbox, now.bbox]) {
					x0 = Math.min(x0, b.x);
					y0 = Math.min(y0, b.y);
					x1 = Math.max(x1, b.x + b.width);
					y1 = Math.max(y1, b.y + b.height);
				}
				if (!editIndex) continue;
				this.strokeIndex.replaceMoved(old, now);
			}
			if (x1 >= x0 && y1 >= y0) swept.push({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad });
		}
		for (const group of firsts) {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const { old, now } of group) {
				const b = now.bbox;
				x0 = Math.min(x0, b.x);
				y0 = Math.min(y0, b.y);
				x1 = Math.max(x1, b.x + b.width);
				y1 = Math.max(y1, b.y + b.height);
				// At the store depth a rebuild gives it; with none known the index is rebuilt at its next read. A
				// member the index holds as stored (a group never shown at a correction) is swapped for its copy.
				if (editIndex && waitFirsts) (this.firstsWaiting ??= []).push({ old, now });
				else if (editIndex && this.strokeIndex.holds(old)) this.strokeIndex.replaceMoved(old, now);
				else if (editIndex && !this.strokeIndex.insertFirst(now, old)) {
					this.indexDirty = true;
					editIndex = false;
				}
			}
			if (x1 >= x0 && y1 >= y0) swept.push({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad });
		}
		// The swept rectangles go to the attached layer alone: a follow never repaints free ink.
		layer.moved(swept);
		// The frontier is not dropped: it merges the groups' boxes at their corrections on each read.
		this.scheduleRepaint("partial");
		this.scheduleRowsIdle();
	}

	/** The first reads a moving camera put off go in the index, as followMoved would have put them; a rebuild has them already. */
	function placeFirstsWaiting(this: InkOverlayPlugin): void {
		const waiting = this.firstsWaiting;
		if (!waiting) return;
		this.firstsWaiting = null;
		if (this.indexDirty) return;
		for (const { old, now } of waiting) {
			if (this.strokeIndex.holds(old)) this.strokeIndex.replaceMoved(old, now);
			else if (!this.strokeIndex.holds(now) && !this.strokeIndex.insertFirst(now, old)) {
				this.indexDirty = true;
				return;
			}
		}
	}

	/**
	 * The insert-space rows cache re-places the moved members at idle, after the follow
	 * move, so the first hover finds the rows current. One pending; the newest move wins. Only a cache already read.
	 */
	function scheduleRowsIdle(this: InkOverlayPlugin): void {
		if (!this.spaceRowsCache?.primed) return;
		const w = this.winRef as Omit<Window, "requestIdleCallback" | "cancelIdleCallback"> & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
		if (this.rowsIdle != null) {
			if (w.requestIdleCallback && w.cancelIdleCallback) w.cancelIdleCallback(this.rowsIdle);
			else w.clearTimeout(this.rowsIdle);
		}
		const run = () => {
			this.rowsIdle = null;
			this.rowsIdleRun();
		};
		// No idle callback (iOS WebKit): a short timer, as scheduleIndexIdle.
		this.rowsIdle = w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 500 }) : w.setTimeout(run, 50);
	}

	/** The idle re-place itself: torn down or never read, nothing. */
	function rowsIdleRun(this: InkOverlayPlugin): void {
		if (!this.container || !this.spaceRowsCache?.primed) return;
		this.spaceRowsCache.get(this.strokesHere());
	}

	/**
	 * Whether the editor is on screen for the anchors: in view (CodeMirror's measure reads no height while it is hidden or
	 * scrolled out of view) and in a visible document (a background tab runs no frame, so no measure).
	 */
	function lineOnScreen(this: InkOverlayPlugin): boolean {
		const view = this.view;
		return !!view && view.inView && view.dom.ownerDocument.visibilityState === "visible";
	}

	/**
	 * Line `pos`'s line element: the child of the content that holds it, when that is a .cm-line. Null where no text line is
	 * drawn there (a block widget, a fold, a line outside the drawn range).
	 */
	function lineBox(view: EditorView, pos: number): HTMLElement | null {
		const at = view.domAtPos(pos), content = view.contentDOM;
		let node: Node | null = at.node === content ? content.childNodes[at.offset] ?? null : at.node;
		while (node && node.parentNode !== content) node = node.parentNode;
		return node && node.nodeType === 1 && (node as HTMLElement).classList.contains("cm-line") ? node as HTMLElement : null;
	}

	/**
	 * The content's rendered vertical scale, its box height over its layout height, by CodeMirror's own rule (getScale in
	 * @codemirror/view): 1 within half a percent of 1 or when the two heights differ by under a px, so at 100 percent the box
	 * and the height map divide by the same 1.
	 */
	function renderedScaleY(boxHeight: number, layoutHeight: number): number {
		if (!(layoutHeight > 0) || !(boxHeight > 0)) return NaN;
		const s = boxHeight / layoutHeight;
		return (s > 0.995 && s < 1.005) || !Number.isFinite(s) || Math.abs(boxHeight - layoutHeight) < 1 ? 1 : s;
	}

	/**
	 * The line box measure's read: each drawn line that anchored ink names, its box top less the document top (DocumentTop's
	 * anchorTop, as the camera reads it), divided by the rendered scale times the font zoom. The rendered scale is the content's
	 * box height over its layout height from the same rect read: the quotient CodeMirror measures its own scaleY by, so while
	 * CodeMirror's scale is that quotient a line's box and its height-map top give the same world top to float noise, where the
	 * nominal cssScale differs from it by the integer layout height's rounding (0.1 against 0.0997807 at 10 percent) and the gap
	 * grows with the line's top. Never CodeMirror's scaleY itself, which lags a zoom under 0.005. One rect read for the rendered
	 * scale, one for the document top and one per line read; none while no anchored line is drawn. Outside an update only.
	 */
	function readLineBoxes(p: InkOverlayPlugin): BoxRead {
		const view = p.view, path = p.filePath();
		if (!view || !path || !p.lineOnScreen()) return null;
		const drawn = view.viewport;
		if (!(p.cssScale > 0) || !(p.fontZoom > 0)) return null;
		const doc = view.state.doc, src = inlineInk.strokes(path), tops = new Map<number, number>();
		const lines = p.lineAnchors.boxLines(path, src, doc.lineAt(drawn.from).number, doc.lineAt(drawn.to).number);
		if (lines.length === 0) return { path, tops, reads: 0, wait: false };
		// The painted scale the overlay holds must be the one the content is painted at now: at a zoom's lift CodeMirror can
		// measure before the overlay adopts the new scale, and a top divided by the old one would be read as the line moving.
		// The content's own box says the scale it is painted at, to its integer layout width; read nothing while they disagree,
		// and every line keeps the top last read, which a zoom alone does not move, until the read at a later frame.
		const content = view.contentDOM, rect = content.getBoundingClientRect();
		const live = content.offsetWidth > 0 ? rect.width / content.offsetWidth : NaN;
		if (!(Math.abs(live - p.cssScale) <= p.cssScale * BOX_SCALE_SLACK)) return { path, tops, reads: 1, wait: true };
		const scale = renderedScaleY(rect.height, content.offsetHeight) * p.fontZoom;
		if (!(scale > 0) || !Number.isFinite(scale)) return { path, tops, reads: 1, wait: false };
		const origin = anchorTop(view, p.contentStyle?.paddingTop, p.cssScale);
		let reads = 2;
		for (const n of lines) {
			const box = lineBox(view, doc.line(n).from);
			if (!box) continue;
			reads++;
			const top = (box.getBoundingClientRect().top - origin) / scale;
			if (Number.isFinite(top)) tops.set(n, top);
		}
		return { path, tops, reads, wait: false };
	}

	/**
	 * The line box read's write: the tops go to the anchors (LineAnchors.boxesRead), the note repaints when a correction moved,
	 * and the page is written when an anchor top moved.
	 */
	function lineBoxesRead(p: InkOverlayPlugin, m: BoxRead): void {
		if (!m || m.path !== p.filePath()) return;
		if (p.lineAnchors.boxesRead(m.path, inlineInk.strokes(m.path), m.tops, m.reads)) p.lineAnchorsMoved(m.path);
		// New ink taken again under its line's first box read moved its anchor top in memory: the page is written again
		// (the store's own save, coalesced as any other), so a reopen shows the stroke on its text.
		if (p.lineAnchors.takeBoxTopMoved()) inlineInk.save(m.path);
		if (!m.wait) {
			boxWaits.delete(p);
			return;
		}
		const waits = (boxWaits.get(p) ?? 0) + 1;
		boxWaits.set(p, waits);
		if (waits <= BOX_WAIT_FRAMES && !boxRetries.get(p)) {
			boxRetries.set(p, p.winRef.requestAnimationFrame(() => {
				boxRetries.set(p, 0);
				p.requestLineBoxes();
			}));
		}
	}

	/**
	 * Asks the next measure to read the drawn anchored lines' boxes (LineAnchors.boxesRead); repaints when a correction moved.
	 * `fresh`, for a request a layout update made: the wait on the painted scale counts its frames again from none.
	 */
	function requestLineBoxes(this: InkOverlayPlugin, fresh = false): void {
		if (fresh) boxWaits.delete(this);
		let req = boxRequests.get(this);
		if (!req) {
			req = { key: {}, read: () => readLineBoxes(this), write: (m) => lineBoxesRead(this, m) };
			boxRequests.set(this, req);
		}
		this.view?.requestMeasure?.(req);
	}

	/**
	 * Reads the drawn anchored lines' boxes at the next frame, outside CodeMirror's measure: for a read no editor change asked
	 * for (the ink loading). A measure request there would run CodeMirror's measure loop past its early exit to its scroll
	 * anchor check, which takes the anchor the last transaction left, so a transaction with no redraw after it (an extension
	 * recreated with a pending owned scroll) would have its anchor applied and the page scrolled when nothing moved.
	 */
	function readLineBoxesAtFrame(p: InkOverlayPlugin): void {
		if (boxFrames.get(p)) return;
		boxFrames.set(p, p.winRef.requestAnimationFrame(() => {
			boxFrames.set(p, 0);
			if (!p.destroyed) lineBoxesRead(p, readLineBoxes(p));
		}));
	}

	/**
	 * CodeMirror's line geometry for the anchors, in its own px below the document top, which is world y times the scale it
	 * measured at times the font zoom. Null while it has no view or no scale.
	 */
	function lineLayout(this: InkOverlayPlugin): LineLayout | null {
		const view = this.view;
		if (!view) return null;
		const px = view.scaleY * this.fontZoom;
		if (!(px > 0) || !Number.isFinite(px)) return null;
		return editorLineLayout(view, px);
	}

	/**
	 * The note's strokes as this surface shows them: each one moved by its line's correction (LineAnchor.ts). Every reader of a
	 * stroke's place on the note surface takes the list here. The store's own list when nothing is moved.
	 */
	function noteStrokes(this: InkOverlayPlugin, path: string): readonly InkStroke[] {
		this.lineAnchors.follow.setList(inlineInk.attachments(path));
		return this.lineAnchors.strokesFor(path, inlineInk.strokes(path));
	}

	/**
	 * This pane's take of the note's records for its paint (freeStrokes, attachedGroups). A group this pane has not read
	 * yet, made, undone or redone in another pane (which changes no text here), asks this pane's own follow measure, so
	 * the next frame reads it in this pane's layout and paints it. The check runs once per list this pane holds, whoever
	 * installed it, so a group the measure skips (out of view) asks no more: it is read when it scrolls in. The same list
	 * again: no check, no request.
	 */
	function paintTake(p: InkOverlayPlugin, path: string): AttachFollow {
		const follow = p.lineAnchors.follow;
		follow.setList(inlineInk.attachments(path));
		const list = follow.attachments;
		if (p.view && checkedLists.get(p) !== list) {
			checkedLists.set(p, list);
			if (follow.unread) p.requestFollowMeasure();
		}
		return follow;
	}

	/**
	 * The note's shown strokes in no attached group: what the committed layers and the extent raster hold.
	 * noteStrokes's own list when the note has no group. The same object across a follow move.
	 */
	function freeStrokes(this: InkOverlayPlugin, path: string): readonly InkStroke[] {
		const follow = paintTake(this, path);
		// No group: noteStrokes's own list. With groups the shown list is not built here: free ink is never moved by a follow.
		return follow.memberMap.size === 0 ? this.noteStrokes(path) : this.lineAnchors.freeFor(path, inlineInk.strokes(path)).free;
	}

	/**
	 * The ink's reach for the surface extent: free ink's frontier, cached on the free list,
	 * merged with each shown group's box at its correction. Never noteStrokes: a follow changes no free stroke, so it
	 * costs a merge over about one box per group, and the frontier keeps its object while its value holds.
	 */
	function inkReach(this: InkOverlayPlugin, path: string): InkReach {
		const free = this.freeStrokes(path);
		const follow = this.lineAnchors.follow;
		if (follow.memberMap.size === 0) return this.frontierCache.reach(path, free, []);
		const { members } = this.lineAnchors.freeFor(path, inlineInk.strokes(path));
		return this.frontierCache.reach(path, free, follow.shownBoxes(members));
	}

	/**
	 * The attached groups this surface paints now: each read group's members as stored and its correction. A pending
	 * group is left out (never shown at a place it is about to leave), and so are members a lasso or Insert Space drag has
	 * lifted, which ride the drag's picture.
	 */
	function attachedGroups(this: InkOverlayPlugin, path: string): AttachedGroup[] {
		const follow = paintTake(this, path);
		if (!follow.any) return [];
		const { members } = this.lineAnchors.freeFor(path, inlineInk.strokes(path));
		const lifted = this.spaceSnapshot?.ids;
		const out: AttachedGroup[] = [];
		// Store order: the member map is filled in store order, so groups come by their first member.
		for (const [id, stored] of members) {
			const offset = follow.groupOffset(id);
			let ms = stored;
			if (!offset) continue;
			if (lifted && lifted.size > 0 && ms.some((s) => lifted.has(s.id))) ms = ms.filter((s) => !lifted.has(s.id));
			if (ms.length === 0) continue;
			const list = ms;
			out.push({ id, members: list, offset, shown: () => list.map((s) => follow.shown(s) ?? s) });
		}
		return out;
	}

	/** Each attachments list's group ids, kept per list object: a store list is replaced, never changed in place. */
	const groupIdsOfList = new WeakMap<readonly AttachmentData[], ReadonlySet<string>>();
	function groupIdsOf(list: readonly AttachmentData[]): ReadonlySet<string> {
		let ids = groupIdsOfList.get(list);
		if (!ids) {
			ids = new Set(list.filter((a) => !isOpaqueAttachment(a)).map((a) => (a as AttachmentRecord).id));
			groupIdsOfList.set(list, ids);
		}
		return ids;
	}

	/**
	 * The attached layer's paint for this frame, after the committed layers': whole when they painted whole or the camera
	 * moved, else the rectangles a follow moved. A note with no group and a blank layer reaches no canvas.
	 */
	function paintAttached(this: InkOverlayPlugin, cam: CameraState, all: boolean): void {
		const layer = this.attachedLayer;
		if (!layer) return;
		const path = this.filePath();
		const groups = path ? this.attachedGroups(path) : [];
		if (groups.length === 0 && !layer.live) return;
		// A drag lifting members, or its end, changes what the layer shows everywhere.
		const snap = this.spaceSnapshot ?? null;
		if (attachedSnaps.get(this) !== snap) {
			attachedSnaps.set(this, snap);
			layer.invalidate("lift");
		}
		const backing = this.committedBacking ?? 0;
		if (this.firstsWaiting && layer.stillAt(cam)) this.placeFirstsWaiting();
		// No sprite is built while the camera moves: a fling or pan preview draws new groups by path, culled, and
		// one more paint at the still camera builds them.
		layer.paint(cam, groups, all, committedFloorFor(this.committedBacking, this.dpr), {
			backingW: this.committedCanvas.width, backingH: this.committedCanvas.height, backing, cssW: this.cssWidth, cssH: this.cssHeight,
		}, layer.stillAt(cam), path ? groupIdsOf(inlineInk.attachments(path)) : null);
		if (layer.buildWaits) this.scheduleRepaint("partial");
	}

	/**
	 * The note's strokes for an export, every stored stroke once, in store order, where this surface shows it: an attached
	 * group's member at its group's correction (a group not read here yet at the correction its record kept), free ink at
	 * its line's correction (the store's own object at none). Never the shown list: it leaves a pending group's members
	 * out. No point settles at a write, so the store keeps the place each stroke was drawn or attached at.
	 */
	function exportStrokes(this: InkOverlayPlugin, path: string): readonly InkStroke[] {
		const anchors = this.lineAnchors, follow = anchors.follow;
		follow.setList(inlineInk.attachments(path));
		const members = follow.memberMap;
		return inlineInk.strokes(path).map((s) => (members.has(s.id) ? follow.exported(s) : anchors.shownOf(s)));
	}

	/** How far this surface shows a stroke below its page position, world units. */
	function lineAnchorDy(this: InkOverlayPlugin, stroke: InkStroke): number {
		return this.lineAnchors.dyOf(stroke);
	}

	/**
	 * Strokes a move has just landed (a lasso drop, an undo or redo of one): each rides the line it now sits on (LineAnchors.retake).
	 * `dys`: each stroke of `ids`, in that order, taken at the correction given (an attach step).
	 */
	function retakeLineAnchors(this: InkOverlayPlugin, path: string, ids: readonly string[], dys?: readonly number[]): void {
		const src = inlineInk.strokes(path);
		if (!dys) {
			const wanted = new Set(ids);
			this.lineAnchors.retake(path, src.filter((s) => wanted.has(s.id)), undefined, src);
			return;
		}
		const byId = new Map(src.map((s) => [s.id, s] as const)), list: InkStroke[] = [], at: number[] = [];
		ids.forEach((id, i) => {
			const s = byId.get(id);
			if (!s) return;
			list.push(s);
			at.push(dys[i]!);
		});
		this.lineAnchors.retake(path, list, at, src);
	}

	/**
	 * An attach step, live or from history: applied only where the step left the record (Q9)
	 * and, when it settles, while the note holds every member; else spent, false. The members' places as shown before the
	 * step are read and the points settle to them: a step that frees the members stores each where it is shown; one that
	 * puts a group back stores each where it is shown less the one correction the group shows by. The list
	 * changes, and each own anchor is taken again at the shown place less the new stored place, so nothing shown moves
	 * whichever way the step goes. A step from history with no text change of its own (the undo or redo of an Attach that
	 * ended a hold) takes its records at the offsets the text changes since have moved them to (AttachFollow.carried).
	 * One that puts a record back (the undo of a Detach, the redo of an Attach) holds the offsets it was made with, which
	 * typing in another pane, or a change not in this pane's history, may have left off its words: its target is read
	 * against this pane's text now (AttachFollow.putBack: first where the record this pane let go of was carried to, then
	 * by its words and context). Found, the record takes that place; not found, it is put back as needing reattachment,
	 * and nothing moves. Its redo (the redo of a Detach) takes away a record history holds at those first offsets while
	 * the store holds it where it was found: the record of that id that is the step's own but for its target's place and
	 * context, its words the same, is the one it takes away.
	 */
	function applyAttachSettle(this: InkOverlayPlugin, op: AttachStep & { path: string }, docChanged = false, live = false): boolean {
		let gone: string | null = null;
		if (!docChanged && !live) {
			const view = this.view && this.filePath() === op.path ? this.view : null;
			const doc = view ? () => view.state.doc.toString() : undefined;
			op = { ...op, ...this.lineAnchors.follow.carried(op, inlineInk.attachments(op.path).find((a) => a.id === op.id), doc) };
			if (view && !op.before && op.after && !isOpaqueAttachment(op.after)) {
				const found = this.lineAnchors.follow.putBack(op.after, view.state.doc.toString());
				if (!found) gone = op.after.id;
				else if (found !== op.after.target) op = { ...op, after: { ...op.after, target: found } };
			} else if (op.before && !op.after && !isOpaqueAttachment(op.before)) {
				const now = inlineInk.attachments(op.path).find((a) => a.id === op.id), t = op.before.target;
				if (now && !isOpaqueAttachment(now) && now.target !== t && now.target.kind === t.kind && now.target.text === t.text)
					op = { ...op, before: { ...op.before, target: now.target } };
			}
		}
		const path = op.path, list = attachStands(op, docChanged), st = op.settle;
		if (!list) return false;
		const byId = new Map(inlineInk.strokes(path).map((s) => [s.id, s] as const)), anchors = this.lineAnchors;
		const ids = st?.strokeIds ?? (op.after ?? op.before)?.strokeIds.filter((id) => byId.has(id)) ?? [];
		anchors.follow.setList(inlineInk.attachments(path));
		const shownBox = ids.map((id) => anchors.shownOf(byId.get(id)!).bbox), shownY = shownBox.map((b) => b.y);
		// Each member's move to where it is shown.
		const shift = ids.map((id, i) => ({ dx: shownBox[i]!.x - byId.get(id)!.bbox.x, dy: shownBox[i]!.y - byId.get(id)!.bbox.y }));
		// The correction the group shows by after a step that settles and puts it back, for the members it keeps; none
		// for a step that frees them, and none for the members it frees (free ink after the step, stored where shown).
		// Its guess: each kept member's shown first point less the place the step recorded for it (`from` plus its move),
		// the value most of them share; ties to the smallest, then the first member. Members moved apart since the step
		// keep their own places in the group, and the group follows its words from where most of its ink is.
		let o: { dx: number; dy: number } = { dx: 0, dy: 0 };
		const kept = new Set(op.after?.strokeIds ?? []);
		if (st && op.after) {
			const tally = new Map<string, { dx: number; dy: number; n: number }>();
			let g = { dx: 0, dy: 0, n: 0 };
			st.strokeIds.forEach((id, i) => {
				if (!kept.has(id)) return;
				const p = byId.get(id)!.points[0]!;
				const dx = p.x + shift[i]!.dx - (st.from[i]!.x + st.dx[i]!), dy = p.y + shift[i]!.dy - (st.from[i]!.y + st.dy[i]!);
				const key = `${Math.round(dx * 1e6)},${Math.round(dy * 1e6)}`;
				const t = tally.get(key) ?? tally.set(key, { dx, dy, n: 0 }).get(key)!;
				t.n++;
				if (t.n > g.n || (t.n === g.n && t !== g && Math.abs(t.dx) + Math.abs(t.dy) < Math.abs(g.dx) + Math.abs(g.dy))) g = t;
			});
			o = { dx: g.dx, dy: g.dy };
		}
		anchors.follow.setList(list, gone === null ? undefined : heldStatus(anchors.follow, list, gone));
		// A redo shows the group at once at its record's place, never a pending frame; a live Attach then
		// sets its own read (attachAt). A read of this layout that stands is the group's correction, and the members
		// settle to it. With none to take, the group is seeded at the guess (a step with no settle: where its ink was shown
		// less where it is stored) and a history step asks the next measure for the text's place; a live Attach (`live`)
		// reads its own point just after, and asks nothing.
		if (op.after && this.view && this.filePath() === path && movesWithText(this, op.after)) {
			const i = ids.findIndex((id) => byId.has(id));
			const carry = st ? o : i < 0 ? undefined : shift[i];
			if (anchors.follow.seeded(op.after, this.view.lineBlockAt(op.after.target.from).top, carry)) {
				if (!live) this.requestFollowMeasure();
			} else if (st) o = anchors.follow.groupOffset(op.after.id) ?? o;
		} else if (st && op.after) {
			// A group that does not move with its text yet. A live Attach places it at its new point with no correction
			// (attachAt, follow.attached), so it ends a hold with every member stored where it is shown; any other step
			// keeps the group shown by its last read.
			o = live ? { dx: 0, dy: 0 } : anchors.follow.groupOffset(op.after.id) ?? o;
		}
		if (st) {
			// Each kept member stored where it is shown less the group's correction, each freed one where it is shown. One
			// store pass per distinct move, not per member: a Detach is one pass, an Attach one per correction it settles.
			// A freed member another group of the new list holds is that group's and stays as it stores it: the undo of a
			// group attach puts the absorbed groups back first, then takes the merged group back to its own members
			// (the follow's map is the new list's, set just above).
			const byMove = new Map<string, { dx: number; dy: number; ids: string[] }>(), holder = anchors.follow.memberMap;
			st.strokeIds.forEach((id, i) => {
				if (!kept.has(id) && holder.has(id)) return;
				const c = kept.has(id) ? o : { dx: 0, dy: 0 };
				const dx = shift[i]!.dx - c.dx, dy = shift[i]!.dy - c.dy, key = `${dx},${dy}`;
				const m = byMove.get(key) ?? byMove.set(key, { dx, dy, ids: [] }).get(key)!;
				m.ids.push(id);
			});
			for (const m of byMove.values()) inlineInk.moveStrokes(path, m.ids, m.dx, m.dy);
			for (const p of instances) if (p === this || p.filePath() === path) p.indexDirty = true;
		}
		// Not counted as an edit (the save below writes it), but a user action on the group: Attach, Detach, its undo or redo.
		inlineInk.setAttachments(path, list, false, true);
		this.retakeLineAnchors(path, ids, ids.map((id, i) => shownY[i]! - byId.get(id)!.bbox.y));
		inlineInk.save(path);
		return true;
	}

	/**
	 * Each record of `list` as this pane holds it now, `gone` as needing reattachment: the status a record put back with its
	 * words nowhere in the text is followed with, every other group's hold kept as it stands.
	 */
	function heldStatus(follow: AttachFollow, list: readonly AttachmentData[], gone: string): Map<string, AttachmentStatus> {
		const status = new Map<string, AttachmentStatus>();
		for (const a of list) {
			const held = a.id === gone || isOpaqueAttachment(a) || (a.target.to > a.target.from && !follow.followsText(a.id));
			status.set(a.id, held ? "needs-reattachment" : "resolved");
		}
		return status;
	}

	/** The members of a step that settles, with their first points: those the store holds, with points. */
	function settleMembers(path: string, ids: readonly string[]): InkStroke[] {
		const byId = new Map(inlineInk.strokes(path).map((s) => [s.id, s] as const));
		return ids.flatMap((id) => {
			const s = byId.get(id);
			return s && s.points.length > 0 ? [s] : [];
		});
	}

	/**
	 * Detach a group: one attach step to none that settles every member by the group's
	 * correction, x and y; each own anchor is taken where it is shown. Nothing moves on any pane; one undo puts it back.
	 */
	function detachAttachment(this: InkOverlayPlugin, path: string, id: string): boolean {
		const op = detachApplied(this, path, id);
		if (!op) return false;
		this.dispatchInk(op);
		this.lineAnchorsMoved(path, false);
		return true;
	}

	/**
	 * A Detach's step made from `list`, not applied: every member settles by the group's correction, x and y. Null when
	 * `list` holds no readable record of `id`.
	 */
	function detachStep(overlay: InkOverlayPlugin, path: string, list: readonly AttachmentData[], id: string): (AttachStep & { path: string }) | null {
		const { step } = detachGroup(list, id);
		if (!step?.before) return null;
		overlay.lineAnchors.follow.setList(list);
		const o = overlay.lineAnchors.follow.groupOffset(id) ?? { dx: 0, dy: 0 };
		const members = settleMembers(path, step.before.strokeIds), strokeIds = members.map((s) => s.id);
		const from = members.map((s) => ({ x: s.points[0]!.x, y: s.points[0]!.y }));
		return { ...step, path, settle: { strokeIds, dx: strokeIds.map(() => o.dx), dy: strokeIds.map(() => o.dy), from } };
	}

	/** A Detach's step made from the list as it stands and applied (applyAttachSettle): the step to record, or null. */
	function detachApplied(overlay: InkOverlayPlugin, path: string, id: string): InkOp | null {
		const op = detachStep(overlay, path, inlineInk.attachments(path), id);
		return op && overlay.applyAttachSettle(op) ? op : null;
	}

	/**
	 * The lasso's Attach: to the words under the selection box when it sits inside one visual row, else to the paragraph
	 * whose line block holds the box's centre y, read from the height map here (where that is no text line, the text line
	 * the box's span overlaps nearest the centre, overlappedTextLine); the target and its reference point are
	 * read in the next measure, and the step is made just after it
	 * (a measure's write may not dispatch). Each member settles by its own correction, so the group starts at none and
	 * nothing moves. False when Attach is off for the selection or nothing can be read.
	 */
	function attachSelected(this: InkOverlayPlugin): boolean {
		const path = this.filePath(), view = this.view, sig = this.lineAnchors.sig;
		if (!path || !view || !sig) return false;
		const sel = attachmentSelection(inlineInk.attachments(path), this.selection.strokeIds);
		const box = this.selectionBounds(), px = view.scaleY * this.fontZoom;
		if (!sel.attach || !box || !(px > 0)) return false;
		const h = (box.y + box.height / 2) * px, doc = view.state.doc;
		let block = view.lineBlockAtHeight(h), above: { from: number; to: number } | null = null;
		// Where the centre finds no text line, ink taller than its line (a box from above the words to well under them) takes
		// the text line its span overlaps nearest the centre; overlapping none, the nearest text line up to two lines from
		// the box, across blank lines (reachedTextLine); with none in reach, it attaches nothing.
		const overlapped = () => {
			const top = box.y * px, bottom = (box.y + box.height) * px;
			return overlappedTextLine(view, top, bottom, h) ?? reachedTextLine(view, top, bottom, 2 * view.defaultLineHeight);
		};
		if (h < block.top) {
			const o = overlapped();
			if (!o) return false;
			block = o;
		} else if (block.to <= block.from || h >= block.bottom) {
			// On a blank line or below the note's last line: up to a quarter line under the text line just above (an
			// underline under its last row), the box is that line's, with no line above. A widget block is not a text line.
			const prev = h >= block.bottom ? block : block.top > 0 ? view.lineBlockAtHeight(block.top - 1) : null;
			if (prev && prev.to > prev.from && prev.from <= block.from && !isWidgetBlock(prev) && h - prev.bottom <= view.defaultLineHeight / 4) block = prev;
			else {
				const o = overlapped();
				if (!o) return false;
				block = o;
			}
		} else {
			// A box just below a line's last row (an underline under its descenders) is that row's: the line above is read too.
			// A widget block above (Properties, a block embed) is not a line of text: it is not read.
			const up = block.top > 0 ? view.lineBlockAtHeight(block.top - 1) : null;
			above = up && up.from < block.from && up.to > up.from && !isWidgetBlock(up) ? up : null;
		}
		const text = doc.toString(), id = sel.groupIds[0] ?? newId("att"), at = block;
		view.requestMeasure({
			read: () => {
				const target = attachTargetIn(this, text, at, box, above);
				if (!target) return "empty" as const;
				const ref = this.followRefAt(target.from);
				return ref ? { target, ref } : null;
			},
			write: (m) => {
				// An empty table cell: nothing attaches, and Attach says so with today's words.
				if (m === "empty") new Notice(ATTACH_STRINGS.noText);
				else if (m) queueMicrotask(() => {
					if (view.state.doc === doc && this.filePath() === path) this.attachAt(path, id, sel.expandedIds, m.target, m.ref);
				});
			},
		});
		return true;
	}

	function dropAttachPin(this: InkOverlayPlugin, id: string, w: Point2): boolean {
		const path = this.filePath(), view = this.view;
		if (!path || !view) return false;
		const a = inlineInk.attachments(path).find((x) => x.id === id);
		const px = view.scaleY * this.fontZoom;
		if (!a || isOpaqueAttachment(a) || !(px > 0)) return false;
		const { h, block } = pinBlockAt(view, w.y * px, () => (rowPitch(this) / 2) * px), doc = view.state.doc, text = doc.toString();
		// A table's line in Source mode (a row or its separator) refuses, as Live Preview's table widget does: there a pipe,
		// the separator, a cell's padding or a word with markup would be read at the widget's edge, off its word.
		if (h < block.top || h >= block.bottom || block.to <= block.from || isWidgetBlock(block) || sourceRowAt(text, block) !== null) {
			new Notice(ATTACH_STRINGS.noText);
			return false;
		}
		const at = { from: block.from, to: block.to };
		view.requestMeasure({
			read: () => {
				const target = pinTargetAt(this, text, at, w);
				const ref = this.followRefAt(target.from);
				return ref ? { target, ref } : null;
			},
			write: (m) => {
				if (m) queueMicrotask(() => {
					if (view.state.doc !== doc || this.filePath() !== path) return;
					const cur = inlineInk.attachments(path).find((x) => x.id === id);
					if (!cur || isOpaqueAttachment(cur)) return;
					const t = cur.target;
					// The same words: nothing to change while the group follows them.
					if (t.kind === m.target.kind && t.from === m.target.from && t.to === m.target.to && this.lineAnchors.follow.followsText(id)) return;
					this.attachAt(path, id, cur.strokeIds, m.target, m.ref);
					this.redrawSelectionUI();
				});
			},
		});
		return true;
	}

	/**
	 * A pin drop's target, read in a measure, at the pin's point `w`: the visual row whose letters' top is nearest the
	 * point, in `block` or the text line half a row above or below it, so under half a row of drift up or down keeps the
	 * row and past it the next row is nearer; on that row the word whose letters hold the point across, else that row's
	 * paragraph. No row within a row's height: `block`'s paragraph. A word broken across two rows is not taken. No read
	 * while a pinch owns the viewport: the paragraph.
	 */
	function pinTargetAt(p: InkOverlayPlugin, text: string, block: { from: number; to: number }, w: Point2): AttachmentTarget {
		const paragraph = (b: { from: number; to: number }) => targetAt(text, b.from, b.to, "paragraph");
		const at = wordPlaceReader(p);
		if (!at) return paragraph(block);
		const pitch = rowPitch(p), px = p.view.scaleY * p.fontZoom, blocks: { from: number; to: number }[] = [block];
		for (const y of [w.y - pitch / 2, w.y + pitch / 2]) {
			const b = p.view.lineBlockAtHeight(y * px);
			if (b.to > b.from && !isWidgetBlock(b) && sourceRowAt(text, b) === null && !blocks.some((x) => x.from === b.from)) blocks.push(b);
		}
		type Placed = { from: number; to: number; b: { from: number; to: number }; x0: number; x1: number; top: number; tall: number };
		const placed: Placed[] = [];
		for (const b of blocks) for (const word of wordsIn(text, b.from, b.to)) {
			const s = at(word.from, 1), e = s ? at(word.to, -1) : null;
			if (!s || !e || Math.abs(e.top - s.top) > (s.bottom - s.top) / 2) continue;
			placed.push({ from: word.from, to: word.to, b, x0: s.x, x1: e.x, top: s.top, tall: s.bottom - s.top });
		}
		let row: Placed | null = null;
		for (const q of placed) {
			const d = Math.abs(w.y - q.top);
			if (d <= Math.max(pitch, q.tall) && (!row || d < Math.abs(w.y - row.top))) row = q;
		}
		if (!row) return paragraph(block);
		const r = row;
		const word = placed.find((q) => q.b === r.b && Math.abs(q.top - r.top) <= r.tall / 2 && w.x >= q.x0 && w.x <= q.x1);
		return word ? targetAt(text, word.from, word.to, "range") : paragraph(r.b);
	}

	/** The editor's row pitch, world units: its default line height on screen. 0 when unknown. */
	function rowPitch(p: InkOverlayPlugin): number {
		const zero = p.camera.screenToWorld(visualToNote(0, p.cssScale), visualToNote(0, p.cssScale));
		const pitch = p.camera.screenToWorld(visualToNote(0, p.cssScale), visualToNote(p.view.defaultLineHeight, p.cssScale)).y - zero.y;
		return pitch > 0 ? pitch : 0;
	}

	/**
	 * The line a pin drop at height `h` reads: the line there, or, when that is an empty line or above the note's first
	 * line, the line half a row lower when it has text (the height read there; `half` is read only then). The pin's point
	 * rests on its row's letters' top, a little below the row's top, so a point drifted up off a paragraph's first row is
	 * over the empty line above it, yet that first row's letters' top is still the nearest. A block widget or a table line
	 * is read where the point is.
	 */
	function pinBlockAt(view: EditorView, h: number, half: () => number): { h: number; block: BlockInfo } {
		const block = view.lineBlockAtHeight(h);
		const text = (b: BlockInfo, y: number) => y >= b.top && y < b.bottom && b.to > b.from && !isWidgetBlock(b);
		if (text(block, h) || isWidgetBlock(block)) return { h, block };
		const d = half();
		if (!(d > 0)) return { h, block };
		const below = view.lineBlockAtHeight(h + d);
		return text(below, h + d) ? { h: h + d, block: below } : { h, block };
	}

	/**
	 * A document position's place, world units, as followRefAt reads a point: its left x and its row's top and bottom. Null
	 * with no container or while a pinch owns the viewport.
	 */
	function wordPlaceReader(p: InkOverlayPlugin): ((pos: number, side: -1 | 1) => { x: number; top: number; bottom: number } | null) | null {
		const view = p.view, container = p.container;
		if (!container || p.pinchHeld()) return null;
		const edge = container.getBoundingClientRect(), panX = p.inkInputPanX(), panY = p.inkInputPanY(), k = p.cssScale;
		return (pos, side) => {
			const r = view.coordsAtPos(pos, side);
			if (!r) return null;
			const a = p.camera.screenToWorld(visualToNote(r.left - edge.left - panX, k), visualToNote(r.top - edge.top - panY, k));
			const b = p.camera.screenToWorld(visualToNote(r.left - edge.left - panX, k), visualToNote(r.bottom - edge.top - panY, k));
			return { x: a.x, top: a.y, bottom: b.y };
		};
	}

	/** A block widget's block (Properties, a block embed): not a line of text. */
	function isWidgetBlock(b: BlockInfo): boolean {
		return typeof b.type === "number" && b.type !== BlockType.Text;
	}

	/** Screen px to world units, as followRefAt converts a point; null with no container or while a pinch owns the viewport. */
	function screenToWorldOf(p: InkOverlayPlugin): ((x: number, y: number) => { x: number; y: number }) | null {
		const container = p.container;
		if (!container || p.pinchHeld()) return null;
		const edge = container.getBoundingClientRect(), panX = p.inkInputPanX(), panY = p.inkInputPanY(), k = p.cssScale;
		return (x, y) => p.camera.screenToWorld(visualToNote(x - edge.left - panX, k), visualToNote(y - edge.top - panY, k));
	}

	/** The first descendant element of `el` carrying class `cls`, walked by children (no selector query). */
	function descendantWith(el: Element, cls: string): Element | null {
		for (const c of Array.from(el.children)) {
			if (c.classList.contains(cls)) return c;
			const d = descendantWith(c, cls);
			if (d) return d;
		}
		return null;
	}

	/** The text nodes under `el` in order; with `shown`, none under an element its own style hides (display none). */
	function textNodesOf(el: Node, shown: boolean, out: CharacterData[] = []): CharacterData[] {
		for (const c of Array.from(el.childNodes)) {
			if (c.nodeType === 3) out.push(c as CharacterData);
			else if (c.nodeType === 1 && !(shown && (c as HTMLElement).style?.display === "none")) textNodesOf(c, shown, out);
		}
		return out;
	}

	/**
	 * A reader of the table widgets drawing blocks, for one read phase (no document change within it). A table is the
	 * block's widget element when it carries cm-table-widget (Obsidian's Live Preview table, as recorded in the app),
	 * its source read as a table, one tr per shown row and one th or td per column. DOM structure only, no layout read.
	 */
	function tableReader(view: EditorView): TableReader {
		const seen = new Map<number, TableDom | null>();
		const read = (block: { from: number; to: number }): TableDom | null => {
			let el: Node | null;
			try {
				const at = view.domAtPos(block.from);
				el = at.node.nodeType === 1 ? at.node.childNodes[at.offset] ?? null : at.node;
			} catch {
				return null;
			}
			if (!el || el.nodeType !== 1 || !(el as Element).classList.contains("cm-table-widget")) return null;
			const src = tableRows(view.state.doc.sliceString(block.from, block.to), block.from);
			if (!src) return null;
			const trs = Array.from((el as Element).querySelectorAll("tr")), table = trs[0]?.closest("table") ?? null;
			const rows = trs.filter((tr) => tr.closest("table") === table);
			if (rows.length !== src.rows.length) return null;
			const cells = rows.map((tr) => Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH"));
			if (cells.some((r) => r.length !== src.ncol)) return null;
			return { src, cells, texts: new Map() };
		};
		let text: string | null = null;
		return {
			table(block) {
				if (!seen.has(block.from)) seen.set(block.from, read(block));
				return seen.get(block.from)!;
			},
			text: () => (text ??= view.state.doc.toString()),
		};
	}

	/**
	 * A cell's drawn text: the resting wrapper's (the first .table-cell-wrapper with no nested editor), and the one shown
	 * now (the wrapper not hidden; under edit, the nested editor's content), each matched to the cell's source. Null for an
	 * empty cell or one GFM does not draw.
	 */
	function cellTextOf(view: EditorView, t: TableDom, row: number, col: number): CellText | null {
		const key = row * t.src.ncol + col;
		if (t.texts.has(key)) return t.texts.get(key)!;
		const cell = t.src.rows[row]?.[col], td = t.cells[row]?.[col];
		let out: CellText | null = null;
		if (cell && td && cell.to > cell.from) {
			const wraps = Array.from(td.children).filter((e) => e.classList.contains("table-cell-wrapper"));
			const resting = wraps.find((w) => !descendantWith(w, "cm-editor")) ?? null;
			const shownWrap = wraps.find((w) => (w as HTMLElement).style?.display !== "none") ?? null;
			const editor = shownWrap ? descendantWith(shownWrap, "cm-content") : null;
			const src = view.state.doc.sliceString(cell.from, cell.to);
			const shownNodes = editor ? textNodesOf(editor, true) : shownWrap ? textNodesOf(shownWrap, true) : [];
			const nodes: { node: CharacterData; start: number }[] = [];
			let at = 0;
			for (const n of shownNodes) {
				nodes.push({ node: n, start: at });
				at += n.data.length;
			}
			const shown = shownNodes.map((n) => n.data).join("");
			out = { cell, rest: resting ? alignShown(src, textNodesOf(resting, false).map((n) => n.data).join("")) : alignShown(src, shown), map: alignShown(src, shown), nodes };
		}
		t.texts.set(key, out);
		return out;
	}

	/**
	 * The screen box of the cell's source character `i` as drawn (one range rect read), or of the next drawn one when `i`
	 * is markup the drawing does not show. Null when no character from `i` on is drawn.
	 */
	function cellCharBox(ct: CellText, i: number): { left: number; right: number; top: number; bottom: number } | null {
		let j = -1;
		for (let k = i; k < ct.map.length && j < 0; k++) j = ct.map[k]!;
		if (j < 0) return null;
		let n = ct.nodes[0];
		for (const x of ct.nodes) if (x.start <= j) n = x;
		if (!n || j - n.start >= n.node.data.length) return null;
		const r = n.node.ownerDocument.createRange();
		r.setStart(n.node, j - n.start);
		r.setEnd(n.node, j - n.start + 1);
		const b = r.getClientRects()[0];
		return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null;
	}

	/**
	 * `pos`'s place in a table widget, as followRefAt reads a point: the world top-left of its character as its cell draws
	 * it. Undefined where no table widget draws `pos`, at the table's first position (the widget's corner, as today: ink
	 * attached in a table before this fix took its reference there), and for a position where `legacy` says the targets
	 * starting there are not inside one cell (attached before this fix): followRefAt reads those as today. Null where no
	 * cell draws `pos`: a pipe, the separator row, padding, a cell GFM leaves out.
	 */
	function tableRefAt(p: InkOverlayPlugin, pos: number, reader: TableReader, legacy?: (t: TableRows, pos: number) => boolean): { x: number; y: number } | null | undefined {
		const view = p.view, block = view.lineBlockAt(pos);
		if (!isWidgetBlock(block) || pos <= block.from || pos > block.to) return undefined;
		const t = reader.table(block);
		if (!t || legacy?.(t.src, pos)) return undefined;
		let cell: TableCell | null = null;
		for (const row of t.src.rows) for (const c of row) if (pos >= c.from && pos < c.to) cell = c;
		const ct = cell && cellTextOf(view, t, cell.row, cell.col), box = ct && cellCharBox(ct, pos - cell!.from), w = box && screenToWorldOf(p);
		return box && w ? w(box.left, box.top) : null;
	}

	/**
	 * Attach's target in a table widget, read in a measure: the box's centre picks one cell, the nearest
	 * when it lies on a border or in no cell (a dead-even tie: the upper, then the left). In that cell, the words on the
	 * centre's row whose middle lies inside the box, each placed where its cell draws it. The cell's text (from its first
	 * drawn character, cellStart, the character every reader reads its reference point at) when none is, when
	 * one of them is not drawn one to one (bold, a link, an embed), or when the box is taller than 1.5 rows. Null for an
	 * empty cell: nothing attaches. Never the whole table, a pipe or two cells.
	 */
	function tableTargetIn(p: InkOverlayPlugin, text: string, t: TableDom, box: BBox, pitch: number): AttachmentTarget | null {
		const w = screenToWorldOf(p);
		if (!w) return null;
		const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
		let best: { row: number; col: number } | null = null, bestD = Infinity;
		t.cells.forEach((r, row) => r.forEach((td, col) => {
			const b = td.getBoundingClientRect(), a = w(b.left, b.top), z = w(b.right, b.bottom);
			const d = Math.hypot(Math.max(a.x - cx, 0, cx - z.x), Math.max(a.y - cy, 0, cy - z.y));
			if (d < bestD - 1e-6) {
				bestD = d;
				best = { row, col };
			}
		}));
		const at = best as { row: number; col: number } | null, cell = at ? t.src.rows[at.row]?.[at.col] : undefined;
		if (!at || !cell || cell.to <= cell.from) return null;
		const whole = () => targetAt(text, cellStart(text, cell), cell.to, "range");
		const ct = cellTextOf(p.view, t, at.row, at.col);
		if (!ct) return whole();
		const placed: { from: number; to: number; left: number; right: number; top: number; bottom: number; plain: boolean; line: number }[] = [];
		const words = cellWords(text, cell);
		// A position's line in the cell: the <br>s before it.
		const lineOf = (pos: number) => text.slice(cell.from, pos).match(/<br\s*\/?>/gi)?.length ?? 0;
		for (const wd of words) {
			let i0 = -1, i1 = -1, plain = true;
			for (let i = wd.from - cell.from; i < wd.to - cell.from; i++) {
				if (ct.map[i]! >= 0) { if (i0 < 0) i0 = i; i1 = i; }
				if (ct.rest[i]! < 0) plain = false;
			}
			if (i0 < 0) continue;
			const s = cellCharBox(ct, i0), e = i1 === i0 ? s : cellCharBox(ct, i1);
			// A word broken across two rows is not placed.
			if (!s || !e || Math.abs(e.top - s.top) > (s.bottom - s.top) / 2) continue;
			const a = w(s.left, s.top), b = w(e.right, s.bottom);
			placed.push({ from: wd.from, to: wd.to, left: a.x, right: b.x, top: a.y, bottom: b.y, plain, line: lineOf(wd.from) });
		}
		if (placed.length === 0) return whole();
		const L = Math.max(pitch > 0 ? pitch : 0, ...placed.map((q) => q.bottom - q.top));
		if (box.height > 1.5 * L) return whole();
		// The centre's row: the band (as wordRangeUnder's) of a placed word that holds the centre, the nearest of two. When
		// a line of the cell (a <br> starts the next) holds no placed word (inline math alone draws no text), the centre may
		// be on that line, and a cell's lines sit closer than the band reaches: then only a placed word's own letters hold
		// the centre, else the cell. A word not placed on a line that also holds a placed word keeps the band.
		const held = new Set(placed.map((q) => q.line));
		const every = words.every((wd) => held.has(lineOf(wd.from)));
		let row = NaN, rd = Infinity;
		for (const q of placed) {
			const c = (q.top + q.bottom) / 2;
			if (every ? cy < c - L / 2 || cy > c + L / 2 + L / 4 : Math.abs(cy - c) > (q.bottom - q.top) / 2) continue;
			if (Math.abs(cy - c) < rd) { rd = Math.abs(cy - c); row = c; }
		}
		if (!Number.isFinite(row)) return whole();
		const right = box.x + box.width;
		const taken = placed.filter((q) => {
			const mid = (q.left + q.right) / 2;
			return Math.abs((q.top + q.bottom) / 2 - row) < (q.bottom - q.top) / 2 && mid > box.x && mid < right;
		});
		if (taken.length === 0 || taken.some((q) => !q.plain)) return whole();
		return targetAt(text, taken[0]!.from, taken[taken.length - 1]!.to, "range");
	}

	/**
	 * Whether a change touched a block widget holding a word or cell group: the widget's text was rewritten, so a column's
	 * width or a row's height may have moved its words with no move of the block's top, even by an edit after them (a
	 * later row typed wider, a cell beside wrapping). Height map only, no layout read.
	 */
	function tableGroupTouched(view: EditorView, list: readonly AttachmentData[], changes: ChangeDesc): boolean {
		const ranges: number[] = [];
		changes.iterChangedRanges((_fa, _ta, fb, tb) => { ranges.push(fb, tb); });
		if (ranges.length === 0) return false;
		for (const a of list) {
			if (isOpaqueAttachment(a) || a.target.kind !== "range" || a.target.to <= a.target.from) continue;
			const b = view.lineBlockAt(a.target.from);
			if (!isWidgetBlock(b)) continue;
			for (let i = 0; i < ranges.length; i += 2) if (ranges[i + 1]! >= b.from && ranges[i]! <= b.to) return true;
		}
		return false;
	}

	/**
	 * The text line (not blank, not a widget) whose block the span `top` to `bottom` overlaps, nearest `h`; a tie takes the
	 * upper line. Heights as the height map reads them. Null when the span overlaps no text line. Walks the blocks in
	 * document order from the one at the span's top (a height above the note lands on its first block), stepping by
	 * position, not height: a block with no height (hidden front matter) would hold a walk by height in place.
	 */
	function overlappedTextLine(view: EditorView, top: number, bottom: number, h: number): BlockInfo | null {
		const end = view.state.doc.length;
		let best: BlockInfo | null = null, bestD = Infinity;
		for (let b = view.lineBlockAtHeight(top); ; b = view.lineBlockAt(b.to + 1)) {
			if (b.bottom > top && b.top < bottom && b.to > b.from && !isWidgetBlock(b)) {
				const d = h < b.top ? b.top - h : h >= b.bottom ? h - b.bottom : 0;
				if (d < bestD) {
					best = b;
					bestD = d;
				}
			}
			if (b.top >= bottom || b.to >= end) break;
		}
		return best;
	}

	/**
	 * The text line (not blank, not a widget) nearest the span `top` to `bottom` that it does not overlap, with a gap of at
	 * most `reach`: above, the span's top less the line's bottom; below, the line's top less the span's bottom. The smaller
	 * gap wins; a tie takes the upper line. Blank lines are crossed and count only as distance. A widget block with height
	 * (a note embed, a table) met before a text line ends that direction with nothing; a span that overlaps one reaches in
	 * neither. A widget with no height (hidden front matter) is not in the way. Null when nothing is in reach. Walks by
	 * position, as overlappedTextLine does: down from the block at the span's top, then up from the last block the walk
	 * down passed above the span (the height map may answer a block above the span for its top), else from the block
	 * before the first one it read.
	 */
	function reachedTextLine(view: EditorView, top: number, bottom: number, reach: number): BlockInfo | null {
		if (!(reach > 0)) return null;
		const end = view.state.doc.length, start = view.lineBlockAtHeight(top);
		const inTheWay = (b: BlockInfo) => isWidgetBlock(b) && b.bottom > b.top;
		const isText = (b: BlockInfo) => b.to > b.from && !isWidgetBlock(b);
		let below: BlockInfo | null = null, lastAbove: BlockInfo | null = start.from > 0 ? view.lineBlockAt(start.from - 1) : null;
		for (let b = start; ; b = view.lineBlockAt(b.to + 1)) {
			if (b.bottom <= top) lastAbove = b;
			else if (b.top >= bottom) {
				if (b.top - bottom > reach || inTheWay(b)) break;
				if (isText(b)) {
					below = b;
					break;
				}
			} else if (inTheWay(b)) return null;
			if (b.to >= end) break;
		}
		let above: BlockInfo | null = null;
		for (let b = lastAbove; b; b = b.from > 0 ? view.lineBlockAt(b.from - 1) : null) {
			if (top - b.bottom > reach || inTheWay(b)) break;
			if (isText(b)) {
				above = b;
				break;
			}
		}
		if (!above) return below;
		if (!below) return above;
		return top - above.bottom <= below.top - bottom ? above : below;
	}

	/**
	 * Attach's target, read in a measure: the words under the box when it sits inside one visual row (wordRangeUnder),
	 * else the paragraph of `block`. Each word's place is read as followRefAt reads a point, at its first and after its
	 * last character; a word broken across two rows is not taken. The row's pitch is the editor's line height, in the same
	 * units. The words of the line `above` come first, so a box in its last row's band takes them; a place of theirs
	 * taller than 2.5 line heights is an inline widget's whole rect (an embed), not letters, and is not read, so it never
	 * takes the row. A heading's letters stay under that: in a wide interface font they run about 1.6 line heights.
	 * With no pitch measured nothing is skipped. The box's own line keeps every place. No read while a pinch
	 * owns the viewport: the paragraph, and followRefAt refuses after it. A table widget's block: its cell's word or text
	 * (tableTargetIn, `above` not read), null for an empty cell. A table row's text line (Source mode): sourceRowTargetIn;
	 * the table's separator line: null.
	 */
	function attachTargetIn(p: InkOverlayPlugin, text: string, block: { from: number; to: number }, box: BBox, above: { from: number; to: number } | null): AttachmentTarget | null {
		const view = p.view, k = p.cssScale;
		const paragraph = () => targetAt(text, block.from, block.to, "paragraph");
		const at = wordPlaceReader(p);
		if (!at) return paragraph();
		const zero = p.camera.screenToWorld(visualToNote(0, k), visualToNote(0, k));
		const pitch = p.camera.screenToWorld(visualToNote(0, k), visualToNote(view.defaultLineHeight, k)).y - zero.y;
		const wb = view.lineBlockAt(block.from);
		if (isWidgetBlock(wb)) {
			const t = tableReader(view).table(wb);
			if (t) return tableTargetIn(p, text, t, box, pitch);
		}
		const aboveTo = above ? above.to : -1;
		const placeOf = (w: { from: number; to: number }) => {
			const s = at(w.from, 1), e = s ? at(w.to, -1) : null;
			// Spans on one row may sit a fraction apart; a word whose end is half a row lower wrapped.
			if (!s || !e || Math.abs(e.top - s.top) > (s.bottom - s.top) / 2) return null;
			if (w.to <= aboveTo && pitch > 0 && s.bottom - s.top > 2.5 * pitch) return null;
			return { left: s.x, right: e.x, top: s.top, bottom: s.bottom };
		};
		const row = sourceRowAt(text, block);
		// A table's separator line is never a word and never a target: nothing attaches, as for an empty cell.
		if (row === "separator") return null;
		if (row) return sourceRowTargetIn(text, row, block, box, at, placeOf, pitch, paragraph);
		const words = [...(above ? wordsIn(text, above.from, above.to) : []), ...wordsIn(text, block.from, block.to)];
		const range = wordRangeUnder(words, box, placeOf, pitch);
		return range ? targetAt(text, range.from, range.to, "range") : paragraph();
	}

	/**
	 * The cells of the table row whose source line is `line`; "separator" for the table's separator line (the line after
	 * its header); null when no table holds the line.
	 */
	function sourceRowAt(text: string, line: { from: number; to: number }): readonly TableCell[] | "separator" | null {
		const t = tableAround(text, line.from);
		if (!t) return null;
		for (const r of t.rows) if (r.length > 0 && r.every((c) => c.from >= line.from && c.to <= line.to)) return r;
		const nl = text.indexOf("\n", t.from);
		return nl >= 0 && line.from === nl + 1 ? "separator" : null;
	}

	/**
	 * A character that may be markup in a cell's source (emphasis, a highlight, code, math, a link or wikilink, a footnote,
	 * a tag, an entity, a comment, an escape): a word holding one may not be drawn as the text has it, so it is not placed
	 * one to one. Taken wide on purpose: a word it catches that is drawn as written still gets its cell's text, which every
	 * view places.
	 */
	const SOURCE_MARKUP = /[*_~=`$^[\]()<>\\%&]/;

	/**
	 * Attach's target on a table row's text line (Source mode), as tableTargetIn reads a drawn table: the box's centre
	 * picks one cell, the nearest when it lies on a pipe or in no cell (a dead-even tie: the left). A cell's place runs
	 * from the pipe before it to the pipe after it (the line's ends for no outer pipe). In that cell, the words under the
	 * box (wordRangeUnder over the cell's words only); the cell's text (from its first drawn character, cellStart) when
	 * none is, or when one holds markup
	 * (SOURCE_MARKUP), as tableTargetIn takes a word not drawn one to one. Null for an empty cell: nothing
	 * attaches. Never a pipe or two cells. The paragraph when no cell can be placed. `above` is not read.
	 */
	function sourceRowTargetIn(
		text: string, row: readonly TableCell[], line: { from: number; to: number }, box: BBox,
		at: (pos: number, side: -1 | 1) => { x: number; top: number; bottom: number } | null,
		placeOf: (w: { from: number; to: number }) => WordPlace | null, pitch: number, paragraph: () => AttachmentTarget,
	): AttachmentTarget | null {
		const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
		let best: TableCell | null = null, bestD = Infinity;
		for (const c of row) {
			const lp = text.lastIndexOf("|", c.from - 1), rp = text.indexOf("|", c.to);
			const lo = lp + 1 >= line.from ? lp + 1 : line.from, hi = rp >= 0 && rp <= line.to ? rp : line.to;
			const a = at(lo, 1), z = at(hi, -1);
			if (!a || !z) continue;
			const x0 = Math.min(a.x, z.x), x1 = Math.max(a.x, z.x), y0 = Math.min(a.top, z.top), y1 = Math.max(a.bottom, z.bottom);
			const d = Math.hypot(Math.max(x0 - cx, 0, cx - x1), Math.max(y0 - cy, 0, cy - y1));
			if (d < bestD - 1e-6) {
				bestD = d;
				best = c;
			}
		}
		if (!best) return paragraph();
		const cell: TableCell = best;
		if (cell.to <= cell.from) return null;
		const range = wordRangeUnder(cellWords(text, cell), box, placeOf, pitch);
		if (!range || SOURCE_MARKUP.test(text.slice(range.from, range.to))) return targetAt(text, cellStart(text, cell), cell.to, "range");
		return targetAt(text, range.from, range.to, "range");
	}

	/**
	 * Attach, made: the record at `ref`, each member settled to where it is shown, one step. A selection over two groups
	 * or more (group attach) takes in the others: each other group holding a member is detached as a Detach makes it,
	 * then the record is attached, every op in one history step, one op per group id, the others' first (applyAttachSettle
	 * keeps their members when the undo puts them back). The whole of it is worked out on a scratch list before any
	 * write, so it lands whole or not at all. Every member's place is read where it is shown before any record goes.
	 */
	function attachAt(this: InkOverlayPlugin, path: string, id: string, ids: readonly string[], target: AttachmentTarget, ref: { x: number; y: number }): void {
		const sig = this.lineAnchors.sig, members = settleMembers(path, ids);
		if (!sig || members.length === 0) return;
		const list = inlineInk.attachments(path), strokeIds = members.map((s) => s.id), memberIds = new Set(strokeIds);
		this.lineAnchors.follow.setList(list);
		const shown = members.map((s) => this.lineAnchors.shownOf(s).points[0]!);
		const record: AttachmentRecord = {
			v: 1, id, strokeIds, target, ref: { x: ref.x, y: ref.y }, layout: { width: sig.width, font: sig.fontPx },
			probe: { id: strokeIds[0]!, x: shown[0]!.x, y: shown[0]!.y },
		};
		// The other groups the members belong to, each detached first; on the scratch list the record must then attach.
		let scratch: readonly AttachmentData[] = list;
		const drops: (AttachStep & { path: string })[] = [];
		for (const a of list) {
			if (isOpaqueAttachment(a) || a.id === id || !a.strokeIds.some((s) => memberIds.has(s))) continue;
			const drop = detachStep(this, path, list, a.id);
			if (!drop || !attachStands(drop)) return;
			drops.push(drop);
			scratch = detachGroup(scratch, a.id).list;
		}
		if (!attachGroup(scratch, record).step) return;
		const applied: InkOp[] = [];
		for (const drop of drops) {
			if (this.applyAttachSettle(drop)) applied.push(drop);
		}
		// Each member as the store holds it now: an absorbed group's members are stored where they were shown.
		const byId = new Map(inlineInk.strokes(path).map((s) => [s.id, s] as const));
		const from = strokeIds.map((sid) => ({ x: byId.get(sid)!.points[0]!.x, y: byId.get(sid)!.points[0]!.y }));
		const { step } = applied.length === drops.length ? attachGroup(inlineInk.attachments(path), record) : { step: null };
		const settle = { strokeIds, dx: shown.map((p, i) => p.x - from[i]!.x), dy: shown.map((p, i) => p.y - from[i]!.y), from };
		const op = step ? { ...step, path, settle } : null;
		if (!op || !this.applyAttachSettle(op, false, true)) {
			// Not reached once the scratch list allowed it; if it is, what was applied is still one step, so one undo
			// puts it back: no group is lost with no history.
			if (applied.length > 0) {
				dispatchSteps(this, applied);
				this.lineAnchorsMoved(path, false);
			}
			return;
		}
		this.lineAnchors.follow.attached(record, this.view.lineBlockAt(target.from).top);
		if (applied.length > 0) dispatchSteps(this, [...applied, op]);
		else this.dispatchInk(op);
		this.lineAnchorsMoved(path, false);
	}

	/** One editor history step of several ink effects, the store already holding them (inkApplied). */
	function dispatchSteps(overlay: InkOverlayPlugin, ops: readonly InkOp[]): void {
		try {
			const effects = ops.map((op) => inkEffect.of(overlay.stampInkIdentity(op)));
			overlay.view.dispatch({ effects, annotations: [inkApplied.of(true), isolateHistory.of("full")] });
		} catch (err) {
			console.error("[handwriting] ink history dispatch failed", err);
		}
	}

	/** Whether a text change moves this group: its target can be read and needs no reattachment, and was not deleted. */
	function movesWithText(overlay: InkOverlayPlugin, a: AttachmentRecord): boolean {
		return overlay.lineAnchors.follow.followsText(a.id) && a.target.from <= overlay.view.state.doc.length;
	}

	/**
	 * Each attached group's top for Insert Space, world y; none when the note has no groups. A group that moves with its
	 * text: its target's first line top, from the height map. One the text change does not move (target needs
	 * reattachment, was deleted, or lies past the end): free ink, whole, by its shown top, the least member bbox y
	 *.
	 */
	function groupLineTops(overlay: InkOverlayPlugin, rows?: object): Map<string, number> | null {
		const path = overlay.filePath(), list = path ? inlineInk.attachments(path) : [], view = overlay.view;
		const px = view ? view.scaleY * overlay.fontZoom : 0;
		if (list.length === 0 || !(px > 0)) return null;
		const tops = new Map<string, number>(), held: AttachmentRecord[] = [];
		for (const a of list) {
			if (isOpaqueAttachment(a)) continue;
			if (movesWithText(overlay, a)) tops.set(a.id, view.lineBlockAt(a.target.from).top / px);
			else held.push(a);
		}
		if (held.length) for (const [id, top] of heldTops(overlay, path!, list, held, rows)) tops.set(id, top);
		return tops;
	}

	/**
	 * The held groups' tops, kept per Insert Space rows: InsertSpaceRows keeps its array while the strokes and their
	 * revisions hold and makes a new one at any change, so the same rows, list and held groups mean the same tops. Hover
	 * asks per frame. A held correction does not change while held (recompute skips it).
	 */
	const heldTopsOfRows = new WeakMap<InkOverlayPlugin, { rows: object; list: readonly AttachmentData[]; ids: string; tops: Map<string, number> }>();

	/** Each held group's shown top, world y: the least member bbox y plus its held correction. */
	function heldTops(overlay: InkOverlayPlugin, path: string, list: readonly AttachmentData[], held: readonly AttachmentRecord[], rows?: object): Map<string, number> {
		const kept = heldTopsOfRows.get(overlay), ids = held.map((a) => a.id).join("\n");
		if (rows && kept && kept.rows === rows && kept.list === list && kept.ids === ids) return kept.tops;
		// Only the held groups' members are read, from the member lists freeFor keeps (the same object while
		// the store list holds), never the whole store.
		const least = new Map<string, number>(), follow = overlay.lineAnchors.follow;
		follow.setList(list);
		const { members } = overlay.lineAnchors.freeFor(path, inlineInk.strokes(path));
		for (const a of held) {
			const ms = members.get(a.id);
			if (!ms) continue;
			let y = Infinity;
			for (const s of ms) if (s.bbox.y < y) y = s.bbox.y;
			if (y < Infinity) least.set(a.id, y);
		}
		const tops = new Map<string, number>();
		for (const [id, top] of least) tops.set(id, top + (follow.groupOffset(id)?.dy ?? 0));
		if (rows) heldTopsOfRows.set(overlay, { rows, list, ids, tops });
		return tops;
	}

	/** Insert Space at world y `seam` and attached groups (insertSpaceMembers): each moves whole with its top, or not. */
	function spaceGroups(this: InkOverlayPlugin, seam: number, rows?: object): { move: Set<string>; hold: Set<string> } | undefined {
		const tops = groupLineTops(this, rows);
		return tops ? insertSpaceMembers(inlineInk.attachments(this.filePath()!), seam, tops) : undefined;
	}

	/** Whether seams at `a` and `b` leave every group on the same side (the preview's lists then stand). */
	function spaceGroupSides(this: InkOverlayPlugin, a: number, b: number, rows?: object): boolean {
		const tops = a === b ? null : groupLineTops(this, rows);
		if (tops) for (const y of tops.values()) if ((y >= a) !== (y >= b)) return false;
		return true;
	}

	/**
	 * The strokes Insert Space moves in the store: never a member of a group that moves with its text. The text change
	 * moves that group (followDocChanged), so a member moved here as well would move twice. A group the text change does
	 * not move is free ink: its members move here when the picture moved them.
	 */
	function spaceStoreIds(this: InkOverlayPlugin, ids: string[]): string[] {
		const path = this.filePath(), list = path ? inlineInk.attachments(path) : [];
		if (list.length === 0) return ids;
		const withText = new Set<string>();
		for (const a of list) if (!isOpaqueAttachment(a) && movesWithText(this, a)) for (const id of a.strokeIds) withText.add(id);
		return ids.filter((id) => !withText.has(id));
	}

	/**
	 * Insert Space moved a group the text change does not move by `dy` in the store: its record's reference point and
	 * probe move with it, so a later reattachment reads a record that agrees with its points. The list is
	 * written now; the returned steps go in the lift's history step beside its move.
	 */
	function spaceHeldShift(this: InkOverlayPlugin, path: string, ids: readonly string[], dy: number): InkOp[] {
		const list = inlineInk.attachments(path), moved = new Set(ids), steps: InkOp[] = [];
		let next = list;
		for (const a of list) {
			if (isOpaqueAttachment(a) || movesWithText(this, a) || !a.strokeIds.some((id) => moved.has(id))) continue;
			const { list: l, step } = attachGroup(next, { ...a, ref: { x: a.ref.x, y: a.ref.y + dy }, probe: { ...a.probe, y: a.probe.y + dy } });
			if (!step) continue;
			next = l;
			steps.push({ ...step, path });
			// Every member moved by dy: a translation, and the attached layer keeps the group's sprite.
			if (a.strokeIds.every((id) => moved.has(id))) this.attachedLayer?.translated(a.id, dy);
		}
		if (next !== list) inlineInk.setAttachments(path, next, true);
		return steps;
	}

	/** A lasso loop touching a member selects its whole group (attachmentSelection's expandedIds). */
	function expandToAttachedGroups(this: InkOverlayPlugin): void {
		const path = this.filePath(), list = path ? inlineInk.attachments(path) : [];
		if (list.length === 0 || this.selection.isEmpty) return;
		const ids = attachmentSelection(list, this.selection.strokeIds).expandedIds;
		if (ids.length !== this.selection.strokeIds.length) this.selection.selectExactly(ids);
	}

	/**
	 * A lasso drop, recorded: the move, and for each group it carried its record with the probe moved with the ink, in one
	 * step. The reference point stays: the group keeps its words and is shown where it was dropped. Free ink: the move alone.
	 */
	function dispatchDrop(this: InkOverlayPlugin, path: string, ids: readonly string[], dx: number, dy: number): void {
		const moved = new Set(ids), list = inlineInk.attachments(path), steps: InkOp[] = [{ type: "move", path, strokeIds: [...ids], dx, dy }];
		let next = list;
		for (const a of list) {
			if (isOpaqueAttachment(a) || !moved.has(a.probe.id)) continue;
			const { list: l, step } = attachGroup(next, { ...a, probe: { ...a.probe, x: a.probe.x + dx, y: a.probe.y + dy } });
			if (!step) continue;
			next = l;
			steps.push({ ...step, path });
		}
		if (next !== list) inlineInk.setAttachments(path, next, true);
		if (steps.length === 1) this.dispatchInk(steps[0]!);
		else dispatchSteps(this, steps);
	}

	/**
	 * The lasso's Detach (attachmentSelection): every selected stroke in the one group detaches that group; a selection
	 * touching two groups or more detaches each of them whole, loose ink in it staying loose. Each group's step is made
	 * from the list as it then stands and applied; the ones applied are one history step, so one undo puts all back.
	 */
	function detachSelected(this: InkOverlayPlugin): boolean {
		const path = this.filePath();
		if (!path) return false;
		const sel = attachmentSelection(inlineInk.attachments(path), [...this.selection.strokeIds]);
		if (!sel.detach) return false;
		if (sel.groupIds.length === 1) {
			if (!this.detachAttachment(path, sel.groupIds[0]!)) return false;
		} else {
			const ops = sel.groupIds.flatMap((id) => detachApplied(this, path, id) ?? []);
			if (ops.length === 0) return false;
			dispatchSteps(this, ops);
			this.lineAnchorsMoved(path, false);
		}
		this.redrawSelectionUI();
		return true;
	}

	/**
	 * The stored text and context of each target the change touched, brought up to the document (spec 5.1, refreshTarget):
	 * a reopen then finds the target by the words and context it has now. Only a target that follows the text and whose
	 * text or context the change reached; a collapsed or held target keeps its old text, so an undo or a reattachment can
	 * find it again. The same list when nothing was refreshed. Offsets are not changed here.
	 */
	function refreshTouched(list: readonly AttachmentData[], changes: ChangeDesc, doc: Text, follows: (id: string) => boolean): readonly AttachmentData[] {
		// The changed ranges in the new document, where the mapped targets are.
		const changed: number[] = [];
		changes.iterChangedRanges((_fa, _ta, fb, tb) => changed.push(fb, tb));
		let out: AttachmentData[] | null = null;
		for (let i = 0; i < list.length; i++) {
			const a = list[i]!;
			if (isOpaqueAttachment(a)) continue;
			// The range test first: plain arithmetic, so a target the change did not reach costs no lookup.
			const t = a.target, lo = t.from - ATTACHMENT_CONTEXT, hi = t.to + ATTACHMENT_CONTEXT;
			let touched = false;
			for (let k = 0; k < changed.length && !touched; k += 2) touched = changed[k + 1]! >= lo && changed[k]! <= hi;
			if (!touched || !follows(a.id)) continue;
			// Read through a window of the target and its context only, never the whole document per key.
			const base = Math.max(0, lo), shifted = { ...t, from: t.from - base, to: t.to - base };
			const next = refreshTarget(shifted, doc.sliceString(base, Math.min(doc.length, hi)));
			if (next !== shifted) (out ??= list.slice())[i] = { ...a, target: { ...next, from: t.from, to: t.to } };
		}
		return out ?? list;
	}

	/**
	 * Whether every target in `list` stands on its words and their context in `doc`, read at its own offsets only. A
	 * target whose text was deleted says nothing either way.
	 */
	function standsIn(list: readonly AttachmentData[], doc: Text): boolean {
		for (const a of list) {
			if (isOpaqueAttachment(a) || a.target.from >= a.target.to) continue;
			const t = a.target;
			if (t.to > doc.length) return false;
			const lo = Math.max(0, t.from - ATTACHMENT_CONTEXT), near = { ...t, from: t.from - lo, to: t.to - lo };
			if (resolveTarget(near, doc.sliceString(lo, Math.min(doc.length, t.to + ATTACHMENT_CONTEXT)), () => NO_SEARCH) !== near) return false;
		}
		return true;
	}

	/**
	 * A document change, for attached groups: their targets mapped and their points moved by the line block's top delta,
	 * read from the height map (allowed inside an update). A moved correction is a real edit: the page is written.
	 */
	function followDocChanged(this: InkOverlayPlugin, path: string, u: ViewUpdate): void {
		const anchors = this.lineAnchors, follow = anchors.follow;
		// A picture's link replaced whole by a link to the same file (a resize, its undo, its redo): read once, first, for
		// every pane, as each pane carries its own history's records (carryLifted) and the writer maps the list.
		const swaps = u.startState && u.state ? sameFileLinkSwaps(u.changes, u.startState.doc, u.state.doc) : null;
		follow.carryLifted(u.changes, swaps);
		// A group held as new here against text one change behind the list is checked again on this text, first.
		follow.recheckNew();
		// A synced ink file can be adopted before its note's text reaches this pane: a sync writes the two files in its own
		// order. Its targets then stand on the text the other device saved, not on the text before this change, which may be
		// that very text arriving; mapped through it, a target already at its words' new place would move again. Such a list
		// is found in the text this change leaves instead, once, at the first change this pane hears after it came. The store
		// marks the note, not the list, so a rewrite of the list with no edit before this change (the note told first and a
		// group found in its old text, a correction stamped by the measure) leaves the adoption pending.
		const stored = inlineInk.attachments(path), adoption = inlineInk.adoptionPending(path);
		if (adoption !== 0 && adoptedMet.get(this) !== adoption) {
			adoptedMet.set(this, adoption);
			if (u.startState && u.state && anchors.writesAttachments) {
				// Found or standing already, the groups are on this text from here; the writer ends the mark for every pane.
				inlineInk.adoptionFound(path);
				if (stored.length > 0 && !standsIn(stored, u.startState.doc)) {
					this.resolveAttachedText(path, u.state.doc);
					anchors.shareAttachments(inlineInk.attachments(path));
					return;
				}
			}
		}
		follow.setList(inlineInk.attachments(path));
		if (follow.attachments.length === 0) return;
		// Of two panes on the note, one maps the targets through the change and writes them (the anchors' writer); this pane
		// reads the list as that one leaves it: now when it was heard first, else when that one hands it over. A list already
		// mapped into this very text is not mapped again: the other pane heard the change first while it was the writer (its
		// strokes replaced and not yet shown, or the focus moved between the two updates).
		const was = mappedInto.get(inlineInk.attachments(path));
		if (was && u.state && was.length === u.state.doc.length && was.eq(u.state.doc)) return;
		if (!anchors.writesAttachments) return;
		const before = follow.snapshot(), prior = follow.attachments;
		// With the line count unchanged, the end of the last changed line; groups below it are read again only
		// if the changed lines' height changed.
		let below: number | undefined;
		if (u.startState && u.state && u.startState.doc.lines === u.state.doc.lines) {
			let last = -1;
			u.changes.iterChangedRanges((_fa, _ta, _fb, tb) => { if (tb > last) last = tb; });
			if (last >= 0) below = u.state.doc.lineAt(last).to;
		}
		const view = this.view, mapped = follow.docChanged(u.changes, (pos) => view.lineBlockAt(pos).top, view.scaleY * this.fontZoom, below, swaps);
		const edit = follow.takeEdited();
		// A target whose text was deleted takes it back when the change puts the same words back with their context (an undo,
		// a paste of the cut line): looked for only when some target is collapsed and the change inserts text.
		let found = mapped;
		const collapsed = mapped.some((a) => !isOpaqueAttachment(a) && a.target.from === a.target.to);
		// A cell target typed at its first or last letter stays its cell's (refindInTables): looked for only when the change
		// reaches a target's edge on a line holding a pipe, read from that line alone.
		const edged = !collapsed && !!u.startState && cellEdgeReached(prior, u.changes, (pos) => u.startState.doc.lineAt(pos));
		if (u.state && (collapsed || edged)) {
			// A word or cell in a table the change rewrote whole (every table edit the app writes): found in its cell again.
			if (u.startState) found = refindInTables(prior, mapped, () => u.startState.doc.toString(), () => u.state.doc.toString(), u.changes);
			// Each insert with its range in the new text: a target is found again only inside one, never on the same words
			// left standing elsewhere in the note.
			const inserted: { from: number; to: number; text: string }[] = [];
			if (collapsed) u.changes.iterChanges((_fa, _ta, fb, tb, text) => { if (text.length > 0) inserted.push({ from: fb, to: tb, text: text.toString() }); });
			if (inserted.length > 0) found = refindCollapsed(found, inserted, () => u.state.doc.toString());
			if (found !== mapped) follow.setList(found);
		}
		// A table rewritten around a word or cell group moves its words with no move of the block's top (a column widened by
		// a later row, a cell beside it wrapping): its groups are read again at the next measure.
		if (u.state && tableGroupTouched(view, found, u.changes)) follow.layoutChanged();
		// Timed only while the diagnostics switch is on (follow.onTime); off, no clock is read.
		const onTime = follow.onTime, t0 = onTime ? performance.now() : 0;
		const list = u.state ? refreshTouched(found, u.changes, u.state.doc, (id) => follow.followsText(id)) : found;
		if (onTime) onTime("refreshTouched", performance.now() - t0);
		// A changed refresh is an edit: the page is written, so a close keeps the words the target has now: a list only mapped by typing is
		// held unwritten, and a reopen on old words would not find the target. A target found again is one too.
		const refreshed = list !== mapped;
		if (refreshed) follow.setList(list);
		if (list !== inlineInk.attachments(path)) {
			// Written as an edit, yet no user action on a group: the note's own text moved it, and at a duplicate lock's clear
			// the file's record of it stands.
			inlineInk.setAttachments(path, list, edit || refreshed, false);
			if (u.state) mappedInto.set(list, u.state.doc);
		}
		anchors.shareAttachments(list);
		if (edit) this.followMoved(path, before);
	}

	/**
	 * The world top-left of the character at `pos` as laid out now: a layout read, made only in a measure's read (never in
	 * an update) and never while a pinch owns the viewport. The same conversion as the hit probe's. At a resting zoom the
	 * read is made: the screen rect is divided by cssScale, which carries the zoom, so Attach and the follow work at any
	 * zoom. Only a held pinch (its gesture or its live preview) refuses, as the raster then shows a preview frame. Inside a
	 * table widget the character as its cell draws it (tableRefAt; `reader` one per read phase, `legacy` the targets
	 * attached before this fix, read as today); the table's first position is the widget's corner, as today. On a
	 * table's text line (Source mode) `pos` itself, as today: a cell target starts at a drawn character (cellStart).
	 */
	function followRefAt(this: InkOverlayPlugin, pos: number, reader?: TableReader, legacy?: (t: TableRows, pos: number) => boolean): { x: number; y: number } | null {
		if (!this.container || this.pinchHeld()) return null;
		const inTable = tableRefAt(this, pos, reader ?? tableReader(this.view), legacy);
		if (inTable !== undefined) return inTable;
		const rect = this.view.coordsAtPos(pos, 1);
		if (!rect) return null;
		const box = this.container.getBoundingClientRect();
		return this.camera.screenToWorld(
			visualToNote(rect.left - box.left - this.inkInputPanX(), this.cssScale),
			visualToNote(rect.top - box.top - this.inkInputPanY(), this.cssScale)
		);
	}

	/** The follow measure's read: the groups in view not read in this layout, at most `cap`. Outside an update only. */
	function followRead(p: InkOverlayPlugin, cap: number): FollowRead {
		const follow = p.lineAnchors.follow, before = follow.snapshot();
		const view = p.view, vp = view.viewport, reader = tableReader(view), list = follow.attachments;
		// Targets starting at `pos` none of which is a cell target made now: not inside one cell (the whole table, a pipe:
		// attached before tables were read), or inside one but starting at a character it does not draw (1.5.1's Source
		// Attach on a word with markup, startsUndrawn). Read as before, so their saved ink does not move.
		const legacy = (t: TableRows, pos: number) => {
			let any = false;
			for (const a of list) {
				if (isOpaqueAttachment(a) || a.target.from !== pos) continue;
				const cell = a.target.kind === "range" && a.target.to > a.target.from ? tableCellIn(t, a.target.from, a.target.to) : null;
				if (cell && !startsUndrawn(reader.text(), cell, a.target.from)) return false;
				any = true;
			}
			return any;
		};
		const m = follow.measure({
			inView: (pos) => pos >= vp.from && pos <= vp.to,
			refAt: (pos) => p.followRefAt(pos, reader, legacy),
			blockTop: (pos) => view.lineBlockAt(pos).top,
		}, cap);
		return { ...m, before };
	}

	/**
	 * The pane's width changed and its words are laid out again, in this frame, before it shows (the content's resize
	 * observer): every attached group in view is read now, one layout read each, and a moved group is painted in this
	 * same frame, so its ink is never shown at the place its words left. The resize
	 * observer runs once per frame, so a continuous resize reads once per frame.
	 */
	function followMeasureNow(this: InkOverlayPlugin): void {
		const path = this.filePath(), follow = this.lineAnchors.follow;
		if (!path || !follow.any || !this.container || this.frame.locked || this.pinchScaleNow !== 1) return;
		follow.setList(inlineInk.attachments(path));
		follow.layoutChanged();
		const m = followRead(this, Infinity);
		if (!m.changed) return;
		this.followMoved(path, m.before);
		if (!this.repaintQueued || this.inQueuedFrame) return;
		// The queued frame is the next one: paint now, before this frame shows, as that frame's repaint would.
		this.inQueuedFrame = true;
		try {
			this.repaint();
		} finally {
			this.inQueuedFrame = false;
		}
	}

	/** Asks the next measure to read the attached groups in view (at most GROUP_READS_PER_MEASURE); repaints on a change. */
	function requestFollowMeasure(this: InkOverlayPlugin): void {
		let req = followRequests.get(this);
		if (!req) {
			const key = {};
			req = {
				key,
				read: () => followRead(this, GROUP_READS_PER_MEASURE),
				write: (m) => {
					const path = this.filePath();
					if (m.changed && path) this.followMoved(path, m.before);
					if (m.more) this.requestFollowMeasure();
				},
			};
			followRequests.set(this, req);
		}
		this.view.requestMeasure?.(req);
	}

export function installLineAnchors(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		lineWindowMeasured,
		readLineSignature,
		lineSignatureMeasured,
		requestLineSignature,
		requestLineBoxes,
		updateLineAnchors,
		lineAnchorsDrawn,
		lineAnchorInkLoaded,
		resolveAttachedText,
		armLineAnchorPass,
		lineAnchorsMoved,
		freeStrokes,
		inkReach,
		attachedGroups,
		paintAttached,
		followMoved,
		placeFirstsWaiting,
		followMeasureNow,
		scheduleRowsIdle,
		rowsIdleRun,
		lineOnScreen,
		lineLayout,
		noteStrokes,
		exportStrokes,
		lineAnchorDy,
		retakeLineAnchors,
		applyAttachSettle,
		detachAttachment,
		detachSelected,
		dropAttachPin,
		attachSelected,
		attachAt,
		expandToAttachedGroups,
		dispatchDrop,
		spaceGroups,
		spaceGroupSides,
		spaceStoreIds,
		spaceHeldShift,
		followDocChanged,
		followRefAt,
		requestFollowMeasure,
	});
}
