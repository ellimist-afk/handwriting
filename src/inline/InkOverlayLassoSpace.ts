/**
 * The note surface's lasso and insert-space methods: the lasso and its drag,
 * the insert-space divider and its hover preview and the selection chrome.
 * They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads. The ink clipboard and snip commands are in InkOverlayClipboard.ts.
 * `hasSelection` and the gesture lifecycle stay in the class.
 */
import { installMethods } from "./InstallMethods";
import type { Text } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Notice } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { anchorTop } from "./DocumentTop";
import { tipMode } from "./TipMode";
import { blankLinesAbove, boundsOf, lineSteps, sameRowSides, strokeIdsBelow, sweptRect, InsertSpaceRows, nearestSpaceBoundary, type SpaceBoundary, canSplitParagraph, spaceProtectedBlocks } from "./InsertSpace";
import { BBox, InkStroke } from "../ink/Stroke";
import { drawStroke } from "../ink/StrokeRenderer";
import { PenSample } from "../input/PointerRouter";
import { padBBox, pointInBBox } from "../objects/Selection";
import { inkApplied, inkEffect } from "./InkHistory";
import { MAX_BACKING_AREA, visualToNote } from "./ZoomScale";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { committedFloorFor, inlineInk, SELECTION_GRAB_PAD, type InkOverlayPlugin } from "./InkOverlay";

/**
 * An insert space drag's moving ink, pen-down to release. The store does not move until the release; the committed layers
 * paint without the moving strokes (committedStrokes) and the tail layer shows them as one picture at the drag's offset
 * (drawSpacePicture), so a drag sample costs one copy of the picture instead of moving and re-rastering every moving stroke.
 */
export type SpaceSnapshot = {
	/** Whose drag: an insert space (vertical; blue, amber and labels) or a lasso selection (both axes, the ink's own colours). */
	kind: "space" | "lasso";
	/** The tail backing column the picture's column 0 is: 0 for an insert space, whose picture is the tail's width. */
	col: number;
	/** The moving strokes' ids, frozen at pen-down. */
	ids: ReadonlySet<string>;
	/** The list `staying` was made from: one filtered list per list, so the extent raster's identity check holds. */
	source: readonly InkStroke[];
	/** `source` without the moving strokes: what the committed layers paint during the drag. */
	staying: readonly InkStroke[];
	/** The moving strokes, store order. */
	moving: readonly InkStroke[];
	/** Their box at pen-down. */
	box: BBox;
	/** The committed layers' painted stroke count at pen-down: they hold that store again once the release paints the box. */
	painted: number;
	/** The staying strokes of the rows the seam crosses (drawn amber), and those of them on screen at `amberAt`. */
	amberAll: readonly InkStroke[];
	amber: readonly InkStroke[];
	amberAt: { x: number; y: number; zoom: number; w: number; h: number; scale: number };
	/** The band at pen-down and the pane's left edge in it, for the labels: the band does not move under a held contact. */
	band: unknown;
	left: number;
	/** The picture: the moving ink at its pen-down place as the drag shows it, its own colours under the blue. */
	canvas: HTMLCanvasElement | null;
	tailCtx: CanvasRenderingContext2D | null;
	/** What the picture holds: the tail's backing rows top .. bottom at offset 0, rastered from lo down to done, at this camera,
	 * backing and tail size; `at` is that camera, which the picture is drawn at, its row 0 being the tail's row top by a whole-px
	 * offset. */
	top: number;
	lo: number;
	done: number;
	bottom: number;
	at: CameraState;
	x: number;
	y: number;
	zoom: number;
	backing: number;
	w: number;
	h: number;
};

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		pruneSelectionOnInkChange(path: string): void;
		strokesHere(): readonly InkStroke[];
		selectionBounds(): BBox | null;
		lassoDown(sample: PenSample): void;
		lassoMove(samples: PenSample[]): void;
		commitLiveDrag(): void;
		lassoUp(): void;
		spaceTextBoundary(y: number, direction: -1 | 1): SpaceBoundary | null;
		planSpace(y: number): SpaceBoundary | null;
		previewSpace(plan: SpaceBoundary, known?: ReturnType<InsertSpaceRows["get"]>): NonNullable<InkOverlayPlugin["spacePreview"]>;
		queueSpaceFeedback(y: number): void;
		clearSpaceFeedback(redraw?: boolean): void;
		spaceDown(sample: PenSample, _ev: PointerEvent): void;
		spaceMove(samples: PenSample[]): void;
		spaceUp(): void;
		spaceTextChange(plan: (SpaceBoundary & { doc: Text }) | null, applied: number): { changes: { from: number; to: number; insert: string } | null; dy: number; lines: number };
		dissolveSelection(): void;
		queueTailShrink(): void;
		shrinkTailNow(): void;
		spaceDrawItems(preview: NonNullable<InkOverlayPlugin["spacePreview"]>, cam: CameraState): { stroke: InkStroke; color: string }[];
		buildSpaceDrawItems(preview: NonNullable<InkOverlayPlugin["spacePreview"]>, cam: CameraState): { stroke: InkStroke; color: string }[];
		redrawSelectionUI(rows?: ReturnType<InsertSpaceRows["get"]>): void;
		rollbackSpaceMove(): void;
		committedStrokes(strokes: readonly InkStroke[]): readonly InkStroke[];
		beginSpaceSnapshot(here: readonly InkStroke[]): boolean;
		beginLassoSnapshot(here: readonly InkStroke[]): boolean;
		endSpaceSnapshot(): SpaceSnapshot | null;
		spaceAmber(snap: SpaceSnapshot, cam: CameraState): readonly InkStroke[];
		drawSpacePicture(snap: SpaceSnapshot, cam: CameraState): void;
		rasterSpacePicture(snap: SpaceSnapshot, cam: CameraState, shift: number, boxTop: number, boxBottom: number, shiftX?: number, boxLeft?: number, boxRight?: number): void;
		rasterSpaceRows(snap: SpaceSnapshot, to: number): void;
		/** An insert space or lasso drag's moving ink (SpaceSnapshot), pen-down to release; null or absent otherwise. */
		spaceSnapshot?: SpaceSnapshot | null;
		/** How far below the tail the picture reaches, in tail heights (1 unless a test sets it). */
		spacePictureReach?: number;
	}
}

const SELECTION_COLOR = "#7f9cf5";
/** The insert space preview's staying strokes (the rows the seam crosses). */
const STAYING_COLOR = "#d98b00";
/** The insert space picture's rows rastered at least at a time, once the drag reaches past what it holds; backing px. */
const SPACE_ROWS_CHUNK = 64;

/** Minimum spacing between lasso vertices, in screen px. */
const LASSO_MIN_STEP_PX = 2;

/**
 * The most a drag may move ink up (a value at or below 0) before its box meets
 * the note's top. A box already at or above the top may not go up at all.
 */
function topWallRoom(box: BBox | null): number {
	return box ? Math.min(0, -box.y) : -Infinity;
}

/**
 * A lasso drag's offset as its picture shows it, in whole backing px at `k` (the camera's zoom times the backing): the nearest
 * whole px in each axis, or in y the next one down when the nearest would put the grab's box above the note's top (the wall).
 * The lift moves the store by this over `k`, so the ink lands where the picture showed it: no jump at the lift, of any size.
 */
function shownLassoOffset(total: { dx: number; dy: number }, box: BBox, k: number): { x: number; y: number } {
	const y = Math.round(total.dy * k);
	return { x: Math.round(total.dx * k), y: y / k < topWallRoom(box) ? Math.ceil(total.dy * k) : y };
}

/** Two insert-space seams that draw the same preview. */
function samePlan(a: SpaceBoundary, b: SpaceBoundary): boolean {
	return a.y === b.y && a.from === b.from && a.lineHeight === b.lineHeight &&
		a.text === b.text && a.blockFallback === b.blockFallback;
}

	/** Reconcile another pane's selection at the ink-change boundary, not on drag frames. */
	function pruneSelectionOnInkChange(this: InkOverlayPlugin, path: string): void {
		if (path !== this.filePath() || this.selection.isEmpty) return;
		// A live gesture in the other pane leaves this lasso alone until its
		// gesture-end notification; only then is the shared stroke list final.
		const before = this.selection.size;
		this.selection.prune(
			new Set(inlineInk.strokes(path).map((stroke) => stroke.id)),
			new Set(this.selection.boxIds),
			new Set(this.selection.imageIds)
		);
		if (this.selection.size === before) return;
		this.redrawSelectionUI();
		this.refreshStrip();
	}

	/** The note's strokes as this surface shows them (noteStrokes): the lasso, the selection, insert-space rows and copy read these. */
	function strokesHere(this: InkOverlayPlugin): readonly InkStroke[] {
		const path = this.filePath();
		return path ? this.noteStrokes(path) : [];
	}

	function selectionBounds(this: InkOverlayPlugin): BBox | null {
		const frozen = this.dragBox;
		// A lasso drag carried as a picture moves the ids frozen at the grab, whatever the selection holds now: a stroke pruned
		// from it mid-drag still rides the picture, so the box drawn and the top wall follow the picture, not the store's bounds,
		// which no longer move. A drag without the picture keeps the box only while the selection is the grab's.
		const pictured = this.spaceSnapshot?.kind === "lasso" && !this.selection.isEmpty;
		if (frozen && this.dragTotal && (pictured || this.selection.size === frozen.size)) {
			const { box } = frozen;
			return { x: box.x + this.dragTotal.dx, y: box.y + this.dragTotal.dy, width: box.width, height: box.height };
		}
		return this.selection.bounds(this.strokesHere(), () => null, () => null);
	}

	function lassoDown(this: InkOverlayPlugin, sample: PenSample): void {
		// One call site for both paths into a lasso gesture - a fresh loop
		// and grabbing an existing selection to drag both reach here, from
		// the two call sites in `penDown` - so the reticle persists through
		// either kind of lasso without either call site having to remember
		// it. Same watchdog reasoning as the eraser: hover has gone quiet by
		// the time a contact is claimed, and nothing else touches
		// `penCursorEl` for the length of the gesture without this.
		this.showLassoCursor(sample);
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const bounds = this.selectionBounds();
		// Landing inside an existing selection moves it; anywhere else lassos.
		if (
			bounds &&
			pointInBBox(w.x, w.y, padBBox(bounds, visualToNote(SELECTION_GRAB_PAD, this.scale)))
		) {
			this.dragFrom = { x: w.x, y: w.y };
			this.dragTotal = { dx: 0, dy: 0 };
			this.dragBox = { box: { ...bounds }, size: this.selection.size };
			this.dragIds = [...this.selection.strokeIds];
			const here = this.filePath();
			this.dragHistoryIdentity = here ? inlineInk.captureHistoryIdentity(here) : null;
			this.beginLassoSnapshot(this.strokesHere());
			return;
		}
		this.selection.clear();
		this.lassoActive = true;
		this.lassoPts = [w];
		if (this.strokesHere().length === 0) {
			// Same reasoning as the eraser's own empty-page check right above
			// it: a fresh loop on a page with no ink at all can never select
			// anything, whatever shape it ends up drawing, so say so now
			// rather than let the lasso close over nothing in silence.
			//
			// And the same gate, for the same reason. Only the eraser was
			// reported (a lasso is not scrubbed, so it spams less readily),
			// but the "even though there is" half is identical here - an
			// unread sidecar makes this branch claim an inked note is empty -
			// and this file's own test header says the eraser and the lasso
			// "are the same shape". Leaving one of a declared pair fixed is
			// how the divergences StripPenChrome.test.ts exists to catch get
			// started.
			this.sayIfPageEmpty(this.filePath(), "select");
		}
		this.redrawSelectionUI();
	}

	function lassoMove(this: InkOverlayPlugin, samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last) return;

		if (this.dragFrom && this.dragTotal) {
			const path = this.filePath();
			if (!path) return;
			// Escape or a tool change let go of the selection with the pen
			// still down: the ink stays where it was let go for the rest of
			// the contact, and the move the lift records stops growing with it.
			if (this.selection.isEmpty) return;
			const w = this.camera.screenToWorld(last.x, last.y);
			const dx = w.x - this.dragFrom.x;
			// Live drag only translates coordinates in the store; the history
			// op is pushed once at release, naming the ids frozen at pen-down,
			// which are also the ids moved here.
			const before = this.selectionBounds();
			// THE TOP IS A WALL. No scroll room exists above the note's top, so
			// ink dragged past it could not be seen, lassoed or fitted again
			// (Alan: no infinite space up and left; the left edge is not walled
			// here). The selection stops with its box at the top; ink already
			// above it may go down, never further up.
			const dy = Math.max(w.y - this.dragFrom.y, topWallRoom(before));
			if (this.spaceSnapshot?.kind === "lasso") {
				// The selected ink rides the tail as the grab's picture (drawSpacePicture): a sample moves nothing in the store and
				// repaints no committed ink, and the lift moves the store once by the total. Moving every selected stroke and
				// repainting its box per sample was the drag's lag on a heavy note. Other panes update at the lift.
				this.dragTotal.dx += dx;
				this.dragTotal.dy += dy;
				this.dragFrom = { x: w.x, y: this.dragFrom.y + dy };
				// A queued repaint draws the picture and the box in its frame; drawing them here too drew them twice.
				if (!this.repaintQueued || this.pinchPreview) this.redrawSelectionUI();
				return;
			}
			this.moveLive(path, this.dragIds, dx, dy);
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			// The pen's return is not a jump: the grab point follows only the
			// distance the ink moved, so the ink resumes once the pen is back
			// at the point where it stopped.
			this.dragFrom = { x: w.x, y: this.dragFrom.y + dy };
			let moved: BBox[] | undefined;
			if (before) {
				moved = [before, { x: before.x + dx, y: before.y + dy, width: before.width, height: before.height }];
				for (const rect of moved) this.damage.addRect(rect);
			} else {
				this.damage.addAll();
			}
			this.scheduleRepaint("partial");
			this.repaintPath(path, moved);
			this.redrawSelectionUI();
			return;
		}

		if (!this.lassoActive) return;
		const minStep = visualToNote(LASSO_MIN_STEP_PX, this.scale);
		for (const sample of samples) {
			const p = this.camera.screenToWorld(sample.x, sample.y);
			const prev = this.lassoPts[this.lassoPts.length - 1];
			if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= minStep) {
				this.lassoPts.push(p);
			}
		}
		this.redrawSelectionUI();
	}

	/**
	 * End a live selection drag where it stands: one save and one undoable
	 * move of the strokes picked up at pen-down.
	 *
	 * Pen-up is the usual caller. Escape, Delete and a tool change can arrive
	 * with the pen still down and clear the selection; the ids frozen at
	 * pen-down keep the pen-up's move naming the strokes that moved. Delete
	 * also changes those strokes, so it commits the drag first: the move so
	 * far is one step and the delete the next, in that order.
	 */
	function commitLiveDrag(this: InkOverlayPlugin): void {
		const total = this.dragTotal;
		if (!total) return;
		let { dx, dy } = total;
		// The op freezes WHICH strokes moved, as picked up at pen-down. An old
		// move must never later act on whatever happens to be selected, and a
		// selection cleared mid-drag must not turn the move into one of nothing.
		const strokeIds = this.dragIds;
		// A drag carried as a picture: from here the committed layers paint the store again, with the count they held at the grab.
		const snap = this.spaceSnapshot?.kind === "lasso" ? this.endSpaceSnapshot() : null;
		this.dragFrom = null;
		this.dragTotal = null;
		this.dragBox = null;
		this.dragIds = [];
		this.dragHistoryIdentity = null;
		const path = this.filePath();
		if (snap) {
			this.indexDirty = true;
			this.paintedStrokeCount = snap.painted;
			// The store moves by the offset the picture showed, whole backing px at the lift's camera, not by the pen's exact total:
			// the ink lands where it was seen. It ends within half a backing px of the pen's total, the drag's own quantisation.
			const b = this.committedBacking ?? 0;
			const k = b > 0 ? this.camera.snapshot.zoom * b : 0;
			if (k > 0 && Number.isFinite(k)) {
				const shown = shownLassoOffset(total, snap.box, k);
				dx = shown.x / k;
				dy = shown.y / k;
			}
		}
		if (path && strokeIds.length && (dx !== 0 || dy !== 0)) {
			// The samples moved only the picture: the store moves here, once, by the offset the picture showed.
			if (snap) this.moveLive(path, strokeIds, dx, dy);
			// The dropped strokes ride the lines they were dropped on, not the ones they left.
			this.retakeLineAnchors(path, strokeIds);
			inlineInk.save(path);
			this.dispatchInk({ type: "move", path, strokeIds, dx, dy });
			// A move changes no stroke COUNT, so the cache's cheap guard
			// cannot see it. §5g/G1.
			this.frontierCache.invalidate(path);
		}
		if (snap) {
			// The committed layers drew without the selected ink since the grab: paint its box where it ends up, and the other
			// panes over where it was and where it is.
			const moved = { x: snap.box.x + dx, y: snap.box.y + dy, width: snap.box.width, height: snap.box.height };
			this.extentArmAsked = true;
			this.bandGrowthMayWait = true; // the range this lift grows needs no new band until a scroll does (syncBand)
			this.damage.addRect(moved);
			this.scheduleRepaint("partial");
			if (path && (dx !== 0 || dy !== 0)) this.repaintPath(path, [snap.box, moved]);
		}
	}

	function lassoUp(this: InkOverlayPlugin): void {
		if (this.dragTotal) {
			this.commitLiveDrag();
			this.redrawSelectionUI();
			return;
		}
		// A drag committed early (Delete mid-drag) leaves the pen down with no
		// drag and no loop: there is nothing to select at lift.
		if (!this.lassoActive) {
			this.redrawSelectionUI();
			return;
		}
		this.lassoActive = false;
		this.selection.selectByLasso(this.lassoPts, this.strokesHere(), [], () => null);
		this.lassoPts = [];
		this.redrawSelectionUI();
	}

	// ---- insert space (divider gesture: ink below the line follows the pen) --

	/** A visual line start, not the beginning of its entire Markdown paragraph.
	 * Layout rectangles are screen pixels; converting through the fresh note
	 * origin and effective ink scale also covers font scaling and scrolling. */
	function spaceTextBoundary(this: InkOverlayPlugin, y:number,direction:-1|1):SpaceBoundary|null {
		if (!this.container || !this.view.dom.isConnected || !(this.scale>0)) return null;
		const origin=anchorTop(this.view,this.contentStyle?.paddingTop,this.cssScale);
		const clientY=origin+y*this.scale;
		const x=this.view.contentDOM.getBoundingClientRect().left+this.cssScale;
		const find=(screenY:number):SpaceBoundary|null=>{
			const pos=this.view.posAtCoords({x,y:screenY});
			if(pos===null)return null;
			const hit=this.view.coordsAtPos(pos,1);
			if(!hit)return null;
			// CM's visual-line navigation samples one SCREEN pixel inside the
			// editor. At 10% that can skip the first character. Find the first
			// position on this rendered row by its vertical coordinates instead.
			let from=this.view.state.doc.lineAt(pos).from,hi=pos;
			while(from<hi){
				const mid=Math.floor((from+hi)/2),rect=this.view.coordsAtPos(mid,1);
				if(!rect)return null;
				if(rect.top<hit.top-.01*this.cssScale)from=mid+1;else hi=mid;
			}
			const line=this.view.state.doc.lineAt(from);
			const block=this.spaceTextEnd?.blocks.find(block=>line.number>=block.from&&line.number<=block.to);
			let blockFallback=false;
			if(block&&(line.number>block.from||from>line.from||block.frontmatter)){
				blockFallback=true;
				if(direction<0){if(block.frontmatter)return null;from=this.view.state.doc.line(block.from).from;}
				else if(block.to<this.view.state.doc.lines)from=this.view.state.doc.line(block.to+1).from;
				else return null;
			}else if(from>line.from&&!canSplitParagraph(line.text,from-line.from)){
				blockFallback=true;
				if(direction<0)from=line.from;
				else if(line.number<this.view.state.doc.lines)from=this.view.state.doc.line(line.number+1).from;
				else return null;
			}
			const rect=this.view.coordsAtPos(from,1);
			if(!rect)return null;
			const dom=this.view.domAtPos(from).node;
			const el=(dom.nodeType===1?dom as Element:dom.parentElement)?.closest(".cm-line");
			if(!el)return null;
			const style=this.winRef.getComputedStyle(el);
			const lh=parseFloat(style.lineHeight)*this.cssScale || this.view.defaultLineHeight;
			if(!(lh>0))return null;
			const top=el.getBoundingClientRect().top;
			const rowTop=top+Math.max(0,Math.round((rect.top-top)/lh))*lh;
			return {y:(rowTop-origin)/this.scale,from,lineHeight:lh/this.scale,blockFallback};
		};
		let boundary=find(clientY);
		if(!boundary)return null;
		if(direction>0&&boundary.y<y-1e-5) {
			boundary=find(origin+(boundary.y+boundary.lineHeight)*this.scale+Math.min(.1,this.cssScale));
		}
		if(!boundary||(boundary.y-y)*direction < -1e-5)return null;
		return boundary;
	}

	function planSpace(this: InkOverlayPlugin, y:number):SpaceBoundary|null {
		const doc=this.view.state.doc;
		if(this.spaceTextEnd?.doc!==doc){
			let pos=0;
			for(let n=doc.lines;n>0;n--){const line=doc.line(n),text=line.text.trimEnd();if(text.trim()){pos=line.from+text.length;break;}}
			this.spaceTextEnd={doc,pos,blocks:spaceProtectedBlocks(n=>doc.line(n).text,doc.lines)};
		}
		// No text below the contact: the ink seam remains continuous instead
		// of jumping back to the final Markdown line. No blank lines are
		// manufactured in a note just to move ink that has no text to follow.
		const end=this.spaceTextEnd.pos;
		const textBottom=end===0?0:this.view.lineBlockAt(end).bottom/this.scale;
		if(end===0||y>=textBottom){
			return {y,from:doc.length,lineHeight:this.view.defaultLineHeight/this.scale,text:false};
		}
		return nearestSpaceBoundary(y,(at,direction)=>this.spaceTextBoundary(at,direction));
	}

	function previewSpace(this: InkOverlayPlugin, plan:SpaceBoundary,known?:ReturnType<InsertSpaceRows["get"]>):NonNullable<InkOverlayPlugin["spacePreview"]> {
		const strokes=this.strokesHere();
		const rows=known??(this.spaceRowsCache??=new InsertSpaceRows()).get(strokes);
		// Below the text every hover sample is a new plan. While the rows are the same (the cache keeps its array while the
		// strokes and their revisions do) and none changes side of the seam, the lists are the last preview's; rebuilding them
		// filters every stroke.
		const prior=this.spacePreview;
		if(prior&&prior.rows===rows&&sameRowSides(rows,prior.plan.y,plan.y))
			return {plan,doc:this.view.state.doc,moving:prior.moving,staying:prior.staying,rows};
		const moving=strokeIdsBelow(strokes,plan.y,rows),ids=new Set(moving);
		const staying=rows.filter(row=>row.top<plan.y&&row.bottom>plan.y)
			.flatMap(row=>row.ids).filter(id=>!ids.has(id));
		return {plan,doc:this.view.state.doc,moving,staying,rows};
	}

	/** Coalesce hover feedback without repainting the committed ink layer.
	 * The pointer itself updates synchronously, even when no seam is legal. */
	function queueSpaceFeedback(this: InkOverlayPlugin, y:number):void {
		if(!this.tail)return;
		this.spaceHoverY=y;
		if(this.spaceFeedbackRaf!=null)return;
		this.spaceFeedbackRaf=this.winRef.requestAnimationFrame(()=>{
			this.spaceFeedbackRaf=null;
			// The overlay can be torn down between the request and the frame;
			// planSpace/previewSpace/redrawSelectionUI all reach geometry that
			// is gone by then.
			if(!this.container)return;
			if(this.spaceHoverY===null||tipMode()!=="space")return;
			// A live drag keeps the set it froze at pen-down, so the frame has
			// nothing to read, plan or draw: spaceMove draws once per sample.
			if(this.spacePlan&&this.spaceLineY!==null)return;
			// One ask of the rows cache per frame, handed to everything below.
			const rows=(this.spaceRowsCache??=new InsertSpaceRows()).get(this.strokesHere());
			// A frame that would draw what the last one drew is skipped: the
			// pen sliding along a line re-planned the seam and re-stroked every
			// previewed stroke at hover rate. Same hover y skips the plan too;
			// same plan skips the redraw. The key also carries what the drawing
			// depends on besides the plan: the document, the ink (the rows
			// cache returns a new array after any change), the camera and size.
			const last=this.spaceFeedbackKey;
			const cam=this.camera.snapshot;
			const same=(k:NonNullable<typeof last>)=>k.doc===this.view.state.doc&&k.mode===this.mode&&
				k.rows===rows&&k.x===cam.x&&k.y===cam.y&&k.zoom===cam.zoom&&
				k.w===this.cssWidth&&k.h===this.cssHeight&&k.preview===this.spacePreview;
			if(last&&last.hoverY===this.spaceHoverY&&same(last))return;
			if(this.mode!=="space"){
				const plan=this.planSpace(this.spaceHoverY);
				const prior=this.spacePreview;
				if(plan&&prior&&last&&same(last)&&samePlan(plan,prior.plan)){
					last.hoverY=this.spaceHoverY;
					return;
				}
				this.spacePreview=plan?this.previewSpace(plan,rows):null;
			}
			this.redrawSelectionUI(rows);
			this.spaceFeedbackKey={hoverY:this.spaceHoverY,doc:this.view.state.doc,mode:this.mode,
				rows,x:cam.x,y:cam.y,zoom:cam.zoom,
				w:this.cssWidth,h:this.cssHeight,preview:this.spacePreview};
		});
	}

	/** Drop the hover feedback. `redraw` false: the caller draws the selection layer itself before it returns. */
	function clearSpaceFeedback(this: InkOverlayPlugin, redraw=true):void {
		if(this.spaceFeedbackRaf!=null)this.winRef.cancelAnimationFrame(this.spaceFeedbackRaf);
		this.spaceFeedbackRaf=null;
		this.spaceFeedbackKey=null;
		this.spaceHoverY=null;
		const hadPreview=!!this.spacePreview;
		this.spacePreview=null;
		if(hadPreview&&redraw)this.redrawSelectionUI();
	}

	function spaceDown(this: InkOverlayPlugin, sample: PenSample, _ev: PointerEvent): void {
		// Same watchdog reasoning as lassoDown and the pan branch above: this
		// is the one call site into a space gesture, so the reticle persists
		// through it from the first sample rather than only from whatever
		// hover happened to leave behind.
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const here = this.strokesHere();
		// Resolve the seam once for the text position, ink membership and
		// displayed guide. Never re-hit-test the original contact at release.
		const plan=this.planSpace(w.y);
		if(!plan){this.spacePlan=null;this.spaceLineY=null;this.clearSpaceFeedback();this.showSpaceCursor(sample);return;}
		const cut = plan.y;
		this.spacePlan={...plan,doc:this.view.state.doc};
		const path=this.filePath();
		this.spaceHistoryIdentity=path?inlineInk.captureHistoryIdentity(path):null;
		this.spacePreview=this.previewSpace(plan);
		this.spaceLineY = cut;
		this.showSpaceCursor(sample);
		this.spaceFromY = w.y;
		this.spaceTotalDy = 0;
		// The id list freezes at pen-down, and so does the box around it:
		// membership cannot change mid-drag, so the damage region is just
		// that box swept by the distance travelled.
		this.spaceIds = [...this.spacePreview.moving];
		this.spaceRows = this.spacePreview.rows;
		this.spaceSteps = [];
		this.spaceBounds = boundsOf(here, this.spaceIds);
		if (this.spaceIds.length === 0 && !this.view.state.doc.sliceString(plan.from).trim()) {
			new Notice("Handwriting: no content below the line");
			this.spacePlan=null;this.spaceLineY=null;this.clearSpaceFeedback();
		}
		const pictured = this.spaceLineY !== null && this.spaceIds.length > 0 && this.beginSpaceSnapshot(here);
		// The pen-down repaint draws the selection layer in the frame that paints the committed layers without the moving ink;
		// drawing it here as well drew it twice for one frame.
		if (!pictured || !this.repaintQueued || this.pinchPreview) this.redrawSelectionUI();
	}

	/**
	 * Take the moving ink off the committed layers for the drag (SpaceSnapshot): one whole repaint, in the next frame, paints them
	 * from the list without it, and the tail shows it as a picture from then until the release. The extent raster goes as a store
	 * change lets it go (the list it was built from is not the one painted now), and a build under way stops here: it would finish
	 * a raster no frame of the drag can use.
	 */
	function beginSpaceSnapshot(this: InkOverlayPlugin, here: readonly InkStroke[]): boolean {
		const box = this.spaceBounds;
		const preview = this.spacePreview;
		if (!box || !preview) return false;
		const ids = new Set(this.spaceIds), stayingIds = new Set(preview.staying);
		const staying: InkStroke[] = [], moving: InkStroke[] = [], amberAll: InkStroke[] = [];
		for (const s of here) {
			if (ids.has(s.id)) moving.push(s);
			else {
				staying.push(s);
				if (stayingIds.has(s.id)) amberAll.push(s);
			}
		}
		const band = this.band;
		this.spaceSnapshot = {
			kind: "space", col: 0, ids, source: here, staying, moving, box: { ...box }, painted: this.paintedStrokeCount, amberAll, amber: [],
			amberAt: { x: NaN, y: NaN, zoom: NaN, w: NaN, h: NaN, scale: NaN },
			band, left: band ? Math.max(0, this.view.scrollDOM.scrollLeft - band.left) : 0,
			canvas: null, tailCtx: null, top: 0, lo: 0, done: 0, bottom: 0, at: { x: 0, y: 0, zoom: 1 }, x: NaN, y: NaN, zoom: NaN, backing: NaN, w: 0, h: 0,
		};
		this.dropExtentBuild();
		this.scheduleRepaint();
		return true;
	}

	/**
	 * Take a lasso selection's ink off the committed layers for its drag, as beginSpaceSnapshot does for an insert space: the ids
	 * and the box frozen at the grab, one whole repaint without them in the next frame, and the tail shows them as a picture at
	 * the drag's offset in both axes until the lift moves the store. No amber, no blue: the ink in its own colours.
	 */
	function beginLassoSnapshot(this: InkOverlayPlugin, here: readonly InkStroke[]): boolean {
		const box = this.dragBox?.box;
		if (!box || this.dragIds.length === 0) return false;
		const ids = new Set(this.dragIds);
		const staying: InkStroke[] = [], moving: InkStroke[] = [];
		for (const s of here) (ids.has(s.id) ? moving : staying).push(s);
		if (moving.length === 0) return false;
		const band = this.band;
		this.spaceSnapshot = {
			kind: "lasso", col: 0, ids, source: here, staying, moving, box: { ...box }, painted: this.paintedStrokeCount, amberAll: [], amber: [],
			amberAt: { x: NaN, y: NaN, zoom: NaN, w: NaN, h: NaN, scale: NaN },
			band, left: band ? Math.max(0, this.view.scrollDOM.scrollLeft - band.left) : 0,
			canvas: null, tailCtx: null, top: 0, lo: 0, done: 0, bottom: 0, at: { x: 0, y: 0, zoom: 1 }, x: NaN, y: NaN, zoom: NaN, backing: NaN, w: 0, h: 0,
		};
		this.dropExtentBuild();
		this.scheduleRepaint();
		return true;
	}

	/** End the drag's snapshot and release its picture. Returns it, or null when none was held. */
	function endSpaceSnapshot(this: InkOverlayPlugin): SpaceSnapshot | null {
		const snap = this.spaceSnapshot ?? null;
		if (!snap) return null;
		this.spaceSnapshot = null;
		if (snap.canvas) {
			snap.canvas.width = 0;
			snap.canvas.height = 0;
			snap.canvas = null;
		}
		snap.tailCtx = null;
		return snap;
	}

	/**
	 * The strokes the committed layers paint from the note's list (InkOverlayRepaint's two call sites): the list itself, or
	 * during an insert space drag the list without the moving strokes, which the tail shows as a picture until the release moves
	 * them in the store. The filtered list is made once per list, so a repaint during the drag finds the same object each time.
	 */
	function committedStrokes(this: InkOverlayPlugin, strokes: readonly InkStroke[]): readonly InkStroke[] {
		const snap = this.spaceSnapshot;
		if (!snap) return strokes;
		if (snap.source !== strokes) {
			snap.source = strokes;
			snap.staying = strokes.filter(s => !snap.ids.has(s.id));
		}
		return snap.staying;
	}

	/** The amber strokes on screen: picked again only when the camera, the size or the zoom changes. */
	function spaceAmber(this: InkOverlayPlugin, snap: SpaceSnapshot, cam: CameraState): readonly InkStroke[] {
		const at = snap.amberAt;
		if (at.x === cam.x && at.y === cam.y && at.zoom === cam.zoom && at.w === this.cssWidth && at.h === this.cssHeight && at.scale === this.cssScale)
			return snap.amber;
		at.x = cam.x; at.y = cam.y; at.zoom = cam.zoom; at.w = this.cssWidth; at.h = this.cssHeight; at.scale = this.cssScale;
		snap.amber = snap.amberAll.filter(s => this.tail.spaceStrokeOnScreen(cam, s, this.cssWidth, this.cssHeight, this.cssScale));
		return snap.amber;
	}

	/**
	 * The moving ink on the tail at the drag's offset: one copy of the picture's rows the tail shows, at whole backing px so it
	 * stays sharp (the ink trails the pen by under half a backing px; a lasso's lift moves the store by that same whole-px offset,
	 * so the ink stays where the picture showed it). Drawn
	 * after the tail's clearAll and before its divider, which mark the layer painted. The picture is made again only when the
	 * camera, the backing or the tail's size changes, or the drag leaves its window; rows the drag reaches for the first time
	 * (an upward drag pulling ink in from below, a downward one bringing it in from above the tail's top) are rastered first, a
	 * chunk at a time.
	 */
	function drawSpacePicture(this: InkOverlayPlugin, snap: SpaceSnapshot, cam: CameraState): void {
		const tail = this.tailCanvas, b = this.committedBacking ?? 0, k = cam.zoom * b;
		if (!tail || !(k > 0) || !Number.isFinite(k) || tail.width === 0 || tail.height === 0) return;
		// The drag's offset in whole backing px: an insert space's is vertical, a lasso's follows the pen both ways (shownLassoOffset,
		// which the lift moves the store by).
		const lasso = snap.kind === "lasso", drag = lasso ? this.dragTotal : null;
		const at = drag ? shownLassoOffset(drag, snap.box, k) : null;
		const shift = at ? at.y : lasso ? 0 : Math.round(this.spaceTotalDy * k), shiftX = at ? at.x : 0;
		// The moving box's rows at pen-down, in tail backing px at offset 0, padded for the blue stroke's floor width.
		const pad = Math.ceil(4 * b / this.cssScale) + 2;
		const boxTop = Math.floor((snap.box.y - cam.y) * k) - pad, boxBottom = Math.ceil((snap.box.y + snap.box.height - cam.y) * k) + pad;
		const needTop = Math.max(boxTop, -shift), needBottom = Math.min(boxBottom, tail.height - shift);
		if (needBottom <= needTop) return;
		// Its columns: an insert space's picture is the tail's width at column 0; a lasso's holds the box's columns the drag shows.
		const boxLeft = lasso ? Math.floor((snap.box.x - cam.x) * k) - pad : 0;
		const boxRight = lasso ? Math.ceil((snap.box.x + snap.box.width - cam.x) * k) + pad : tail.width;
		const needLeft = Math.max(boxLeft, -shiftX), needRight = Math.min(boxRight, tail.width - shiftX);
		if (needRight <= needLeft) return;
		if (!snap.canvas || snap.x !== cam.x || snap.y !== cam.y || snap.zoom !== cam.zoom || snap.backing !== b || snap.w !== tail.width ||
			snap.h !== tail.height || needTop < snap.top || needBottom > snap.bottom || needLeft < snap.col || needRight > snap.col + snap.canvas.width)
			this.rasterSpacePicture(snap, cam, shift, boxTop, boxBottom, shiftX, boxLeft, boxRight);
		const pic = snap.canvas;
		if (!pic) return;
		if (needBottom > snap.done) this.rasterSpaceRows(snap, Math.max(needBottom, snap.done + SPACE_ROWS_CHUNK));
		if (needTop < snap.lo) this.rasterSpaceRows(snap, Math.min(needTop, snap.lo - SPACE_ROWS_CHUNK));
		const from = Math.max(needTop, snap.lo), to = Math.min(needBottom, snap.done);
		if (to <= from) return;
		const ctx = snap.tailCtx ??= tail.getContext("2d");
		if (!ctx) return;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		const fromX = lasso ? needLeft : 0, toX = lasso ? needRight : pic.width;
		ctx.drawImage(pic, fromX - snap.col, from - snap.top, toX - fromX, to - from, fromX + shiftX, from + shift, toX - fromX, to - from);
		ctx.restore();
	}

	/**
	 * Make the picture's window: rows down to the pane's bottom plus `spacePictureReach` pane heights (an upward drag pulls ink in
	 * from there), at least the whole canvas, and up to the box's top within one canvas's pixel budget counted from that bottom.
	 * A box whose top is above the canvas's (a tall row crossing the line near the screen's top) then keeps its window while a
	 * drag down brings those rows in; when the budget does not reach the rows the offset shows now, the window starts at them.
	 * Row 0 is the tail's backing row `top`, a whole px. Nothing is rastered here: drawSpacePicture rasters the rows it shows
	 * (rasterSpaceRows), starting from the rows the offset shows now, so a drag never pays for rows it does not reach. The
	 * pane's place in the canvas is read here: two layout reads per window, at pen-down and when the drag leaves it.
	 */
	function rasterSpacePicture(this: InkOverlayPlugin, snap: SpaceSnapshot, cam: CameraState, shift: number, boxTop: number, boxBottom: number,
		shiftX = 0, boxLeft = 0, boxRight = 0): void {
		const tail = this.tailCanvas, b = this.committedBacking ?? 0;
		// A lasso's columns: at the grab, only the box's columns the offset shows now; when the drag leaves that window, those
		// columns and one tail width either side, within the box, so a drag on sideways makes the picture again at most once a
		// tail width. An insert space's: the tail's own.
		const margin = snap.kind === "lasso" && snap.canvas ? tail.width : 0;
		const col = snap.kind === "lasso" ? Math.max(boxLeft, -shiftX - margin) : 0;
		const w = snap.kind === "lasso" ? Math.max(1, Math.min(boxRight, tail.width - shiftX + margin) - col) : tail.width;
		const reach = Math.max(0, this.spacePictureReach ?? 1);
		// The pane in the committed canvas's backing rows (its box carries any zoom transform); the tail's rows are the same.
		const layer = this.committedCanvas.getBoundingClientRect(), pane = this.view.scrollDOM.getBoundingClientRect();
		const perPx = layer.height > 0 ? this.committedCanvas.height / layer.height : 0;
		const paneBottom = (pane.bottom - layer.top) * perPx, paneHeight = pane.height * perPx;
		const reachRows = Number.isFinite(paneBottom) && paneHeight > 0 ? Math.max(tail.height, Math.ceil(paneBottom + reach * paneHeight)) : tail.height;
		const budget = Math.floor(MAX_BACKING_AREA / w), need = Math.max(boxTop, -shift);
		let bottom = Math.min(boxBottom, reachRows - shift), top = Math.max(boxTop, bottom - budget);
		if (top > need) { top = need; bottom = Math.min(bottom, top + budget); }
		bottom = Math.max(top, bottom);
		// A detached canvas in the layer's own document (a popout's, in a popout).
		const pic = snap.canvas ?? (tail.cloneNode(false) as HTMLCanvasElement);
		if (pic.width !== w) pic.width = w;
		if (pic.height !== bottom - top) pic.height = bottom - top;
		const ctx = pic.getContext("2d");
		snap.canvas = ctx ? pic : null;
		snap.top = top; snap.lo = snap.done = Math.max(top, -shift); snap.bottom = bottom; snap.col = col;
		snap.x = cam.x; snap.y = cam.y; snap.zoom = cam.zoom; snap.backing = b; snap.w = tail.width; snap.h = tail.height;
		snap.at = { x: cam.x, y: cam.y, zoom: cam.zoom };
		if (!ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		ctx.clearRect(0, 0, pic.width, pic.height);
	}

	/**
	 * Raster the picture's rows from `done` down to `to`, or, with `to` above `lo`, from `to` up to `lo`: the moving strokes at
	 * their pen-down place, each with the paint its committed layer gives it (the highlighter as one wash at the layer's alpha,
	 * the pen over it), then the blue preview stroke over each, as the drag drew them; clipped to those rows on whole px, so a
	 * stroke drawn again for the next rows paints no pixel twice.
	 * Each stroke is drawn at the tail's own camera and moved up by `top` whole device rows in the transform, so its path is the
	 * committed layer's to the last bit and only the whole rows differ. Drawn at a camera moved by `top` rows instead, the float
	 * rounding of the larger offset moved edges by a fraction of a px: against the same paint on a canvas of the picture's size
	 * and clip, 22 px of the look at pen-down differed by more than 3 levels (up to 17); with the offset, none.
	 */
	function rasterSpaceRows(this: InkOverlayPlugin, snap: SpaceSnapshot, to: number): void {
		const up = to < snap.lo, pic = snap.canvas, ctx = pic?.getContext("2d");
		const from = up ? Math.max(to, snap.top) : snap.done, end = up ? snap.lo : Math.min(to, snap.bottom);
		if (!pic || !ctx || end <= from) return;
		if (up) snap.lo = from; else snap.done = end;
		const b = snap.backing, at = snap.at, cssW = pic.width / b, cssH = pic.height / b;
		// The rows as a camera of their own, for the on-screen test of each stroke (the blue stroke's own, padded for its width).
		const rows = { x: at.x + snap.col / (at.zoom * b), y: at.y + from / (at.zoom * b), zoom: at.zoom }, rowsH = (end - from) / b;
		const shown = (s: InkStroke) => this.tail.spaceStrokeOnScreen(rows, s, cssW, rowsH, this.cssScale);
		const floor = committedFloorFor(this.committedBacking, this.dpr);
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.beginPath();
		ctx.rect(0, from - snap.top, pic.width, end - from);
		ctx.clip();
		ctx.setTransform(b, 0, 0, b, -snap.col, -snap.top);
		let wash = false;
		for (const s of snap.moving) if (s.tool === "highlighter" && shown(s)) { drawStroke(ctx, at, s, undefined, true, undefined, floor); wash = true; }
		if (wash) {
			// The highlight layer paints its strokes opaque and carries one alpha (a crossing stays one flat wash): the same here.
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = "destination-in";
			ctx.fillStyle = `rgba(0, 0, 0, ${HIGHLIGHTER_ALPHA})`;
			ctx.fillRect(0, from - snap.top, pic.width, end - from);
			ctx.globalCompositeOperation = "source-over";
			ctx.setTransform(b, 0, 0, b, -snap.col, -snap.top);
		}
		for (const s of snap.moving) if (s.tool === "pen" && shown(s)) drawStroke(ctx, at, s, undefined, true, undefined, floor);
		if (snap.kind === "space") for (const s of snap.moving) if (shown(s)) this.tail.drawSpaceStroke(at, s, SELECTION_COLOR, cssW, cssH, this.cssScale, ctx);
		ctx.restore();
	}

	function spaceMove(this: InkOverlayPlugin, samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last || this.spaceLineY === null) return;
		const path = this.filePath();
		if (!path) return;
		const w = this.camera.screenToWorld(last.x, last.y);
		// The same wall as the lasso drag, for the ink below the seam; the
		// release closes the text by the distance the ink actually moved.
		const dy = Math.max(w.y - this.spaceFromY, topWallRoom(this.spaceBounds));
		if (dy === 0) return;
		// A sample moves nothing in the store and repaints no committed ink: the
		// moving ink rides the tail as the pen-down picture (drawSpacePicture),
		// and the release moves the store once by the snapped total, with the
		// history op (the lasso drag's shape). Moving every stroke and
		// re-rastering the band per sample was the drag's lag on a heavy note.
		// Other panes of the note update at the release.
		// Vertical only: the divider is a seam, not a joystick.
		this.spaceTotalDy += dy;
		this.spaceFromY += dy;
		// The live seam follows raw displacement. The origin and rounded
		// release destination are drawn separately from the frozen plan.
		if (this.spaceLineY !== null) this.spaceLineY += dy;
		// The box rides with the drag for the top wall; the drag's own object.
		if (this.spaceBounds) this.spaceBounds.y += dy;
		// A queued repaint (the pen-down's, or one a scroll asked for) redraws
		// the seam and the picture in its frame; drawing them here too drew
		// them twice. Draw here only when no repaint is queued, or when a pinch
		// holds the raster and that frame returns before the chrome.
		if (!this.repaintQueued || this.pinchPreview) this.redrawSelectionUI();
	}

	function spaceUp(this: InkOverlayPlugin): void {
		const path = this.filePath();
		const applied = this.spaceTotalDy;
		const strokeIds = this.spaceIds;
		const plan = this.spacePlan;
		const rows = this.spaceRows ?? null;
		// From here the committed layers paint the store again. This pane's
		// stroke index was built without the moving strokes during the drag, so
		// it rebuilds at its next repaint and the store move below leaves it out.
		// The layers' painted count goes back to the pen-down one: a whole repaint
		// during the drag counted the strokes it painted without the moving ink,
		// and the box repaint below puts that ink back, so the band and bake
		// carries that compare the count with the store take the layers again.
		const snap = this.endSpaceSnapshot();
		if (snap) {
			this.indexDirty = true;
			this.paintedStrokeCount = snap.painted;
		}
		this.spaceRows = null;
		this.spaceSteps = [];
		// This is the normal commit path (also native cancel/blur). Teardown
		// must never undo its movement again after the paired transaction.
		this.spaceHistoryIdentity = null;
		this.spaceLineY = null;
		this.spaceIds = [];
		this.spaceBounds = null;
		this.spacePlan = null;
		this.spaceTotalDy = 0;
		this.clearSpaceFeedback();
		// The committed layers drew without the moving ink since the pen went
		// down: paint its box where it ends up, from the store (and, when the
		// ink moved, the other panes over where it was and where it is).
		const repaintMoved = (dy: number) => {
			this.extentArmAsked = true;
			if (snap) this.damage.addRect({ x: snap.box.x, y: snap.box.y + dy, width: snap.box.width, height: snap.box.height });
			this.scheduleRepaint("partial");
			if (snap && path && dy !== 0) this.repaintPath(path, [sweptRect(snap.box, dy)]);
		};
		if (!path || applied === 0 || !plan) {
			if (snap) repaintMoved(0);
			this.redrawSelectionUI();
			return;
		}
		// Open (or close) the same distance in the TEXT, so the note keeps
		// its shape instead of the ink sliding off the words it belongs to.
		// Both halves ride one transaction: undo puts the lines and the ink
		// back together, which is the only way this can be reversible.
		// The TEXT is authoritative. Whatever the text could not do, the ink
		// does not do either: a drag under half a line, or an upward drag over
		// writing that must not be deleted, settles back to zero rather than
		// leaving the ink permanently offset from the line it belongs to -
		// which is the one thing this gesture exists to prevent.
		const change = this.spaceTextChange(plan, applied);
		const dy = change.dy;
		// The store moves once, by the snapped distance: the drag moved only
		// its picture. The text edit below cannot move ink (updateInner
		// repaints it as "scroll"), so the release repaints the moved ink's box.
		if (dy === 0) {
			// Nothing moved in the end: no op worth recording, and the store
			// never moved, so there is nothing to save either.
			repaintMoved(0);
			this.redrawSelectionUI();
			return;
		}
		if (strokeIds.length) this.moveLive(path, strokeIds, 0, dy);
		if(strokeIds.length)inlineInk.save(path);
		// Space opened: the moved rows shift in the cache by the same step,
		// so the next hover does not regroup every point in the note. The
		// shift runs in a task after the release paint (a frame, then a
		// timeout), so the release frame paints the landed ink and nothing
		// else; a hover that comes first runs it in its own ask. A failed
		// dispatch below moves the ink back, and that move's revision makes
		// the shift refuse and the next ask rebuild.
		if (dy > 0 && rows) {
			this.spaceRowsCache.queueShift(rows, strokeIds, [dy]);
			this.winRef.requestAnimationFrame(() => this.winRef.setTimeout(() => this.spaceRowsCache.runQueued(this.strokesHere()), 0));
		}
		const op = strokeIds.length?this.stampInkIdentity({ type: "move", path, strokeIds, dx: 0, dy }):null;
		try {
			this.view.dispatch({
				changes: change.changes ?? undefined,
				effects: op?inkEffect.of(op):undefined,
				annotations: op?[inkApplied.of(true), isolateHistory.of("full")]:isolateHistory.of("full"),
			});
		} catch (err) {
			console.error("[handwriting] insert-space dispatch failed", err);
			// The text did not change, so the ink goes back where the drag began,
			// and the restored state reaches the disk as rollbackSpaceMove does.
			if (strokeIds.length) {
				inlineInk.moveStrokes(path, strokeIds, 0, -dy);
				inlineInk.save(path);
				this.frontierCache.invalidate(path);
			}
			new Notice("Handwriting: could not open the space, so the ink is back where it was.");
			this.scheduleRepaint();
			this.repaintPath(path);
			this.redrawSelectionUI();
			return;
		}
		repaintMoved(dy);
		this.redrawSelectionUI();
	}

	/**
	 * The document edit that matches a drag of `applied` note units: blank
	 * lines inserted at the divider, or blank ones taken back when the drag
	 * closed a gap. Returns the SNAPPED distance too, because the ink has to
	 * land on the same whole number of lines the text just moved by.
	 *
	 * A changed document, short drag or upward drag over nonblank text
	 * returns zero; the caller then rolls back the live ink movement.
	 */
	function spaceTextChange(this: InkOverlayPlugin,
		plan: (SpaceBoundary & {doc: Text}) | null,
		applied: number
	): { changes: { from: number; to: number; insert: string } | null; dy: number; lines: number } {
		const none = { changes: null, dy: 0, lines: 0 };
		if (!plan || plan.doc!==this.view.state.doc) return none;
		if(plan.text===false)return {changes:null,dy:applied,lines:0};
		const lineHeight = plan.lineHeight;
		const steps = lineSteps(applied, lineHeight);
		if (steps === 0) return none;
		// The drag snaps in rows of the seam line, but what opens or closes in
		// the text is BLANK lines, at body height. At a heading the two differ,
		// and moving the ink by the heading's rows walked it off its words.
		// The stylesheet's line height, as the seam's own is read: CodeMirror's
		// measured default rounds, and at 10% zoom that put ink an eighth of a
		// unit off the text over two lines.
		const css = parseFloat(this.contentStyle?.lineHeight ?? "") * this.cssScale;
		const blank = (css > 0 ? css : this.view.defaultLineHeight) / this.scale;
		const rowHeight = blank > 0 ? blank : lineHeight;
		const pos = plan.from;
		const doc = this.view.state.doc;
		const line = doc.lineAt(pos);
		if (steps > 0) {
			return {
				// An internal break replaces an existing visual wrap. One extra
				// newline preserves that wrap before opening the requested space.
				changes: { from: pos, to: pos, insert: "\n".repeat(steps+(pos>line.from?1:0)) },
				dy: steps * rowHeight,
				lines: steps,
			};
		}
		// Closing up: take back only blank lines, never a word of writing.
		if(pos!==line.from)return none;
		const removable = blankLinesAbove((n) => doc.line(n).text, line.number, -steps);
		if (removable === 0) return none;
		const first = doc.line(line.number - removable);
		return {
			changes: { from: first.from, to: line.from, insert: "" },
			dy: -removable * rowHeight,
			lines: -removable,
		};
	}

	/**
	 * A TOOL change puts a selection away too, not just the next contact.
	 * Design §5o: leaving a lasso outline live after the strip's tool
	 * changed read as "the lasso selector remains" (Alan, device finding
	 * 2026-09-02). Exact idiom as the pen-contact clear at `:1919-1920`.
	 *
	 * The strip too, not just the canvas. The §5o listener refreshes every
	 * strip BEFORE it dissolves, so a refresh done there sees the selection
	 * that is about to go; Delete and Copy are gated on `hasInkSelection()`
	 * and stayed lit over nothing. Picking up Pan with ink selected is how
	 * that shows: the ruling clears the selection (pan and lasso are
	 * exclusive - alan, 2026-09-02) and the two buttons were left behind.
	 * `pasteInkHere` is the symmetric case and already does this - it selects
	 * what it pasted and refreshes so the buttons light UP. The pdf's
	 * `dissolveSelection` has ended in `refreshStrip()` all along; this is the
	 * note surface agreeing with it.
	 *
	 * Only when a selection actually went away: the listener has already
	 * refreshed once for the mode change itself, and an unconditional second
	 * refresh would run on every tool change for nothing.
	 */
	function dissolveSelection(this: InkOverlayPlugin): void {
		if (!this.selection.clear()) return;
		this.redrawSelectionUI();
		this.refreshStrip();
	}

	/**
	 * Shrink the tail from the whole band to the empty backing in a task after the frame (a frame, then a timeout), not in the
	 * frame that dropped the chrome: the shrink reallocates the canvas, about 4 ms at an insert space release on the test rig
	 * whatever the note. Skipped when a stroke is live or chrome is back by then; the next redraw without either asks again.
	 */
	function queueTailShrink(this: InkOverlayPlugin): void {
		if (this.tailShrinkQueued) return;
		this.tailShrinkQueued = true;
		this.winRef.requestAnimationFrame(() => this.winRef.setTimeout(() => this.shrinkTailNow(), 0));
	}

	/** The queued tail shrink (queueTailShrink). */
	function shrinkTailNow(this: InkOverlayPlugin): void {
		this.tailShrinkQueued = false;
		if (!this.tail || !this.container || this.builder) return;
		const preview = this.spacePreview;
		if ((this.lassoActive && this.lassoPts.length > 1) || (preview !== null && preview.doc === this.view.state.doc) ||
			this.selectionBounds() !== null || this.tail.inlineGrid?.mode !== "full") return;
		this.tail.prepareLive(null, null);
	}

	/**
	 * The preview's strokes to draw: on hover, the last list while the preview's lists and rows (the rows cache keeps its array
	 * while the strokes and their revisions do), the camera and the size hold, so a hover frame skips the walk of every stroke.
	 * A live drag moves strokes under a frozen preview, so it builds every time.
	 */
	function spaceDrawItems(this: InkOverlayPlugin, preview:NonNullable<InkOverlayPlugin["spacePreview"]>,cam:CameraState):{stroke:InkStroke;color:string}[] {
		const l=this.spaceDrawList;
		if(!this.spacePlan&&l&&l.moving===preview.moving&&l.staying===preview.staying&&l.rows===preview.rows&&l.x===cam.x&&l.y===cam.y&&
			l.zoom===cam.zoom&&l.w===this.cssWidth&&l.h===this.cssHeight&&l.scale===this.cssScale)return l.items;
		return this.buildSpaceDrawItems(preview,cam);
	}

	/** Walk the store once for the preview's strokes on screen (spaceDrawItems). */
	function buildSpaceDrawItems(this: InkOverlayPlugin, preview:NonNullable<InkOverlayPlugin["spacePreview"]>,cam:CameraState):{stroke:InkStroke;color:string}[] {
		const moving=new Set(preview.moving),staying=new Set(preview.staying),items:{stroke:InkStroke;color:string}[]=[];
		for(const stroke of this.strokesHere()){
			const moves=moving.has(stroke.id);
			if((moves||staying.has(stroke.id))&&this.tail.spaceStrokeOnScreen(cam,stroke,this.cssWidth,this.cssHeight,this.cssScale))
				items.push({stroke,color:moves?SELECTION_COLOR:STAYING_COLOR});
		}
		this.spaceDrawList={moving:preview.moving,staying:preview.staying,rows:preview.rows,x:cam.x,y:cam.y,zoom:cam.zoom,
			w:this.cssWidth,h:this.cssHeight,scale:this.cssScale,items};
		return items;
	}

	function redrawSelectionUI(this: InkOverlayPlugin, rows?: ReturnType<InsertSpaceRows["get"]>): void {
		if (!this.tail) return;
		// A repaint with no selection still needs a compact live head; an idle
		// repaint releases the bitmap instead of restoring the whole band.
		// The hover frame hands over the rows it just read; every other caller
		// asks the cache itself, so a reload or erase under a hover still drops
		// a preview of ink that is gone.
		if(this.spacePreview&&!this.spacePlan&&(rows??this.spaceRowsCache.get(this.strokesHere()))!==this.spacePreview.rows)this.spacePreview=null;
		const preview=this.spacePreview;
		const bounds = this.selectionBounds();
		const head = this.builder ? this.activeWet.head() : undefined;
		const fullUI = (this.lassoActive && this.lassoPts.length > 1) ||
			(preview !== null && preview.doc === this.view.state.doc) || bounds !== null;
		if (fullUI) this.tail.restoreFullSurface();
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		this.dressTail(this.builder !== null && this.activeWet === this.highlightWet);
		const cam = this.camera.snapshot;
		// With no head and the tail at its full size (the chrome just went), the shrink to the empty backing reallocates the canvas;
		// it runs in a task after this frame, and the cleared full tail stands in until then.
		if (!fullUI && !head && this.tail.inlineGrid?.mode === "full") this.queueTailShrink();
		else if (!fullUI) this.tail.prepareLive(head ? {
			cam, style: this.activeStyle, from: head.from, to: head.to,
			pressure: head.pressure,
			hwWorld: this.activeWet.liveHalfWidth(this.activeStyle, head.pressure),
		} : null, null);
		if (this.lassoActive && this.lassoPts.length > 1) {
			this.tail.drawLasso(cam, this.lassoPts, SELECTION_COLOR);
		}
		// A reload/erase while hovering invalidates the affected-set promise.
		// A live drag intentionally keeps its frozen set despite translations.
		if (preview && preview.doc===this.view.state.doc) {
			// A drag shows its moving ink as the pen-down picture and the amber
			// strokes from a list kept while the camera holds; the hover draws
			// every previewed stroke.
			const snap=this.spaceSnapshot;
			if(snap){
				this.drawSpacePicture(snap,cam);
				for(const stroke of this.spaceAmber(snap,cam))
					this.tail.drawSpaceStroke(cam,stroke,STAYING_COLOR,this.cssWidth,this.cssHeight,this.cssScale);
			}else for(const {stroke,color} of this.spaceDrawItems(preview,cam))
				this.tail.drawSpaceStroke(cam,stroke,color,this.cssWidth,this.cssHeight,this.cssScale);
			this.tail.drawSpaceDivider(cam,preview.plan.y,SELECTION_COLOR,this.cssWidth);
			// The labels start at the pane's left edge, not the band's: the band
			// sits up to a margin left of the pane on a note that scrolls sideways.
			// A drag reads it once at pen-down: the band does not move under a
			// held contact, and a layout read per sample was a cost of its own.
			const band=this.band,left=snap&&snap.band===band?snap.left:band?Math.max(0,this.view.scrollDOM.scrollLeft-band.left):0;
			const label=preview.plan.blockFallback?"Block boundary":preview.plan.text===false?"Ink gap":"Text boundary";
			this.tail.drawSpaceLabel(cam,preview.plan.y,label+(preview.moving.length?" · blue ink moves":"")+(preview.staying.length?" · amber ink stays":""),SELECTION_COLOR,this.cssScale,false,left);
			if(this.spacePlan && this.spaceLineY!==null){
				const {dy,lines}=this.spaceTextChange(this.spacePlan,this.spaceTotalDy);
				const landing=this.spacePlan.y+dy;
				const gap=this.spacePlan.text===false?`${Math.round(dy*10)/10} gap`:`${lines} lines`;
				this.tail.drawSpaceLabel(cam,landing,`Release: ${gap}`,SELECTION_COLOR,this.cssScale,true,left);
			}
		}
		// A lasso drag's selected ink, as the grab's picture at the drag's offset.
		const held = this.spaceSnapshot;
		if (held && held.kind === "lasso") this.drawSpacePicture(held, cam);
		if (bounds) this.tail.drawSelectionBox(cam, bounds, SELECTION_COLOR);
		// A repaint can land mid-stroke - a scroll, an external reload, damage
		// from an erase elsewhere. clearAll above takes the live head with it,
		// and the head is the lag-free tip: erasing it until the next pointer
		// event is a blink at exactly the place the eye is resting.
		if (head) {
			this.tail.drawHead(
				cam,
				this.activeStyle,
				head.from,
				head.to,
				head.pressure,
				this.activeWet.liveHalfWidth(this.activeStyle, head.pressure)
			);
		}
	}

	/** An insert space drag abandoned before its release: a note switch, an
	 * unmount, an undo or a lost contact (resetGestureState). The drag moved
	 * only its picture, so the store is as it was at pen-down, on whichever
	 * record it belongs to, and nothing is moved back or saved. The committed
	 * layers drew without the moving ink: they repaint whole. */
	function rollbackSpaceMove(this: InkOverlayPlugin):void {
		const snap=this.endSpaceSnapshot();
		this.spaceHistoryIdentity=null;
		this.spaceTotalDy=0;
		// A lasso drag carried as a picture never moved the store: nothing for rollbackLiveGesture to move back.
		if(snap?.kind==="lasso")this.dragTotal=null;
		if(snap)this.scheduleRepaint();
	}

export function installLassoSpace(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		pruneSelectionOnInkChange,
		strokesHere,
		selectionBounds,
		lassoDown,
		lassoMove,
		commitLiveDrag,
		lassoUp,
		spaceTextBoundary,
		planSpace,
		previewSpace,
		queueSpaceFeedback,
		clearSpaceFeedback,
		spaceDown,
		spaceMove,
		spaceUp,
		spaceTextChange,
		dissolveSelection,
		queueTailShrink,
		shrinkTailNow,
		spaceDrawItems,
		buildSpaceDrawItems,
		redrawSelectionUI,
		rollbackSpaceMove,
		committedStrokes,
		beginSpaceSnapshot,
		beginLassoSnapshot,
		endSpaceSnapshot,
		spaceAmber,
		drawSpacePicture,
		rasterSpacePicture,
		rasterSpaceRows,
	});
}
