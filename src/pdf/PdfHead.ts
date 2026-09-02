/**
 * Getting a PDF's first 64 KiB without reading the PDF.
 *
 * `resolvePdfId` (main.ts) did `await this.app.vault.readBinary(file)` - the
 * WHOLE document - and then handed it to `pdfInkId`, which hashes the head
 * and the byte length and throws the rest away. On a 200 MB scan that is
 * 200 MB into memory, on every open, to read 64 KiB of it.
 *
 * Obsidian's vault API has no ranged read. Desktop is Electron and has node
 * `fs`; mobile has neither, and keeps the whole-file read. So the read is
 * expressed as an injectable source with two ways to answer, and the caller
 * supplies whichever its platform actually has.
 *
 * The contract, which the tests pin:
 *
 * - The ranged source is tried when present, and reads at most HEAD_BYTES
 *   from offset 0.
 * - The byte length comes from the OPEN HANDLE's own stat, never from
 *   `TFile.stat.size`. The vault's cached size can lag the file on disk
 *   after an external write, and a length that disagrees with the bytes
 *   changes the id - which moves a document's ink to a sidecar that does
 *   not exist.
 * - The handle is closed in `finally`, on success and on throw alike.
 * - A ranged read that stops before it has the bytes the handle's own stat
 *   promised is a failure, not a short head: it falls back like a throw.
 * - On ANY throw the whole-file read runs instead, giving exactly the head
 *   and length the old code gave. A vault on a network share that refuses
 *   `open`, a path the runtime cannot express, a revoked permission: all of
 *   them cost the old read and none of them cost the ink.
 *
 * Nothing here touches Obsidian or node directly - that is the point. main.ts
 * builds the source; this file decides what a head IS.
 */

import { HEAD_BYTES, headOf } from "./PdfIdentity";

/** A PDF's head and the file's true length: everything the id needs. */
export interface PdfHead {
	head: Uint8Array;
	byteLength: number;
}

/**
 * An open file that can be read at an offset.
 *
 * Deliberately smaller than a node FileHandle: three methods, all of which a
 * test can fake, so the close-in-finally rule is provable without a disk.
 */
export interface RangedHandle {
	/** Fill `into` from file offset `at`; returns the bytes actually read. */
	read(into: Uint8Array, at: number): Promise<number>;
	/** This handle's own view of the file's size. Never a cached vault stat. */
	size(): Promise<number>;
	close(): Promise<void>;
}

/**
 * The two ways to reach a PDF's bytes.
 *
 * `openRanged` is absent on mobile and on any desktop build where `require`
 * is unavailable or the vault is not on a real filesystem; when it is absent
 * nothing about the read changes from 1.4.5. The path being read is closed
 * over by whoever builds the source, so this file never handles a path.
 */
export interface HeadSource {
	openRanged?: () => Promise<RangedHandle>;
	/** The whole file, as `readBinary` hands it back. Always present. */
	whole: () => Promise<ArrayBuffer | Uint8Array>;
}

/** The head of a fully-read file - the 1.4.5 path, unchanged. */
function wholeHead(bytes: ArrayBuffer | Uint8Array): PdfHead {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return { head: headOf(view), byteLength: view.length };
}

async function readRanged(handle: RangedHandle): Promise<PdfHead> {
	try {
		// Size first: it decides how much to ask for, and a file shorter than
		// the window must yield exactly its own bytes, not a zero-padded
		// buffer - a padded head hashes differently from the whole-file read
		// of the same file, which is the one thing that must never happen.
		const byteLength = await handle.size();
		const want = Math.min(HEAD_BYTES, Math.max(0, byteLength));
		const buf = new Uint8Array(want);
		let got = 0;
		// A single read is not guaranteed to fill the buffer, on any platform
		// that can return a short count. Loop until it stops making progress.
		while (got < want) {
			const n = await handle.read(buf.subarray(got), got);
			if (n <= 0) break;
			got += n;
		}
		// A read that stopped short is NOT a head. `want` came from this
		// handle's own stat, so the bytes exist; a zero return here is the
		// driver saying "not now" - a network share, a FUSE mount, a
		// OneDrive placeholder still being hydrated, rclone, DFS - and
		// hashing what did arrive mints a different id from the whole-file
		// read of the same file. That moves the document's ink to a sidecar
		// nothing looks in: it is all still on disk and none of it appears,
		// which is the worst shape a bug can have here. Throwing lands on
		// `readPdfHead`'s catch, which is exactly the fallback every other
		// failure in this function already takes.
		if (got < want) throw new Error(`pdf head read stopped at ${got} of ${want} bytes`);
		return { head: headOf(buf.subarray(0, got)), byteLength };
	} finally {
		// Best effort, and deliberately not allowed to fail the read: the
		// bytes are already in hand by the time this runs, and throwing away
		// a good head over a descriptor that would not close would spend the
		// whole-file read this function exists to avoid.
		try {
			await handle.close();
		} catch {
			// Nothing to do and nothing to tell the user.
		}
	}
}

/**
 * A PDF's head and length, by the cheapest route the platform offers.
 *
 * Every failure lands on the whole-file read, so the worst case is 1.4.5's
 * cost and the id is identical either way.
 */
export async function readPdfHead(src: HeadSource): Promise<PdfHead> {
	if (src.openRanged) {
		try {
			return await readRanged(await src.openRanged());
		} catch {
			// Includes a failure to open at all, where there is no handle to
			// close. Fall through to the read that always works.
		}
	}
	return wholeHead(await src.whole());
}
