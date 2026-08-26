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
 * only honest signal is an arrival. One pen raw of any kind, hover
 * included, proves the channel exists, and on Chromium the approach hover
 * latches it before the first stroke of a session ever starts.
 *
 * The latch alone leaves one race: the session's first stroke on Chromium,
 * cold strike, zero prior hover. Raw is withheld during gesture arbitration
 * and flushed later; if a frame-aligned move ever dispatched out of that
 * flush ahead of the first raw, it would feed samples the raw is about to
 * feed again. The timestamp gate makes every ordering correct: each stroke
 * feeds a sample once, whichever event delivers it first, and duplicates
 * drop by timestamp. It also discards approach-hover samples WebKit may
 * fold into the first move's coalesced list (stamped before the down).
 *
 * Split the way GuardStyle and PlatformCapabilities are split: no obsidian
 * import, no DOM types beyond the numbers themselves, loads under vitest.
 * The router owns the events; this class owns the decision.
 */

export class InkFeedArbiter {
	/** Latched for the session by the first pen `pointerrawupdate`. */
	private rawChannelSeen = false;
	/** Newest timestamp fed to ink this stroke. */
	private lastFedTs = Infinity;

	/** Any pen raw, hover or stroke, proves the channel. */
	noteRawChannel(): void {
		this.rawChannelSeen = true;
	}

	/** True while ink must come from `pointermove` (no raw ever seen). */
	moveFeedsInk(): boolean {
		return !this.rawChannelSeen;
	}

	/**
	 * Stroke start. Samples at or before the down timestamp never ink;
	 * the down itself is delivered separately by onPenDown.
	 */
	strokeStart(downTs: number): void {
		this.lastFedTs = downTs;
	}

	/** No stroke in flight: nothing feeds until the next strokeStart. */
	strokeEnd(): void {
		this.lastFedTs = Infinity;
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
