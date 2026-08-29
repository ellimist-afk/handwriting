/**
 * The stroke prediction switch.
 *
 * Ink is on the canvas ~1.5ms after the pen moves and ~23ms before it reaches
 * the screen (measured, alan's hardware, 2026-08-28). Almost none of that is
 * ours: the event is already ~1.5ms old on arrival, drawing costs 0.06ms, and
 * the rest is the compositor and the panel. No amount of faster code touches
 * it. The only way past a delay you cannot shorten is to draw slightly ahead
 * of it - which is what Prediction.ts does, and this is its switch.
 *
 * OFF by default, and that default is a judgement rather than caution:
 *
 * Prediction trades correctness for perceived speed. The caps in
 * Prediction.ts keep the trade small - the horizon scales to zero as the path
 * bends, so corners do not grow hooks, and a parked pen is left alone so slow
 * movement does not jitter - but small is not none. What a user can still
 * see is the line flicking a little past a sharp corner before it is
 * corrected, on fast handwriting.
 *
 * And the whole scheme rests on one assumption: that a wrong guess can be
 * erased before the eye registers it. An e-ink panel cannot do that. The
 * erase is itself a refresh, so instead of a whisker that never quite
 * existed, a Boox user gets a visible artifact and an extra refresh for it.
 * Handwriting has e-ink users - the Onyx Boox reports of 2026-08-27 - and
 * defaulting this on would be shipping them a downgrade they never asked for.
 *
 * So: on for whoever wants it, after feeling both, on their own hardware.
 * `predCorrectionPx` in the ink metrics reports how far wrong the guesses
 * actually were, so the question can be answered with a number instead of an
 * impression.
 *
 * DiagSwitch's shape: module state, two functions, no obsidian import - the
 * same as MouseInk next door.
 */

let enabled = false;

export function predictionEnabled(): boolean {
	return enabled;
}

export function setPrediction(on: boolean): void {
	enabled = on;
}
