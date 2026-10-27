/**
 * The note surface's line anchors: the signature and window reads, the update that follows the editor, the old-ink pass, the
 * shown strokes and the retake. They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 */
import { EditorView, ViewUpdate } from "@codemirror/view";
import { type Text } from "@codemirror/state";
import { InkStroke } from "../ink/Stroke";
import { editorLineLayout, type LineLayout, type LineRange, type LineSignature } from "./LineAnchor";
import { installMethods } from "./InstallMethods";
import { inlineInk, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		lineWindowMeasured(): void;
		readLineSignature(view: EditorView): LineSignature;
		lineSignatureMeasured(sig: LineSignature): void;
		requestLineSignature(): void;
		updateLineAnchors(u: ViewUpdate): void;
		lineAnchorsDrawn(path: string, doc: Text, src: readonly InkStroke[], measure: boolean, only?: LineRange): void;
		lineAnchorInkLoaded(path: string): void;
		armLineAnchorPass(path: string, ms: number): void;
		lineAnchorsMoved(path: string): void;
		lineOnScreen(): boolean;
		lineLayout(): LineLayout | null;
		noteStrokes(path: string): readonly InkStroke[];
		lineAnchorDy(stroke: InkStroke): number;
		retakeLineAnchors(path: string, ids: readonly string[]): void;
	}
}

/** How long after the last editor update that drew lines before old ink on the measured lines is anchored, in ms (LineAnchor.ts). */
const LINE_ANCHOR_QUIET_MS = 300;

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
	 * the lines CodeMirror shows now, marked measured at its next measure or by the old-ink pass.
	 */
	function lineSignatureMeasured(this: InkOverlayPlugin, sig: LineSignature): void {
		// HELD WHILE THE ZOOM OWNS THE VIEWPORT. Away from 100 percent the content box is the plugin's own counter-sizing, not a
		// re-wrap: the wrap under zoom is the 100 percent wrap. Measured on the round-trip cell, the width read 99, 141, 199, 306,
		// 405 and 519 at the 600 to 120 percent rests and 620 from a preview frame at the release, so no anchor was honoured
		// while zoomed and the release took a preview's signature. The 100 percent signature stands; the read at 100 percent
		// confirms it.
		if (this.pinchScaleNow !== 1) return;
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
				if (anchors.layoutChanged(path, src, measure ? "measure" : "transaction")) this.lineAnchorsMoved(path);
			} else if (measure && anchors.windowOpen && anchors.windowViewed(path, src)) this.lineAnchorsMoved(path);
		} else if (u.geometryChanged) {
			// No anchored ink and no window open: nothing to re-take or read again, but what was read is now old, and the measured
			// heights move with their lines.
			if (u.docChanged) anchors.skipped(u.startState.doc, u.changes, u.state.doc);
			else anchors.skipped();
		}
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
		if (inlineInk.strokes(path).length > 0 && (anchors.measuredFor(path) > 0 || anchors.markable) && !(this.lineAnchorPassTimer > 0))
			this.armLineAnchorPass(path, LINE_ANCHOR_QUIET_MS);
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
			this.lineAnchors.anchorMeasured(path, inlineInk.strokes(path));
			if (this.lineAnchors.generation !== gen) this.lineAnchorsMoved(path);
		}, ms);
	}

	/** Shown corrections changed: the copies, the index, the rasters and the frontier all describe the old places. */
	function lineAnchorsMoved(this: InkOverlayPlugin, path: string): void {
		this.frontierCache.invalidate(path);
		this.scheduleRepaint();
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
		return this.lineAnchors.strokesFor(path, inlineInk.strokes(path));
	}

	/** How far this surface shows a stroke below its page position, world units. */
	function lineAnchorDy(this: InkOverlayPlugin, stroke: InkStroke): number {
		return this.lineAnchors.dyOf(stroke);
	}

	/** Strokes a move has just landed (a lasso drop, an undo or redo of one): each rides the line it now sits on (LineAnchors.retake). */
	function retakeLineAnchors(this: InkOverlayPlugin, path: string, ids: readonly string[]): void {
		const wanted = new Set(ids);
		this.lineAnchors.retake(path, inlineInk.strokes(path).filter((s) => wanted.has(s.id)));
	}

export function installLineAnchors(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		lineWindowMeasured,
		readLineSignature,
		lineSignatureMeasured,
		requestLineSignature,
		updateLineAnchors,
		lineAnchorsDrawn,
		lineAnchorInkLoaded,
		armLineAnchorPass,
		lineAnchorsMoved,
		lineOnScreen,
		lineLayout,
		noteStrokes,
		lineAnchorDy,
		retakeLineAnchors,
	});
}
