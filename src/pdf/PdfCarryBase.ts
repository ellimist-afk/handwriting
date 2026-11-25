/**
 * What a carry puts in the new ink file beside the strokes it adds.
 *
 * A PDF whose bytes changed gets a new ink file, and the ink drawn before the change is carried into it
 * (PdfClaims.carryInk). The placed strokes go by the ledger, as before. Everything else a plain save of the old
 * record writes goes too: a later build's unknown top-level keys, each carried stroke's unknown entry (a later
 * tool's value included), the strokes no page could place, and every known field that is not the file's own
 * (text boxes, attachments, images, and the rest), with the unknown entries of the objects they hold. Left out,
 * the first carry on a build that does not know a field deleted it, and a device older than the build that wrote
 * it could not tell.
 *
 * The new file's own value wins: a key it lacks, or a list it holds empty, takes the old record's; a list with
 * entries is left whole. A pageless stroke goes once, by its content against the strokes the new file holds
 * already, so a second carry from the same old file adds none again and two different strokes stay two.
 */
import type { InkStroke } from "../ink/Stroke";
import { emptyPage, type PageData } from "../model/PageData";

/** The fields each ink file holds for itself, and the two maps merged key by key. */
const OWN = new Set<string>(["schemaVersion", "pageId", "surface", "coordSpace", "pdfPaths", "strokes", "unknownTop", "unknownByObject"]);

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** A copy keyed by what the file controls: null prototype, so a key named `__proto__` stays a key. */
function copyMap<T>(map: Record<string, T>): Record<string, T> {
	const out = Object.create(null) as Record<string, T>;
	for (const key of Object.keys(map)) out[key] = map[key]!;
	return out;
}

const empty = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * The new record's base once `from` (the old record's parsed file) is carried into it with `added` (the placed
 * strokes this carry adds). A fresh object; neither base is changed. Null when the old file gives nothing the new
 * base lacks: the record keeps its base, and the new file's bytes are what they were before this rule.
 */
export function carriedBase(base: PageData | null, id: string, from: PageData, added: readonly InkStroke[]): PageData | null {
	const into = base ?? emptyPage(id);
	const out: PageData = {
		...into,
		unknownTop: copyMap(into.unknownTop),
		unknownByObject: copyMap(into.unknownByObject),
		strokes: [...into.strokes],
	};
	let changed = false;
	const entryFor = (objectId: string): void => {
		if (!hasOwn(from.unknownByObject, objectId) || hasOwn(out.unknownByObject, objectId)) return;
		out.unknownByObject[objectId] = from.unknownByObject[objectId]!;
		changed = true;
	};
	const fields = out as unknown as Record<string, unknown>;
	const old = from as unknown as Record<string, unknown>;
	for (const key of Object.keys(old)) {
		if (OWN.has(key) || empty(old[key]) || !empty(fields[key])) continue;
		const value = old[key];
		fields[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
		changed = true;
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			const objectId = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
			if (typeof objectId === "string") entryFor(objectId);
		}
	}
	for (const key of Object.keys(from.unknownTop)) {
		if (hasOwn(out.unknownTop, key)) continue;
		out.unknownTop[key] = from.unknownTop[key];
		changed = true;
	}
	const held = new Map<string, number>();
	for (const s of out.strokes) {
		if (typeof s.page === "number") continue;
		const key = JSON.stringify(s);
		held.set(key, (held.get(key) ?? 0) + 1);
	}
	for (const s of from.strokes) {
		if (typeof s.page === "number") continue;
		const key = JSON.stringify(s);
		const left = held.get(key) ?? 0;
		if (left > 0) {
			held.set(key, left - 1);
			continue;
		}
		out.strokes.push(s);
		entryFor(s.id);
		changed = true;
	}
	for (const s of added) entryFor(s.id);
	return changed ? out : null;
}
