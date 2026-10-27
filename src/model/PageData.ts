import { InkPoint, InkStroke, LineAnchor, settleLineAnchors } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import { describeDecodeLoss, emptyDecodeLoss, migratePageData, onlyUnknownPointKeys, wasLossy } from "./PageMigrate";
export { migratePageData, type DecodeLoss } from "./PageMigrate";

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
	/**
	 * This note's own Infinite Canvas and paper background choices. Absent:
	 * the note follows the global setting. They live here and not in the
	 * note's properties, which hold the page id alone. Additive, like
	 * fontRefPx: an older build keeps them as unknown top-level fields. A value
	 * this build does not know stays in unknownTop and is written back as found.
	 */
	noteCanvas?: boolean;
	notePaper?: NotePaperKind;
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
	/**
	 * Set with `damaged` when the file's only fault is ink under a key this
	 * build does not read. Such a file is most likely newer than any leftover
	 * save beside it, so the store never puts that save in its place.
	 */
	onlyUnknownPointKeys?: boolean;
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

/** The paper kinds a note can choose for itself. */
export const NOTE_PAPER_KINDS = ["none", "lines", "grid", "dots"] as const;
export type NotePaperKind = (typeof NOTE_PAPER_KINDS)[number];

export const KNOWN_TOP = new Set([
	"schemaVersion",
	"pageId",
	"surface",
	"coordSpace",
	"pdfPaths",
	"deck",
	"slides",
	"fontRefPx",
	"noteCanvas",
	"notePaper",
	"textBoxes",
	"images",
	"strokes",
]);
export const KNOWN_BOX = new Set(["id", "x", "y", "width", "z"]);
export const KNOWN_IMAGE = new Set(["id", "x", "y", "width", "height", "z"]);
export const KNOWN_STROKE = new Set(["id", "tool", "color", "width", "createdAt", "device", "widthMode", "pts",
	"ptsd", "points", "page", "pressureProfile", "pressureSensitivity", "lineAnchor"]);

/** Everything in `raw` that is not a key we claim to own. */
export function unknownKeys(raw: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
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

export function unpackPoints(flat: unknown, loss?: PointLoss): InkPoint[] {
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

export function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A coordinate that is both finite and inside MAX_COORD; see that constant. */
export function coord(v: unknown): number | undefined {
	const n = num(v);
	return n !== undefined && n >= -MAX_COORD && n <= MAX_COORD ? n : undefined;
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** A non-empty string, or undefined - an empty slide hash is not a hash. */
export function nonEmptyStr(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

export function serializePage(page: PageData, version: number = SCHEMA_VERSION): string {
	settleLineAnchors();
	return JSON.stringify(pageRecord(page, version, page.strokes.map((s) => strokeRecord(page, s, version))));
}

/** The page as JSON.stringify writes it, with `strokes` as the value of its stroke list. */
function pageRecord(page: PageData, version: number, strokes: unknown): Record<string, unknown> {
	return withUnknown(
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
			...(typeof page.noteCanvas === "boolean" ? { noteCanvas: page.noteCanvas } : {}),
			...(page.notePaper !== undefined && NOTE_PAPER_KINDS.includes(page.notePaper)
				? { notePaper: page.notePaper }
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
			strokes,
		},
		page.unknownTop
	);
}

/** One stroke as JSON.stringify writes it inside the page's stroke list. */
function strokeRecord(page: PageData, s: InkStroke, version: number): Record<string, unknown> {
	return withUnknown(
		{
			id: s.id,
			// A tool this build read as its fallback pen keeps the value
			// it was written with, through the field map below.
			...(s.tool === "pen" && page.unknownByObject[s.id]?.tool !== undefined ? {} : { tool: s.tool }),
			color: s.color,
			width: round(s.width, 3),
			createdAt: s.createdAt,
			...(s.device === "mouse" ? { device: s.device } : {}),
			...(s.widthMode === "uniform" ? { widthMode: s.widthMode } : {}),
			...(s.pressureProfile === "exp7" ? { pressureProfile: s.pressureProfile } : {}),
			...(s.pressureSensitivity === "on" || s.pressureSensitivity === "off"
				? { pressureSensitivity: s.pressureSensitivity }
				: {}),
			...(typeof s.page === "number" ? { page: s.page } : {}),
			...(s.lineAnchor ? { lineAnchor: lineAnchorRecord(s.lineAnchor) } : {}),
			...(version >= 2
				? { ptsd: packPointsV2(s.points) }
				: { pts: packPoints(s.points) }),
		},
		page.unknownByObject[s.id]
	);
}

/**
 * Parts of a line anchor read from a file that this build does not know (a later build's), kept with the anchor object they
 * came with and written back as found while it is that object. An anchor taken again is a new object and carries none.
 */
const lineAnchorExtras = new WeakMap<LineAnchor, Record<string, unknown>>();
const LINE_ANCHOR_KEYS = new Set(["line", "top", "y", "key", "width", "fontPx"]);

/**
 * A stroke's line anchor as the file holds it: the line's top to a thousandth of a world unit, so a reloaded anchor reads a
 * correction under the anchors' float noise; the stroke's y to a hundredth; the rest as taken.
 */
function lineAnchorRecord(a: LineAnchor): Record<string, unknown> {
	const record: Record<string, unknown> = { line: a.line, top: round(a.top, 3), y: round(a.y, 2), key: a.key, width: a.width, fontPx: round(a.fontPx, 3) };
	if (a.above !== undefined) record.above = a.above;
	const extra = lineAnchorExtras.get(a);
	if (extra) for (const k in extra) if (!LINE_ANCHOR_KEYS.has(k) && !(k === "above" && a.above !== undefined)) record[k] = extra[k];
	return record;
}

/**
 * A line anchor read from a file, or undefined when any part of it is not one this build can honour. An unreadable value is
 * kept as found through the stroke's field map, never dropped.
 */
export function readLineAnchor(v: unknown): LineAnchor | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const line = num(o.line), top = num(o.top), y = num(o.y), key = num(o.key), width = num(o.width), fontPx = num(o.fontPx);
	if (line === undefined || !Number.isInteger(line) || line < 1) return undefined;
	if (top === undefined || y === undefined || Math.abs(top) > MAX_COORD || Math.abs(y) > MAX_COORD) return undefined;
	if (key === undefined || !Number.isInteger(key) || key < 0 || key > 0xffffffff) return undefined;
	if (width === undefined || !(width > 0) || fontPx === undefined || !(fontPx > 0)) return undefined;
	const anchor: LineAnchor = { line, top, y, key, width, fontPx };
	// The lines-above hash when it is one; any other value is kept as found and the anchor reads as one without it.
	const above = num(o.above);
	if (above !== undefined && Number.isInteger(above) && above >= 0 && above <= 0xffffffff) anchor.above = above;
	let extra: Record<string, unknown> | null = null;
	for (const k in o) if (!LINE_ANCHOR_KEYS.has(k) && !(k === "above" && anchor.above !== undefined)) (extra ??= {})[k] = o[k];
	if (extra) lineAnchorExtras.set(anchor, extra);
	return anchor;
}

/** How long one slice of serializePageSliced runs before it pauses: a quarter of a 60 Hz frame. */
export const SAVE_SLICE_MS = 4;

/**
 * Stands in for the stroke list while the rest of the page is stringified, so the strokes are spliced in exactly where
 * JSON.stringify puts the list, whatever order the unknown fields give the keys. Its JSON form is searched for, and a
 * page that holds it anywhere else is written by serializePage instead.
 */
const STROKES_MARK = "\u0000handwriting strokes\u0000";
const STROKES_MARK_JSON = JSON.stringify(STROKES_MARK);

/**
 * The same bytes as serializePage, built a few strokes at a time, so a big page never holds the main thread for the
 * whole stringify (40 to 80 ms at 3000 strokes). The save's serializer (PageStore.writeNowInFlight); every other
 * caller keeps serializePage.
 *
 * Once a slice has run for `sliceMs`, it awaits `pause` before the next stroke: a turn of the event loop, or a wait
 * for a pen to lift. A page that fits in one slice never pauses, so its save runs as it did before.
 *
 * The strokes written are the list as it was when the pass began: a stroke added or removed during a pause is the
 * next save's. A stroke changed in place during a pause (a lasso or insert space drag translates its points and bumps
 * its revision) would leave the file half one state and half another, so the pass starts over; a second change in
 * place hands the page to serializePage after one more pause. Either way the text is one state of the page.
 */
export async function serializePageSliced(
	page: PageData,
	pause: () => Promise<void>,
	version: number = SCHEMA_VERSION,
	sliceMs: number = SAVE_SLICE_MS
): Promise<string> {
	return (await serializePageSlicedStamped(page, pause, () => NO_STAMP, version, sliceMs)).text;
}

/** A stamp of a text fed its parts in order (PageStore's beginContentStamp); `end` is the stamp of the parts joined. */
export interface TextStamp {
	push(part: string): void;
	end(): string;
}

const NO_STAMP: TextStamp = { push: () => {}, end: () => "" };

/**
 * serializePageSliced, stamping the text as it is built: every part goes to a stamp begun for the pass, inside the same
 * slices, so the save never stamps the whole text in one task (24 to 37 ms with the join on the 25 MB MCB EXAM 3 page).
 * A pass that starts over begins a new stamp; the serializePage fallback stamps its text whole.
 */
export async function serializePageSlicedStamped(
	page: PageData,
	pause: () => Promise<void>,
	begin: () => TextStamp,
	version: number = SCHEMA_VERSION,
	sliceMs: number = SAVE_SLICE_MS
): Promise<{ text: string; stamp: string }> {
	const whole = (text: string): { text: string; stamp: string } => {
		const stamp = begin();
		stamp.push(text);
		return { text, stamp: stamp.end() };
	};
	for (let pass = 0; pass < 2; pass++) {
		const strokes = page.strokes.slice();
		const revs = strokes.map(strokeRev);
		const head = JSON.stringify(pageRecord(page, version, STROKES_MARK));
		const at = head.indexOf(STROKES_MARK_JSON);
		if (at < 0 || head.indexOf(STROKES_MARK_JSON, at + 1) >= 0) return whole(serializePage(page, version));
		const stamp = begin();
		const parts: string[] = [];
		const add = (part: string): void => {
			parts.push(part);
			stamp.push(part);
		};
		add(head.slice(0, at));
		add("[");
		// Anchors are written as up to date as the text: settled at the start and after every pause, as typing may come between.
		settleLineAnchors();
		let since = performance.now();
		for (let i = 0; i < strokes.length; i++) {
			if (performance.now() - since >= sliceMs) {
				await pause();
				settleLineAnchors();
				since = performance.now();
			}
			if (i > 0) add(",");
			add(JSON.stringify(strokeRecord(page, strokes[i]!, version)));
		}
		add("]");
		add(head.slice(at + STROKES_MARK_JSON.length));
		if (strokes.every((s, i) => strokeRev(s) === revs[i])) return { text: parts.join(""), stamp: stamp.end() };
		await pause();
	}
	return whole(serializePage(page, version));
}

export function parsePage(json: string, fallbackPageId: string): ParseResult {
	try {
		// One leading byte-order mark is not part of the JSON. A tool that saves
		// the file with one made JSON.parse throw, so the note showed no ink and
		// locked. Dropped here as the Markdown side drops it; the next save
		// writes the file without it.
		const raw: unknown = JSON.parse(json.startsWith("\uFEFF") ? json.slice(1) : json);
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
			return {
				data,
				recovered: false,
				damaged: true,
				problem: describeDecodeLoss(loss),
				...(onlyUnknownPointKeys(loss) ? { onlyUnknownPointKeys: true } : {}),
			};
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
