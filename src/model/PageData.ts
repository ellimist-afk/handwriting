import { InkPoint, InkStroke, InkTool, computeBBox } from "../ink/Stroke";

/**
 * The spatial half of a Handwriting page (handoff §4, §19, §70).
 *
 * Text lives in the Markdown file; coordinates and ink live here. The camera
 * is deliberately NOT part of this data (§22): panning must never dirty a
 * synced file. It is kept in plugin-local settings keyed by page id.
 *
 * Every persisted sidecar carries `schemaVersion`, and `migratePageData` exists
 * from version 1 onwards so there is never a moment where migration has to be
 * retrofitted.
 */

export const SCHEMA_VERSION = 1;

/**
 * Highest schema this build can READ. Writes stay at SCHEMA_VERSION until
 * the fleet can read v2 (two-phase rollout: every device gets the reader
 * releases before any device writes the format, or a synced v2 sidecar
 * future-locks the note on the laggard). Flipping writes later is one
 * constant, and serializePage already takes the version.
 *
 * v2 packs stroke points as integer deltas (x/y x100, pressure x1000,
 * t in ms): same quantization v1's rounding already applied, roughly half
 * the bytes of v1's absolute decimals - which matters exactly where the
 * sidecar travels, the live-reload sync path.
 */
export const READ_SCHEMA_VERSION = 2;

/**
 * Bound on any stored coordinate, in note-surface units.
 *
 * Finiteness was the only check a coordinate faced, and finite is not the
 * same as survivable. The spatial index buckets a stroke by the AREA its
 * bbox covers in 256-unit cells, so one point at 1e6 asks it to walk about
 * sixteen million cells: the note freezes with no error and no console
 * output, and larger values never finish (reproduced 2026-09-01). The same
 * numbers flow into canvas transforms and the exporters.
 *
 * A page is a few thousand units tall, so 1e7 is four orders above anything
 * a device can produce and still small enough to bucket instantly. Points
 * outside it are dropped as unreadable rather than clamped: a clamped point
 * is a silent lie about where the pen went, and a sidecar carrying one is
 * damaged, not merely large.
 */
export const MAX_COORD = 1e7;

/**
 * Bound on a stroke's base width. It is padding on the bbox
 * (`computeBBox(points, width * 2)`), so a hostile width explodes the same
 * bucket walk MAX_COORD closes even when every point is sane.
 */
export const MAX_WIDTH = 1e3;

export interface TextBoxData {
	id: string;
	/** World coordinates (§5). */
	x: number;
	y: number;
	width: number;
	/** Paint order among DOM objects. */
	z: number;
}

/**
 * Where an image sits. Note what is NOT here: the attachment path. That lives
 * in the Markdown as a normal `![[embed]]`, so Obsidian counts the attachment
 * as used, updates the link when the file is renamed, and still shows the
 * picture if Handwriting is uninstalled. The sidecar owns arrangement only, exactly
 * the rule text already follows.
 */
export interface ImageData {
	id: string;
	x: number;
	y: number;
	/** World units. Aspect is baked in at drop time; there is no crop. */
	width: number;
	height: number;
	z: number;
}

export interface PageData {
	schemaVersion: number;
	pageId: string;
	/**
	 * Which coordinate world the geometry lives in. `"inline"` = note-surface
	 * coordinates over the ordinary Markdown editor (origin at the content
	 * column's top-left). Absent = a legacy canvas page (free world space).
	 * The two must never be confused: the inline layer refuses to render or
	 * overwrite a canvas sidecar, and vice-versa nothing reinterprets legacy
	 * geometry until it is deliberately migrated.
	 */
	surface?: "inline" | "pdf" | "slides";
	/**
	 * Which coordinate convention the geometry is written in, for surfaces
	 * where that could ever change. `"page-css@1"` = page-local css px at
	 * scale 1.0, top-left origin of the page div.
	 *
	 * Written so a future migration is VERSIONED rather than guessed. If a
	 * later build needs PDF user units (rotation support is the likely
	 * reason), it can tell which convention a file was written in instead of
	 * inferring it from the numbers - and inferring it from the numbers is
	 * not possible, because both conventions produce plausible coordinates.
	 */
	coordSpace?: string;
	/**
	 * PDF sidecars only: the vault paths this sidecar believes it belongs
	 * to. Stored IN the sidecar so replicas agree by sync rather than
	 * coordination - this is what lets two byte-identical PDFs be different
	 * INSTANCES of one content family (a fresh copy starts blank) while a
	 * renamed file keeps its ink. Absent = pre-instance data, adopted by
	 * the first opener. See PdfIdentity.chooseInstance.
	 */
	pdfPaths?: string[];
	/**
	 * Slides sidecars only: the LOGICAL deck size the ink was drawn against
	 * (Reveal's `.slides` client box, 960x700 by default).
	 *
	 * Stored because the geometry is meaningless without it. A theme that
	 * declares a different deck size, or a future Reveal default, would
	 * otherwise reinterpret every stored coordinate silently; with the size
	 * on the file a later build can tell "these numbers were written against
	 * a 960x700 deck" apart from "these numbers are wrong".
	 */
	deck?: { width: number; height: number };
	/**
	 * Slides sidecars only: which slide each `page` index meant when the ink
	 * was written, by a hash of that section's source text.
	 *
	 * The index alone is not an identity - inserting one `---` above the
	 * first slide shifts every later index by one - so the hash is what lets
	 * a load re-attach stored ink to the section it was drawn on. Never used
	 * to DELETE ink: a section whose hash no longer matches anything keeps
	 * its index (see SlidesInkSurface.remapSlides).
	 */
	slides?: { index: number; hash: string }[];
	/**
	 * The editor font size in px that every stored coordinate on this note was
	 * drawn against (audit 46). Ink is stored in the frame of the size the note
	 * was first inked at; without this a reopen at another size latches the new
	 * size and reads all existing ink in the wrong frame. Written once and never
	 * changed. Absent on every note that predates it, and on any note that has
	 * not been saved since its reference was known. Additive: an older build
	 * keeps it as an unknown top-level field, so the schema version stays.
	 */
	fontRefPx?: number;
	textBoxes: TextBoxData[];
	images: ImageData[];
	strokes: InkStroke[];
	/**
	 * Fields written by a different (probably newer) Handwriting that this version
	 * does not understand, preserved verbatim so a round-trip never destroys
	 * them. Without this, an older plugin silently deletes a newer plugin's
	 * data the first time it saves, and in a synced vault both versions are
	 * live at once.
	 */
	unknownTop: Record<string, unknown>;
	/** Same, per stroke id and per text-box id. */
	unknownByObject: Record<string, Record<string, unknown>>;
}

export interface ParseResult {
	data: PageData;
	/** True when the sidecar existed but could not be understood. */
	recovered: boolean;
	/**
	 * WHICH recovery this was: the ink came back out of the ink TRASH.
	 *
	 * `recovered` carries four different events and its readers could not tell
	 * them apart, so a page restored from the trash was announced to the user
	 * as an interrupted save - a different event with a different cause.
	 *
	 * THE TWO EVENTS CANNOT SHARE A MESSAGE, which is what forces this field.
	 * Alan ruled the restore's own sentence on 2026-09-09 ("Handwriting
	 * restored the ink on ... from trash"), and that sentence is FALSE for the
	 * corrupt-file promotion exactly as "from an interrupted save" was false
	 * for the restore. One flag cannot carry both.
	 *
	 * Set ONLY on the ink-trash paths. The store already knew which event had
	 * happened and recorded it in `problem`, which is prose written for a human
	 * and cannot be branched on; this is that same fact as a shape.
	 */
	fromInkTrash?: boolean;
	/**
	 * True when the persisted payload did not come back whole. Two shapes,
	 * and callers must fail closed for both - render nothing new over it and
	 * above all REFUSE to persist for this page, or what we did decode
	 * overwrites whatever the file actually held:
	 *
	 * - UNREADABLE (JSON parse failure or I/O failure): `data` is a
	 *   placeholder, not the user's ink.
	 * - PARTLY DECODABLE: the JSON parsed, but strokes or samples inside it
	 *   did not survive validation (`problem` says how many of each). `data`
	 *   then holds the readable REMNANT - real ink, just not all of it - so
	 *   a caller that wants to show what survived can, and a caller that
	 *   writes would destroy the rest.
	 *
	 * Distinct from `recovered`, which also covers the benign
	 * tmp-file-after-interrupted-write path where the parse SUCCEEDED.
	 */
	damaged?: boolean;
	problem?: string;
	/**
	 * Set with `damaged`: the vault path the store actually read and could not use, the live sidecar in the
	 * configured folder or a leftover <id>.json.tmp. The damaged-ink notice names this file.
	 */
	damagedPath?: string;
	/**
	 * Set when the main file was corrupt, its own complete .tmp was promoted
	 * in its place, and the corrupt bytes were kept at this path.
	 */
	damagedKeptAs?: string;
	/**
	 * Set when the file declares a schema newer than this build. The caller
	 * must treat the page as read-only: we can render what we recognise, but
	 * writing would drop whatever the newer version added.
	 */
	futureVersion?: number;
}

export function newId(prefix: string): string {
	try {
		return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
	} catch {
		return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

export function newPageId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}

/**
 * Every character a page id may contain, and the only shape one may have.
 *
 * A page id is not a label: it is interpolated straight into a vault path
 * (`PageStore.path`, and the tmp, trash, damaged and conflict names beside
 * it). The id arrives from a note's `handwriting-page-id` frontmatter or
 * from a sidecar's own `pageId` field, and both are user-editable text that
 * sync hands us from other machines. A note carrying
 * `handwriting-page-id: ../../x` read, and on the first stroke wrote, a
 * `.json` outside the ink folder entirely.
 *
 * No separator, no leading dot, and a length a filesystem will take. Every
 * id this plugin has ever minted passes: `crypto.randomUUID`,
 * `page-<digits>-<base36>`, and the pdf `pdf-<hex>` / `pdf-<hex>-<n>`
 * instance names.
 */
const SAFE_PAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Whether `id` may be interpolated into a sidecar path. See SAFE_PAGE_ID.
 *
 * The `..` test is redundant against the pattern above - a separator cannot
 * survive it - and is kept anyway, because the pattern is the kind of line
 * that gets widened later by someone adding one more allowed character.
 */
export function isSafePageId(id: unknown): id is string {
	return typeof id === "string" && SAFE_PAGE_ID.test(id) && !id.includes("..");
}

export function emptyPage(pageId: string): PageData {
	return {
		schemaVersion: SCHEMA_VERSION,
		pageId,
		textBoxes: [],
		images: [],
		strokes: [],
		// Object.create(null): these are keyed by ids the sidecar controls, and
		// a plain {} treats a key of literally "__proto__" as an assignment to
		// its own prototype rather than a data property. Object.keys and
		// JSON.stringify treat a null-prototype object exactly like a plain
		// one; only prototype-chain lookups (nothing here relies on any) would
		// differ. K1, audit-fixes-design.md 5k.
		unknownTop: Object.create(null) as Record<string, unknown>,
		unknownByObject: Object.create(null) as Record<string, Record<string, unknown>>,
	};
}

const KNOWN_TOP = new Set([
	"schemaVersion",
	"pageId",
	"surface",
	"coordSpace",
	"pdfPaths",
	"deck",
	"slides",
	"fontRefPx",
	"textBoxes",
	"images",
	"strokes",
]);
const KNOWN_BOX = new Set(["id", "x", "y", "width", "z"]);
const KNOWN_IMAGE = new Set(["id", "x", "y", "width", "height", "z"]);
const KNOWN_STROKE = new Set(["id", "tool", "color", "width", "createdAt", "device", "widthMode", "pts",
	"ptsd", "points", "page", "pressureProfile"]);

/** Everything in `raw` that is not a key we claim to own. */
function unknownKeys(raw: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!known.has(k)) out[k] = v;
	}
	return out;
}

/** Merge preserved unknown fields back in, without letting them shadow ours. */
function withUnknown(
	base: Record<string, unknown>,
	unknown: Record<string, unknown> | undefined
): Record<string, unknown> {
	if (!unknown || Object.keys(unknown).length === 0) return base;
	return { ...unknown, ...base };
}

// ---- serialization ------------------------------------------------------

/**
 * Points are packed as a flat number array [x, y, pressure, t, ...]. Handwriting
 * produces thousands of samples per page; one object per point would triple the
 * file size and the parse cost for no benefit. Coordinates keep 2 decimals
 * (sub-pixel at zoom 1), pressure 3.
 */
function packPoints(points: InkPoint[]): number[] {
	const out: number[] = [];
	for (const p of points) {
		out.push(round(p.x, 2), round(p.y, 2), round(p.pressure, 3), Math.round(p.t));
	}
	return out;
}

/** v2: integer deltas. First point absolute (scaled), the rest deltas. */
export function packPointsV2(points: InkPoint[]): number[] {
	const out: number[] = [];
	let px = 0;
	let py = 0;
	let pp = 0;
	let pt = 0;
	for (const p of points) {
		const x = Math.round(p.x * 100);
		const y = Math.round(p.y * 100);
		const pr = Math.round(p.pressure * 1000);
		const t = Math.round(p.t);
		out.push(x - px, y - py, pr - pp, t - pt);
		px = x;
		py = y;
		pp = pr;
		pt = t;
	}
	return out;
}

export function unpackPointsV2(flat: unknown, loss?: PointLoss): InkPoint[] {
	if (!Array.isArray(flat)) return [];
	const out: InkPoint[] = [];
	let x = 0;
	let y = 0;
	let pr = 0;
	let t = 0;
	for (let i = 0; i + 3 < flat.length; i += 4) {
		const dx = num(flat[i]);
		const dy = num(flat[i + 1]);
		const dp = num(flat[i + 2]);
		const dt = num(flat[i + 3]);
		// Every value here is a DELTA, and that cuts two ways.
		//
		// A READABLE delta must advance the running position even when the
		// point it lands on is refused below (outside MAX_COORD). Skipping
		// that accumulation shifted every later point by the dropped step,
		// which read as ink sliding off the words rather than as one missing
		// sample. That rule stands.
		//
		// An UNREADABLE delta is a different case, and folding it into the
		// same rule with `?? 0` was the defect: there is no step to advance
		// by, and a guessed zero is a permanent offset applied to every later
		// sample - the same drift, silently, inside the one content type that
		// already has a loss detector, which could not see it because the
		// point still decoded. A pure delta stream has no re-anchor, so from
		// an unknown step onward every absolute value is unknowable, and any
		// point emitted past it is a guess dressed as data. The only
		// reconstruction in which nothing emitted is wrong is to STOP HERE.
		// Everything before is exact; the shortfall is counted by
		// notePointLoss below (decoded falls short of flat.length / 4), and
		// through it the file is reported damaged, so the next save preserves
		// the original bytes instead of overwriting them with the guess.
		if (dx === undefined || dy === undefined || dp === undefined || dt === undefined) break;
		x += dx;
		y += dy;
		pr += dp;
		t += dt;
		const px = x / 100;
		const py = y / 100;
		if (px < -MAX_COORD || px > MAX_COORD || py < -MAX_COORD || py > MAX_COORD) continue;
		out.push({ x: px, y: py, pressure: pr / 1000, t });
	}
	notePointLoss(flat, out.length, loss);
	return out;
}

function unpackPoints(flat: unknown, loss?: PointLoss): InkPoint[] {
	if (!Array.isArray(flat)) return [];
	const out: InkPoint[] = [];
	for (let i = 0; i + 3 < flat.length; i += 4) {
		const x = coord(flat[i]);
		const y = coord(flat[i + 1]);
		const pressure = num(flat[i + 2]);
		const t = num(flat[i + 3]);
		if (x === undefined || y === undefined) continue;
		out.push({
			x,
			y,
			pressure: pressure === undefined ? 0.5 : pressure,
			t: t === undefined ? 0 : t,
		});
	}
	notePointLoss(flat, out.length, loss);
	return out;
}

/**
 * Out-parameter for the point codecs: a payload that did not decode whole.
 *
 * Deliberately a per-call object rather than module state - two pages can be
 * parsed in the same tick (a folder scan, a sync burst), and a shared counter
 * would attribute one file's loss to another.
 */
export interface PointLoss {
	lost: boolean;
}

/**
 * Whether a packed point array lost anything, given how many points came out.
 *
 * Two ways to lose ink from one nonempty array, and both count: a tuple was
 * REJECTED (an unreadable coordinate, or one outside MAX_COORD), or the array
 * ENDS MID-TUPLE, in which case those trailing values are never even read -
 * the loop stops at `i + 3 < length`. A stroke-count comparison sees neither,
 * which is the whole reason this exists.
 */
function notePointLoss(flat: unknown[], decoded: number, loss?: PointLoss): void {
	if (!loss || flat.length === 0) return;
	if (decoded < Math.floor(flat.length / 4) || flat.length % 4 !== 0) loss.lost = true;
}

function round(n: number, places: number): number {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A coordinate that is both finite and inside MAX_COORD; see that constant. */
function coord(v: unknown): number | undefined {
	const n = num(v);
	return n !== undefined && n >= -MAX_COORD && n <= MAX_COORD ? n : undefined;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** A non-empty string, or undefined - an empty slide hash is not a hash. */
function nonEmptyStr(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

export function serializePage(page: PageData, version: number = SCHEMA_VERSION): string {
	return JSON.stringify(
		withUnknown(
			{
				schemaVersion: version,
				pageId: page.pageId,
				...(page.surface ? { surface: page.surface } : {}),
				...(page.coordSpace ? { coordSpace: page.coordSpace } : {}),
				...(page.pdfPaths ? { pdfPaths: page.pdfPaths } : {}),
				// Slides only. Emitted only when present, so every sidecar the
				// note and PDF surfaces write stays byte-identical to before.
				...(page.deck
					? {
							deck: {
								width: round(page.deck.width, 2),
								height: round(page.deck.height, 2),
							},
						}
					: {}),
				...(page.slides
					? { slides: page.slides.map((s) => ({ index: s.index, hash: s.hash })) }
					: {}),
				...(typeof page.fontRefPx === "number" && Number.isFinite(page.fontRefPx) && page.fontRefPx > 0
					? { fontRefPx: page.fontRefPx }
					: {}),
				textBoxes: page.textBoxes.map((b) =>
					withUnknown(
						{
							id: b.id,
							x: round(b.x, 2),
							y: round(b.y, 2),
							width: round(b.width, 2),
							z: b.z,
						},
						page.unknownByObject[b.id]
					)
				),
				images: page.images.map((im) =>
					withUnknown(
						{
							id: im.id,
							x: round(im.x, 2),
							y: round(im.y, 2),
							width: round(im.width, 2),
							height: round(im.height, 2),
							z: im.z,
						},
						page.unknownByObject[im.id]
					)
				),
			strokes: page.strokes.map((s) =>
					withUnknown(
						{
							id: s.id,
							tool: s.tool,
							color: s.color,
							width: round(s.width, 3),
							createdAt: s.createdAt,
							...(s.device === "mouse" ? { device: s.device } : {}),
							...(s.widthMode === "uniform" ? { widthMode: s.widthMode } : {}),
							...(s.pressureProfile === "exp7" ? { pressureProfile: s.pressureProfile } : {}),
							...(typeof s.page === "number" ? { page: s.page } : {}),
							...(version >= 2
								? { ptsd: packPointsV2(s.points) }
								: { pts: packPoints(s.points) }),
						},
						page.unknownByObject[s.id]
					)
				),
			},
			page.unknownTop
		)
	);
}

/**
 * Tolerant by design (§61: "sidecar missing, malformed sidecar"). A page whose
 * sidecar is corrupt must still open, with whatever survived, rather than
 * throwing the user out of their note.
 *
 * See DecodeLoss below for the other half of that bargain: what it survived
 * WITHOUT has to travel with it, or the next save writes the remnant back.
 */

/**
 * What a migration had to discard, counted per call.
 *
 * The migration is deliberately tolerant (§61): a stroke it cannot use is
 * skipped so the rest of the page still opens. Tolerant is right for OPENING
 * and catastrophic for SAVING - the skipped strokes are gone from the model,
 * and writing that model back over the file destroys the only copy of them.
 * So the loss has to leave the migration with the data, which is what this
 * carries and what `parsePage` turns into a damage verdict.
 */
export interface DecodeLoss {
	/** Strokes dropped because the sidecar gave them no usable id. */
	unusableId: number;
	/** Strokes whose nonempty point payload decoded to nothing at all. */
	unreadablePoints: number;
	/** Strokes that decoded some of their samples, but not all of them. */
	partialPoints: number;
	/** Text boxes dropped because the entry was not an object at all. */
	unreadableBoxes: number;
	/** Text boxes dropped because the sidecar gave them no usable id or position. */
	unusableBoxes: number;
	/** Images dropped because the entry was not an object at all. */
	unreadableImages: number;
	/** Images dropped because the sidecar gave them no usable id or position. */
	unusableImages: number;
	/** Strokes dropped because the entry was not an object at all. */
	unreadableStrokes: number;
	/**
	 * The sidecar HAD a `strokes` key and it was not an array, so every stroke
	 * it claimed to hold was skipped without any of the counters above seeing
	 * it. A boolean, not a count, because the loop never ran: there is nothing
	 * to count. An ABSENT key is not this - absent means the page has none,
	 * which is what every sidecar written before a field existed looks like.
	 */
	unreadableStrokeList: boolean;
	/** Same for `textBoxes`: the key was there and was not an array. */
	unreadableBoxList: boolean;
	/** Same for `images`: the key was there and was not an array. */
	unreadableImageList: boolean;
}

function emptyDecodeLoss(): DecodeLoss {
	return {
		unusableId: 0,
		unreadablePoints: 0,
		partialPoints: 0,
		unreadableBoxes: 0,
		unusableBoxes: 0,
		unreadableImages: 0,
		unusableImages: 0,
		unreadableStrokes: 0,
		unreadableStrokeList: false,
		unreadableBoxList: false,
		unreadableImageList: false,
	};
}

function wasLossy(loss: DecodeLoss): boolean {
	return (
		loss.unusableId > 0 ||
		loss.unreadablePoints > 0 ||
		loss.partialPoints > 0 ||
		loss.unreadableBoxes > 0 ||
		loss.unusableBoxes > 0 ||
		loss.unreadableImages > 0 ||
		loss.unusableImages > 0 ||
		loss.unreadableStrokes > 0 ||
		loss.unreadableStrokeList ||
		loss.unreadableBoxList ||
		loss.unreadableImageList
	);
}

/**
 * Counts only, never content: this string travels into logs, and a sidecar's
 * coordinates are the user's handwriting.
 */
function describeDecodeLoss(loss: DecodeLoss): string {
	const groups: string[] = [];
	const parts: string[] = [];
	if (loss.unreadableStrokes > 0) parts.push(`${loss.unreadableStrokes} unreadable`);
	if (loss.unusableId > 0) parts.push(`${loss.unusableId} with no usable id`);
	if (loss.unreadablePoints > 0) parts.push(`${loss.unreadablePoints} with unreadable points`);
	if (loss.partialPoints > 0) parts.push(`${loss.partialPoints} missing some points`);
	if (parts.length > 0) groups.push(`strokes ${parts.join(", ")}`);
	const boxes: string[] = [];
	if (loss.unreadableBoxes > 0) boxes.push(`${loss.unreadableBoxes} unreadable`);
	if (loss.unusableBoxes > 0) boxes.push(`${loss.unusableBoxes} with no usable id or position`);
	if (boxes.length > 0) groups.push(`text boxes ${boxes.join(", ")}`);
	const images: string[] = [];
	if (loss.unreadableImages > 0) images.push(`${loss.unreadableImages} unreadable`);
	if (loss.unusableImages > 0) images.push(`${loss.unusableImages} with no usable id or position`);
	if (images.length > 0) groups.push(`images ${images.join(", ")}`);
	const lists: string[] = [];
	if (loss.unreadableStrokeList) lists.push("strokes");
	if (loss.unreadableBoxList) lists.push("text boxes");
	if (loss.unreadableImageList) lists.push("images");
	if (lists.length > 0) groups.push(`${lists.join(", ")} not a readable list`);
	return `partly decodable sidecar: ${groups.join("; ")}`;
}

/**
 * A content collection the sidecar HAS and this build cannot read.
 *
 * `Array.isArray` alone cannot tell ABSENT from PRESENT-AND-WRONG, and the
 * two mean opposite things: absent is "this page has none", which every
 * sidecar written before the field existed looks like, while a present
 * non-array claims a collection whose entries we then silently drop. Only
 * the second is damage. A JSON-parsed object never holds `undefined`, so
 * `!== undefined` is exactly "the key is present" for anything parsePage
 * can hand us.
 */
function unreadableList(v: unknown): boolean {
	return v !== undefined && !Array.isArray(v);
}

export function migratePageData(
	raw: unknown,
	fallbackPageId: string,
	loss?: DecodeLoss
): PageData {
	const page = emptyPage(fallbackPageId);
	if (!raw || typeof raw !== "object") return page;
	const o = raw as Record<string, unknown>;
	// The sidecar's own id is as untrusted as the frontmatter's: it names
	// the file we write back to. An unusable one falls back to the id the
	// caller opened the page under, which is the one already checked.
	page.pageId = isSafePageId(o.pageId) ? o.pageId : fallbackPageId;
	if (o.surface === "inline") page.surface = "inline";
	// The pdf surface is a separate coordinate world - page-local css px at
	// scale 1 - and must never be confused with note-surface geometry. The
	// stores are separate instances and each refuses the other's sidecars.
	if (o.surface === "pdf") page.surface = "pdf";
	// The slides surface is a third coordinate world - Reveal's logical deck
	// units, which are negative in the letterbox margin - and it is isolated
	// the same way the pdf one is, one step harder: its sidecar does not even
	// share the note's id. It lives at `<pageId>.slides`, an id the note and
	// canvas paths can never ask for because they only ever load the bare
	// `handwriting-page-id` out of frontmatter. So an old build cannot open
	// slides ink as a page, and this build cannot open a note as slides ink.
	if (o.surface === "slides") page.surface = "slides";
	if (typeof o.coordSpace === "string" && o.coordSpace !== "") page.coordSpace = o.coordSpace;
	// Both are slides fields and both are optional, but they fail differently
	// on purpose. `deck` is all-or-nothing: a size with one bad number says
	// nothing about the other, so the pair is dropped whole. `slides` is
	// filtered PER ENTRY: a bad entry is skipped and its siblings are kept,
	// because the list is a set of independent index->hash facts and throwing
	// away the good ones would strand every slide's ink on its old number.
	// Dropped either way means "unknown", which is what an absent field means
	// too, and neither ever deletes a stroke.
	if (o.deck && typeof o.deck === "object") {
		const d = o.deck as Record<string, unknown>;
		const w = coord(d.width);
		const h = coord(d.height);
		if (w !== undefined && h !== undefined && w > 0 && h > 0) page.deck = { width: w, height: h };
	}
	if (Array.isArray(o.slides)) {
		const list: { index: number; hash: string }[] = [];
		for (const item of o.slides) {
			if (!item || typeof item !== "object") continue;
			const s = item as Record<string, unknown>;
			const index = num(s.index);
			const hash = nonEmptyStr(s.hash);
			if (index === undefined || !Number.isInteger(index) || index < 0 || !hash) continue;
			list.push({ index, hash });
		}
		if (list.length > 0) page.slides = list;
	}
	// Finite and above zero, else absent: a bad value says nothing about the
	// size, and absent is what "unknown" already means.
	if (typeof o.fontRefPx === "number" && Number.isFinite(o.fontRefPx) && o.fontRefPx > 0) {
		page.fontRefPx = o.fontRefPx;
	}
	if (Array.isArray(o.pdfPaths)) {
		const paths = o.pdfPaths.filter((p): p is string => typeof p === "string" && p !== "");
		if (paths.length > 0) page.pdfPaths = paths;
	}
	page.unknownTop = unknownKeys(o, KNOWN_TOP);

	if (loss && unreadableList(o.textBoxes)) loss.unreadableBoxList = true;
	if (Array.isArray(o.textBoxes)) {
		for (const item of o.textBoxes) {
			// Dropped exactly as before, and now counted: the entry is still on
			// disk, so losing it silently is what lets the next save overwrite it.
			if (!item || typeof item !== "object") {
				if (loss) loss.unreadableBoxes++;
				continue;
			}
			const b = item as Record<string, unknown>;
			// The id becomes a key of unknownByObject and, on the next save, is
			// echoed straight back into the sidecar - the same shape check that
			// guards a page id (isSafePageId/SAFE_PAGE_ID) guards an object id
			// too, and for the same reason: "__proto__" as a plain-object key is
			// a prototype write, not a data write. An id that fails is dropped
			// with the object, same as a bad coordinate. K1, audit-fixes-design.md 5k.
			const id = isSafePageId(b.id) ? b.id : undefined;
			const x = coord(b.x);
			const y = coord(b.y);
			if (!id || x === undefined || y === undefined) {
				if (loss) loss.unusableBoxes++;
				continue;
			}
			page.textBoxes.push({
				id,
				x,
				y,
				width: num(b.width) ?? 320,
				z: num(b.z) ?? 0,
			});
			const extra = unknownKeys(b, KNOWN_BOX);
			if (Object.keys(extra).length > 0) page.unknownByObject[id] = extra;
		}
	}

	if (loss && unreadableList(o.images)) loss.unreadableImageList = true;
	if (Array.isArray(o.images)) {
		for (const item of o.images) {
			// See the textBoxes loop above: same two exits, counted the same way.
			if (!item || typeof item !== "object") {
				if (loss) loss.unreadableImages++;
				continue;
			}
			const im = item as Record<string, unknown>;
			// See the textBoxes loop above: same id shape check, same reason.
			const id = isSafePageId(im.id) ? im.id : undefined;
			const x = coord(im.x);
			const y = coord(im.y);
			if (!id || x === undefined || y === undefined) {
				if (loss) loss.unusableImages++;
				continue;
			}
			page.images.push({
				id,
				x,
				y,
				width: num(im.width) ?? 320,
				height: num(im.height) ?? 240,
				z: num(im.z) ?? 0,
			});
			const extra = unknownKeys(im, KNOWN_IMAGE);
			if (Object.keys(extra).length > 0) page.unknownByObject[id] = extra;
		}
	}

	if (loss && unreadableList(o.strokes)) loss.unreadableStrokeList = true;
	if (Array.isArray(o.strokes)) {
		for (const item of o.strokes) {
			// Counted like its two neighbours: the entry is still on disk.
			if (!item || typeof item !== "object") {
				if (loss) loss.unreadableStrokes++;
				continue;
			}
			const s = item as Record<string, unknown>;
			// See the textBoxes loop above: same id shape check, same reason.
			const id = isSafePageId(s.id) ? s.id : undefined;
			// Skipped exactly as before - an id we cannot write back to is
			// unusable - but the stroke's points are still on disk, so losing
			// it silently is what the caller must not do.
			if (!id) {
				if (loss) loss.unusableId++;
				continue;
			}
			// Accept every shape ever written: v2 deltas, v1 packed, and a
			// raw points array, so a hand-edited or future-written sidecar
			// still loads.
			const sample: PointLoss = { lost: false };
			const points = Array.isArray(s.ptsd)
				? unpackPointsV2(s.ptsd, sample)
				: Array.isArray(s.pts)
					? unpackPoints(s.pts, sample)
					: Array.isArray(s.points)
						? unpackObjectPoints(s.points, sample)
						: [];
			if (points.length === 0) {
				// A stroke with no readable samples still cannot be drawn, so
				// it is dropped as before. Whether that is LOSS depends on
				// what was there: an empty array (or no point field at all)
				// had nothing to lose; a nonempty one did.
				if (loss && sample.lost) loss.unreadablePoints++;
				continue;
			}
			if (loss && sample.lost) loss.partialPoints++;
			// Width is bbox padding as well as a line thickness, so an absurd
			// one reaches the index the same way an absurd coordinate does.
			// Out of range falls back to the default instead of clamping: the
			// stroke is still drawable, and the number was never a width.
			const rawWidth = num(s.width);
			const width =
				rawWidth !== undefined && rawWidth > 0 && rawWidth <= MAX_WIDTH ? rawWidth : 2.2;
			const tool: InkTool = s.tool === "highlighter" ? "highlighter" : "pen";
			page.strokes.push({
				id,
				tool,
				color: str(s.color) ?? "#4b7bec",
				width,
				points,
				// Recomputed rather than trusted: a stale bbox silently breaks
				// culling and eraser hit-testing.
				bbox: computeBBox(points, width * 2),
				createdAt: num(s.createdAt) ?? Date.now(),
				...(s.device === "mouse" ? { device: "mouse" as const } : {}),
				...(s.widthMode === "uniform" ? { widthMode: "uniform" as const } : {}),
				...(s.pressureProfile === "exp7" ? { pressureProfile: "exp7" as const } : {}),
				// Page numbers are 1-based; anything else is not a page and is
				// dropped rather than stored as a number that indexes nowhere.
				...(Number.isInteger(s.page) && (s.page as number) >= 1
					? { page: s.page as number }
					: {}),
			});
			const extra = unknownKeys(s, KNOWN_STROKE);
			// The discriminator is known only for the one generation this build
			// understands. Preserve future values through the opaque field map.
			if (s.pressureProfile !== undefined && s.pressureProfile !== "exp7") {
				extra.pressureProfile = s.pressureProfile;
			}
			if (Object.keys(extra).length > 0) page.unknownByObject[id] = extra;
		}
	}
	return page;
}

function unpackObjectPoints(arr: unknown[], loss?: PointLoss): InkPoint[] {
	const out: InkPoint[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const p = item as Record<string, unknown>;
		const x = coord(p.x);
		const y = coord(p.y);
		if (x === undefined || y === undefined) continue;
		out.push({ x, y, pressure: num(p.pressure) ?? 0.5, t: num(p.t) ?? 0 });
	}
	// One object per point, so the arithmetic is simply how many came back.
	if (loss && arr.length > 0 && out.length < arr.length) loss.lost = true;
	return out;
}

export function parsePage(json: string, fallbackPageId: string): ParseResult {
	try {
		const raw: unknown = JSON.parse(json);
		const declared =
			raw && typeof raw === "object"
				? num((raw as Record<string, unknown>).schemaVersion)
				: undefined;
		const loss = emptyDecodeLoss();
		const data = migratePageData(raw, fallbackPageId, loss);
		// A newer Handwriting wrote this. We can still render what we recognise, but
		// the caller must not write it back.
		//
		// Checked BEFORE the loss below, and it wins: a future sidecar is
		// already read-only, so nothing can overwrite it, and half of what
		// "did not decode" is simply a schema this build does not speak.
		// Calling that damage would swap a precise refusal for a vaguer one.
		if (declared !== undefined && declared > READ_SCHEMA_VERSION) {
			return { data, recovered: false, futureVersion: declared };
		}
		// The file parsed, and part of its ink did not survive decoding. `data`
		// is the readable remnant and worth keeping, but this must NOT be
		// reported as an ordinary load: PageStore.load records an undamaged
		// input as the page's known revision, and the next save then writes
		// the filtered model back with no conflict copy - over the only copy
		// of the strokes that failed. Damage is what makes the stores hold
		// the original bytes and stop writing.
		if (wasLossy(loss)) {
			return { data, recovered: false, damaged: true, problem: describeDecodeLoss(loss) };
		}
		return { data, recovered: false };
	} catch (err) {
		return {
			data: emptyPage(fallbackPageId),
			recovered: true,
			damaged: true,
			problem: String(err),
		};
	}
}
