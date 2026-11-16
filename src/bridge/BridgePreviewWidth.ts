/**
 * How wide the companion should draw its line while the pen is down.
 *
 * The companion's line is one constant width; the stroke that replaces it at
 * pen-up is not. Its width follows pressure (`widthForPressure`), thins with
 * speed (InkShape.ts) and tapers at both ends, so it is almost never as wide
 * as the nib that was selected. Telling the companion the selected nib made
 * its line much the lighter of the two, and the writing visibly gained weight
 * each time the pen lifted.
 *
 * So the companion is told the width a stroke ordinarily comes out at: the
 * style's own law at an ordinary pressure, times an ordinary share left by
 * speed thinning. With pressure sensitivity off the law ignores the pressure
 * and the same sum still holds.
 *
 * Pure: no `obsidian` import, no DOM.
 */
import { EXP7_PEN, widthForPressure } from "../ink/PenStyle";

/**
 * The pressure ordinary handwriting sits near, after the device gain. Set by
 * eye on a Note Mini C (2026-11-15), where strokes peaked at 0.55 to 0.8 of
 * the digitizer's range: at 0.6 the line and the stroke that replaced it
 * weighed the same.
 */
export const PREVIEW_PRESSURE = 0.6;

/** The share of its width a stroke keeps at ordinary writing speed (`thinningK`, InkShape.ts). */
export const PREVIEW_SPEED_FACTOR = 0.85;

/**
 * `baseWidth` is the nib a pen stroke would be built with; the result is in
 * the same units. The law is the one StrokeBuilder gives every new pen
 * stroke (exp7), under which a firm hand draws well over the nominal nib.
 */
export function bridgePreviewWidth(baseWidth: number): number {
	return widthForPressure({ ...EXP7_PEN, baseWidth }, PREVIEW_PRESSURE) * PREVIEW_SPEED_FACTOR;
}
