/**
 * The ink clipboard (roadmap: copy/paste ink + across notes).
 *
 * Module state, like the tool: one clipboard for the session, so a lasso
 * copied in one note pastes into any other. The STROKES never go on the
 * system clipboard - a paste of note-space coordinates has nothing honest
 * to say to another application (that's what the SVG export is for) - but
 * a one-line MARKER does, because ctrl+v has nothing else to go on. See
 * inkClipboardMarker below.
 *
 * Coordinates ride along in the frame of the source note's font reference
 * size. A paste into a note with a different known reference scales each
 * stroke by target over source, so the ink keeps its look; an unknown size on
 * either side (or a PDF source) pastes unchanged.
 * Pasting back into the SOURCE note staggers by 16px per paste, or the copy
 * would sit invisibly on its original. Any other note keeps the copied
 * coordinates for its first paste and staggers each later one by 16px more,
 * so a second paste never lands exactly on the first. Each note counts its
 * own pastes; a new copy starts every count again, and undo does not.
 * A PDF is also known by its vault path, which its caller passes: a PDF whose bytes changed gets a new id, and it is
 * still the same file, the source or not, and its count goes on.
 *
 * Every paste mints fresh ids. The store skips ids it already holds
 * (applyAdd's duplicate guard), and undo tracks strokes by id, so a pasted
 * stroke must be a new individual, not a reference.
 *
 * A CUT is also kept on this device. A cut is a copy and a delete, and the delete is saved, so a restart
 * between the cut and the paste used to leave the ink in no note and on no clipboard. The cut's ink, token and source
 * go into the vault's own per-device store before the delete, and come back when the store is registered at the next
 * start, so the old marker is current again. The next copy or cut replaces or clears it. A plain copy is never kept:
 * its ink is still in the note, and its old marker still gets the restart notice. A store that fails or is full only
 * means nothing is kept, as before.
 */

import { InkStroke, newStrokeId } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { scaleStroke } from "../objects/Selection";

const PASTE_STAGGER_PX = 16;

/** The one key the kept cut lives under, in the vault's per-device store. */
const CUT_KEY = "handwriting-ink-cut";
/** A kept cut's record, measured as JSON, may not be longer than this; a longer cut is not kept. */
export const CUT_KEEP_MAX_CHARS = 512 * 1024;

/** This device's own store for the vault, as onloadDevice hands it over: save(key, null) clears the key. */
export interface InkClipboardStore {
	load(key: string): unknown;
	save(key: string, value: unknown): void;
}
let store: InkClipboardStore | null = null;

/**
 * Where the held ink was copied from: a note, or a PDF.
 *
 * A PDF paste goes by this, not by the strokes. PDF ink keeps its page through a note - the copy, the note paste,
 * the note's file and the note copy all keep it - so a page on a stroke does not say the clipboard was filled from a
 * PDF, and ink copied back out of a note is in the note's coordinates. Only a copy that says "pdf" pastes on a PDF.
 */
export type InkSource = "note" | "pdf";

let held: InkStroke[] = [];
let heldFrom: InkSource | null = null;
let sourcePath: string | null = null;
let sourceFontRefPx: number | null = null;
/** The source PDF's vault path; null for a note, or when the caller passed none. */
let sourceFile: string | null = null;
/** Pastes so far, per destination note path, since the last copy. */
const pastesInto = new Map<string, number>();
/** Pastes so far, per destination PDF's vault path, since the last copy. */
const pastesIntoFile = new Map<string, number>();
let token: string | null = null;

/**
 * The line ink copy leaves on the system clipboard.
 *
 * Without it ctrl+v had no way to know the last copy was ink: the strokes
 * sat in module state, the system clipboard still held whatever text was
 * there before, and pasting did that instead (reported 1.1.2 - the copy
 * notice appears, the paste does nothing). The marker is an identity
 * card, never the data: it names the ink this session holds, so a marker
 * left over from an earlier run is recognized and refused rather than
 * pasting whatever ink happens to be loaded now.
 *
 * Copying anything else replaces the marker, which is exactly the
 * disambiguation a private clipboard could not do: text copied after ink
 * pastes as text. A clipboard manager keeps the line in its history, so
 * pasting that entry again pastes the ink again.
 */
const MARKER_PREFIX = "handwriting-ink/v1 ";

/** The marker for the ink now held, or null when the clipboard is empty. */
export function inkClipboardMarker(): string | null {
	if (held.length === 0 || token === null) return null;
	const plural = held.length === 1 ? "" : "s";
	return `${MARKER_PREFIX}${token} (${held.length} stroke${plural})`;
}

/** The token inside a pasted payload; null when it is not our marker. */
export function markerToken(text: string): string | null {
	const line = text.trim();
	if (!line.startsWith(MARKER_PREFIX)) return null;
	const tok = line.slice(MARKER_PREFIX.length).trim().split(" ")[0] ?? "";
	return tok === "" ? null : tok;
}

/** True when a pasted marker names the ink this session is holding. */
export function markerIsCurrent(text: string): boolean {
	const tok = markerToken(text);
	return tok !== null && token !== null && tok === token && held.length > 0;
}

// A copy leaves its line anchor behind: pasted ink is placed anew, wherever it lands.
const clone = ({ lineAnchor: _line, ...s }: InkStroke): InkStroke => ({
	...s,
	points: s.points.map((p) => ({ ...p })),
	bbox: { ...s.bbox },
});

/**
 * Fill the clipboard. `from` is the note unless the caller says "pdf", so only the PDF copy can fill it for a PDF
 * paste. An empty copy returns before anything is set and leaves the old ink and its source, as before.
 */
export function copyInk(
	strokes: readonly InkStroke[],
	fromPath: string,
	fromFontRefPx: number | null = null,
	from: InkSource = "note",
	fromFile: string | null = null
): number {
	if (strokes.length === 0) return 0;
	// First: a kept cut is the clipboard of the session that cut it, so any new copy or cut clears it. A cut keeps
	// its own after this, through keepCutOnDevice.
	saveKept(null);
	held = strokes.map(clone);
	heldFrom = from;
	sourcePath = fromPath;
	sourceFile = fromFile;
	sourceFontRefPx = fromFontRefPx;
	pastesInto.clear();
	pastesIntoFile.clear();
	token = newStrokeId();
	return held.length;
}

export function clipboardSize(): number {
	return held.length;
}

/** Where the held ink was copied from; null when the clipboard is empty. */
export function inkCopiedFrom(): InkSource | null {
	return held.length === 0 ? null : heldFrom;
}

/** Fresh strokes for one paste; empty when the clipboard is. */
export function pasteInk(intoPath: string, intoFontRefPx: number | null = null, intoFile: string | null = null): InkStroke[] {
	if (held.length === 0) return [];
	const k =
		sourceFontRefPx !== null && intoFontRefPx !== null && sourceFontRefPx !== intoFontRefPx
			? intoFontRefPx / sourceFontRefPx
			: 1;
	// A PDF counts by its id and by its file, the larger of the two, and both take the new count: a changed PDF's new
	// id goes on from its file's count, and an id that comes back goes on from the later one.
	const n = Math.max(pastesInto.get(intoPath) ?? 0, intoFile === null ? 0 : pastesIntoFile.get(intoFile) ?? 0) + 1;
	pastesInto.set(intoPath, n);
	if (intoFile !== null) pastesIntoFile.set(intoFile, n);
	// The source steps the very first paste off the original; anywhere else lands its first paste where the ink was
	// copied from. The source is the same id (a rename keeps it) or the same file (a change of bytes keeps that).
	const intoSource = intoPath === sourcePath || (intoFile !== null && intoFile === sourceFile);
	const dx = PASTE_STAGGER_PX * (intoSource ? n : n - 1);
	return held.map((s) => {
		const c = clone(s);
		c.id = newStrokeId();
		if (k !== 1) scaleStroke(c, k);
		if (dx !== 0) {
			// dx offsets BOTH axes on purpose: one stagger value moves each
			// repeated paste diagonally instead of stacking pastes exactly.
			for (const p of c.points) {
				p.x += dx;
				p.y += dx;
			}
			c.bbox.x += dx;
			c.bbox.y += dx;
		}
		return c;
	});
}

/** One write to the store; a throw (full, failing) is swallowed, so nothing kept is the worst it does. */
function saveKept(value: unknown): void {
	if (store === null) return;
	try {
		store.save(CUT_KEY, value);
	} catch {
		// Nothing is kept. The cut and the session clipboard go on as before.
	}
}

/**
 * Keep the ink just cut on this device, so it still pastes after a restart. Called by a cut after its copy and
 * before its delete. The strokes go through the ink file's own codec. Over CUT_KEEP_MAX_CHARS nothing is written:
 * the copy has already cleared the key, so an older cut never comes back in its place.
 */
export function keepCutOnDevice(): void {
	if (store === null || held.length === 0 || token === null || heldFrom === null || sourcePath === null) return;
	let record: string;
	try {
		const page = serializePage({ ...emptyPage("ink-cut"), strokes: held });
		record = JSON.stringify({ v: 1, token, from: heldFrom, sourcePath, sourceFile, sourceFontRefPx, page });
	} catch {
		return;
	}
	if (record.length > CUT_KEEP_MAX_CHARS) return;
	saveKept(JSON.parse(record) as unknown);
}

/**
 * Register this device's store, as onloadDevice does at every start, and bring back a kept cut when nothing is held.
 * A record that does not check out in every part is dropped and its key cleared; nothing here throws.
 */
export function setInkClipboardStore(next: InkClipboardStore | null): void {
	store = next;
	if (next === null || held.length > 0) return;
	let raw: unknown;
	try {
		raw = next.load(CUT_KEY);
	} catch {
		return;
	}
	if (raw === null || raw === undefined) return;
	if (!restoreKept(raw)) saveKept(null);
}

/** Put a kept record back as the held ink, its token, source and font size; false when any part is wrong. */
function restoreKept(raw: unknown): boolean {
	let rec: unknown = raw;
	if (typeof rec === "string") {
		try {
			rec = JSON.parse(rec) as unknown;
		} catch {
			return false;
		}
	}
	if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false;
	const r = rec as Record<string, unknown>;
	if (r.v !== 1) return false;
	if (typeof r.token !== "string" || r.token === "") return false;
	if (r.from !== "note" && r.from !== "pdf") return false;
	if (typeof r.sourcePath !== "string") return false;
	if (r.sourceFile !== null && typeof r.sourceFile !== "string") return false;
	const font = r.sourceFontRefPx;
	if (font !== null && (typeof font !== "number" || !Number.isFinite(font) || font <= 0)) return false;
	if (typeof r.page !== "string") return false;
	// The codec drops a stroke it cannot read and falls back on a width it cannot read; a kept cut is all or nothing,
	// so every stored stroke must carry its own width.
	try {
		const strokes = (JSON.parse(r.page) as { strokes?: unknown }).strokes;
		if (!Array.isArray(strokes) || strokes.length === 0) return false;
		for (const s of strokes) {
			const w = (s as { width?: unknown } | null)?.width;
			if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return false;
		}
	} catch {
		return false;
	}
	const parsed = parsePage(r.page, "ink-cut");
	if (parsed.recovered || parsed.damaged || parsed.futureVersion !== undefined) return false;
	if (parsed.data.strokes.length === 0) return false;
	held = parsed.data.strokes.map(clone);
	heldFrom = r.from;
	sourcePath = r.sourcePath;
	sourceFile = r.sourceFile;
	sourceFontRefPx = font;
	pastesInto.clear();
	pastesIntoFile.clear();
	token = r.token;
	return true;
}

/** Test seam. */
export function clearInkClipboard(): void {
	saveKept(null);
	held = [];
	heldFrom = null;
	sourcePath = null;
	sourceFile = null;
	sourceFontRefPx = null;
	pastesInto.clear();
	pastesIntoFile.clear();
	token = null;
}
