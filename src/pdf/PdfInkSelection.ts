/**
 * The pdf surface's selection and clipboard methods: the lasso gesture and its live drag, the selection snip, delete, cut, copy and
 * paste. They are methods of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 */
import { padBBox, pointInBBox, polygonBounds, strokeInLasso, unionBounds } from "../objects/Selection";
import { copyInk, inkClipboardMarker, pasteInk } from "../inline/InkClipboard";
import { withInkDestination } from "../ink/InkTheme";
import { pdfPageDestination } from "../ink/InkPdf";
import { PenSample } from "../input/PointerRouter";
import { clipboardSize } from "../inline/InkClipboard";
import { PageBox, snipViewport } from "./PageMap";
import { wholePageCanvasOf } from "./PdfViewerProbe";
import { installMethods } from "../inline/InstallMethods";
import type { SnipResult, PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		selectionGrabbed(pageNumber: number, p: { x: number; y: number }, scale: number): boolean;
		lassoDown(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void;
		queueEditFrame(box: PageBox, kind: "lasso" | "space", path?: string, page?: number, strokeIds?: string[], dx?: number, dy?: number): void;
		flushEditFrame(paint?: boolean): void;
		lassoMove(box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void;
		snipSelection(): Promise<SnipResult>;
		selectionBounds(page: number): ReturnType<typeof unionBounds>;
		clearSelection(): void;
		dissolveSelection(): void;
		drawLasso(box: PageBox): void;
		deleteSelection(): boolean;
		lassoUp(page: number): void;
		copyToClipboard(): number;
		copySelection(): void;
		deleteSelectionCommand(): boolean;
		cutSelectionCommand(): void;
		notifyUnidentified(): void;
		cutSelection(): number;
		pasteFromClipboard(): void;
	}
}

/**
 * Device pixels a SNIP may hold - and a separate number on purpose.
 *
 * The two shared `MAX_OVERLAY_PX` while it was 4M, which was a coincidence of
 * value rather than a shared reason, and raising the overlay cap silently
 * raised this one with it: a lasso and a snip could produce a 10M px PNG, two
 * and a half times what the feature ever shipped at, pasted into a note and
 * synced. Nothing about the band argues for a bigger picture - the band cap is
 * a backstop against an allocation the browser would refuse, while this one is
 * a judgement about how big a file it is polite to put in someone's vault - so
 * it keeps the number it was written with.
 */
const MAX_SNIP_PX = 4_000_000;

/** Screen-px slack around a selection for the grab that starts a drag. */
const SELECTION_GRAB_PAD_PX = 8;


	/**
	 * Whether a page point lands on the active selection - the grab test.
	 *
	 * Padded, the way the note surface pads its own. The pad is screen px
	 * turned into page units here, so the slack stays the same size on the
	 * glass at any zoom.
	 *
	 * One predicate, two callers: `lassoDown` below, and the bare-tip branch
	 * in pen-down. Written out twice it would be two chances to pad
	 * differently, and a grab area that moved depending on how the pen got
	 * here is exactly the kind of thing nobody reports and everybody feels.
	 */
	function selectionGrabbed(this: PdfInkController, pageNumber: number, p: { x: number; y: number }, scale: number): boolean {
		const bounds = this.selectionBounds(pageNumber);
		return !!bounds && pointInBBox(p.x, p.y, padBBox(bounds, SELECTION_GRAB_PAD_PX / scale));
	}

	/**
	 * A lasso contact either grabs the existing selection or starts a new one.
	 *
	 * Inside the selection's bounds means move it; anywhere else means the
	 * user is drawing a new loop and the old selection is finished with. That
	 * is the note surface's rule, and it is what makes a selection feel like
	 * an object rather than a mode.
	 */
	function lassoDown(this: PdfInkController, box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const p = this.pagePoint(box, scale, sample, scroller);
		if (!p) return;
		// One call site for both paths into a lasso gesture (a fresh loop and
		// grabbing an existing selection both reach here), so the reticle is
		// driven once for the family rather than at each of penDown's two
		// call sites. Same watchdog reasoning as pan and space: hover has
		// gone quiet by the time a contact is claimed.
		this.showLassoCursor(sample);
		if (this.selectionGrabbed(box.pageNumber, p, scale)) {
			this.dragFrom = { x: p.x, y: p.y };
			this.dragTotal = { dx: 0, dy: 0 };
			return;
		}
		// Through clearSelection, never by assignment: clearing the field here
		// left the old page's chrome on screen, because wiping it is keyed to
		// the page the selection BELONGED to and only clearSelection knows it.
		this.clearSelection();
		this.lassoPts = [{ x: p.x, y: p.y }];
		// Page-scoped, same reasoning as the erase branch: a fresh loop on a
		// page with no ink of its own can never select anything, whatever
		// shape it ends up drawing, even while other pages carry ink. Said
		// once per page (ruled 2026-09-14), not per contact.
		this.sayIfPageEmpty(box.pageNumber, "select");
	}

	/** Keep all geometry, but apply and paint live edits once per display frame. */
	function queueEditFrame(this: PdfInkController, box: PageBox, kind: "lasso" | "space", path?: string, page?: number, strokeIds?: string[], dx = 0, dy = 0): void {
		if (path && page !== undefined && strokeIds) {
			this.editTarget ??= { path, page, strokeIds: [...strokeIds] };
			this.editDelta.dx += dx;
			this.editDelta.dy += dy;
		}
		this.editPaint = { box, kind };
		if (this.editFrame !== null) return;
		const frame = this.frame;
		this.editFrame = this.win.requestAnimationFrame(() => {
			if (this.frame !== frame) return;
			this.flushEditFrame();
		});
	}

	/** Drain before completion; the immutable target survives selection cleanup. */
	function flushEditFrame(this: PdfInkController, paint = true): void {
		if (this.editFrame !== null) this.win.cancelAnimationFrame(this.editFrame);
		this.editFrame = null;
		const target = this.editTarget;
		const { dx, dy } = this.editDelta;
		this.editDelta = { dx: 0, dy: 0 };
		const pendingPaint = this.editPaint;
		this.editPaint = null;
		if (target && target.path === this.documentId() && (dx !== 0 || dy !== 0)) {
			this.apply({ type: "move", path: target.path, strokeIds: target.strokeIds, dx, dy }, target.page, "live");
		}
		if (!paint || !pendingPaint) return;
		if (pendingPaint.kind === "space") this.drawSpaceLine(pendingPaint.box);
		else if (this.lassoPts.length > 0 || this.dragFrom) this.drawLasso(pendingPaint.box);
	}

	function lassoMove(this: PdfInkController, box: PageBox, scale: number, sample: PenSample, scroller: HTMLElement): void {
		const p = this.pagePoint(box, scale, sample, scroller);
		if (!p) return;
		if (this.dragFrom) {
			if (this.selected.length === 0) return;
			const dx = p.x - this.dragFrom.x;
			const dy = p.y - this.dragFrom.y;
			this.dragFrom = { x: p.x, y: p.y };
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			const id = this.documentId();
			if (id && (dx !== 0 || dy !== 0)) {
				this.queueEditFrame(box, "lasso", id, this.selectionPage, this.selected, dx, dy);
			}
			return;
		}
		this.lassoPts.push({ x: p.x, y: p.y });
		this.queueEditFrame(box, "lasso");
	}

	/**
	 * Render the selected region - page and committed ink together - to a
	 * PNG. The selection's bounding box, padded a little, is the crop.
	 *
	 * The page comes off the viewer's own canvas rather than re-rendered:
	 * rendering the PDF is the viewer's job, and observation is this whole
	 * integration's contract. The ink is NOT copied from the overlay,
	 * whose backing store is capped (MAX_OVERLAY_PX), covers only the BAND
	 * rather than the page, and can be softer than the viewer's pixels; the
	 * strokes are redrawn at the snip's own scale instead, through the same
	 * `drawCommitted` paint() uses. The snip's own cap is MAX_SNIP_PX, which
	 * is a different number for a different reason - see both.
	 *
	 * A page the viewer has not rendered yet snips as paper white with the
	 * ink on it - honest about what is known, rather than failing.
	 *
	 * Every refusal names its reason. The command is only offered while a
	 * selection is held, so a snip that comes back empty was stopped by
	 * something else - a page that is rotated, a pane with no width - and
	 * "nothing is selected" under a lasso that is plainly on screen sends
	 * the reader lassoing again for the same answer.
	 */
	async function snipSelection(this: PdfInkController): Promise<SnipResult> {
		const page = this.selectionPage;
		const b = this.selectionBounds(page);
		if (!b) return { ok: false, reason: "nothing is selected to snip" };
		const probed = this.probe();
		if (!probed || probed.scaleFactor === null) {
			return { ok: false, reason: "the PDF viewer could not be read" };
		}
		const pageEl = this.pageElement(probed.scroller, page);
		if (!pageEl) return { ok: false, reason: `page ${page} is not in the viewer` };
		const wPx = pageEl.clientWidth;
		const hPx = pageEl.clientHeight;
		if (wPx <= 0 || hPx <= 0) return { ok: false, reason: `page ${page} has no size on screen` };
		// `pageWidthPt` is also where a rotation is noticed - the aspect flips
		// against the cached size - so it runs before the rotation check, and
		// the height comes from the same cache rather than from the box: for
		// a rotated page the box is the WRONG shape, which is the whole point.
		const wPt = this.pageWidthPt(page, wPx, hPx, probed.scaleFactor);
		const size = this.pageSize.get(page);
		if (wPt <= 0 || !size) return { ok: false, reason: `page ${page} has not settled yet` };
		if (this.rotated.has(page)) {
			return { ok: false, reason: `page ${page} is rotated, and ink on a rotated page is not supported` };
		}
		// The viewer's whole-page canvas sets the snip's resolution: `k` is its
		// backing pixels per point, and both the crop out of it and the output
		// scale come from the one number. Not the last visible canvas: on a
		// zoomed page that is pdf.js's detail canvas, which covers only the
		// visible part of the page. Without a whole-page canvas the CSS size at
		// device pixels is the honest fallback, on white.
		const pageCanvas = wholePageCanvasOf(pageEl);
		const k = pageCanvas && pageCanvas.width > 0 ? pageCanvas.width / wPt : null;
		const pxPerPt = k ?? (wPx / wPt) * (this.win.devicePixelRatio || 1);
		const vp = snipViewport(b, 8, wPt, size.hPt, pxPerPt, MAX_SNIP_PX);
		if (!vp) return { ok: false, reason: "the selection lies off the page" };
		const out = createEl("canvas");
		try {
			out.width = Math.max(1, Math.round((vp.x1 - vp.x0) * vp.scale));
			out.height = Math.max(1, Math.round((vp.y1 - vp.y0) * vp.scale));
			const ctx = out.getContext("2d");
			if (!ctx) return { ok: false, reason: "the image could not be drawn" };
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, out.width, out.height);
			if (pageCanvas && k !== null) {
				ctx.drawImage(
					pageCanvas,
					vp.x0 * k,
					vp.y0 * k,
					(vp.x1 - vp.x0) * k,
					(vp.y1 - vp.y0) * k,
					0,
					0,
					out.width,
					out.height
				);
			}
			ctx.setTransform(1, 0, 0, 1, -vp.x0 * vp.scale, -vp.y0 * vp.scale);
			// Painted for the page the user declares, which is what "Ink color
			// when exporting" promises of a snip; "keep" is a null destination
			// and leaves the stored colour. The scope wraps this one synchronous
			// call and ends before the encode: the destination is module-wide
			// and `drawCommitted` is also the overlay's painter, so a scope left
			// open across the await would give a live repaint in that gap the
			// snip's colours.
			const strokes = this.strokes(page);
			withInkDestination(pdfPageDestination(this.pageAssumption()), () =>
				this.drawCommitted(ctx, { x: 0, y: 0, zoom: vp.scale }, strokes)
			);
			const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
			if (!blob) return { ok: false, reason: "the image could not be encoded" };
			return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()), pageNumber: page };
		} finally {
			// The backing store is the size of the cap; released now rather
			// than whenever the collector gets to a detached canvas.
			out.width = 0;
			out.height = 0;
		}
	}

	/** The box around everything currently selected, in page units. */
	function selectionBounds(this: PdfInkController, page: number): ReturnType<typeof unionBounds> {
		if (page !== this.selectionPage) return null;
		if (this.selected.length === 0) return null;
		const picked = new Set(this.selected);
		return unionBounds(
			this.strokes(page)
				.filter((s) => picked.has(s.id))
				.map((s) => s.bbox)
		);
	}

	function clearSelection(this: PdfInkController): void {
		if (this.selected.length === 0 && this.lassoPts.length === 0) return;
		const page = this.selectionPage;
		this.selected = [];
		this.lassoPts = [];
		this.selectionPage = 0;
		const pair = this.wetOn(page);
		const box = this.frameBox(page);
		if (pair && box) pair.wet.clear(box.widthPx, box.heightPx);
	}

	/**
	 * A TOOL change puts a selection away too, not just the next contact.
	 * Design §5o: leaving a lasso outline live after the strip's tool
	 * changed read as "the lasso selector remains" (Alan, device finding
	 * 2026-09-02) - only the next non-lasso pen contact cleared it before.
	 */
	function dissolveSelection(this: PdfInkController): void {
		this.clearSelection();
		this.refreshStrip();
	}

	/** The loop being drawn, and the box around what it has caught. */
	function drawLasso(this: PdfInkController, box: PageBox): void {
		const pair = this.wetOn(box.pageNumber);
		const cam = this.cameraFor(box);
		if (!pair || !cam) return;
		const ctx = pair.wetCanvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, box.widthPx, box.heightPx);
		ctx.save();
		ctx.strokeStyle = "#4b7bec";
		ctx.lineWidth = 1;
		// The LOOP is the conditional part, never the box. Gating both on the
		// loop meant the selection outline could never be drawn at all: while
		// the loop is being drawn nothing is selected yet, and by the time
		// something is selected the loop has already been thrown away.
		if (this.lassoPts.length >= 2) {
			ctx.setLineDash([4, 4]);
			ctx.beginPath();
			ctx.moveTo(this.lassoPts[0]!.x * cam.zoom, this.lassoPts[0]!.y * cam.zoom);
			for (const q of this.lassoPts.slice(1)) ctx.lineTo(q.x * cam.zoom, q.y * cam.zoom);
			ctx.stroke();
		}
		const b = this.selectionBounds(box.pageNumber);
		if (b) {
			ctx.setLineDash([2, 3]);
			ctx.strokeRect(b.x * cam.zoom, b.y * cam.zoom, b.width * cam.zoom, b.height * cam.zoom);
		}
		ctx.restore();
	}

	/**
	 * Remove the selected strokes. True when there was something to remove.
	 *
	 * One op, with the original indices, so undo puts them back at the depth
	 * they were at rather than on top of everything drawn since.
	 */
	function deleteSelection(this: PdfInkController): boolean {
		const id = this.documentId();
		if (!id || this.selected.length === 0) return false;
		// Finish and record the drag before removal snapshots its moved strokes.
		if (this.dragFrom) this.penUp();
		const all = this.opList();
		const picked = new Set(this.selected);
		const strokes = all.filter((s) => picked.has(s.id));
		if (strokes.length === 0) return false;
		const indices = strokes.map((s) => all.indexOf(s));
		// The boolean is the caller's whole evidence - `deleteSelectionCommand`
		// picks its sentence off it - so a refused op has to read as a delete
		// that did not happen. Reporting true here would put "deleted N
		// strokes" on screen over ink that is still there, which is the exact
		// report the rest of this method was written against. The selection
		// stays for the same reason: nothing was removed from under it.
		if (!this.emit({ type: "remove", path: id, strokes, indices })) return false;
		this.clearSelection();
		this.refreshStrip();
		return true;
	}

	/** Close the loop and keep whatever it caught. */
	function lassoUp(this: PdfInkController, page: number): void {
		const pts = this.lassoPts;
		this.lassoPts = [];
		if (pts.length < 3) {
			const box = this.frameBox(page);
			if (box) this.drawLasso(box);
			return;
		}
		const bounds = polygonBounds(pts);
		this.selected = this.strokes(page)
			.filter((s) => strokeInLasso(s, pts, bounds))
			.map((s) => s.id);
		this.selectionPage = page;
		this.refreshStrip();
		const box = this.frameBox(page);
		if (box) this.drawLasso(box);
	}

	/**
	 * The lassoed strokes into the session clipboard, quietly - shared by
	 * `copySelection` (which notifies) and `cutSelection` (which notifies
	 * with "cut", not "copied", so it cannot call copySelection and would
	 * double-notify if it did).
	 */
	function copyToClipboard(this: PdfInkController): number {
		// The clipboard is a door out of this controller too, and a slower
		// one: synthetic ink copied here survives calibration being switched
		// back off, and the next paste is an `add` of it into a real document
		// through a boundary that has no way left to tell it apart. Cut goes
		// through here as well, so this covers both.
		if (this.syntheticSources()) return 0;
		const id = this.documentId();
		if (!id || this.selected.length === 0) return 0;
		const chosen = new Set(this.selected);
		// Drain pending movement before copying without ending the live drag.
		this.flushEditFrame(false);
		const strokes = this.strokes(this.selectionPage).filter((st) => chosen.has(st.id));
		const count = copyInk(strokes, id);
		const marker = count > 0 ? inkClipboardMarker() : null;
		if (marker !== null) {
			try {
				void this.win.navigator.clipboard?.writeText(marker).catch(() => {
					/* The command can still paste session ink when the clipboard is denied. */
				});
			} catch {
				/* The owning window may not expose a clipboard API. */
			}
		}
		return count;
	}

	/**
	 * The lassoed strokes into the session clipboard - the same clipboard
	 * the note surface uses, under the document id, so pasting back into
	 * this document staggers the copies the way pasting into a note does.
	 */
	function copySelection(this: PdfInkController): void {
		if (!this.identified) {
			this.notifyUnidentified();
			return;
		}
		const n = this.copyToClipboard();
		// Audit doc §5k/AD3: an empty selection said "copied 0 strokes" and
		// left the clipboard alone, so the next paste brought back an older
		// copy and read as this one having gone somewhere. `copyToClipboard`
		// returns before `copyInk` when there is nothing selected, so nothing
		// to undo here - only something to say, in the sentence the note
		// surface's command already says for the same state.
		if (n === 0) {
			this.notify("Handwriting: lasso some ink first");
			return;
		}
		// 1.4.6-design.md 5m/AF6: this said "copied 1 stroke" / "copied N
		// strokes", new prose next to cutSelectionCommand's "cut N
		// stroke(s)" below - the wording the note command already uses.
		// Reused verbatim, not recomposed.
		this.notify(`Handwriting: copied ${n} stroke(s)`);
		this.refreshStrip();
	}

	/**
	 * Delete, said out loud - the command's half of `deleteSelection`, shared
	 * with the strip button so both name the same cause. Returns whether ink
	 * was actually removed (audit doc §5s/AM-A), so a caller that must not
	 * treat a refusal the same as a success - the keydown handler's three-way
	 * split, §5s/AM-B - can tell them apart without re-running the gates
	 * here.
	 *
	 * The id is checked BEFORE the selection, audit doc §5k/AD4: a document
	 * still being hashed has no id, `deleteSelection` returns false for that
	 * reason as readily as for an empty lasso, and "lasso some ink first" told
	 * somebody staring at their own lasso the one thing that was not wrong.
	 *
	 * Notifies on every refusal, unconditionally - the strip button and the
	 * palette/hotkey command both reach this, and pressing either one is
	 * itself the deliberate act (§5s/AM-B). The keydown handler's own
	 * "nothing lassoed" case is filtered out before this is ever called, not
	 * inside it, so that rule lives once, at the one caller that needs it.
	 */
	function deleteSelectionCommand(this: PdfInkController): boolean {
		if (!this.identified) {
			this.notifyUnidentified();
			return false;
		}
		const deleted = this.deleteSelection();
		if (!deleted) this.notify("Handwriting: lasso some ink first");
		return deleted;
	}

	/** Cut, said out loud, in the wording the note command already uses. */
	function cutSelectionCommand(this: PdfInkController): void {
		if (!this.identified) {
			this.notifyUnidentified();
			return;
		}
		const n = this.cutSelection();
		this.notify(n > 0 ? `Handwriting: cut ${n} stroke(s)` : "Handwriting: lasso some ink first");
	}

	/**
	 * The wait, in the sentence the PDF commands in main.ts already use for
	 * it. The pen's own refusal (penDown) says "ink starts in a moment"
	 * because drawing resumes by itself; a palette or button action does not
	 * resume by itself, so this is the one that asks for the retry.
	 */
	function notifyUnidentified(this: PdfInkController): void {
		this.notify("Handwriting: still identifying this PDF - try again in a moment");
	}

	/**
	 * Copy, then delete - the PDF side of InkOverlay.cutSelectedInk. Kept
	 * quiet (no notify of its own, like deleteSelection) so the command in
	 * main.ts owns the "cut N stroke(s)" / "lasso some ink first" wording,
	 * the same text it already uses for the note surface.
	 */
	function cutSelection(this: PdfInkController): number {
		const n = this.copyToClipboard();
		if (n > 0) this.deleteSelection();
		// Its own refresh, audit doc §5k/(b): the strip was only ever correct
		// here because `deleteSelection` refreshes on the way out, so a cut
		// that copied nothing - or any future cut that stops short of the
		// delete - left the trash and paste buttons lit from a selection that
		// is gone.
		this.refreshStrip();
		return n;
	}

	/**
	 * Paste, page-true: pdf strokes carry the page they were copied from and
	 * go back to it. Ink copied from a NOTE has no page and its coordinates
	 * are note pixels besides - placing it would be a guess at both position
	 * and scale - so it is refused with the reason instead of appearing tiny
	 * in a corner nobody chose.
	 */
	function pasteFromClipboard(this: PdfInkController): void {
		const id = this.documentId();
		// Audit doc §5k/AD4: this returned in silence, and the button and the
		// palette entry both offered the paste that reached it. The offer is
		// withdrawn now (canPasteInk and the command's checkCallback both ask
		// for an id), and if one is taken anyway the wait is said rather than
		// swallowed.
		if (!id) {
			this.notifyUnidentified();
			return;
		}
		if (clipboardSize() === 0) return;
		const pasted = pasteInk(id);
		if (pasted.some((st) => st.page === undefined)) {
			this.notify("Handwriting: that ink was copied from a note - paste it on a note.");
			return;
		}
		// Ink copied from a longer PDF can name a page this one does not have.
		// Stored anyway it shows nowhere, and flatten then refuses the whole
		// document over it, so the paste is refused instead. pdf.js keeps every
		// page div, so the probe's page list is the document's page count; with
		// no pages read yet there is nothing to compare against and the paste
		// goes ahead as before.
		const pageCount = this.probe()?.pages.length ?? 0;
		const lastPage = Math.max(...pasted.map((st) => st.page!));
		if (pageCount > 0 && lastPage > pageCount) {
			this.notify(
				`Handwriting: that ink is on page ${lastPage}, and this PDF has ${pageCount} - nothing was pasted.`
			);
			return;
		}
		this.emit({ type: "add", path: id, strokes: pasted });
		this.refresh();
		const n = pasted.length;
		this.notify(n === 1 ? "Handwriting: pasted 1 stroke" : `Handwriting: pasted ${n} strokes`);
	}

export function installPdfSelection(proto: PdfInkController): void {
	installMethods(proto, {
		selectionGrabbed,
		lassoDown,
		queueEditFrame,
		flushEditFrame,
		lassoMove,
		snipSelection,
		selectionBounds,
		clearSelection,
		dissolveSelection,
		drawLasso,
		deleteSelection,
		lassoUp,
		copyToClipboard,
		copySelection,
		deleteSelectionCommand,
		cutSelectionCommand,
		notifyUnidentified,
		cutSelection,
		pasteFromClipboard,
	});
}
