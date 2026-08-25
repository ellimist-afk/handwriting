/**
 * The one thing a pinch is allowed to change: Obsidian's base font size, the
 * same value its own quick-adjust (Ctrl+scroll) moves.
 *
 * That setting is not in Obsidian's public API, so the plugin never reaches
 * for it directly. `main.ts` attaches a host that knows how to read and write
 * it, wrapped so a future Obsidian that renames or removes the call makes
 * pinch do nothing at all instead of throwing on the input path.
 */

export interface FontZoomHost {
	/** Current base font size in px, or null when it cannot be read. */
	read(): number | null;
	/** Apply a new base font size in px. */
	write(px: number): void;
}

let host: FontZoomHost | null = null;
let lastWritten: number | null = null;

export function attachFontZoomHost(next: FontZoomHost | null): void {
	host = next;
	lastWritten = null;
}

export function readBaseFontPx(): number | null {
	if (!host) return null;
	try {
		const px = host.read();
		return typeof px === "number" && Number.isFinite(px) && px > 0 ? px : null;
	} catch {
		return null;
	}
}

/**
* Write a size, skipping the write when it would not change anything. A pinch
 * samples at input rate but only crosses an integer font size occasionally,
 * and every real write costs a full editor reflow.
 *
 * Returns true when a write actually happened, so the caller knows to rescale.
 */
export function writeBaseFontPx(px: number): boolean {
	if (!host) return false;
	if (!Number.isFinite(px) || px <= 0) return false;
	if (lastWritten === px) return false;
	lastWritten = px;
	try {
		host.write(px);
		return true;
	} catch {
		/* a pinch that cannot resize is a pinch that does nothing */
		return false;
	}
}
