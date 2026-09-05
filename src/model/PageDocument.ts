import { InkStroke } from "../ink/Stroke";
import {
	MarkdownBlock,
	MarkdownImage,
	MD_VERSION,
	ParsedMarkdownPage,
	composeMarkdownPage,
	parseMarkdownPage,
	updateFrontmatter,
} from "./MarkdownPage";
import { ImageData, PageData, TextBoxData, emptyPage, newPageId } from "./PageData";
import { joinImages, joinPage } from "./PageJoin";

/**
 * The owner of a page's canonical content: the text of every container, the
 * geometry of every container, and the ink.
 *
 * This exists because text used to live in the DOM layer, which made the file
 * and the view two independent copies of the same thing with no reconciler
 * between them. An edit made elsewhere (another window, another machine over
 * sync) was only half-absorbed: text of *known* containers was refreshed,
 * but containers added externally were never adopted and were therefore dropped
 * from the next save, and containers deleted externally were resurrected.
 *
 * So: the DOM is a view of this, never the source. Everything that decides what
 * ends up in the `.md` is here, in one place, with no Obsidian and no DOM, so
 * it can be tested with bare strings.
 */

export interface DocBox {
	data: TextBoxData;
	text: string;
}

/**
 * The id given to the implicit container that holds an ordinary note's body.
 * It exists only in the sidecar; nothing is written into the Markdown for it.
 */
export const BODY_BOX_ID = "handwriting-body";

export interface DocImage {
	data: ImageData;
	/** Vault path of the attachment, as written in the Markdown embed. */
	target: string;
}

export interface ReconcileResult {
	/** Containers that appeared in the file and are now adopted. */
	added: DocBox[];
	/** Container ids that vanished from the file and have been dropped. */
	removed: string[];
	/** Containers whose text changed on disk. */
	changed: DocBox[];
	/** Images that appeared in the file. */
	addedImages: DocImage[];
	/** Image ids that vanished from the file. */
	removedImages: string[];
	/** Ids skipped because the user is mid-edit in them. */
	skipped: string[];
	frontmatterChanged: boolean;
	extraChanged: boolean;
	/** True when anything at all differed from what we hold. */
	get dirty(): boolean;
}

export class PageDocument {
	pageId = "";
	frontmatter: string[] = [];
	extra = "";
	/** Geometry + ink. Canonical, and what gets serialized to the sidecar. */
	page: PageData = emptyPage("");
	/** Canonical text per container id. The DOM mirrors this, never leads it. */
	private texts = new Map<string, string>();
	/**
	 * Attachment path per image id. Canonical source is the Markdown embed, so
	 * a rename done by Obsidian flows straight through to us.
	 */
	private imageTargets = new Map<string, string>();

	/** Set when the file on disk was written by a newer Handwriting than this one. */
	spatialFutureVersion: number | undefined;
	/** The sidecar was unreadable: never write spatial state for this page. */
	spatialDamaged = false;
	markdownFutureVersion: number | undefined;

	/**
	 * True while this note is still an ordinary Markdown file, with no Handwriting
	 * block markers anywhere. Its whole body shows as one container at the origin, and
	 * the Markdown is left exactly as the user wrote it. Markers only appear
	 * when something actually needs an anchor (a second container, or an image).
	 */
	bodyMode = false;
	/**
	 * True when this note was born marker-less. Only such a note may RETURN to
	 * body form when it is back to nothing but its body. A real v0.7 marker
	 * note must never flip formats (see dematerialize).
	 */
	private bodyOrigin = false;
	/** The file exactly as it was on disk, so an untouched page round-trips byte for byte. */
	private rawMd = "";
	/** The body exactly as it was on disk, so an ink-only session cannot reflow it. */
	private rawBody = "";
	/**
	 * The file's own line ending (MarkdownPage.ts's `ParsedMarkdownPage.eol`,
	 * 5i I5). `rawBody` is reassembled with it now instead of always `\n`, so
	 * the bodyMode branch of compose() below has to rejoin with the same
	 * ending or a CRLF note's untouched body (still CRLF from rawBody) would
	 * get a stray LF stitched in front of it by this file's own hardcoded
	 * separator - not something I5's briefed file list (MarkdownPage.ts,
	 * InlineClaim.ts) mentioned, but a direct consequence of changing what
	 * `rawBody` is joined with. Defaults to `\n`, matching every existing
	 * caller before this field could be populated from a parse.
	 */
	private eol: "\r\n" | "\n" = "\n";
	private bodyEdited = false;
	/** The user moved something, so an arrangement now exists worth a sidecar. */
	private geometryEdited = false;
	/** Suppresses mode transitions while mirroring an external file (reconcile). */
	private inReconcile = false;
	/**
	 * False until something the user did actually changes the Markdown. Ink,
	 * erasing and moving ink never do. That is what lets Handwriting open any note
	 * without touching it.
	 */
	markdownDirty = false;
	/**
	 * True once the note carries a `handwriting-page-id`. The id is not a document
	 * class and does not force any view; it is only how the sidecar survives a
	 * rename. So it is written when the page first acquires spatial state, and
	 * never merely because the note was looked at.
	 */
	identityClaimed = false;

	// ---- loading ------------------------------------------------------------

	/**
	 * Take the markdown half. Returns the parse so the caller can decide about
	 * page ids before the sidecar arrives.
	 */
	loadMarkdown(md: string): ParsedMarkdownPage & { generatedId: boolean } {
		const parsed = parseMarkdownPage(md);
		let generatedId = false;
		let pageId = parsed.pageId;
		if (!pageId) {
			pageId = newPageId();
			generatedId = true;
		}
		this.pageId = pageId;
		this.frontmatter = parsed.frontmatter;
		this.extra = parsed.extra;
		this.rawMd = md;
		this.rawBody = parsed.rawBody;
		this.eol = parsed.eol;
		this.bodyEdited = false;
		this.geometryEdited = false;
		this.markdownDirty = false;
		this.identityClaimed = !generatedId;
		// An ordinary note: no markers of ours anywhere. Show it as one
		// container rather than a blank canvas, and leave the file alone.
		this.bodyMode = parsed.blocks.length === 0 && parsed.images.length === 0;
		this.bodyOrigin = this.bodyMode;
		this.markdownFutureVersion =
			parsed.version !== undefined && parsed.version > MD_VERSION ? parsed.version : undefined;
		return { ...parsed, pageId, generatedId };
	}

	/**
	 * Parse without mutating. Used to ask "is this still the same page?" before
	 * deciding between reconciling and reopening.
	 */
	loadMarkdownPreview(md: string): ParsedMarkdownPage {
		return parseMarkdownPage(md);
	}

	/**
	 * Take the spatial half and join it to the text. Text without geometry keeps
	 * the text and invents a position; geometry without text is dropped. The
	 * asymmetry is the point: a lost sidecar costs layout, never words.
	 */
	applySidecar(
		sidecar: PageData | undefined,
		blocks: readonly MarkdownBlock[],
		embeds: readonly MarkdownImage[],
		defaultWidth: number
	): {
		boxes: DocBox[];
		images: DocImage[];
		orphanedText: number;
		droppedGeometry: number;
	} {
		this.page = sidecar ?? emptyPage(this.pageId);
		this.page.pageId = this.pageId;

		const effectiveBlocks = this.bodyMode
			? [{ id: BODY_BOX_ID, text: this.rawBody.trim() }]
			: blocks;
		const joined = joinPage(effectiveBlocks, this.page.textBoxes, { defaultWidth });
		this.page.textBoxes = joined.boxes.map((b) => b.data);
		this.texts.clear();
		for (const b of joined.boxes) this.texts.set(b.data.id, b.text);
		// The body container's text came from the body, not from `extra`.
		if (this.bodyMode) this.extra = "";

		const joinedImages = joinImages(embeds, this.page.images, { defaultWidth });
		this.page.images = joinedImages.images.map((im) => im.data);
		this.imageTargets.clear();
		for (const im of joinedImages.images) this.imageTargets.set(im.data.id, im.target);

		return {
			boxes: joined.boxes,
			images: joinedImages.images,
			orphanedText: joined.orphanedText,
			droppedGeometry: joined.droppedGeometry + joinedImages.droppedGeometry,
		};
	}

	// ---- accessors ----------------------------------------------------------

	get strokes(): InkStroke[] {
		return this.page.strokes;
	}

	get boxes(): DocBox[] {
		return this.page.textBoxes.map((data) => ({
			data,
			text: this.texts.get(data.id) ?? "",
		}));
	}

	textOf(id: string): string {
		return this.texts.get(id) ?? "";
	}

	get images(): DocImage[] {
		return this.page.images.map((data) => ({
			data,
			target: this.imageTargets.get(data.id) ?? "",
		}));
	}

	targetOf(id: string): string {
		return this.imageTargets.get(id) ?? "";
	}

	hasImage(id: string): boolean {
		return this.page.images.some((im) => im.id === id);
	}

	indexOfImage(id: string): number {
		return this.page.images.findIndex((im) => im.id === id);
	}

	imageData(id: string): ImageData | undefined {
		return this.page.images.find((im) => im.id === id);
	}

	addImage(data: ImageData, target: string, index?: number): void {
		this.markdownDirty = true;
		if (index === undefined || index >= this.page.images.length) {
			this.page.images.push(data);
		} else {
			this.page.images.splice(Math.max(0, index), 0, data);
		}
		this.imageTargets.set(data.id, target);
		// An image always needs its own anchor, so this materialises.
		this.syncMode();
	}

	removeImage(id: string): { data: ImageData; target: string; index: number } | undefined {
		const index = this.page.images.findIndex((im) => im.id === id);
		if (index < 0) return undefined;
		this.markdownDirty = true;
		const data = this.page.images[index]!;
		const target = this.imageTargets.get(id) ?? "";
		this.page.images.splice(index, 1);
		this.imageTargets.delete(id);
		this.syncMode();
		return { data, target, index };
	}

	hasBox(id: string): boolean {
		return this.page.textBoxes.some((b) => b.id === id);
	}

	/** Position in paint order, or -1. Undo restores boxes at their index. */
	indexOfBox(id: string): number {
		return this.page.textBoxes.findIndex((b) => b.id === id);
	}

	boxData(id: string): TextBoxData | undefined {
		return this.page.textBoxes.find((b) => b.id === id);
	}

	/** Read-only when the file came from a newer Handwriting than this build. */
	get spatialWritable(): boolean {
		return this.spatialFutureVersion === undefined && !this.spatialDamaged;
	}

	get markdownWritable(): boolean {
		return this.markdownFutureVersion === undefined;
	}

	// ---- mutation -----------------------------------------------------------

	setText(id: string, text: string): void {
		if (!this.hasBox(id)) return;
		if (this.texts.get(id) === text) return;
		this.texts.set(id, text);
		if (this.bodyMode && id === BODY_BOX_ID) this.bodyEdited = true;
		this.markdownDirty = true;
		// A transient box that just gained real words now needs an anchor.
		this.syncMode();
	}

	/** The user moved something: arrangement now exists worth persisting. */
	noteGeometryEdited(): void {
		this.geometryEdited = true;
	}

	/**
	 * True when there is anything the sidecar should hold. Until this is true,
	 * the page must not claim an identity or write a sidecar. A housekeeping
	 * save on a note the user merely touched has nothing to persist.
	 */
	get hasSpatialState(): boolean {
		if (!this.bodyMode) return true; // markers exist: geometry is meaningful
		return (
			this.page.strokes.length > 0 ||
			this.page.images.length > 0 ||
			this.geometryEdited
		);
	}

	/**
	 * Absence of a page id is never evidence that the document changed. An
	 * unclaimed note is identified by the file loaded in the view; treating
	 * `undefined !== <our random id>` as "different note" made every external
	 * edit reload the page and wipe live ink and undo (audit v0.8.0 #1).
	 */
	isSameDocument(pageId: string | undefined): boolean {
		return pageId === undefined || pageId === this.pageId;
	}

	/**
	 * Keep the representation honest after every mutation: markers exist only
	 * while something actually needs an anchor, and a note born marker-less
	 * returns to body form when it is back to nothing but its body. This is
	 * what makes materialisation reversible: undoing the box that caused it
	 * undoes the format change too.
	 */
	private syncMode(): void {
		if (this.inReconcile) return;
		if (this.bodyMode) {
			const needsMarkers =
				this.page.images.length > 0 ||
				this.page.textBoxes.some(
					(b) =>
						b.id !== BODY_BOX_ID &&
						(this.texts.get(b.id) ?? "").trim().length > 0
				);
			if (needsMarkers) this.materialize();
		} else {
			this.dematerialize();
		}
	}

	/**
	 * Leave body mode: from here the file carries block markers.
	 *
	 * Reached only when something genuinely needs an anchor of its own: a
	 * container with real text, or an image. An EMPTY extra box never gets
	 * here: a stray finger tap creates one and blur deletes it, and neither
	 * event may restructure the user's Markdown.
	 */
	private materialize(): void {
		if (!this.bodyMode) return;
		this.bodyMode = false;
		this.bodyEdited = false;
		this.markdownDirty = true;
		// Deliberately NOT identityClaimed = true. Claiming is the sidecar's
		// concern (scheduleSidecar claims before it writes); keeping the flags
		// separate means undoing a materialisation that never needed a sidecar
		// composes the original bytes back, id and all.
	}

	/** Return to body form once a marker-born-marker-less note is body-only again. */
	private dematerialize(): void {
		if (this.bodyMode || !this.bodyOrigin) return;
		if (this.page.images.length > 0) return;
		const boxes = this.page.textBoxes;
		if (boxes.length > 1) return;
		if (boxes.length === 1 && boxes[0]!.id !== BODY_BOX_ID) return;
		const currentBody = boxes.length === 1 ? this.texts.get(BODY_BOX_ID) ?? "" : "";
		this.bodyMode = true;
		this.bodyEdited = currentBody !== this.rawBody.trim();
		this.markdownDirty = true;
	}

	addBox(data: TextBoxData, text: string, index?: number): void {
		if (index === undefined || index >= this.page.textBoxes.length) {
			this.page.textBoxes.push(data);
		} else {
			this.page.textBoxes.splice(Math.max(0, index), 0, data);
		}
		this.texts.set(data.id, text);
		if (this.bodyMode && data.id === BODY_BOX_ID) {
			// Restoring the implicit body container (undo of a body delete).
			this.bodyEdited = text !== this.rawBody.trim();
			this.markdownDirty = true;
			return;
		}
		// In body mode an empty extra box is ephemeral: not in the file, so
		// not dirty. syncMode materialises the moment it carries real text.
		if (!this.bodyMode) this.markdownDirty = true;
		this.syncMode();
	}

	removeBox(id: string): { data: TextBoxData; text: string; index: number } | undefined {
		const index = this.page.textBoxes.findIndex((b) => b.id === id);
		if (index < 0) return undefined;
		const data = this.page.textBoxes[index]!;
		const text = this.texts.get(id) ?? "";
		this.page.textBoxes.splice(index, 1);
		this.texts.delete(id);
		if (this.bodyMode && id === BODY_BOX_ID) {
			// Deleting the body container is a REAL edit: the body empties in
			// the Markdown too. Anything else lies to the user: the canvas
			// showed it gone while the file kept it (audit v0.8.0 #5).
			const hadText = text.length > 0 || this.rawBody.trim().length > 0;
			if (hadText) {
				this.bodyEdited = true;
				this.markdownDirty = true;
			}
			return { data, text, index };
		}
		if (!this.bodyMode) this.markdownDirty = true;
		this.syncMode();
		return { data, text, index };
	}

	// ---- markdown -----------------------------------------------------------

	/**
	 * Stamp the identity Handwriting needs, without restructuring anything. Called the
	 * first time a page acquires spatial data, because the sidecar is keyed by
	 * this id and a rename must not orphan the ink.
	 */
	claimIdentity(): void {
		if (this.identityClaimed) return;
		this.identityClaimed = true;
		this.markdownDirty = true;
	}

	compose(): string {
		if (this.bodyMode) {
			// Nothing we do has changed the words or the identity, so the file we
			// hand back is the file we were given, the same bytes, not a
			// re-rendering of them. Opening a note must never rewrite it.
			if (!this.bodyEdited && !this.identityClaimed) return this.rawMd;
			// Still an ordinary note: no block markers, no `handwriting:` marker. The
			// id appears only once there is spatial state for it to key, and a
			// note with no frontmatter does not get an empty fence bolted on
			// just because someone retyped a line.
			const body = this.bodyEdited ? this.texts.get(BODY_BOX_ID) ?? "" : this.rawBody;
			const fm = this.identityClaimed
				? updateFrontmatter(this.frontmatter, this.pageId, { version: false })
				: this.frontmatter;
			if (fm.length === 0) return body.replace(/^\r?\n/, "");
			const eol = this.eol;
			// The closing fence already ends with `eol` - the body follows
			// directly. A body that itself starts with `eol` (the user's own
			// blank line) keeps it; nothing extra is manufactured on top (same
			// defect, same fix, as InlineClaim.ts's claimMarkdown/reassignMarkdown).
			return `---${eol}${fm.join(eol)}${eol}---${eol}${body}`;
		}
		return composeMarkdownPage({
			pageId: this.pageId,
			frontmatter: this.frontmatter,
			blocks: this.page.textBoxes.map((b) => ({
				id: b.id,
				text: this.texts.get(b.id) ?? "",
			})),
			images: this.page.images.map((im) => ({
				id: im.id,
				target: this.imageTargets.get(im.id) ?? "",
			})),
			extra: this.extra,
		});
	}

	/**
	 * Absorb a version of the file that someone else wrote.
	 *
	 * Every difference is applied. Added containers are adopted with invented
	 * geometry, removed ones are dropped, changed text is taken, frontmatter and
	 * loose body content are taken verbatim. The one exception is a container
	 * the user is actively typing in: its text is left alone (they are mid-word
	 * and the file is behind them), while everything else still reconciles.
	 *
	 * Nothing here touches undo history: an external edit is not the user's
	 * operation to undo.
	 */
	reconcile(
		md: string,
		opts: { editingId?: string | null; defaultWidth: number }
	): ReconcileResult {
		const parsed = parseMarkdownPage(md);
		const added: DocBox[] = [];
		const removed: string[] = [];
		const changed: DocBox[] = [];
		const skipped: string[] = [];
		const addedImages: DocImage[] = [];
		const removedImages: string[] = [];
		let editingId = opts.editingId ?? null;

		if (this.bodyMode) {
			if (parsed.blocks.length === 0 && parsed.images.length === 0) {
				// Still an ordinary note on both sides: the whole body is one
				// container, so an external edit is one text change. Taking the
				// raw body back is what stops a later save resurrecting the
				// version we opened with.
				return this.reconcileBody(md, parsed, editingId);
			}
			// Someone else gave the file real markers (another window, a sync).
			// Fall through: the body container is not in the file any more, so
			// the normal rules drop it and adopt what the file now says. The
			// mid-edit exemption cannot apply to it, because keeping it would
			// write the body a second time next to the blocks that now contain it.
			if (editingId === BODY_BOX_ID) editingId = null;
			this.bodyMode = false;
			this.bodyEdited = false;
		}
		// Mirroring the file: mode is decided by what the file says, not by
		// the transient states these mutations pass through.
		this.inReconcile = true;
		try {

		const incoming = new Map<string, string>();
		for (const b of parsed.blocks) incoming.set(b.id, b.text);

		// Gone from the file → gone from the page (geometry included).
		for (const existing of [...this.page.textBoxes]) {
			if (!incoming.has(existing.id)) {
				if (existing.id === editingId) {
					skipped.push(existing.id);
					continue;
				}
				this.removeBox(existing.id);
				removed.push(existing.id);
			}
		}

		// New in the file → adopt, inventing a position the same way a missing
		// sidecar does.
		const unknownBlocks = parsed.blocks.filter((b) => !this.hasBox(b.id));
		if (unknownBlocks.length > 0) {
			const placed = joinPage(unknownBlocks, [], {
				defaultWidth: opts.defaultWidth,
				fallbackY: this.nextFreeY(),
			});
			for (const box of placed.boxes) {
				this.addBox(box.data, box.text);
				added.push(box);
			}
		}

		// Text differences on containers we already had.
		for (const data of this.page.textBoxes) {
			const next = incoming.get(data.id);
			if (next === undefined) continue;
			if (added.some((a) => a.data.id === data.id)) continue;
			if (this.texts.get(data.id) === next) continue;
			if (data.id === editingId) {
				skipped.push(data.id);
				continue;
			}
			this.texts.set(data.id, next);
			changed.push({ data, text: next });
		}

		// Images reconcile on the same rule as text: the file decides which
		// exist, we keep the arrangement of the ones that survive.
		const incomingImages = new Map<string, string>();
		for (const im of parsed.images) incomingImages.set(im.id, im.target);

		for (const existing of [...this.page.images]) {
			if (!incomingImages.has(existing.id)) {
				this.removeImage(existing.id);
				removedImages.push(existing.id);
			}
		}
		const newEmbeds = parsed.images.filter((im) => !this.hasImage(im.id));
		if (newEmbeds.length > 0) {
			const placed = joinImages(newEmbeds, [], {
				defaultWidth: opts.defaultWidth,
				fallbackY: this.nextFreeY(),
			});
			for (const im of placed.images) {
				this.addImage(im.data, im.target);
				addedImages.push(im);
			}
		}
		// An attachment renamed by Obsidian rewrites the embed, not the id.
		for (const im of parsed.images) {
			const target = incomingImages.get(im.id);
			if (target && this.imageTargets.get(im.id) !== target) {
				this.imageTargets.set(im.id, target);
			}
		}

		const frontmatterChanged =
			parsed.frontmatter.join("\n") !== this.frontmatter.join("\n");
		const extraChanged = parsed.extra !== this.extra;
		this.frontmatter = parsed.frontmatter;
		this.extra = parsed.extra;
		if (parsed.pageId) {
			this.pageId = parsed.pageId;
			this.identityClaimed = true;
		}

		return {
			added,
			removed,
			changed,
			skipped,
			addedImages,
			removedImages,
			frontmatterChanged,
			extraChanged,
			get dirty() {
				return (
					added.length > 0 ||
					removed.length > 0 ||
					changed.length > 0 ||
					addedImages.length > 0 ||
					removedImages.length > 0 ||
					frontmatterChanged ||
					extraChanged
				);
			},
		};
		} finally {
			this.inReconcile = false;
		}
	}

	/**
	 * Reconcile an ordinary note that is still ordinary: one implicit container
	 * holding the body, so the only things that can differ are the body text and
	 * the frontmatter.
	 */
	private reconcileBody(
		md: string,
		parsed: ParsedMarkdownPage,
		editingId: string | null
	): ReconcileResult {
		const changed: DocBox[] = [];
		const skipped: string[] = [];
		const nextBody = parsed.rawBody;
		this.eol = parsed.eol;
		const editing = editingId === BODY_BOX_ID;
		const textChanged = nextBody.trim() !== (this.texts.get(BODY_BOX_ID) ?? "");

		if (textChanged && editing) {
			skipped.push(BODY_BOX_ID);
		} else if (textChanged) {
			this.texts.set(BODY_BOX_ID, nextBody.trim());
			this.rawBody = nextBody;
			this.rawMd = md;
			this.bodyEdited = false;
			const data = this.page.textBoxes.find((b) => b.id === BODY_BOX_ID);
			if (data) changed.push({ data, text: nextBody.trim() });
		} else {
			this.rawMd = md;
			this.rawBody = nextBody;
		}

		const frontmatterChanged = parsed.frontmatter.join("\n") !== this.frontmatter.join("\n");
		this.frontmatter = parsed.frontmatter;
		if (parsed.pageId) {
			this.pageId = parsed.pageId;
			this.identityClaimed = true;
		}

		return {
			added: [],
			removed: [],
			changed,
			skipped,
			addedImages: [],
			removedImages: [],
			frontmatterChanged,
			extraChanged: false,
			get dirty() {
				return changed.length > 0 || frontmatterChanged;
			},
		};
	}

	/** Somewhere below everything already placed, so adopted text is visible. */
	private nextFreeY(): number {
		let maxY = 0;
		let any = false;
		for (const b of this.page.textBoxes) {
			maxY = Math.max(maxY, b.y);
			any = true;
		}
		for (const im of this.page.images) {
			maxY = Math.max(maxY, im.y + im.height);
			any = true;
		}
		return any ? maxY + 140 : 40;
	}
}

// There is deliberately NO second "where does the body start" function here.
// The parse in MarkdownPage.ts is the single answer (its rawBody field); a
// duplicate implementation disagreed on malformed fences and corrupted notes
// the moment the page id was first written (audit v0.8.0 #3).

/**
 * Why a pen contact cannot become ink right now, or null if it can.
 *
 * The three states in which a sidecar write is refused: the sidecar has not
 * loaded yet, a newer Handwriting wrote the file, or the file could not be
 * read at all. Every caller that persists ink already checks these; the pen
 * paths did not, so a stroke was accepted, drawn, committed to the in-memory
 * page and then never written - it looked like it worked and was gone on
 * reload, with nothing said.
 *
 * Pure and out here rather than a method on the view, because the view is
 * DOM-bound and cannot be built in a test, and this rule is the kind that
 * gets quietly widened later.
 */
export function inkRefusal(state: {
	loaded: boolean;
	spatialFutureVersion: number | undefined;
	spatialDamaged: boolean;
}): string | null {
	if (!state.loaded) {
		return "Handwriting: this page's saved ink is still loading. Try again in a moment.";
	}
	// Order matters: a page can be both, and "a newer version wrote this" is
	// the more useful thing to hear - it names something the user can act on.
	if (state.spatialFutureVersion !== undefined) {
		return "Handwriting: this page is read-only because a newer version of Handwriting wrote it. New ink could not be saved.";
	}
	if (state.spatialDamaged) {
		return "Handwriting: this page's saved ink cannot be read, so new ink cannot be saved either. The existing file has not been touched.";
	}
	return null;
}
