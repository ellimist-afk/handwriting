import { Notice, TFile, TextFileView, WorkspaceLeaf, normalizePath } from "obsidian";
import { Camera } from "../camera/Camera";
import { CameraState } from "../camera/coordinates";
import { telemetry } from "../diag/Telemetry";
import { PointerRouter, PenSample } from "../input/PointerRouter";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, PenStyle, widthForPressure } from "../ink/PenStyle";
import { InkStroke, InkTool } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { drawCommitted, drawStroke } from "../ink/StrokeRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { StrokeMetrics } from "../ink/StrokeMetrics";
import { DEFAULT_CAPS, buildTail, correctionError } from "../ink/Prediction";
import { strokesHitByCircle } from "../ink/Eraser";
import { padBBox, pointInBBox } from "../objects/Selection";
import { SelectionModel } from "../objects/SelectionModel";
import { Point2 } from "../ink/Smoothing";
import { BBox } from "../ink/Stroke";
import { History } from "../history/History";
import { TextLayer } from "../objects/TextLayer";
import { ImageLayer } from "../objects/ImageLayer";
import { ImageData, PageData, TextBoxData, newId } from "../model/PageData";
import { MarkdownBlock, MarkdownImage } from "../model/MarkdownPage";
import { PageDocument } from "../model/PageDocument";
import { createMoveOp, moveObjects } from "../objects/ObjectOps";
import { PageStore } from "../persistence/PageStore";
import { computeCanvasSize, formatRaster, inspectRaster } from "../diag/Raster";
import { runDetached } from "../util/Detached";

export const HANDWRITING_PAGE_VIEW_TYPE = "handwriting-page";

const MINOR_GRID_WORLD = 40;
const MAJOR_GRID_WORLD = 200;
/** Eraser radius in screen pixels; world radius scales with zoom. */
const ERASER_SCREEN_R = 12;
/** Real samples kept for prediction turn detection. */
const PEN_HISTORY = 8;
const CAMERA_SAVE_MS = 1500;
const SELECTION_COLOR = "#7f9cf5";
/** How far outside the selection box still counts as grabbing it, in px. */
const SELECTION_GRAB_PAD = 8;
/** Minimum spacing between lasso vertices, in screen px. */
const LASSO_MIN_STEP_PX = 2;

/** What the view needs from the plugin, without importing it (no cycles). */
export interface HandwritingHost {
	store: PageStore;
	getCamera(pageId: string): CameraState | undefined;
	setCamera(pageId: string, cam: CameraState): void;
	/** Geometry smoothing verdict from the pen lab; false = approved pipeline. */
	settings: { smoothInk: boolean };
	/**
	 * Paths deliberately sent to the canvas (the open-on-canvas command).
	 * Everything else that lands in a live canvas view bounces back to
	 * Markdown - see onLoadFile.
	 */
	canvasIntent: Set<string>;
}

type Tool = "pen" | "highlighter" | "eraser" | "lasso";

/**
 * A Handwriting page: an infinite canvas backed by a real Markdown file.
 *
 * Text lives in the `.md` (indexed by Obsidian, readable without the plugin);
 * geometry and ink live in `.handwriting/<page-id>.json`. The pen pipeline below is
 * frozen as approved at the checkpoint: synchronous drawing inside
 * `pointerrawupdate`, current processing, synchronized (non-desynchronized) canvas.
 */
export class HandwritingPageView extends TextFileView {
	private host: HandwritingHost;

	// DOM
	private rootEl!: HTMLElement;
	private paperEl!: HTMLElement;
	private committedCanvas!: HTMLCanvasElement;
	private wetCanvas!: HTMLCanvasElement;
	/** Highlighter ink, committed and wet, both below the text layer (§6). */
	private highlightCanvas!: HTMLCanvasElement;
	private wetHighlightCanvas!: HTMLCanvasElement;
	private tailCanvas!: HTMLCanvasElement;
	private caretEl!: HTMLElement;
	private eraserEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private zoomLabelEl!: HTMLElement;
	private toolButtons: Array<{ el: HTMLButtonElement; active: () => boolean }> = [];

	private committedCtx!: CanvasRenderingContext2D;
	private highlightCtx!: CanvasRenderingContext2D;
	private wetInk!: WetInkRenderer;
	private wetHighlight!: WetInkRenderer;
	private tail!: TailRenderer;
	private textLayer!: TextLayer;
	private imageLayer!: ImageLayer;

	// state
	private camera = new Camera();
	private router: PointerRouter | null = null;
	private history = new History(() => this.updateStatus());
	/**
	 * Canonical content: container text, container geometry and ink. The DOM
	 * text layer is a view of this, never the source of truth.
	 */
	private doc = new PageDocument();
	/** Convenience alias so spatial code reads the same as it always did. */
	private get page(): PageData {
		return this.doc.page;
	}
	private get pageId(): string {
		return this.doc.pageId;
	}
	private tool: Tool = "pen";
	private penStyle: PenStyle = { ...DEFAULT_PEN };
	private highlighterStyle: PenStyle = { ...HIGHLIGHTER_PEN };
	private predictionOn = false;

	// stroke state
	private builder: StrokeBuilder | null = null;
	private erasing = false;
	private erasedThisStroke: Array<{ index: number; stroke: InkStroke }> = [];
	private penHistory: PenSample[] = [];
	private lastTail: PenSample[] = [];
	private metrics = new StrokeMetrics();
	private presentProbePending = false;
	private tickerActive = false;

	// caret ("click here, then type", §13)
	private caret: { x: number; y: number } | null = null;

	// lasso / selection (§26, §58), all world-space, so pan and zoom are free
	private lassoPts: Point2[] = [];
	private lassoActive = false;
	private selection = new SelectionModel();
	private dragFrom: { x: number; y: number } | null = null;
	private dragTotal: { dx: number; dy: number } | null = null;

	// bookkeeping
	private cssWidth = 0;
	private cssHeight = 0;
	private dpr = 1;
	private renderQueued = false;
	private resizeObserver: ResizeObserver | null = null;
	private detachCamera: (() => void) | null = null;
	private loadToken = 0;
	/** False until the sidecar for the current file has been read. */
	private loaded = false;
	/**
	 * True once the page id is known to be ON DISK in the Markdown. Distinct
	 * from doc.identityClaimed (which means "the next compose will include the
	 * id"): the sidecar and the camera may only be persisted once THIS is true,
	 * because both are keyed by the id.
	 */
	private identitySaved = false;
	/** The in-flight first write of the page id, when one is running. */
	private claimInFlight: Promise<void> | null = null;
	private lastComposed = "";
	private cameraTimer: number | null = null;
	private debug = false;

	constructor(leaf: WorkspaceLeaf, host: HandwritingHost) {
		super(leaf);
		this.host = host;
	}

	getViewType(): string {
		return HANDWRITING_PAGE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Handwriting page";
	}

	getIcon(): string {
		return "pen-tool";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "md";
	}

	// ---- lifecycle ----------------------------------------------------------

	async onOpen(): Promise<void> {
		const content = this.contentEl;
		content.empty();
		content.addClass("handwriting-content");

		this.rootEl = content.createDiv({ cls: "handwriting-root" });
		this.rootEl.tabIndex = 0;

		// Layer order (§6): paper, DOM objects, committed ink, wet ink,
		// prediction tail, interaction UI. Ink sits ABOVE text so a pen can
		// cross typed content, which is the whole OneNote model.
		this.paperEl = this.rootEl.createDiv({ cls: "handwriting-paper" });
		// Highlighter sits between the paper and the text, so a highlight reads
		// as ink UNDER the words rather than a wash over them.
		this.highlightCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-highlight" });
		this.wetHighlightCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-highlight" });
		this.imageLayer = new ImageLayer(this.rootEl, this.app, this.file?.path ?? "");
		this.textLayer = new TextLayer(this.rootEl, this.app, this, this.file?.path ?? "", {
			onTextChanged: (id, text) => this.onBoxTextChanged(id, text),
			onMoved: (id, from, to) => this.onBoxMoved(id, from, to),
			onEmptied: (id) => this.deleteBox(id, true),
			onEditingChanged: () => this.updateStatus(),
		});
		this.committedCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-committed" });
		this.wetCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-wet" });
		this.tailCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-tail" });
		this.caretEl = this.rootEl.createDiv({ cls: "handwriting-caret" });
		this.eraserEl = this.rootEl.createDiv({ cls: "handwriting-eraser-cursor" });

		this.buildToolbar();
		this.statusEl = this.rootEl.createDiv({ cls: "handwriting-status" });

		const ctx = this.committedCanvas.getContext("2d");
		const hctx = this.highlightCanvas.getContext("2d");
		if (!ctx || !hctx) throw new Error("Handwriting: no 2d context");
		this.committedCtx = ctx;
		this.highlightCtx = hctx;
		// Frozen pen pipeline: synchronized canvas. A desynchronized canvas felt worse
		// on the test Surface. The highlighter uses the same renderer on its own
		// layer; the pipeline is unchanged, only the canvas it draws into differs.
		this.wetInk = new WetInkRenderer(this.wetCanvas, false);
		this.wetHighlight = new WetInkRenderer(this.wetHighlightCanvas, false);
		this.wetInk.smooth = this.host.settings.smoothInk;
		this.wetHighlight.smooth = this.host.settings.smoothInk;
		this.tail = new TailRenderer(this.tailCanvas);

		this.router = new PointerRouter(this.rootEl, this.camera, {
			onPenDown: (s, ev) => telemetry.guard("penDown", () => this.penDown(s, ev)),
			onPenMove: (samples, ev, count) =>
				telemetry.guard("penMove", () => this.penMove(samples, ev, count)),
			onPenUp: () => telemetry.guard("penUp", () => this.penUp()),
			onPenRaw: (samples, ev, predicted) =>
				telemetry.guard("penRaw", () => this.penRaw(samples, ev, predicted)),
			onTap: (x, y, source) => telemetry.guard("tap", () => this.onTap(x, y, source)),
			onStatus: () => {
				/* HUD is debug-only now; nothing on the hot path. */
			},
		});

		this.detachCamera = this.camera.onChange(() => {
			this.router?.refreshRect();
			this.textLayer.setCamera(this.camera.snapshot);
			this.imageLayer.setCamera(this.camera.snapshot);
			this.positionCaret();
			this.redrawSelectionUI();
			this.requestRender();
			this.scheduleCameraSave();
		});

		this.registerDomEvent(this.rootEl, "keydown", (ev) => this.onKeyDown(ev));

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.rootEl);
		this.handleResize();
		this.textLayer.setCamera(this.camera.snapshot);
		this.imageLayer.setCamera(this.camera.snapshot);
		this.registerDropAndPaste();
		this.updateStatus();
	}

	async onClose(): Promise<void> {
		this.textLayer?.endEdit();
		this.saveCameraNow();
		await this.host.store.flush();
		this.tickerActive = false;
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.detachCamera?.();
		this.detachCamera = null;
	}

	async onLoadFile(file: TFile): Promise<void> {
		// canAcceptExtension says "md", and Obsidian REUSES a live view for
		// any file it accepts: once a leaf shows the canvas, every note
		// opened in that leaf loads INTO the canvas (seen live 2026-08-27 -
		// "every page turned into a slate canvas"). Only marked pages and
		// deliberate open-on-canvas targets belong here; anything else
		// bounces the leaf back to Markdown.
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const marker: unknown = fm?.["handwriting"];
		const belongs =
			marker === "page" || marker === true || this.host.canvasIntent.has(file.path);
		if (!belongs) {
			const leaf = this.leaf;
			queueMicrotask(() => {
				void leaf.setViewState({
					type: "markdown",
					state: { file: file.path, mode: "source" },
				});
			});
			return;
		}
		this.textLayer?.setSourcePath(file.path);
		this.imageLayer?.setSourcePath(file.path);
		await super.onLoadFile(file);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		// Flush before the next page takes over the view (§64).
		this.textLayer?.endEdit();
		this.saveCameraNow();
		await this.host.store.flush();
		await super.onUnloadFile(file);
	}

	// ---- Markdown <-> view --------------------------------------------------

	getViewData(): string {
		// Until the sidecar has loaded, the in-memory page is empty. Composing
		// from it would write an empty note over the user's text. Hand back
		// exactly what we were given instead.
		if (!this.loaded) return this.data;
		// A newer Handwriting wrote this file; rewriting it in our older format would
		// delete whatever that version added.
		if (!this.doc.markdownWritable) return this.data;
		// Nothing we did changed the Markdown. Obsidian saves a text view on
		// close whether or not anything happened, so composing here is what
		// would rewrite a note the user only looked at. Hand back the bytes we
		// were given: open → close leaves the file untouched.
		if (!this.doc.markdownDirty) return this.data;
		const md = this.doc.compose();
		this.lastComposed = md;
		return md;
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;
		// Our own save coming back through the file watcher (§72): nothing to do.
		if (!clear && data === this.lastComposed) return;

		if (clear || !this.loaded) {
			this.openFrom(data);
			return;
		}

		const parsed = this.doc.loadMarkdownPreview(data);
		// Absence of a page id is never evidence that the document changed: an
		// unclaimed note is identified by the file in this view. Reloading here
		// wiped live ink and undo on every external edit, including Obsidian
		// rewriting the note because a linked file was renamed.
		if (!this.doc.isSameDocument(parsed.pageId)) {
			// A genuinely different persisted identity took over this leaf.
			this.openFrom(data);
			return;
		}

		// Same page, changed underneath us: another window, another device via
		// sync, or a plugin. Absorb every difference instead of refreshing
		// only the containers we already knew about: adopting nothing meant the
		// next save silently deleted whatever had been added elsewhere.
		const result = this.doc.reconcile(data, {
			editingId: this.textLayer?.editingBoxId ?? null,
			defaultWidth: TextLayer.defaultWidth(),
		});
		// The file on disk carries an id. Whoever wrote it (us earlier, or
		// another view of the same note), the identity is persisted now.
		if (parsed.pageId) this.identitySaved = true;
		if (!result.dirty) return;

		for (const id of result.removed) this.textLayer.remove(id);
		for (const id of result.removedImages) this.imageLayer.remove(id);
		this.pruneSelection();
		for (const box of [...result.added, ...result.changed]) this.textLayer.upsert(box);
		for (const im of result.addedImages) this.imageLayer.upsert(im);
		// Geometry changed with the container set, so the sidecar owes a write.
		// The markdown already matches disk, so it does not.
		if (
			result.added.length > 0 ||
			result.removed.length > 0 ||
			result.addedImages.length > 0 ||
			result.removedImages.length > 0
		) {
			this.saveSpatial();
		}
		// (No production logging: reconciliation is routine, not an anomaly.)
		this.lastComposed = data;
		this.requestRender();
		this.updateStatus();
	}

	/** Full open: parse markdown, then join the sidecar asynchronously. */
	private openFrom(data: string): void {
		this.history.clear();
		this.loaded = false;
		this.doc = new PageDocument();
		const parsed = this.doc.loadMarkdown(data);
		// Persisted identity exists exactly when the file already carried an id.
		this.identitySaved = this.doc.identityClaimed;
		this.caret = null;
		this.positionCaret();
		runDetached(
			this.loadPage(parsed.blocks, parsed.images),
			"load a canvas page",
			() => new Notice("Handwriting: could not load this canvas page. See the developer console.")
		);
	}

	clear(): void {
		this.loaded = false;
		this.doc = new PageDocument();
		this.lastComposed = "";
		this.history.clear();
		this.textLayer?.setAll([]);
		this.imageLayer?.setAll([]);
		this.caret = null;
		this.positionCaret();
		this.requestRender();
	}

	/** Join sidecar geometry with markdown text; recover gracefully if either is missing. */
	private async loadPage(blocks: MarkdownBlock[], embeds: MarkdownImage[]): Promise<void> {
		const token = ++this.loadToken;
		const pageId = this.doc.pageId;
		const result = await this.host.store.load(pageId);
		if (token !== this.loadToken) return; // a different page won the race

		if (result?.damaged) {
			// Fail closed: the placeholder must never be written back over
			// whatever the damaged file still holds.
			this.doc.spatialDamaged = true;
			new Notice(
				"Handwriting cannot read this page's saved ink and layout. The file has not been overwritten. The page opens read-only for ink until that file is repaired or removed."
			);
		} else if (result?.recovered && !result.damagedKeptAs) {
			// (The corrupt-file promotion announces itself through the
			// store's onRecovered, with the kept path; this is the bare
			// interrupted-save case.)
			// A success, and it must read as one: this fires when the atomic
			// tmp/rename recovery worked. An earlier text reported "sidecar
			// problem", internal vocabulary for a fault the user did not have.
			new Notice(
				"Handwriting recovered this note's ink from an interrupted save. Nothing was lost."
			);
		}
		if (result?.futureVersion !== undefined) {
			this.doc.spatialFutureVersion = result.futureVersion;
			new Notice(
				`Handwriting: this page was written by a newer version of Handwriting (schema ${result.futureVersion}). It opens read-only so nothing is lost.`
			);
		}

		const joined = this.doc.applySidecar(
			result?.data,
			blocks,
			embeds,
			TextLayer.defaultWidth()
		);
		// (No production logging: fallback layout is normal for legacy pages.)

		this.textLayer.setAll(joined.boxes);
		this.imageLayer.setAll(joined.images);
		const cam = this.host.getCamera(pageId);
		if (cam) this.camera.setState(cam.x, cam.y, cam.zoom);
		this.textLayer.setCamera(this.camera.snapshot);
		this.loaded = true;
		this.requestRender();
		this.updateStatus();
	}

	/**
	 * Ink and geometry live in the sidecar only. Writing the Markdown file
	 * every time a stroke lands would churn a synced note for content that
	 * did not change (sync-tool conflict copies, §72-adjacent).
	 */
	private saveSpatial(): void {
		if (!this.loaded || !this.pageId) return;
		// Never write back a file a newer Handwriting produced.
		if (!this.doc.spatialWritable) return;
		this.scheduleSidecar();
	}

	/** Text changed: both halves of the page need writing. */
	private saveAll(): void {
		if (!this.loaded || !this.pageId) return;
		if (this.doc.spatialWritable) this.scheduleSidecar();
		// Only when the compose output actually differs: an unconditional save
		// here rewrote (and re-dated) notes whose Markdown never changed.
		if (this.file && this.doc.markdownWritable && this.doc.markdownDirty) {
			this.requestSave();
		}
	}

	/**
	 * The reference must exist before the referent: the page id is persisted
	 * into the Markdown, awaited rather than debounced, before any sidecar
	 * keyed by that id can be written. Otherwise a crash in the 1 to 2 s
	 * between the two debounces left ink under an id no note referenced
	 * (audit v0.8.0 #2).
	 */
	private scheduleSidecar(): void {
		if (!this.identitySaved) {
			// Nothing spatial worth keeping yet: a housekeeping save (an empty
			// box dying on blur) must not stamp an id on a note the user
			// merely touched, and has nothing to put in a sidecar anyway.
			if (!this.doc.hasSpatialState) return;
			if (this.file && this.doc.markdownWritable) {
				this.doc.claimIdentity();
				if (!this.claimInFlight) {
					this.claimInFlight = this.save()
						.then(() => {
							this.identitySaved = true;
						})
						.catch((err) => {
							console.error("[handwriting] could not persist the page id", err);
						})
						.finally(() => {
							this.claimInFlight = null;
						});
				}
				// Defer the sidecar until the id write settles. On failure it
				// is still written, because an orphaned sidecar is recoverable
				// and lost ink is not. The next save retries the claim.
				const pageId = this.pageId;
				const page = this.doc.page;
				runDetached(
					this.claimInFlight.then(() => this.host.store.schedule(pageId, page)),
					"schedule a canvas sidecar after saving its page id"
				);
				return;
			}
			// No file / read-only Markdown: fall through and write the sidecar
			// anyway. Orphan-tolerant beats ink-losing.
		}
		this.host.store.schedule(this.pageId, this.page);
	}

	// ---- text boxes ---------------------------------------------------------

	private createBox(wx: number, wy: number, initialChar?: string): void {
		const id = newId("tb");
		const data = {
			id,
			x: wx,
			y: wy,
			width: TextLayer.defaultWidth(),
			z: this.page.textBoxes.length,
		};
		const add = () => {
			this.doc.addBox(data, this.doc.textOf(id));
			this.textLayer.upsert({ data, text: this.doc.textOf(id) });
			this.saveAll();
		};
		const remove = () => {
			this.doc.removeBox(id);
			this.textLayer.remove(id);
			this.saveAll();
		};
		add();
		this.history.push({ label: "Create text box", apply: add, invert: remove });
		this.clearCaret();
		this.textLayer.beginEdit(id, initialChar);
	}

	private deleteBox(id: string, onlyIfEmpty: boolean): void {
		if (!this.doc.hasBox(id)) return;
		const text = this.doc.textOf(id);
		if (onlyIfEmpty && text.trim().length > 0) return;
		const index = this.doc.indexOfBox(id);
		const data = this.doc.boxData(id);
		if (index < 0 || !data) return;
		const remove = () => {
			this.doc.removeBox(id);
			this.textLayer.remove(id);
			this.saveAll();
		};
		const restore = () => {
			this.doc.addBox(data, text, index);
			this.textLayer.upsert({ data, text });
			this.saveAll();
		};
		remove();
		// An empty box vanishing on blur is housekeeping, not an edit worth undoing.
		if (!onlyIfEmpty) {
			this.history.push({ label: "Delete text box", apply: remove, invert: restore });
		}
	}

	private onBoxTextChanged(id: string, text: string): void {
		// The document owns the words; the textarea is just where they are being
		// typed. Text edits keep their own undo stack (§23), so no history op.
		this.doc.setText(id, text);
		// saveAll, not just requestSave: setText can materialise (a transient
		// box gaining its first words), and the new box's geometry then owes
		// the sidecar a write. For a body-only note the sidecar half is a
		// no-op, since text alone is never spatial state.
		this.saveAll();
	}

	private onBoxMoved(id: string, from: { x: number; y: number }, to: { x: number; y: number }): void {
		const data = this.page.textBoxes.find((b) => b.id === id);
		if (!data) return;
		// Dragging a container is spatial intent: arrangement now exists.
		this.doc.noteGeometryEdited();
		const move = (p: { x: number; y: number }) => () => {
			data.x = p.x;
			data.y = p.y;
			const model = this.textLayer.get(id);
			if (model) this.textLayer.upsert({ data, text: model.text });
			this.saveSpatial();
		};
		this.history.push({ label: "Move text box", apply: move(to), invert: move(from) });
		this.saveSpatial();
	}

	// ---- caret --------------------------------------------------------------

	private setCaret(wx: number, wy: number): void {
		this.caret = { x: wx, y: wy };
		this.positionCaret();
		this.rootEl.focus();
	}

	private clearCaret(): void {
		this.caret = null;
		this.positionCaret();
	}

	private positionCaret(): void {
		if (!this.caretEl) return;
		if (!this.caret) {
			this.caretEl.setCssStyles({ display: "none" });
			return;
		}
		const s = this.camera.worldToScreen(this.caret.x, this.caret.y);
		this.caretEl.setCssStyles({
			display: "",
			transform: `translate(${s.x}px, ${s.y}px) scale(${this.camera.zoom})`,
		});
	}

	private onTap(x: number, y: number, source: "mouse" | "touch"): void {
		const w = this.camera.screenToWorld(x, y);
		if (this.tool === "lasso") {
			const bounds = this.selectionBounds();
			if (!bounds || !pointInBBox(w.x, w.y, bounds)) this.clearSelection();
			return;
		}
		const hit = this.textLayer.hitTest(w.x, w.y);
		if (hit) {
			this.clearCaret();
			this.textLayer.beginEdit(hit);
			return;
		}
		if (this.textLayer.isEditing) {
			this.textLayer.endEdit();
			return;
		}
		if (source === "touch") {
			// A finger has no keyboard to type into a caret. Give it a real
			// editor so the on-screen keyboard appears.
			this.createBox(w.x, w.y);
			return;
		}
		this.setCaret(w.x, w.y);
	}

	private onKeyDown(ev: KeyboardEvent): void {
		if (this.textLayer.isEditing) return; // the textarea owns its keys
		const mod = ev.ctrlKey || ev.metaKey;
		if (mod && ev.key.toLowerCase() === "z" && !ev.shiftKey) {
			ev.preventDefault();
			this.undo();
			return;
		}
		if (mod && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
			ev.preventDefault();
			this.redo();
			return;
		}
		if (mod || ev.altKey) return;
		if (ev.key === "Delete" || ev.key === "Backspace") {
			if (this.hasSelection()) {
				ev.preventDefault();
				this.deleteSelection();
				return;
			}
		}
		if (ev.key === "Escape") {
			this.clearSelection();
			this.clearCaret();
			return;
		}
		if (!this.caret) return;
		if (ev.key === "Enter") {
			ev.preventDefault();
			this.createBox(this.caret.x, this.caret.y);
			return;
		}
		// Typing at the caret is what actually creates the box, so an idle
		// click never litters the page with empty containers.
		if (ev.key.length === 1) {
			ev.preventDefault();
			this.createBox(this.caret.x, this.caret.y, ev.key);
		}
	}

	// Each operation persists exactly what it touched, so undo/redo only has to
	// repaint.
	undo(): void {
		if (!this.history.canUndo) return;
		this.history.undo();
		this.pruneSelection();
		this.redrawCommitted();
		this.redrawSelectionUI();
	}

	redo(): void {
		if (!this.history.canRedo) return;
		this.history.redo();
		this.pruneSelection();
		this.redrawCommitted();
		this.redrawSelectionUI();
	}

	/** Drop selected ids for objects that no longer exist. */
	private pruneSelection(): void {
		if (this.selection.isEmpty) return;
		this.selection.prune(
			new Set(this.page.strokes.map((s) => s.id)),
			new Set(this.page.textBoxes.map((b) => b.id)),
			new Set(this.page.images.map((im) => im.id))
		);
	}

	// ---- pen path (frozen pipeline) ----------------------------------------

	private eraserWorldRadius(): number {
		return ERASER_SCREEN_R / this.camera.zoom;
	}

	/**
	 * The wet layer for the current tool. The pen pipeline is unchanged. This
	 * only chooses which canvas the same renderer draws into, so a highlight is
	 * already beneath the text while it is still wet.
	 */
	private wet(): WetInkRenderer {
		return this.tool === "highlighter" ? this.wetHighlight : this.wetInk;
	}

	/** The committed layer a finished stroke belongs to. */
	private committedCtxFor(tool: InkTool): CanvasRenderingContext2D {
		return tool === "highlighter" ? this.highlightCtx : this.committedCtx;
	}

	/** Pen or highlighter appearance, by active tool. */
	private strokeStyle(): PenStyle {
		return this.tool === "highlighter" ? this.highlighterStyle : this.penStyle;
	}

	private penDown(sample: PenSample, ev: PointerEvent): void {
		telemetry.bump("view.strokeBegin");
		this.clearCaret();
		if (this.textLayer.isEditing) this.textLayer.endEdit();

		// Eraser end reports as bit 5 of `buttons` (§25). The test pen never
		// showed it in diagnostics, so the toolbar tool is the fallback path
		// and this counter tells us if the hardware ever speaks up.
		const eraserButton = (ev.buttons & 32) !== 0 || ev.button === 5;
		if (eraserButton) telemetry.bump("pen.eraserButton");

		// Side button held = lasso, whatever tool is selected (§52). This is
		// the temporary-override model from §53: reach for the button, drag a
		// loop, let go. No toolbar trip and no mode left behind. Diagnostics
		// established that this pen reports the side button as bit 2 of `buttons`.
		const sideHeld = (ev.buttons & 2) !== 0;
		if (sideHeld) telemetry.bump("pen.barrelLasso");
		if ((this.tool === "lasso" || sideHeld) && !eraserButton) {
			this.lassoDown(sample);
			return;
		}
		this.erasing = eraserButton || this.tool === "eraser";
		this.erasedThisStroke = [];
		this.penHistory = [sample];
		this.lastTail = [];
		this.metrics.begin(this.erasing ? "erase" : "ink", performance.now());

		if (this.erasing) {
			this.showEraserCursor(sample);
			this.eraseAt(sample);
			return;
		}
		const tool: InkTool = this.tool === "highlighter" ? "highlighter" : "pen";
		const style = this.strokeStyle();
		this.builder = new StrokeBuilder(tool, style.color, style.baseWidth);
		this.builder.start(sample.timestamp);
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const point = this.builder.add(
			w.x,
			w.y,
			normalizePressure(sample.pressure),
			sample.timestamp,
			sample.tiltX,
			sample.tiltY
		);
		if (point) this.wet().beginStroke(point);
		this.startTicker();
	}

	private penMove(samples: PenSample[], ev: PointerEvent, coalescedCount: number): void {
		this.metrics.recordEvent("move", coalescedCount, performance.now() - ev.timeStamp, false);
		void samples;
	}

	private penRaw(samples: PenSample[], ev: PointerEvent, predicted: PenSample[]): void {
		if (this.lassoActive || this.dragFrom) {
			this.lassoMove(samples);
			return;
		}
		const t0 = performance.now();
		this.metrics.recordEvent("raw", samples.length, t0 - ev.timeStamp, true);
		if (this.erasing) {
			for (const s of samples) this.eraseAt(s);
			const last = samples[samples.length - 1];
			if (last) this.showEraserCursor(last);
			return;
		}
		if (!this.builder) return;
		this.inkSamples(samples, predicted);
		this.metrics.recordHandler(performance.now() - t0);
	}

	private inkSamples(samples: PenSample[], predicted: PenSample[]): void {
		if (!this.builder || samples.length === 0) return;
		telemetry.bump("view.inkBatch");
		const cam = this.camera.snapshot;
		const first = samples[0]!;
		const err = correctionError(this.lastTail, first);
		if (err !== undefined) this.metrics.recordCorrection(err);

		const drawStart = performance.now();
		let accepted = 0;
		for (const s of samples) {
			const w = this.camera.screenToWorld(s.x, s.y);
			const point = this.builder.add(
				w.x,
				w.y,
				normalizePressure(s.pressure),
				s.timestamp,
				s.tiltX,
				s.tiltY
			);
			if (point) {
				this.wet().appendPoint(cam, this.strokeStyle(), point);
				accepted++;
				telemetry.bump("view.segment");
			}
			this.penHistory.push(s);
		}
		if (this.penHistory.length > PEN_HISTORY) {
			this.penHistory.splice(0, this.penHistory.length - PEN_HISTORY);
		}
		const drawEnd = performance.now();
		const newestTs = samples[samples.length - 1]!.timestamp;
		this.metrics.recordAccepted(accepted);
		this.metrics.recordDraw(drawEnd - drawStart, drawEnd - newestTs);
		this.updateOverlay(predicted);
		this.schedulePresentProbe(newestTs);
	}

	/**
	 * Redraw everything transient in front of the settled ink: the live head
	 * that reaches the nib, plus the predicted tail if that experiment is on.
	 * One clear, one pass.
	 */
	private updateOverlay(predicted: PenSample[]): void {
		this.tail.clear();
		this.lastTail = [];

		const head = this.wet().head();
		if (head) {
			this.tail.drawHead(
				this.camera.snapshot,
				this.strokeStyle(),
				head.from,
				head.to,
				head.pressure
			);
		}
		if (!this.predictionOn) return;
		const result = buildTail(this.penHistory, predicted, predicted.length > 0 ? "chromium" : "extrap", DEFAULT_CAPS);
		if (result.points.length === 0) return;
		const last = this.penHistory[this.penHistory.length - 1]!;
		const widthPx =
			widthForPressure(this.penStyle, normalizePressure(last.pressure)) * this.camera.zoom;
		this.tail.draw(last.x, last.y, result.points, this.penStyle.color, widthPx);
		this.lastTail = result.points;
	}

	private schedulePresentProbe(newestTs: number): void {
		if (this.presentProbePending) return;
		this.presentProbePending = true;
		window.requestAnimationFrame(() => {
			this.presentProbePending = false;
			this.metrics.recordPresent(performance.now() - newestTs);
		});
	}

	private startTicker(): void {
		if (this.tickerActive) return;
		this.tickerActive = true;
		const tick = (ts: number) => {
			if (!this.tickerActive) return;
			this.metrics.recordFrame(ts);
			window.requestAnimationFrame(tick);
		};
		window.requestAnimationFrame(tick);
	}

	private penUp(): void {
		if (this.lassoActive || this.dragFrom) {
			this.tickerActive = false;
			this.lassoUp();
			return;
		}
		telemetry.bump("view.strokeEnd");
		this.tickerActive = false;
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		this.hideEraserCursor();
		this.metrics.end(performance.now());

		if (this.erasing) {
			this.erasing = false;
			const erased = this.erasedThisStroke;
			this.erasedThisStroke = [];
			if (erased.length > 0) {
				const ids = new Set(erased.map((e) => e.stroke.id));
				const apply = () => {
					this.page.strokes = this.page.strokes.filter((s) => !ids.has(s.id));
					this.redrawCommitted();
					this.saveSpatial();
				};
				const invert = () => {
					// Reinsert at the original indices so z-order survives undo.
					const sorted = [...erased].sort((a, b) => a.index - b.index);
					for (const e of sorted) {
						this.page.strokes.splice(Math.min(e.index, this.page.strokes.length), 0, e.stroke);
					}
					this.redrawCommitted();
					this.saveSpatial();
				};
				this.history.push({ label: `Erase ${erased.length} stroke(s)`, apply, invert });
				this.saveSpatial();
			}
			return;
		}

		const builder = this.builder;
		this.builder = null;
		if (!builder) return;
		const stroke = builder.finish();
		this.wet().clear(this.cssWidth, this.cssHeight);
		// The live head shares the overlay with the selection outline, so put
		// the outline back after a stroke wipes it.
		this.redrawSelectionUI();
		if (!stroke) return;

		const apply = () => {
			this.page.strokes.push(stroke);
			this.redrawCommitted();
			this.saveSpatial();
		};
		const invert = () => {
			this.page.strokes = this.page.strokes.filter((s) => s.id !== stroke.id);
			this.redrawCommitted();
			this.saveSpatial();
		};
		// Already drawn on the wet layer. Commit it without redrawing the page.
		this.page.strokes.push(stroke);
		drawStroke(
			this.committedCtxFor(stroke.tool),
			this.camera.snapshot,
			stroke,
			undefined,
			this.wetInk.smooth
		);
		this.history.push({ label: "Ink", apply, invert });
		this.saveSpatial();
		this.updateStatus();
	}

	private eraseAt(sample: PenSample): void {
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const hits = strokesHitByCircle(this.page.strokes, w.x, w.y, this.eraserWorldRadius());
		if (hits.length === 0) return;
		const hitSet = new Set(hits);
		const survivors: InkStroke[] = [];
		this.page.strokes.forEach((s, index) => {
			if (hitSet.has(s.id)) this.erasedThisStroke.push({ index, stroke: s });
			else survivors.push(s);
		});
		this.page.strokes = survivors;
		telemetry.bump("view.erased", hits.length);
		// Batched to the next frame: erase samples arrive at input rate, and a
		// full page redraw per sample would be far worse than the erase itself.
		this.requestRender();
	}

	private showEraserCursor(sample: PenSample): void {
		const r = ERASER_SCREEN_R;
		this.eraserEl.setCssStyles({
			display: "",
			width: `${r * 2}px`,
			height: `${r * 2}px`,
			transform: `translate(${sample.x - r}px, ${sample.y - r}px)`,
		});
	}

	private hideEraserCursor(): void {
		this.eraserEl.setCssStyles({ display: "none" });
	}

	// ---- images --------------------------------------------------------------

	/**
	 * Drop or paste an image onto the page.
	 *
	 * The bytes become an ordinary vault attachment through Obsidian's own
	 * attachment-path rules, and the page references it with a real `![[embed]]`
	 * in the Markdown. Handwriting stores only where it sits. That means the vault
	 * owns the picture exactly as it owns typed words: Obsidian counts the
	 * attachment as used, renames flow through on their own, and the note still
	 * shows the image if Handwriting is ever uninstalled.
	 */
	private registerDropAndPaste(): void {
		this.registerDomEvent(this.rootEl, "dragover", (ev) => {
			if (!ev.dataTransfer) return;
			// Only claim the drop if it actually carries files.
			if (!Array.from(ev.dataTransfer.types).includes("Files")) return;
			ev.preventDefault();
			ev.dataTransfer.dropEffect = "copy";
		});
		this.registerDomEvent(this.rootEl, "drop", (ev) => {
			const files = ev.dataTransfer?.files;
			if (!files || files.length === 0) return;
			const images = [...files].filter((f) => f.type.startsWith("image/"));
			if (images.length === 0) return;
			ev.preventDefault();
			const rect = this.rootEl.getBoundingClientRect();
			const w = this.camera.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
			runDetached(this.insertImages(images, w.x, w.y), "insert dropped images");
		});
		this.registerDomEvent(this.rootEl, "paste", (ev) => {
			const files = ev.clipboardData?.files;
			if (!files || files.length === 0) return;
			const images = [...files].filter((f) => f.type.startsWith("image/"));
			if (images.length === 0) return;
			ev.preventDefault();
			// Paste lands at the caret if there is one, else mid-viewport.
			const at =
				this.caret ??
				this.camera.screenToWorld(this.cssWidth / 2, this.cssHeight / 2);
			runDetached(this.insertImages(images, at.x, at.y), "insert pasted images");
		});
	}

	private async insertImages(files: File[], wx: number, wy: number): Promise<void> {
		let offset = 0;
		for (const file of files) {
			try {
				await this.insertImage(file, wx + offset, wy + offset);
				offset += 24;
			} catch (err) {
				console.error("[handwriting] image insert failed", err);
				new Notice(`Handwriting: could not add ${file.name}. See the developer console.`);
			}
		}
	}

	private async insertImage(file: File, wx: number, wy: number): Promise<void> {
		if (!this.file) return;
		if (!this.doc.markdownWritable || !this.doc.spatialWritable) {
			new Notice("Handwriting: this page is read-only because it was written by a newer version of Handwriting.");
			return;
		}
		const bytes = await file.arrayBuffer();
		const name = file.name && file.name.length > 0 ? file.name : `pasted-image-${Date.now()}.png`;
		// Obsidian decides where attachments live; we do not invent a folder.
		const path = normalizePath(
			await this.app.fileManager.getAvailablePathForAttachment(name, this.file.path)
		);
		const created = await this.app.vault.createBinary(path, bytes);

		const size = await measureImage(this.app.vault.getResourcePath(created));
		const fit = ImageLayer.fitToDefault(size.width, size.height);
		const id = newId("im");
		const data: ImageData = {
			id,
			x: Math.round(wx),
			y: Math.round(wy),
			width: fit.width,
			height: fit.height,
			z: this.page.images.length,
		};
		// Link by the path Obsidian would use, so its own rename handling applies.
		const target = this.app.metadataCache.fileToLinktext(created, this.file.path);

		const add = () => {
			this.doc.addImage(data, target);
			this.imageLayer.upsert({ data, target });
			this.saveAll();
		};
		const remove = () => {
			this.doc.removeImage(id);
			this.imageLayer.remove(id);
			this.saveAll();
		};
		add();
		this.history.push({ label: "Add image", apply: add, invert: remove });
		this.updateStatus();
	}

	// ---- lasso & selection (§26, §58, §78) ----------------------------------

	private hasSelection(): boolean {
		return !this.selection.isEmpty;
	}

	/** World bounds of everything selected. */
	private selectionBounds(): BBox | null {
		return this.selection.bounds(
			this.page.strokes,
			(id) => this.textLayer.rectOf(id),
			(id) => this.imageLayer.rectOf(id)
		);
	}

	private lassoDown(sample: PenSample): void {
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const bounds = this.selectionBounds();
		// Landing inside an existing selection moves it; anywhere else starts a
		// new lasso.
		if (bounds && pointInBBox(w.x, w.y, padBBox(bounds, SELECTION_GRAB_PAD / this.camera.zoom))) {
			this.dragFrom = { x: w.x, y: w.y };
			this.dragTotal = { dx: 0, dy: 0 };
			return;
		}
		this.clearSelection();
		this.lassoActive = true;
		this.lassoPts = [w];
		this.redrawSelectionUI();
	}

	private lassoMove(samples: PenSample[]): void {
		const last = samples[samples.length - 1];
		if (!last) return;

		if (this.dragFrom && this.dragTotal) {
			const w = this.camera.screenToWorld(last.x, last.y);
			const dx = w.x - this.dragFrom.x;
			const dy = w.y - this.dragFrom.y;
			this.applyMove(dx, dy);
			this.dragTotal.dx += dx;
			this.dragTotal.dy += dy;
			this.dragFrom = w;
			this.requestRender();
			this.redrawSelectionUI();
			return;
		}

		if (!this.lassoActive) return;
		// Thin the polygon in world space so a slow hand doesn't pile up
		// thousands of near-identical vertices for the hit test to chew on.
		const minStep = LASSO_MIN_STEP_PX / this.camera.zoom;
		for (const sample of samples) {
			const p = this.camera.screenToWorld(sample.x, sample.y);
			const prev = this.lassoPts[this.lassoPts.length - 1];
			if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) >= minStep) {
				this.lassoPts.push(p);
			}
		}
		this.redrawSelectionUI();
	}

	private lassoUp(): void {
		if (this.dragTotal) {
			const { dx, dy } = this.dragTotal;
			this.dragFrom = null;
			this.dragTotal = null;
			if (dx !== 0 || dy !== 0) this.pushMoveOp(dx, dy);
			this.redrawSelectionUI();
			return;
		}
		this.lassoActive = false;
		this.computeSelection();
		this.lassoPts = [];
		this.redrawSelectionUI();
		this.updateStatus();
	}

	private computeSelection(): void {
		this.selection.selectByLasso(
			this.lassoPts,
			this.page.strokes,
			this.page.textBoxes,
			(id) => this.textLayer.rectOf(id),
			this.page.images,
			(id) => this.imageLayer.rectOf(id)
		);
	}

	private clearSelection(): void {
		if (!this.hasSelection() && this.lassoPts.length === 0) return;
		this.selection.clear();
		this.lassoPts = [];
		this.redrawSelectionUI();
		this.updateStatus();
	}

	/**
	 * The live drag. Reading the current selection is correct HERE, because this
	 * is the gesture in progress, not a recorded operation (see pushMoveOp).
	 */
	private applyMove(dx: number, dy: number): void {
		moveObjects(
			this.page,
			{
				strokeIds: this.selection.strokeIds,
				boxIds: this.selection.boxIds,
				imageIds: this.selection.imageIds,
			},
			dx,
			dy
		);
		for (const data of this.page.textBoxes) {
			if (!this.selection.hasBox(data.id)) continue;
			this.textLayer.upsert({ data, text: this.doc.textOf(data.id) });
		}
		for (const data of this.page.images) {
			if (!this.selection.hasImage(data.id)) continue;
			this.imageLayer.upsert({ data, target: this.doc.targetOf(data.id) });
		}
	}

	private pushMoveOp(dx: number, dy: number): void {
		this.doc.noteGeometryEdited();
		// The operation captures WHICH objects moved. Reading the live selection
		// instead means undo does nothing once the selection has been cleared
		// (which happens on every tool switch) while history still advances.
		const op = createMoveOp(
			this.page,
			{
				strokeIds: this.selection.strokeIds,
				boxIds: this.selection.boxIds,
				imageIds: this.selection.imageIds,
			},
			dx,
			dy,
			() => {
				this.syncMovedBoxes();
				this.requestRender();
				this.redrawSelectionUI();
				this.saveSpatial();
			}
		);
		this.history.push(op);
		this.saveSpatial();
	}

	/** Push geometry changes out to the DOM layer after a model-level move. */
	private syncMovedBoxes(): void {
		for (const data of this.page.textBoxes) {
			this.textLayer.upsert({ data, text: this.doc.textOf(data.id) });
		}
		for (const data of this.page.images) {
			this.imageLayer.upsert({ data, target: this.doc.targetOf(data.id) });
		}
	}

	deleteSelection(): void {
		if (!this.hasSelection()) return;
		const strokes: Array<{ index: number; stroke: InkStroke }> = [];
		this.page.strokes.forEach((s, index) => {
			if (this.selection.hasStroke(s.id)) strokes.push({ index, stroke: s });
		});
		const boxes: Array<{ index: number; data: TextBoxData; text: string }> = [];
		this.page.textBoxes.forEach((data, index) => {
			if (!this.selection.hasBox(data.id)) return;
			boxes.push({ index, data, text: this.doc.textOf(data.id) });
		});
		const images: Array<{ index: number; data: ImageData; target: string }> = [];
		this.page.images.forEach((data, index) => {
			if (!this.selection.hasImage(data.id)) return;
			images.push({ index, data, target: this.doc.targetOf(data.id) });
		});
		if (strokes.length === 0 && boxes.length === 0 && images.length === 0) return;

		const strokeIds = new Set(strokes.map((s) => s.stroke.id));
		const boxIds = new Set(boxes.map((b) => b.data.id));
		const imageIds = new Set(images.map((im) => im.data.id));
		// Containers and images both live in the Markdown, so removing either
		// owes the file a write. Deleting an image removes only the embed. The
		// attachment itself stays in the vault, which is the user's to manage.
		const touchesMarkdown = boxes.length > 0 || images.length > 0;

		const apply = () => {
			this.page.strokes = this.page.strokes.filter((s) => !strokeIds.has(s.id));
			for (const id of boxIds) {
				this.doc.removeBox(id);
				this.textLayer.remove(id);
			}
			for (const id of imageIds) {
				this.doc.removeImage(id);
				this.imageLayer.remove(id);
			}
			this.selection.clear();
			this.requestRender();
			this.redrawSelectionUI();
			if (touchesMarkdown) this.saveAll();
			else this.saveSpatial();
		};
		const invert = () => {
			// Reinsert at the original indices so paint order survives undo.
			for (const s of [...strokes].sort((a, b) => a.index - b.index)) {
				this.page.strokes.splice(Math.min(s.index, this.page.strokes.length), 0, s.stroke);
			}
			for (const b of [...boxes].sort((a, b2) => a.index - b2.index)) {
				this.doc.addBox(b.data, b.text, b.index);
				this.textLayer.upsert({ data: b.data, text: b.text });
			}
			for (const im of [...images].sort((a, b2) => a.index - b2.index)) {
				this.doc.addImage(im.data, im.target, im.index);
				this.imageLayer.upsert({ data: im.data, target: im.target });
			}
			this.requestRender();
			this.redrawSelectionUI();
			if (touchesMarkdown) this.saveAll();
			else this.saveSpatial();
		};

		apply();
		this.history.push({
			label: `Delete ${strokes.length + boxes.length + images.length} object(s)`,
			apply,
			invert,
		});
		this.updateStatus();
	}

	/**
	 * The lasso and the selection outline are stored in world coordinates and
	 * redrawn from them, so panning and zooming keeps them locked to what they
	 * describe.
	 */
	private redrawSelectionUI(): void {
		if (!this.tail) return;
		this.tail.clearAll(this.cssWidth, this.cssHeight);
		const cam = this.camera.snapshot;
		if (this.lassoActive && this.lassoPts.length > 1) {
			this.tail.drawLasso(cam, this.lassoPts, SELECTION_COLOR);
		}
		const bounds = this.selectionBounds();
		if (bounds) this.tail.drawSelectionBox(cam, bounds, SELECTION_COLOR);
	}

	// ---- toolbar / status ---------------------------------------------------

	private buildToolbar(): void {
		const toolbar = this.rootEl.createDiv({ cls: "handwriting-toolbar handwriting-ui" });
		this.zoomLabelEl = toolbar.createSpan({ cls: "handwriting-zoom-label", text: "100%" });

		const addTool = (label: string, isActive: () => boolean, apply: () => void) => {
			const btn = toolbar.createEl("button", { text: label });
			btn.addEventListener("click", () => {
				apply();
				this.refreshToolButtons();
			});
			this.toolButtons.push({ el: btn, active: isActive });
		};

		addTool("Pen", () => this.tool === "pen", () => {
			this.tool = "pen";
			this.clearSelection();
		});
		addTool("Highlight", () => this.tool === "highlighter", () => {
			this.tool = "highlighter";
			this.clearSelection();
		});
		addTool("Eraser", () => this.tool === "eraser", () => {
			this.tool = "eraser";
			this.clearSelection();
		});
		addTool("Lasso", () => this.tool === "lasso", () => {
			this.tool = "lasso";
			this.clearCaret();
		});

		const undoBtn = toolbar.createEl("button", { text: "Undo" });
		undoBtn.addEventListener("click", () => this.undo());
		const redoBtn = toolbar.createEl("button", { text: "Redo" });
		redoBtn.addEventListener("click", () => this.redo());
		const resetBtn = toolbar.createEl("button", { text: "Reset view" });
		resetBtn.addEventListener("click", () => this.camera.setState(0, 0, 1));

		this.refreshToolButtons();
	}

	private refreshToolButtons(): void {
		for (const { el, active } of this.toolButtons) el.toggleClass("is-active", active());
	}

	/** Set the active tool from a command, so it can carry a hotkey. */
	setTool(tool: Tool): void {
		this.tool = tool;
		if (tool === "lasso") this.clearCaret();
		else this.clearSelection();
		this.refreshToolButtons();
		this.updateStatus();
	}

	/** Applied live when the pen-lab verdict is toggled. */
	setSmoothing(on: boolean): void {
		this.wetInk.smooth = on;
		this.wetHighlight.smooth = on;
		this.redrawCommitted();
	}

	toggleDebug(): void {
		this.debug = !this.debug;
		this.statusEl.toggleClass("is-debug", this.debug);
		this.updateStatus();
	}

	togglePrediction(): boolean {
		this.predictionOn = !this.predictionOn;
		this.router && (this.router.wantPredicted = this.predictionOn);
		this.updateStatus();
		return this.predictionOn;
	}

	private updateStatus(): void {
		if (!this.statusEl) return;
		const selected = this.selection.size;
		const base =
			`${this.page.strokes.length} strokes  ${this.page.textBoxes.length} text  ` +
			`${this.page.images.length} img  ${this.tool}` +
			(selected > 0 ? `  •  ${selected} selected` : "");
		if (!this.debug) {
			this.statusEl.setText(base);
			return;
		}
		const last = this.metrics.summaries[this.metrics.summaries.length - 1];
		this.statusEl.setText(
			[
				base,
				`page ${this.pageId.slice(0, 8)}  undo ${this.history.depth}  pred ${this.predictionOn ? "on" : "off"}`,
				formatRaster(inspectRaster(this.committedCanvas), this.camera.zoom),
				telemetry.panelText(),
				last ? StrokeMetrics.summaryText(last) : "(no stroke yet)",
			].join("\n")
		);
	}

	// ---- rendering ----------------------------------------------------------

	private handleResize(): void {
		const rect = this.rootEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.dpr = (this.containerEl.ownerDocument.defaultView ?? window).devicePixelRatio || 1;

		// Backing store and CSS box are kept exactly `dpr` apart. Rounding the
		// backing store while leaving the CSS box fractional (the obvious
		// version) leaves the compositor resampling the whole canvas, which
		// reads as soft, stair-stepped ink once you zoom in.
		const size = computeCanvasSize(rect.width, rect.height, this.dpr);
		this.cssWidth = size.cssW;
		this.cssHeight = size.cssH;
		for (const c of [
			this.committedCanvas,
			this.wetCanvas,
			this.tailCanvas,
			this.highlightCanvas,
			this.wetHighlightCanvas,
		]) {
			c.width = size.backingW;
			c.height = size.backingH;
			c.setCssStyles({ width: `${size.cssW}px`, height: `${size.cssH}px` });
		}
		this.committedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.highlightCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.wetInk.applyDpr(this.dpr);
		this.wetHighlight.applyDpr(this.dpr);
		this.tail.applyDpr(this.dpr);
		this.router?.refreshRect();
		this.requestRender();
	}

	private requestRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		window.requestAnimationFrame(() => {
			this.renderQueued = false;
			// Electron changes devicePixelRatio on app zoom and on moving to a
			// different-DPI monitor. Without this the canvas keeps a stale
			// backing store and the compositor upscales it.
			if (((this.containerEl.ownerDocument.defaultView ?? window).devicePixelRatio || 1) !== this.dpr) {
				this.handleResize();
				return;
			}
			this.redrawCommitted();
		});
	}

	private redrawCommitted(): void {
		if (!this.committedCtx) return;
		const cam = this.camera.snapshot;
		this.updateGrid();
		drawCommitted(
			this.highlightCtx,
			cam,
			this.page.strokes,
			this.cssWidth,
			this.cssHeight,
			this.wetInk.smooth,
			"highlighter"
		);
		drawCommitted(
			this.committedCtx,
			cam,
			this.page.strokes,
			this.cssWidth,
			this.cssHeight,
			this.wetInk.smooth,
			"pen"
		);
		this.zoomLabelEl?.setText(`${Math.round(cam.zoom * 100)}%`);
		this.updateStatus();
	}

	private updateGrid(): void {
		const z = this.camera.zoom;
		const minorPx = MINOR_GRID_WORLD * z;
		const majorPx = MAJOR_GRID_WORLD * z;
		const ox = this.camera.x * z;
		const oy = this.camera.y * z;
		const mod = (a: number, n: number) => ((a % n) + n) % n;
		const minorColor = "rgba(128, 128, 128, 0.10)";
		const majorColor = "rgba(128, 128, 128, 0.22)";

		const layers = [
			`linear-gradient(to right, ${majorColor} 1px, transparent 1px)`,
			`linear-gradient(to bottom, ${majorColor} 1px, transparent 1px)`,
		];
		const sizes = [`${majorPx}px ${majorPx}px`, `${majorPx}px ${majorPx}px`];
		const positions = [`${-mod(ox, majorPx)}px 0px`, `0px ${-mod(oy, majorPx)}px`];
		if (minorPx >= 8) {
			layers.push(
				`linear-gradient(to right, ${minorColor} 1px, transparent 1px)`,
				`linear-gradient(to bottom, ${minorColor} 1px, transparent 1px)`
			);
			sizes.push(`${minorPx}px ${minorPx}px`, `${minorPx}px ${minorPx}px`);
			positions.push(`${-mod(ox, minorPx)}px 0px`, `0px ${-mod(oy, minorPx)}px`);
		}
		this.paperEl.setCssStyles({
			backgroundImage: layers.join(", "),
			backgroundSize: sizes.join(", "),
			backgroundPosition: positions.join(", "),
		});
	}

	// ---- camera persistence (§22: never in the page file) -------------------

	private scheduleCameraSave(): void {
		if (this.cameraTimer !== null) window.clearTimeout(this.cameraTimer);
		this.cameraTimer = window.setTimeout(() => {
			this.cameraTimer = null;
			this.saveCameraNow();
		}, CAMERA_SAVE_MS);
	}

	private saveCameraNow(): void {
		if (this.cameraTimer !== null) {
			window.clearTimeout(this.cameraTimer);
			this.cameraTimer = null;
		}
		// Only pages with a persisted identity get a camera entry. An unclaimed
		// note's id is a per-open random UUID. Saving under it leaked one dead
		// entry into data.json per view session and never restored anything.
		if (this.pageId && this.identitySaved) {
			this.host.setCamera(this.pageId, this.camera.snapshot);
		}
	}
}

function normalizePressure(p: number): number {
	if (!Number.isFinite(p) || p <= 0) return 0.5;
	return Math.min(1, p);
}

/** Natural pixel size of an image, for the initial placement. */
function measureImage(src: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const probe = new Image();
		probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
		probe.onerror = () => resolve({ width: 0, height: 0 });
		probe.src = src;
	});
}
