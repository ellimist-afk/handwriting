/**
 * The paper's share of the text's pinch pan, as the stylesheet reads it.
 *
 * A repeating pattern moved by a whole number of pitches is the same pattern, so
 * the value is folded into [0, pitch) before it is written, keeping the gradient
 * stops within one period whatever the pan's size. Stored to the engine's 1/64 px
 * layout unit, as the paper's phase is. Without a usable pitch the value is only
 * stored to the layout unit.
 */
export function foldIntoPitch(v: number, pitch: number): number {
	if (!Number.isFinite(v)) return 0;
	if (!Number.isFinite(pitch) || pitch <= 0) return Math.round(v * 64) / 64;
	const r = v % pitch;
	// `+ 0` turns the -0 a whole negative multiple leaves into 0.
	const folded = r < 0 ? r + pitch : r + 0;
	const snapped = Math.round(folded * 64) / 64;
	return snapped >= pitch ? 0 : snapped;
}

/**
 * Why the preview paper came down; each path that ends its life names itself once. "input" is a contact (a pen-down
 * included) or a wheel while the paper rides a bounce.
 */
export type PreviewPaperEnd = "settle" | "bounce-end" | "cancel" | "commit" | "unmount" | "note-switch" | "input";

/** The computed style a preview paper is copied from: a `CSSStyleDeclaration`, or anything that reads like one. */
export type PreviewPaperSource = Pick<CSSStyleDeclaration, "getPropertyValue" | "backgroundImage" | "backgroundSize" | "backgroundPosition" |
	"backgroundRepeat" | "backgroundColor" | "backgroundOrigin" | "backgroundClip" | "backgroundAttachment">;

/**
 * The paper's pitch as the scroller resolves it, layout px, or null when it is not a px length. The property is not
 * registered, so its computed value is the text the cascade gave it: the overlay writes px, and a theme's `2.5rem` or
 * `calc(...)` stays that text, which parses to a number that is not the pitch.
 */
export function previewPaperPitch(cs: Pick<CSSStyleDeclaration, "getPropertyValue">): number | null {
	const text = cs.getPropertyValue("--handwriting-paper-pitch").trim();
	if (!/^(\d+\.?\d*|\.\d+)px$/.test(text)) return null;
	const pitch = Number.parseFloat(text);
	return Number.isFinite(pitch) && pitch > 0 ? pitch : null;
}

/** A paper phase as the scroller resolves it, layout px; 0 where it is not a px length (a theme's, which is not planned). */
export function previewPaperPhase(cs: Pick<CSSStyleDeclaration, "getPropertyValue">, name: "--handwriting-paper-phase" | "--handwriting-paper-phase-x"): number {
	const text = cs.getPropertyValue(name).trim();
	if (!/^-?(\d+\.?\d*|\.\d+)px$/.test(text)) return 0;
	const phase = Number.parseFloat(text);
	return Number.isFinite(phase) ? phase : 0;
}

/** The part of `v` past the whole number below it, in [0, 1); a value within a millionth of a whole number has none. */
export function fractionOf(v: number): number {
	if (!Number.isFinite(v) || Math.abs(v - Math.round(v)) < 1e-6) return 0;
	return v - Math.floor(v);
}

/**
 * Whether the scroller's background is the paper this overlay planned, drawn the way the preview paper can carry it: at
 * least one layer, every layer a gradient, every layer attached `local` (it scrolls with the text), and every layer on
 * the planned pitch - a repeating gradient whose period is the pitch, or a tile one pitch square.
 *
 * THE PITCH IS PART OF THE TEST, not a detail. The element's offset is folded by the pitch, which moves a pattern by a
 * whole number of ITS OWN periods only when the two agree. A theme that paints its own gradients on the scroller (the
 * cost harness's control arm is exactly that shape, 32 of them) would otherwise be picked up as paper and stepped
 * sideways by a fold that means nothing to it. Such a background is left to the scroller, which is what draws it today.
 */
export function previewPaperCopyable(cs: Pick<CSSStyleDeclaration, "backgroundImage" | "backgroundAttachment" | "backgroundSize">, pitch: number): boolean {
	const image = cs.backgroundImage.trim();
	if (!image || image === "none") return false;
	const layers = splitLayers(image);
	const attachments = splitLayers(cs.backgroundAttachment);
	const sizes = splitLayers(cs.backgroundSize);
	if (!layers.length || !attachments.length) return false;
	if (!attachments.every(a => a === "local")) return false;
	return layers.every((layer, i) => {
		if (/^repeating-(linear)-gradient\(/.test(layer)) return onPitch(periodOf(layer), pitch);
		// A tile: its size is the pitch square (the dots' own layer; `auto` is the untiled gradients' size, not a tile).
		if (/^radial-gradient\(/.test(layer)) {
			const size = (sizes[i] ?? sizes[0] ?? "").trim().split(/\s+/);
			return size.length === 2 && onPitch(Number.parseFloat(size[0]!), pitch) && onPitch(Number.parseFloat(size[1]!), pitch);
		}
		return false;
	});
}

/** A repeating linear gradient's period, px: its last stop less its first. */
function periodOf(layer: string): number {
	const stops = [...layer.matchAll(/(-?\d*\.?\d+)px/g)].map(m => Number(m[1]));
	return stops.length >= 2 ? stops[stops.length - 1]! - stops[0]! : Number.NaN;
}
const onPitch = (v: number, pitch: number) => Number.isFinite(v) && Math.abs(v - pitch) <= 1 / 32;

/**
 * The scroller's resolved background onto the preview paper. Attachment stays the element's own: it does not scroll.
 *
 * `extra` is a SECOND element whose layers join the first's, in that order - grid paper's vertical rules,
 * which live on their own box inside the scroller because two repeating gradients on one large box lose the first
 * layer's rules. The preview's own box is the pane plus a pitch of margin, a shape measured clean with both layers
 * on it, so the copy carries the axes together and the gesture sees one paper.
 */
export function copyPreviewPaperBackground(el: { style: Pick<CSSStyleDeclaration, "backgroundImage" | "backgroundSize" | "backgroundPosition" |
	"backgroundRepeat" | "backgroundColor" | "backgroundOrigin" | "backgroundClip"> }, cs: PreviewPaperSource, extra?: PreviewPaperSource | null): void {
	const join = (a: string, b: string): string => (extra ? `${a}, ${b}` : a);
	el.style.backgroundImage = join(cs.backgroundImage, extra?.backgroundImage ?? "");
	el.style.backgroundSize = join(cs.backgroundSize, extra?.backgroundSize ?? "");
	el.style.backgroundPosition = join(cs.backgroundPosition, extra?.backgroundPosition ?? "");
	el.style.backgroundRepeat = join(cs.backgroundRepeat, extra?.backgroundRepeat ?? "");
	el.style.backgroundColor = cs.backgroundColor;
	el.style.backgroundOrigin = join(cs.backgroundOrigin, extra?.backgroundOrigin ?? "");
	el.style.backgroundClip = join(cs.backgroundClip, extra?.backgroundClip ?? "");
}

/** Top-level comma-separated layers of a computed background value; commas inside parentheses belong to their layer. */
function splitLayers(value: string): string[] {
	const out: string[] = [];
	let depth = 0, start = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === "(") depth++;
		else if (c === ")") depth = Math.max(0, depth - 1);
		else if (c === "," && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1; }
	}
	const last = value.slice(start).trim();
	if (last) out.push(last);
	return out;
}
