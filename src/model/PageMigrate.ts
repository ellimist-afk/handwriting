/**
 * Decode half of the page sidecar, moved from PageData.ts: what a migration had to discard (DecodeLoss and the
 * functions that count and describe it) and the tolerant migration itself. Pure functions on parsed JSON; the save
 * path stays in PageData.ts. Bodies moved unchanged; PageData.ts imports the migration back for parsePage and
 * re-exports migratePageData and DecodeLoss, so importers keep their paths.
 */
import { InkPoint, InkTool, computeBBox } from "../ink/Stroke";
import {
	coord,
	emptyPage,
	isSafePageId,
	KNOWN_BOX,
	KNOWN_IMAGE,
	KNOWN_STROKE,
	KNOWN_TOP,
	MAX_WIDTH,
	nonEmptyStr,
	NOTE_PAPER_KINDS,
	type NotePaperKind,
	num,
	type PageData,
	type PointLoss,
	readLineAnchor,
	str,
	unknownKeys,
	unpackPoints,
	unpackPointsV2,
} from "./PageData";

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
	/**
	 * Strokes dropped because their points sit only under a key this build does
	 * not read: a newer build's points, most likely. Damage like the rest, but
	 * the one kind that says nothing is wrong with the file itself.
	 */
	unknownPointKeys: number;
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

export function emptyDecodeLoss(): DecodeLoss {
	return {
		unusableId: 0,
		unreadablePoints: 0,
		unknownPointKeys: 0,
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

export function wasLossy(loss: DecodeLoss): boolean {
	return (
		loss.unusableId > 0 ||
		loss.unreadablePoints > 0 ||
		loss.unknownPointKeys > 0 ||
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

/** True when ink under a key this build does not read is the file's only fault. */
export function onlyUnknownPointKeys(loss: DecodeLoss): boolean {
	return loss.unknownPointKeys > 0 && !wasLossy({ ...loss, unknownPointKeys: 0 });
}

/**
 * Counts only, never content: this string travels into logs, and a sidecar's
 * coordinates are the user's handwriting.
 */
export function describeDecodeLoss(loss: DecodeLoss): string {
	const groups: string[] = [];
	const parts: string[] = [];
	if (loss.unreadableStrokes > 0) parts.push(`${loss.unreadableStrokes} unreadable`);
	if (loss.unusableId > 0) parts.push(`${loss.unusableId} with no usable id`);
	const unreadablePoints = loss.unreadablePoints + loss.unknownPointKeys;
	if (unreadablePoints > 0) parts.push(`${unreadablePoints} with unreadable points`);
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
	if (typeof o.noteCanvas === "boolean") page.noteCanvas = o.noteCanvas;
	if (NOTE_PAPER_KINDS.includes(o.notePaper as NotePaperKind)) page.notePaper = o.notePaper as NotePaperKind;
	page.unknownTop = unknownKeys(o, KNOWN_TOP);
	// A choice this build cannot read (a paper kind from a later release) is
	// not dropped: it rides as an unknown field, so the note follows the
	// setting here and keeps its value for the build that wrote it.
	if (o.noteCanvas !== undefined && page.noteCanvas === undefined) page.unknownTop.noteCanvas = o.noteCanvas;
	if (o.notePaper !== undefined && page.notePaper === undefined) page.unknownTop.notePaper = o.notePaper;

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
		// Two strokes under one id are still two strokes. Every consumer keys
		// strokes by id, so the second one gets a name of its own here: the
		// first `<id>-N` no object in the file carries (strokes, text boxes and
		// images share one id space through unknownByObject), so a real
		// `<id>-2` keeps its name and the same file always reads the same.
		// An exact copy, equal in every field, is one stroke written twice and
		// loads once: kept twice, a highlighter copy would draw darker.
		const taken = fileObjectIds(o);
		// Raw entries by file id. Compared (canonicalJson) only when an id
		// repeats, so an ordinary file pays one map write per stroke.
		const variants = new Map<string, Array<Record<string, unknown>>>();
		for (const item of o.strokes) {
			// Counted like its two neighbours: the entry is still on disk.
			if (!item || typeof item !== "object") {
				if (loss) loss.unreadableStrokes++;
				continue;
			}
			const s = item as Record<string, unknown>;
			// See the textBoxes loop above: same id shape check, same reason.
			let id = isSafePageId(s.id) ? s.id : undefined;
			if (id !== undefined) {
				const seen = variants.get(id);
				if (seen) {
					const shape = canonicalJson(s);
					if (seen.some((other) => canonicalJson(other) === shape)) continue;
					seen.push(s);
					let n = 2;
					while (taken.has(`${id}-${n}`)) n++;
					const own = `${id}-${n}`;
					taken.add(own);
					// A name the id rules refuse is an unusable id at this read:
					// the note locks rather than the stroke being lost.
					id = isSafePageId(own) ? own : undefined;
				} else {
					variants.set(id, [s]);
				}
			}
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
				// No point list this build reads, yet the stroke holds a field it
				// does not know: a newer build's points, most likely. Dropping it
				// quietly let the next save write the page without it, so it
				// counts as unreadable and the damage lock holds the file.
				else if (
					loss &&
					s.ptsd === undefined &&
					s.pts === undefined &&
					s.points === undefined &&
					Object.keys(unknownKeys(s, KNOWN_STROKE)).length > 0
				) {
					loss.unknownPointKeys++;
				}
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
			const lineAnchor = readLineAnchor(s.lineAnchor);
			page.strokes.push({
				id,
				tool,
				color: str(s.color) ?? "#4b7bec",
				width,
				points,
				// Recomputed rather than trusted: a stale bbox silently breaks
				// culling and eraser hit-testing.
				bbox: computeBBox(points, width * 2),
				createdAt: num(s.createdAt) ?? 0,
				...(s.device === "mouse" ? { device: "mouse" as const } : {}),
				...(s.widthMode === "uniform" ? { widthMode: "uniform" as const } : {}),
				...(s.pressureProfile === "exp7" ? { pressureProfile: "exp7" as const } : {}),
				...(s.pressureSensitivity === "on" || s.pressureSensitivity === "off"
					? { pressureSensitivity: s.pressureSensitivity }
					: {}),
				// Page numbers are 1-based; anything else is not a page and is
				// dropped rather than stored as a number that indexes nowhere.
				...(Number.isInteger(s.page) && (s.page as number) >= 1
					? { page: s.page as number }
					: {}),
				...(lineAnchor ? { lineAnchor } : {}),
			});
			const extra = unknownKeys(s, KNOWN_STROKE);
			// The discriminator is known only for the one generation this build
			// understands. Preserve future values through the opaque field map.
			if (s.pressureProfile !== undefined && s.pressureProfile !== "exp7") {
				extra.pressureProfile = s.pressureProfile;
			}
			// The same for a tool, device or width mode this build has no
			// meaning for: the stroke is drawn with the fallback, and a re-save
			// writes back the value it was written with, not the fallback.
			if (s.tool !== undefined && s.tool !== "pen" && s.tool !== "highlighter") extra.tool = s.tool;
			if (s.device !== undefined && s.device !== "mouse") extra.device = s.device;
			if (s.widthMode !== undefined && s.widthMode !== "uniform") extra.widthMode = s.widthMode;
			if (s.pressureSensitivity !== undefined && s.pressureSensitivity !== "on" && s.pressureSensitivity !== "off") {
				extra.pressureSensitivity = s.pressureSensitivity;
			}
			if (s.lineAnchor !== undefined && !lineAnchor) extra.lineAnchor = s.lineAnchor;
			if (Object.keys(extra).length > 0) page.unknownByObject[id] = extra;
		}
	}
	return page;
}

/** Every id an object in the raw file carries: strokes, text boxes and images, as written. */
function fileObjectIds(o: Record<string, unknown>): Set<string> {
	const out = new Set<string>();
	for (const list of [o.strokes, o.textBoxes, o.images]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
			if (typeof id === "string") out.add(id);
		}
	}
	return out;
}

/** JSON with object keys sorted, so two entries equal in every field compare equal however they were written. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
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
