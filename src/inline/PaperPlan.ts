/**
 * Lined, grid and dotted paper, as arithmetic.
 *
 * The paper scales with the text, like graph paper: zooming out packs the
 * lines together, even past legibility, zooming in spreads them apart, and a
 * plain scroll changes nothing. The paper is a gradient on the note's scroller,
 * sized in the scroller's layout px, with local attachment. On the zoom host
 * the CSS zoom, and any scale the host is under, already scale that background
 * with the note, so the pitch never takes the zoom and a pinch never moves
 * the paper. The one scale the background does not get for free is the text size
 * (quick font size is a reflow, not a zoom), so that is their input. The zoom
 * reaches only the thickness of rules and dots, which never go under one
 * device px: zoomed far out the paper is a dense even texture, never lines
 * that vanish.
 *
 * Inputs
 *   textFontPx  the editor text's computed font size, as the refresh path and
 *               the camera sync already read it. Absolute, not relative to the
 *               size the editor had when the overlay mounted: a note opened
 *               while the font is already enlarged, or a plugin reload then,
 *               still gets paper at the text's size. Sets the thickness; sets
 *               the pitch only when there is no row height.
 *   textRowPx   the height of one plain body row, in layout px, read where the
 *               font is read (paperRowPx): the lines follow the text's rows, so
 *               at Obsidian's 16 px and 1.5 they are 24 px apart. NaN when no
 *               row height could be read.
 *   originY     the note origin's y in the gradient's positioning area (the
 *               scroller's padding box), in layout px; null when unknown, and
 *               then no phase is planned and the caller keeps the last one.
 *   devicePx    device px per layout px: the dpr times the zoom the host is
 *               meant to be at (the intended zoom, not a measured read-back).
 *
 * Scale  s = textFontPx / 16, 16 px being Obsidian's default text size.
 * Pitch  textRowPx, to 1/64 layout px: each rule's bottom edge on a plain
 *        row's bottom edge. With no row height, 28 x s, the older grid at the
 *        text's size. Dots tile one pitch square, and the engine stores a
 *        tile's size in its 1/64 px layout unit, so a pitch that is no whole
 *        number of that unit (30.8 at 17.6 px text) put each dot row a little
 *        off the one before, 10 px by 100000 px down a note. Exact already at
 *        16, 20 and 24 px text. Set here, at the text scale, so a zoom never
 *        moves it.
 * Rule   paperThickness("rule", s, devicePx) = s where s covers a device px,
 *        else RULE_FLOOR_DEVICE_PX / devicePx: one layout px at the text's
 *        size, and a little over one device px where that falls under one.
 * Dot    paperThickness("dot", s, devicePx) = max(s, sqrt(2)/2 / devicePx): the
 *        dot's solid radius, floored at the smallest disc that always holds a
 *        pixel centre; its soft edge is 1.5 times it.
 * Phase  originY mod pitch, put on the device px grid at the intended zoom
 *        (round(phase x devicePx) / devicePx), then in [0, pitch) to 1/64 layout
 *        px (the engine's layout unit): each rule's bottom edge sits on the
 *        note origin, within half a device px. Where the pitch is a whole
 *        number of device px every rule then sits on pixel edges and paints one
 *        crisp row; left off the grid, every rule shared one sub-pixel position
 *        and a half-px one could lose them all. The x phase is planned the same
 *        way from the text column's left edge.
 *
 * All are layout px, written as custom properties on the editor; the stylesheet
 * builds lined, grid and dotted paper from them. Nothing is rounded but the
 * phase: a thickness and the phase are pure functions of the text size, the
 * origin and the intended zoom, so a commit at the same zoom plans exactly the
 * value it already wrote.
 */

export const BASE_PITCH = 28;
/** Obsidian's default text size: the size at which the fallback pitch (no row height read) is 28 px. */
export const BASE_FONT_PX = 16;

/** The engine's layout unit: positions are stored to 1/64 px. */
const LAYOUT_UNIT = 64;

export interface PaperPlan {
	pitch: number;
	rule: number;
	dot: number;
	phase: number | null;
	/** The vertical rules' and the dots' phase from the text column's left edge; null when no column was given. */
	phaseX: number | null;
}

export type PaperMark = "rule" | "dot";

const toLayoutUnit = (px: number): number => Math.round(px * LAYOUT_UNIT) / LAYOUT_UNIT;

/**
 * A rule's floor in device px, where its literal width falls under one. A band exactly one device px wide whose stops
 * both sit on pixel centres covers no pixel centre, and the rasteriser paints nothing: zoomed out, where rules cycle
 * through sub-pixel positions, a few rules in some note placements vanished. A sixty-fourth more always holds a centre
 * strictly inside; the price is a rule two rows tall where its bottom stop falls just past a centre. A literal rule
 * that already covers a device px keeps its width, so 100 percent on dpr 1 and 50 percent on dpr 2 draw as before:
 * there every rule shares one sub-pixel position, and a floor would double every rule on the page at once.
 */
export const RULE_FLOOR_DEVICE_PX = 1 + 1 / 64;

/**
 * The thickness policy, for every paper kind: a rule's width, or a dot's solid
 * radius, in layout px. Literal, the same factor as the text, and never under
 * what covers one device px at `devicePx` device px per layout px (a pixel
 * centre for a dot). With no usable device ratio, the literal thickness.
 */
export function paperThickness(mark: PaperMark, textScale: number, devicePx: number): number {
	const literal = 1 * textScale;
	if (!Number.isFinite(devicePx) || devicePx <= 0) return literal;
	if (mark === "dot") return Math.max(literal, Math.SQRT1_2 / devicePx);
	return literal * devicePx >= 1 ? literal : RULE_FLOOR_DEVICE_PX / devicePx;
}

/**
 * One plain body row's height in layout px: the editor content's computed line height when it is a px length (the
 * content's own style is the body text's, so a heading on line 1 never sets it); CodeMirror's measured default line
 * height when it is not ("normal"); NaN when neither is usable, and the plan falls back to 28 x font / 16.
 */
export function paperRowPx(lineHeight: string | undefined, defaultLineHeight?: number): number {
	const px = lineHeight !== undefined && /px$/.test(lineHeight.trim()) ? Number.parseFloat(lineHeight) : Number.NaN;
	if (Number.isFinite(px) && px > 0) return px;
	return defaultLineHeight !== undefined && Number.isFinite(defaultLineHeight) && defaultLineHeight > 0 ? defaultLineHeight : Number.NaN;
}

export function paperPlan(textFontPx: number, noteOriginY: number | null, devicePx: number, noteOriginX: number | null = null, textRowPx = Number.NaN): PaperPlan | null {
	if (!Number.isFinite(textFontPx) || textFontPx <= 0) return null;
	const scale = textFontPx / BASE_FONT_PX;
	const pitch = toLayoutUnit(Number.isFinite(textRowPx) && textRowPx > 0 ? textRowPx : BASE_PITCH * scale);
	return { pitch, rule: paperThickness("rule", scale, devicePx), dot: paperThickness("dot", scale, devicePx), phase: wrapPhase(noteOriginY, pitch, devicePx), phaseX: wrapPhase(noteOriginX, pitch, devicePx) };
}

/**
 * An origin folded into [0, pitch), put on the device px grid, then to the layout unit; null for no origin. The paper's
 * origin is the text's, on both axes. With no usable device ratio, the fold alone.
 */
function wrapPhase(origin: number | null, pitch: number, devicePx: number): number | null {
	if (origin === null || !Number.isFinite(origin)) return null;
	const folded = ((origin % pitch) + pitch) % pitch;
	const onGrid = Number.isFinite(devicePx) && devicePx > 0 ? Math.round(folded * devicePx) / devicePx : folded;
	const wrapped = toLayoutUnit(onGrid);
	return wrapped >= toLayoutUnit(pitch) ? 0 : wrapped;
}
