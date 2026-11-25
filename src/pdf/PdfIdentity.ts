import { sha256 } from "./Sha256";
/**
 * Which sidecar a PDF's ink lives in.
 *
 * A note answers this with a page id written into its frontmatter. A PDF
 * cannot: there is nowhere to put one, and writing into the file is the one
 * thing this feature promises never to do. So the id is derived from the
 * CONTENT instead.
 *
 * What that buys, in the order it matters:
 *
 * - Renaming or moving a PDF costs nothing. The ink follows the bytes.
 * - Two machines syncing the same file agree on the id by construction,
 *   without any coordination - which is the only reason ink drawn on a
 *   tablet can appear on a desktop.
 * - Two copies of the same PDF in one vault share their ink. That is a
 *   choice, not an accident: they are the same document, and someone who
 *   files a duplicate under a second name expects their annotations there.
 *
 * The head, not the whole file. A hundred-megabyte scan should not be read
 * end to end every time it opens, and the first 64 KiB of a PDF carries its
 * header, its catalog and enough object data that two different documents
 * colliding there is not a practical concern - especially paired with the
 * exact byte length, which a colliding pair would also have to match.
 *
 * What it deliberately does NOT survive: re-exporting the PDF. A file that
 * has been through another editor is a different document, its pages may have
 * reflowed, and old ink positions would be lies. That orphans the sidecar,
 * which is the honest outcome; see the adoption ledger in the design. Fail
 * closed, keep the file, tell the user once.
 */

/** How much of the file the id is derived from. */
export const HEAD_BYTES = 64 * 1024;

/** Length of the hex digest kept. 128 bits is far past collision concern. */
export const ID_HEX_CHARS = 32;

/**
 * The exact bytes the digest is taken over: the head, a separator, then the
 * file's full length in decimal.
 *
 * The length is in there so that truncation cannot forge an identity. Two
 * documents sharing a 64 KiB prefix - a template and a filled-in copy of it,
 * say - differ in length, and that difference reaches the hash.
 *
 * Pure, so the composition is testable without a digest implementation.
 */
export function idInput(head: Uint8Array, byteLength: number): Uint8Array {
	const suffix = new TextEncoder().encode(`:${byteLength}`);
	const out = new Uint8Array(head.length + suffix.length);
	out.set(head, 0);
	out.set(suffix, head.length);
	return out;
}

/** The head of a file, or all of it when it is smaller than the window. */
export function headOf(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return view.subarray(0, Math.min(HEAD_BYTES, view.length));
}

/** Hex for a digest, lower case, as the id is compared as a string. */
export function toHex(digest: ArrayBuffer): string {
	const bytes = new Uint8Array(digest);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

/** The id from an already-computed digest. Separated so it can be tested. */
export function idFromDigest(digest: ArrayBuffer): string {
	return `pdf-${toHex(digest).slice(0, ID_HEX_CHARS)}`;
}

/**
 * A PDF's sidecar id, from its head and its true length.
 *
 * Split out from `pdfInkId` (1.4.6) so the id can be computed from a head
 * that was read on its own. Hashing the first 64 KiB never needed the other
 * 200 MB in memory, but the vault API has no ranged read, so until now the
 * whole document was read on every open just to reach this - see PdfHead.ts.
 *
 * `crypto.subtle` where the platform provides it; the shipped SHA-256 where
 * it does not. WKWebView contexts can lack SubtleCrypto entirely, and when
 * they did, this THREW - runDetached logged it into a console nobody opens,
 * the id never resolved, and every pen contact on every PDF said "still
 * identifying" forever. On an iPad that read as ink, erase and colours all
 * broken at once (2026-08-30, release eve).
 *
 * Same algorithm on both paths, byte for byte, and the tests pin that: an
 * id derived on the fallback MUST equal one from the platform digest, or two
 * devices file one document's ink under different names and sync splits
 * silently.
 */
export async function pdfInkIdFromHead(
	head: Uint8Array,
	byteLength: number,
	crypto?: Crypto
): Promise<string> {
	// Clamped again here, not trusted from the caller. This is the one place
	// both ways of obtaining a head meet - a whole-file read on mobile, a
	// ranged read of the first HEAD_BYTES on desktop (PdfHead.ts) - and a
	// source that handed back one byte too many would give that platform a
	// different id for the same document, which is a silent sync split.
	const input = idInput(headOf(head), byteLength);
	if (typeof crypto?.subtle?.digest === "function") {
		try {
			// A fresh copy: subtle.digest wants an ArrayBuffer, and a subarray
			// view hands it the whole underlying buffer rather than the window.
			const digest = await crypto.subtle.digest("SHA-256", input.slice().buffer);
			return idFromDigest(digest);
		} catch {
			// Present but refusing (a locked-down context): fall through.
		}
	}
	return idFromDigest(sha256(input).buffer as ArrayBuffer);
}

/**
 * The same id from a whole file, for callers that already hold every byte.
 *
 * Kept because the vault's `readBinary` returns the whole document and that
 * is still the only read mobile has.
 */
export async function pdfInkId(bytes: ArrayBuffer | Uint8Array, crypto?: Crypto): Promise<string> {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return pdfInkIdFromHead(headOf(view), view.length, crypto);
}

// ---- instances (1.4.3) ------------------------------------------------------
//
// Content identity alone cannot tell two byte-identical files apart - and on
// launch day that surfaced immediately: export the same OneNote page twice
// and the second copy arrived already wearing the first one's ink (alan,
// 2026-09-01). So a content id becomes a FAMILY, and each vault file gets an
// INSTANCE within it: `pdf-<hash>` for the first (which is exactly the
// pre-instance id, so every existing sidecar is instance one and nobody's
// ink moves), `pdf-<hash>-2` and up for fresh copies.
//
// Which instance a path belongs to is decided by the paths each sidecar
// CLAIMS (stored in the sidecar itself, so replicas agree by sync rather
// than coordination): see chooseInstance.

const INSTANCE = /^(pdf-[0-9a-f]+)(?:-(\d+))?$/;

/** The content family an instance id belongs to: its `pdf-<hash>` prefix. */
/**
 * Is this a PDF ink id?
 *
 * The one place that shape is decided, so callers on the note side can tell
 * a sidecar that belongs to a document from one that belongs to a note. A
 * note's frontmatter is free text and can name ANY id - a copied property,
 * a hand edit - and the id alone is what the note surface acts on.
 */
export function isPdfInkId(id: string): boolean {
	return INSTANCE.test(id);
}

export function familyOf(id: string): string {
	const m = INSTANCE.exec(id);
	return m ? m[1]! : id;
}

/** The lowest instance id in `family` not already taken. */
export function nextInstanceId(family: string, taken: Iterable<string>): string {
	const used = new Set<number>();
	for (const id of taken) {
		const m = INSTANCE.exec(id);
		if (!m || m[1] !== family) continue;
		used.add(m[2] === undefined ? 1 : Number(m[2]));
	}
	for (let n = 1; ; n++) {
		if (!used.has(n)) return n === 1 ? family : `${family}-${n}`;
	}
}

/** A sidecar instance offered to chooseInstance: its id and path claims. */
export interface InstanceClaim {
	id: string;
	/** Vault paths this sidecar believes it belongs to; [] = pre-instance. */
	paths: string[];
	/**
	 * A blank this session opened before the vault's list was full, never drawn on and never written: its claim names
	 * no deleted ink's new path, and the open of its path uses it only when no ink is named there (PdfInkStore.earlyBlank).
	 */
	beforeList?: boolean;
}

export type InstanceChoice =
	| { id: string; action: "use" }
	/**
	 * Adopt: write `path` into this sidecar's claims (legacy or renamed).
	 * `pairedOver` as for a fresh copy.
	 */
	| { id: string; action: "adopt"; pairedOver?: readonly string[] }
	/**
	 * A fresh copy: a new blank instance under this id. `heldFor` is set when
	 * the pairing by name left this file unpaired: the deleted claims this
	 * file is new for, which go on counting it (PdfInkStore.holdTiedPath).
	 * `pairedOver` is set whenever the open paired by name: every deleted
	 * claim it paired over, each of which stays paired at its retirement
	 * (PdfInkStore.markPaired), whichever of them this open ends.
	 */
	| { id: string; action: "fresh"; heldFor?: readonly string[]; pairedOver?: readonly string[] };

/**
 * How many trailing parts of two vault paths are equal: the file name, then
 * each folder above it, stopping at the first that differs. "One/A.pdf" and
 * "Two/A.pdf" share 1; "One/A.pdf" and "One/B.pdf" share 0.
 */
export function trailingPartsShared(a: string, b: string): number {
	const x = a.split("/");
	const y = b.split("/");
	let n = 0;
	while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
	return n;
}

/** A deleted ink claim offered for pairing: its key, the path it claimed, and the paths that may be its new name. */
export interface DeletedClaim {
	key: string;
	deleted: string;
	fresh: readonly string[];
	/** A path a tied open holds for it is not in the vault's list now: every path offered to it counts as held (offeredPaths). */
	holdsAll?: boolean;
}

/**
 * Pairs a family's deleted ink claims with the new paths they may have moved
 * to. Byte-identical PDFs moved together all match every new path by content,
 * so only their names can tell them apart.
 *
 * A pair scores the trailing parts its two paths share. Pairs are taken best
 * score first, each claim and each path once, and only when neither side has
 * another open pair at that score. A claim or a path that had an open pair at
 * a score and was not taken there pairs with nothing below it: a tie leaves
 * both sides unpaired rather than guessing, because wrong ink is worse than
 * none. Returns each paired claim's key with its path.
 */
export function pairDeletedClaims(claims: readonly DeletedClaim[]): Map<string, string> {
	const pairs = claims.flatMap((c) =>
		[...new Set(c.fresh)].map((path) => ({ key: c.key, path, score: trailingPartsShared(c.deleted, path) }))
	);
	const scores = [...new Set(pairs.map((p) => p.score))].sort((a, b) => b - a);
	const paired = new Map<string, string>();
	const doneKeys = new Set<string>();
	const donePaths = new Set<string>();
	for (const score of scores) {
		const open = pairs.filter((p) => p.score === score && !doneKeys.has(p.key) && !donePaths.has(p.path));
		for (const p of open) {
			const keyAlone = open.filter((q) => q.key === p.key).length === 1;
			const pathAlone = open.filter((q) => q.path === p.path).length === 1;
			if (keyAlone && pathAlone) paired.set(p.key, p.path);
		}
		for (const p of open) {
			doneKeys.add(p.key);
			donePaths.add(p.path);
		}
	}
	return paired;
}

/**
 * A deletion in its grace, as an open and the retirement both read it
 * (PdfInkStore.waitingDeletions).
 */
export interface WaitingDeletion {
	/** The PDF paths that existed when it was deleted: never a new name for its ink. */
	existing: ReadonlySet<string>;
	/** New paths tied opens hold for it: each counts for it, though a blank claims it, and never takes its ink. */
	held: ReadonlySet<string>;
	/** It pairs by name, alone or not (PdfInkStore.markPaired). */
	paired: boolean;
	/** Ink ids that came to claim the path after another file was renamed onto it: not its claim. */
	arrived: ReadonlySet<string>;
	/**
	 * While a file that existed at the delete is on the path: its content family, once read, unless it came with ink
	 * of its own moved from its old name (cameWithInk). An ink file of this family claiming the path is that file's,
	 * in whatever order it reached this device: never the deletion's (isDeletedClaim).
	 */
	ontoFamily?: string;
	/** The file on the path came with ink of its own, moved from its old name: only `arrived` is that file's. */
	cameWithInk?: true;
	/**
	 * Set once its retirement deferred on a path it could not read: the paths new for it then. Only these, under
	 * the names vault renames give them, stay new for it (isNewFor).
	 */
	newAtDefer?: ReadonlySet<string>;
	/**
	 * The vault may not list every file yet: the deletions restored at load have not started their grace. An open
	 * that pairs by name then decides nothing: it names no ink and holds no path (chooseInstance).
	 */
	beforeList?: boolean;
	/**
	 * Per ink id found for the path whose leave of it is owed (PdfClaims.pairedInkLeaves): the inks that keep the path
	 * for those leaves. Read only by isLeavingClaim.
	 */
	leaving?: ReadonlyMap<string, readonly string[]>;
}

/**
 * Whether ink `id`'s claim on the deleted path is a found ink's that is to leave it, its leave owed off the path, while
 * an ink that keeps the path for that leave has a claim on it too, the deleted file's. That claim is the leave's, not
 * another copy's: it names no new path for the ink and ties nothing with the kept ink's claim, at an open or at the
 * retirement. The found ink follows the kept ink, and its leave runs there.
 */
export function isLeavingClaim(
	w: WaitingDeletion,
	deleted: string,
	id: string,
	claimsOf: (id: string) => readonly string[] | undefined
): boolean {
	const kept = w.leaving?.get(id);
	return kept !== undefined && kept.some((k) => k !== id && isDeletedClaim(w, k) && claimsOf(k)?.includes(deleted) === true);
}

/**
 * Whether `path` may be a new name for a waiting deletion's ink: it did not exist at the delete and, once the
 * deletion's retirement has deferred, it was new then. A path created after the defer is not new for it, at a
 * retry or at an open; the retirement and every open ask this, and only this.
 */
export function isNewFor(w: { existing: ReadonlySet<string>; newAtDefer?: ReadonlySet<string> | undefined }, path: string): boolean {
	return !w.existing.has(path) && (w.newAtDefer === undefined || w.newAtDefer.has(path));
}

/**
 * Whether ink id `id`'s claim on a waiting deletion's path is the deleted file's. Not when it arrived with the file
 * renamed onto the path, nor when it is of that file's bytes and that file came with no ink of its own. Every reader
 * of "the deleted file's claim" asks this, and only this: the open, its count, adoption, the carry, a rename off and
 * the retirement.
 */
export function isDeletedClaim(w: WaitingDeletion, id: string): boolean {
	return !w.arrived.has(id) && (w.ontoFamily === undefined || familyOf(id) !== w.ontoFamily);
}

/** An ink file's claim on a deleted path whose deletion is in its grace. */
export interface WaitingClaim {
	id: string;
	deleted: string;
}

/** The key a waiting claim is paired by. */
export function waitingKey(c: WaitingClaim): string {
	return `${c.id}\n${c.deleted}`;
}

/**
 * Every waiting claim of a content family: each claim an ink file of the
 * family holds on a path whose deletion waits, unless the id arrived there
 * with a file renamed onto it, nor a found ink's claim that is to leave the
 * path (isLeavingClaim). An open and the retirement count these, and only
 * these, so the two cannot name different inks for one path. `counted`: the
 * one found ink whose leaving claims count anyway, as before the leave was
 * owed; the retirement's own walk of that ink, once the ink that keeps the
 * path did not move.
 */
export function waitingClaims(
	family: string,
	claims: Iterable<readonly [string, readonly string[]]>,
	waiting: ReadonlyMap<string, WaitingDeletion>,
	counted?: string
): WaitingClaim[] {
	const all = [...claims];
	const byId = new Map(all);
	const out: WaitingClaim[] = [];
	for (const [id, paths] of all) {
		if (familyOf(id) !== family) continue;
		for (const deleted of new Set(paths)) {
			const w = waiting.get(deleted);
			if (!w || !isDeletedClaim(w, id)) continue;
			if (id !== counted && isLeavingClaim(w, deleted, id, (k) => byId.get(k))) continue;
			out.push({ id, deleted });
		}
	}
	return out;
}

/**
 * Whether these waiting claims pair by name: two or more of them, or one
 * whose deletion was paired. The one predicate an open uses both to read the
 * vault's new paths and to pair, and the retirement to choose its road.
 */
export function pairsByName(claims: readonly WaitingClaim[], waiting: ReadonlyMap<string, WaitingDeletion>): boolean {
	return claims.length >= 2 || claims.some((c) => waiting.get(c.deleted)?.paired === true);
}

/**
 * The paths offered to each waiting claim: every path in `now` new for it
 * (isNewFor) that no other ink file claims, of any family, and the paths a
 * tied open holds for it.
 *
 * A claim one of whose held paths is not in `now` holds every path offered to
 * it (holdsAll). The hold follows a rename this plugin hears; one it did not
 * hear (Obsidian closed, the plugin off) leaves the hold on a name that is
 * gone, and the copy it held may be any of the new paths, under a name that
 * pairs. Wrong ink is worse than none. Read at each use, on the list the open
 * or the retirement takes, never once at the restore: the vault is still
 * filling its list when the plugin loads.
 */
export function offeredPaths(
	claims: readonly WaitingClaim[],
	now: readonly string[],
	inkClaims: ReadonlyMap<string, readonly string[]>,
	waiting: ReadonlyMap<string, WaitingDeletion>
): DeletedClaim[] {
	const claimers = new Map<string, Set<string>>();
	for (const [id, paths] of inkClaims) {
		for (const p of paths) {
			let ids = claimers.get(p);
			if (!ids) claimers.set(p, (ids = new Set()));
			ids.add(id);
		}
	}
	const claimedByOther = (id: string, q: string) => [...(claimers.get(q) ?? [])].some((other) => other !== id);
	const listed = new Set(now);
	return claims.map((c) => {
		const w = waiting.get(c.deleted)!;
		const holdsAll = [...w.held].some((q) => !listed.has(q));
		return {
			key: waitingKey(c),
			deleted: c.deleted,
			fresh: now.filter((q) => isNewFor(w, q) && (!claimedByOther(c.id, q) || w.held.has(q))),
			...(holdsAll ? { holdsAll: true } : {}),
		};
	});
}

/**
 * Pairs the offered paths `isFamily` takes as this family's
 * (pairDeletedClaims), then drops a pair onto a path held for its claim, or
 * any pair of a claim that holds all: that claim pairs nothing lower.
 */
export function pairWaiting(
	offered: readonly DeletedClaim[],
	isFamily: (path: string) => boolean,
	waiting: ReadonlyMap<string, WaitingDeletion>
): Map<string, string> {
	const pairs = pairDeletedClaims(offered.map((o) => ({ ...o, fresh: o.fresh.filter(isFamily) })));
	for (const o of offered) {
		const q = pairs.get(o.key);
		if (q !== undefined && (o.holdsAll === true || waiting.get(o.deleted)?.held.has(q))) pairs.delete(o.key);
	}
	return pairs;
}

/**
 * The vault's PDF paths now, the family read for each path offered to a
 * waiting claim, and every ink file's claims, read for an open that pairs by
 * name (PdfClaims.resolvePdfId).
 */
export interface FreshPaths {
	paths: readonly string[];
	/** An offered path absent here could not be read: it decides nothing (chooseInstance tries it both ways). */
	families: ReadonlyMap<string, string | null>;
	/** Every ink file's claims, of any family, as the retirement counts them (PdfInkStore.inkClaims). */
	claims: ReadonlyMap<string, readonly string[]>;
}

/**
 * A sidecar whose every path has gone, one of them inside a grace that began
 * before `path` existed, and, once that deletion deferred, `path` was new for
 * it then (isNewFor). A path another file was renamed onto in its deletion's
 * grace has gone for an ink file that did not arrive there with it. A found ink's claim that is to leave the deleted
 * path (isLeavingClaim) adopts nothing: the ink that keeps the path does, and the found ink follows it.
 */
function adoptsPending(
	c: InstanceClaim,
	path: string,
	exists: (path: string) => boolean,
	waiting: ReadonlyMap<string, WaitingDeletion>,
	claimsOf: (id: string) => readonly string[] | undefined
): boolean {
	const gone = (p: string) => {
		const w = waiting.get(p);
		return !exists(p) || (w !== undefined && w.existing.has(p) && isDeletedClaim(w, c.id));
	};
	return (
		c.paths.every(gone) &&
		c.paths.some((p) => {
			const w = waiting.get(p);
			return w !== undefined && isDeletedClaim(w, c.id) && isNewFor(w, path) && !isLeavingClaim(w, p, c.id, claimsOf);
		})
	);
}

/**
 * The waiting claims an open of a family counts: those of every ink file of
 * the family, as the retirement counts them, one another pane is opening now
 * among them.
 */
function waitingAtOpen(
	family: string,
	candidates: readonly InstanceClaim[],
	waiting: ReadonlyMap<string, WaitingDeletion>
): WaitingClaim[] {
	return waitingClaims(family, candidates.map((c) => [c.id, c.paths] as const), waiting);
}

/**
 * The open pairs by name (pairsByName), so chooseInstance needs the vault's
 * new paths, their families and every ink file's claims. Otherwise it needs
 * none of them, and an ordinary open lists and reads nothing.
 */
export function mayPairOnOpen(
	family: string,
	candidates: readonly InstanceClaim[],
	waiting: ReadonlyMap<string, WaitingDeletion>
): boolean {
	return pairsByName(waitingAtOpen(family, candidates, waiting), waiting);
}

/**
 * Which paths the caller must read the family of before chooseInstance can
 * pair `path`: none unless the open pairs by name; else every other path
 * offered to a waiting claim, the set the retirement reads.
 */
export function familiesToReadForOpen(
	family: string,
	path: string,
	candidates: readonly InstanceClaim[],
	waiting: ReadonlyMap<string, WaitingDeletion>,
	now: readonly string[],
	inkClaims: ReadonlyMap<string, readonly string[]>
): string[] {
	const claims = waitingAtOpen(family, candidates, waiting);
	if (!pairsByName(claims, waiting)) return [];
	const offered = offeredPaths(claims, now, claimsNamingInk(inkClaims, candidates), waiting);
	return [...new Set(offered.flatMap((o) => o.fresh))].filter((q) => q !== path);
}

/**
 * Every ink file's claims less those of a blank opened before the vault's list was full (InstanceClaim.beforeList),
 * as the retirement counts them (PdfInkStore.inkClaims).
 */
function claimsNamingInk(
	claims: ReadonlyMap<string, readonly string[]>,
	candidates: readonly InstanceClaim[]
): ReadonlyMap<string, readonly string[]> {
	const early = new Set(candidates.filter((c) => c.beforeList === true).map((c) => c.id));
	if (early.size === 0) return claims;
	return new Map([...claims].filter(([id]) => !early.has(id)));
}

/** Offered paths that could not be read are tried as this family and as not, up to this many; more decide nothing. */
const MOST_UNREAD_TRIED = 6;

/**
 * The ink an open that pairs by name gives `path`: the one the retirement
 * would pair it with, given the same claims and paths. `decided` is false
 * when a path that could not be read could change that answer.
 */
function namedForOpen(
	family: string,
	path: string,
	claims: readonly WaitingClaim[],
	waiting: ReadonlyMap<string, WaitingDeletion>,
	fresh: FreshPaths
): { decided: boolean; id?: string; heldFor?: string[] } {
	const offered = offeredPaths(claims, fresh.paths, fresh.claims, waiting);
	const idOf = new Map(claims.map((c) => [waitingKey(c), c.id]));
	const unread = [...new Set(offered.flatMap((o) => o.fresh))].filter((q) => q !== path && !fresh.families.has(q));
	if (unread.length > MOST_UNREAD_TRIED) return { decided: false };
	let answer: string | null | undefined;
	for (let mask = 0; mask < 1 << unread.length; mask++) {
		const assumed = new Set(unread.filter((_, i) => (mask >> i) & 1));
		const isFamily = (q: string) => q === path || fresh.families.get(q) === family || assumed.has(q);
		const pairs = pairWaiting(offered, isFamily, waiting);
		const key = offered.find((o) => pairs.get(o.key) === path)?.key;
		const id = key === undefined ? null : idOf.get(key)!;
		if (answer !== undefined && answer !== id) return { decided: false };
		answer = id;
	}
	if (answer) return { decided: true, id: answer };
	return { decided: true, heldFor: [...new Set(offered.filter((o) => o.fresh.includes(path)).map((o) => o.deleted))] };
}

/**
 * Which instance of a content family the file at `path` is.
 *
 * In order: a sidecar already claiming this path is simply this file. A
 * sidecar with NO claims is pre-1.4.3 data; the first opener adopts it,
 * which is the migration path. A sidecar whose every claimed path has
 * vanished from the vault belonged to a file that was renamed or moved -
 * the ink follows. And when every instance is claimed by a file that still
 * exists, this file is a fresh COPY, and a copy starts blank: that is the
 * whole point of instances.
 *
 * Pure - the vault reaches in only through `exists` - so every branch is
 * testable without a vault.
 */
export function chooseInstance(
	family: string,
	path: string,
	candidates: readonly InstanceClaim[],
	exists: (path: string) => boolean,
	/** The deletions in their grace (PdfInkStore.waitingDeletions). */
	waiting: ReadonlyMap<string, WaitingDeletion> = new Map(),
	/** Read when the open pairs by name (mayPairOnOpen, familiesToReadForOpen). */
	fresh?: FreshPaths,
	/**
	 * Names a deletion in its grace also takes off ink of this family, with no file there now (PdfInkStore oldNames),
	 * each with that deletion. Adoption reads them as it reads the deleted path; no count of waiting claims does, as the
	 * retirement counts none: the ink's claim on such a name is the same claim as the deleted path's.
	 */
	oldNames: ReadonlyMap<string, WaitingDeletion> = new Map()
): InstanceChoice {
	// A path deleted and then taken by another file's rename inside the grace is in its own deletion's list. The
	// deleted file's claim on it is not this file; an id that came with this file is used, and so, unless this file
	// came with ink of its own, is ink of this file's bytes: this open knows them, read or not at the deletion.
	const known = waiting.get(path);
	const renamedOnto = known?.existing.has(path) === true;
	if (renamedOnto && known.cameWithInk !== true && known.ontoFamily !== family) {
		waiting = new Map(waiting).set(path, { ...known, ontoFamily: family });
	}
	const here = waiting.get(path);
	const adoptWaiting = oldNames.size === 0 ? waiting : new Map([...oldNames, ...waiting]);
	const claimsHere = (c: InstanceClaim) => c.paths.includes(path) && (!renamedOnto || (here !== undefined && !isDeletedClaim(here, c.id)));
	for (const c of candidates) {
		if (c.beforeList !== true && claimsHere(c)) return { id: c.id, action: "use" };
	}
	const claims = waitingAtOpen(family, candidates, waiting);
	let heldFor: string[] | undefined;
	let marks: { pairedOver?: readonly string[] } = {};
	if (!pairsByName(claims, waiting)) {
		// One waiting claim, never paired: a sync rename may CREATE its new path before anyone opens it, and only a
		// path absent at deletion can take that ink; an older template cannot. As before, and nothing is listed or read.
		const claimsOf = (id: string) => candidates.find((c) => c.id === id)?.paths;
		const adopter = candidates.find((c) => adoptsPending(c, path, exists, adoptWaiting, claimsOf));
		if (adopter) return { id: adopter.id, action: "adopt" };
	} else {
		// Paired by name, as the retirement pairs them: with the same claims, paths and holds, an open gives a waiting
		// ink to this file where the retirement would, and nowhere else. Every claim it paired over stays paired,
		// whatever this open returns. Not named, this file opens blank, and holds its path for each claim it was
		// offered to: unless a path that could not be read could have named an ink, which leaves the retirement to
		// decide, holding nothing.
		marks = { pairedOver: [...new Set(claims.map((c) => c.deleted))] };
		// Before the vault lists every file, a path not listed yet could change the pairing: the open decides nothing,
		// names no ink and holds no path. A blank opened then names no ink for its own path either.
		const listFull = !claims.some((c) => waiting.get(c.deleted)?.beforeList === true);
		const named: { decided: boolean; id?: string; heldFor?: string[] } =
			fresh && listFull
				? namedForOpen(family, path, claims, waiting, { ...fresh, claims: claimsNamingInk(fresh.claims, candidates) })
				: { decided: false };
		if (named.id !== undefined) return { id: named.id, action: "adopt", ...marks };
		if (named.decided) heldFor = named.heldFor;
	}
	// A blank opened here before the list was full, no ink named for this path: it is this file.
	const early = candidates.find((c) => c.beforeList === true && claimsHere(c));
	if (early) return { id: early.id, action: "use" };
	for (const c of candidates) {
		if (c.paths.length === 0) return { id: c.id, action: "adopt", ...marks };
	}
	for (const c of candidates) {
		if (c.paths.every((p) => !exists(p) && !adoptWaiting.has(p))) return { id: c.id, action: "adopt", ...marks };
	}
	return {
		id: nextInstanceId(
			family,
			candidates.map((c) => c.id)
		),
		action: "fresh",
		...(heldFor && heldFor.length > 0 ? { heldFor } : {}),
		...marks,
	};
}
