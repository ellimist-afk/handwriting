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
	surface?: "inline" | "pdf";
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
	 * True when the persisted payload was UNREADABLE (JSON parse failure or
	 * I/O failure): `data` is a placeholder, not the user's ink. Callers
	 * must fail closed: render nothing, and above all REFUSE to persist for
	 * this page, or the placeholder overwrites whatever the file held.
	 * Distinct from `recovered`, which also covers the benign
	 * tmp-file-after-interrupted-write path where the parse SUCCEEDED.
	 */
	damaged?: boolean;
	problem?: string;
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
	"textBoxes",
	"images",
	"strokes",
]);
const KNOWN_BOX = new Set(["id", "x", "y", "width", "z"]);
const KNOWN_IMAGE = new Set(["id", "x", "y", "width", "height", "z"]);
const KNOWN_STROKE = new Set(["id", "tool", "color", "width", "createdAt", "device", "pts",
	"ptsd", "points", "page"]);

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

export function unpackPointsV2(flat: unknown): InkPoint[] {
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
		// Every value here is a DELTA, so the running position has to advance
		// even for a quadruple we refuse to emit. Skipping the accumulation
		// (what this did before) shifted every later point in the stroke by
		// the dropped delta, which reads as ink sliding off the words rather
		// than as one missing sample.
		x += dx ?? 0;
		y += dy ?? 0;
		pr += dp ?? 0;
		t += dt ?? 0;
		if (dx === undefined || dy === undefined) continue;
		const px = x / 100;
		const py = y / 100;
		if (px < -MAX_COORD || px > MAX_COORD || py < -MAX_COORD || py > MAX_COORD) continue;
		out.push({ x: px, y: py, pressure: pr / 1000, t });
	}
	return out;
}

function unpackPoints(flat: unknown): InkPoint[] {
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
	return out;
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

export function serializePage(page: PageData, version: number = SCHEMA_VERSION): string {
	return JSON.stringify(
		withUnknown(
			{
				schemaVersion: version,
				pageId: page.pageId,
				...(page.surface ? { surface: page.surface } : {}),
				...(page.coordSpace ? { coordSpace: page.coordSpace } : {}),
				...(page.pdfPaths ? { pdfPaths: page.pdfPaths } : {}),
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
 */
export function migratePageData(raw: unknown, fallbackPageId: string): PageData {
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
	if (typeof o.coordSpace === "string" && o.coordSpace !== "") page.coordSpace = o.coordSpace;
	if (Array.isArray(o.pdfPaths)) {
		const paths = o.pdfPaths.filter((p): p is string => typeof p === "string" && p !== "");
		if (paths.length > 0) page.pdfPaths = paths;
	}
	page.unknownTop = unknownKeys(o, KNOWN_TOP);

	if (Array.isArray(o.textBoxes)) {
		for (const item of o.textBoxes) {
			if (!item || typeof item !== "object") continue;
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
			if (!id || x === undefined || y === undefined) continue;
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

	if (Array.isArray(o.images)) {
		for (const item of o.images) {
			if (!item || typeof item !== "object") continue;
			const im = item as Record<string, unknown>;
			// See the textBoxes loop above: same id shape check, same reason.
			const id = isSafePageId(im.id) ? im.id : undefined;
			const x = coord(im.x);
			const y = coord(im.y);
			if (!id || x === undefined || y === undefined) continue;
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

	if (Array.isArray(o.strokes)) {
		for (const item of o.strokes) {
			if (!item || typeof item !== "object") continue;
			const s = item as Record<string, unknown>;
			// See the textBoxes loop above: same id shape check, same reason.
			const id = isSafePageId(s.id) ? s.id : undefined;
			if (!id) continue;
			// Accept every shape ever written: v2 deltas, v1 packed, and a
			// raw points array, so a hand-edited or future-written sidecar
			// still loads.
			const points = Array.isArray(s.ptsd)
				? unpackPointsV2(s.ptsd)
				: Array.isArray(s.pts)
					? unpackPoints(s.pts)
					: Array.isArray(s.points)
						? unpackObjectPoints(s.points)
						: [];
			if (points.length === 0) continue;
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
				// Page numbers are 1-based; anything else is not a page and is
				// dropped rather than stored as a number that indexes nowhere.
				...(Number.isInteger(s.page) && (s.page as number) >= 1
					? { page: s.page as number }
					: {}),
			});
			const extra = unknownKeys(s, KNOWN_STROKE);
			if (Object.keys(extra).length > 0) page.unknownByObject[id] = extra;
		}
	}
	return page;
}

function unpackObjectPoints(arr: unknown[]): InkPoint[] {
	const out: InkPoint[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") continue;
		const p = item as Record<string, unknown>;
		const x = coord(p.x);
		const y = coord(p.y);
		if (x === undefined || y === undefined) continue;
		out.push({ x, y, pressure: num(p.pressure) ?? 0.5, t: num(p.t) ?? 0 });
	}
	return out;
}

export function parsePage(json: string, fallbackPageId: string): ParseResult {
	try {
		const raw: unknown = JSON.parse(json);
		const declared =
			raw && typeof raw === "object"
				? num((raw as Record<string, unknown>).schemaVersion)
				: undefined;
		const data = migratePageData(raw, fallbackPageId);
		// A newer Handwriting wrote this. We can still render what we recognise, but
		// the caller must not write it back.
		if (declared !== undefined && declared > READ_SCHEMA_VERSION) {
			return { data, recovered: false, futureVersion: declared };
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
