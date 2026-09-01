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
 * A PDF's sidecar id.
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
export async function pdfInkId(bytes: ArrayBuffer | Uint8Array, crypto?: Crypto): Promise<string> {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const input = idInput(headOf(view), view.length);
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
