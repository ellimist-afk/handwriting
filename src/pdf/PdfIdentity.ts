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
}

export type InstanceChoice =
	| { id: string; action: "use" }
	/** Adopt: write `path` into this sidecar's claims (legacy or renamed). */
	| { id: string; action: "adopt" }
	/** A fresh copy: a new blank instance under this id. */
	| { id: string; action: "fresh" };

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
	exists: (path: string) => boolean
): InstanceChoice {
	for (const c of candidates) {
		if (c.paths.includes(path)) return { id: c.id, action: "use" };
	}
	for (const c of candidates) {
		if (c.paths.length === 0) return { id: c.id, action: "adopt" };
	}
	for (const c of candidates) {
		if (c.paths.every((p) => !exists(p))) return { id: c.id, action: "adopt" };
	}
	return {
		id: nextInstanceId(
			family,
			candidates.map((c) => c.id)
		),
		action: "fresh",
	};
}
