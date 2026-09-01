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
 *
 * 1.4.5: on by default after all. The e-ink case above has its own switch
 * now (Boox mode, which predicts with e-ink caps), so the default no longer
 * has to protect it - and a Surface owner on 1.4.4 reported the line behind
 * the nib when the fix was a toggle they had no reason to know about.
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

/**
 * Boox mode's revision of the e-ink judgement above: the default horizon is
 * invisible inside e-ink's delivery delay, not harmful - the first NoteAir
 * trace measured events arriving 58-103ms late, and 12ms of prediction
 * inside that hole is nothing. So Boox mode runs prediction WITH e-ink
 * sized caps (EINK_CAPS) instead of leaving it off; the wrongness guards
 * are unchanged, only the horizon grows.
 */
let eink = false;

export function setPredictionEink(on: boolean): void {
	eink = on;
}

export function predictionEinkOn(): boolean {
	return eink;
}
