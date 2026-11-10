/**
 * Which pointer event feeds ink (handoff: the iOS port).
 *
 * The inline surface inks from `pointerrawupdate`, and WebKit never fires
 * it: on an iPad the plugin installed clean, captured the pen, and drew the
 * first and last point of every stroke. The samples in between only exist
 * there inside `pointermove`'s coalesced list (hardware report 2026-08-25:
 * 0 raw in 303 moves, up to 4 coalesced per move). So when raw is absent,
 * the move stream has to carry the ink.
 *
 * THE MODE IS OBSERVED, NOT FEATURE-DETECTED, for the reason documented at
 * length in PlatformCapabilities.ts: `"onpointerrawupdate" in window` is
 * false on the Chromium this plugin ships for. A platform check would lie
 * too: Obsidian on Android is a Chromium webview where raw fires fine. The
 * only honest signal is an arrival.
 *
 * PER STROKE. The router listens for raw only while a stroke is in flight
 * (a hovering pen with a raw listener costs a raw dispatch every 4 ms; with
 * none, Chromium sends no raw at all). So the listener is new at every
 * claim, and the browser learns of it a few ms later: each stroke's first
 * samples can arrive as moves before its raw stream starts. Moves therefore
 * feed every stroke until that stroke's own first raw. On WebKit no raw
 * ever comes and moves carry the whole stroke, as before.
 *
 * The timestamp gate makes every ordering correct: each stroke feeds a
 * sample once, whichever event delivers it first, and duplicates drop by
 * timestamp. A raw flushing samples the moves already fed drops them; a
 * withheld-then-flushed cold strike is the same case. It also discards
 * approach-hover samples WebKit may fold into the first move's coalesced
 * list (stamped before the down).
 *
 * Split the way GuardStyle and PlatformCapabilities are split: no obsidian
 * import, no DOM types beyond the numbers themselves, loads under vitest.
 * The router owns the events; this class owns the decision.
 */

/** What the owner does at a stroke's start and end: the router binds and unbinds its raw listener here. */
export interface InkFeedHooks {
	strokeStarted?(): void;
	strokeEnded?(): void;
}

export class InkFeedArbiter {
	/** Set by this stroke's first pen `pointerrawupdate`, cleared at every stroke start. */
	private rawThisStroke = false;
	/** Newest timestamp fed to ink this stroke. */
	private lastFedTs = Infinity;

	constructor(private readonly hooks: InkFeedHooks = {}) {}

	/** A pen raw arrived: from here this stroke inks from raw. */
	noteRawChannel(): void {
		this.rawThisStroke = true;
	}

	/** True while ink must come from `pointermove` (no raw yet this stroke). */
	moveFeedsInk(): boolean {
		return !this.rawThisStroke;
	}

	/**
	 * Stroke start. Samples at or before the down timestamp never ink;
	 * the down itself is delivered separately by onPenDown.
	 */
	strokeStart(downTs: number): void {
		this.lastFedTs = downTs;
		this.rawThisStroke = false;
		this.hooks.strokeStarted?.();
	}

	/** No stroke in flight: nothing feeds until the next strokeStart. */
	strokeEnd(): void {
		this.lastFedTs = Infinity;
		this.hooks.strokeEnded?.();
	}

	/**
	 * Gate one event's coalesced timestamps. Returns the indices whose
	 * samples ink now, in order, and advances the stroke's high-water mark.
	 * The raw path runs through here too, so the feed has one authority.
	 *
	 * The floor is taken once per event: WebKit quantizes timestamps, and
	 * two real samples inside one coalesced list may share a stamp. Both
	 * ink. Only a stamp at or below a PREVIOUS event's high-water mark is
	 * a duplicate delivery, and those drop.
	 */
	feed(timestamps: readonly number[]): number[] {
		const floor = this.lastFedTs;
		let hi = floor;
		const out: number[] = [];
		for (let i = 0; i < timestamps.length; i++) {
			const ts = timestamps[i];
			if (ts !== undefined && ts > floor) {
				out.push(i);
				if (ts > hi) hi = ts;
			}
		}
		this.lastFedTs = hi;
		return out;
	}
}
