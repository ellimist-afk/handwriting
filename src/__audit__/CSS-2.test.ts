/**
 * AUDIT PROBE CSS-2 (1.4.21, tag 1a05f62c). Read-only probe, lens EXECUTION.
 *
 * Claim: the note zoom bar is placed by one fixed rule (styles.css:3126,
 * top:52px right:8px z-index:30) in the same parent as the pen strip and the
 * collapsed pill (z-index 12). On Android the strip is moved to top 48 and
 * the pill to top 55 / right 15, so the bar sits over the strip's right end
 * and completely over the pill, and a tap on the pill lands on Fit.
 *
 * Part A runs the REAL MobileTools on the shared fake DOM
 * (src/testUtils/fakeDom.ts): one parent holds bar, pill and strip; with
 * Infinite Canvas on and the default "auto" mode the bar shows while the
 * strip is collapsed to the pill (InkOverlay.ts:3210 collapses it on every
 * note switch); nothing gives the bar a corner class or inline placement;
 * the bar's 4th button runs fitHandwriting.
 * Part B reads the REAL styles.css with postcss and resolves, per element and
 * body class set, the declarations that place these boxes (class/tag
 * compounds and descendant combinators only; anything else that names the
 * element and sets a placing property is reported and must be empty). The
 * suite has no layout engine, so box extents are summed from the declared px
 * values, using only LOWER bounds for the bar (min-width, fixed height).
 * env() insets are 0 (the stylesheet's own comment: android tablets and
 * non-notched ipads report none). Host (Obsidian app.css) rules are not
 * loaded; the one known host rule on buttons only widens the bar.
 * Controls: desktop and iPad must come out clear, so a red on Android is a
 * red on the geometry, not on the arithmetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import css from "../../styles.css?raw";
import postcss from "postcss";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { MobileTools, type MobileToolsHost } from "../inline/MobileTools";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import {
	getNoteZoomControlsMode,
	resetNoteZoomControlsForTest,
	setZoomBarCanvasEnabled,
} from "../inline/NoteZoomControlsMode";
import { setCanvasNoteOverrideForTest } from "../inline/CanvasNoteOverride";
import { clearToolPicked } from "../inline/MouseInk";
import { penInkEnabled } from "../inline/PenInk";
import { DEFAULT_TOOLBAR_CORNER } from "../inline/ToolbarCorner";

// Copied from src/inline/MobileTools.test.ts's fakeHost, phone arm (hasTouch).
const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	hasTouch: () => true,
	...over,
});

// ------------------------------------------------------------ CSS resolver
interface N {
	tag: string;
	classes: Set<string>;
}
interface Hit {
	prop: string;
	value: string;
	important: boolean;
	spec: number;
	order: number;
	sel: string;
	line: number | undefined;
}
const PLACING = ["top", "right", "bottom", "left", "inset", "position", "z-index", "transform", "translate", "margin-top", "margin-right", "display"];
const sheet = postcss.parse(css);

function compound(s: string): { tag: string | null; classes: string[] } | null {
	const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(s);
	if (!m || s === "") return null;
	return { tag: m[1] ?? null, classes: (m[2] ?? "").split(".").filter(Boolean) };
}
function hits(c: { tag: string | null; classes: string[] }, n: N): boolean {
	return (!c.tag || c.tag === n.tag) && c.classes.every((k) => n.classes.has(k));
}
/** chain = [element, parent, ..., body]; descendant combinators only. */
function match(sel: string, chain: N[]): "hit" | "miss" | "unmodelled" {
	const parts = sel.trim().split(/\s+/).map(compound);
	if (parts.some((p) => p === null)) return "unmodelled";
	const cs = parts as { tag: string | null; classes: string[] }[];
	if (!hits(cs[cs.length - 1]!, chain[0]!)) return "miss";
	let i = 1;
	for (let k = cs.length - 2; k >= 0; k--) {
		while (i < chain.length && !hits(cs[k]!, chain[i]!)) i++;
		if (i >= chain.length) return "miss";
		i++;
	}
	return "hit";
}
function spec(sel: string): number {
	return sel
		.trim()
		.split(/\s+/)
		.map(compound)
		.reduce((s, c) => s + (c ? c.classes.length * 10 + (c.tag ? 1 : 0) : 0), 0);
}
function resolve(chain: N[], props: string[]) {
	const won: Record<string, Hit | undefined> = {};
	const inAtRule: string[] = [];
	const unmodelled: string[] = [];
	let order = 0;
	sheet.walkRules((rule) => {
		order++;
		const at = rule.parent?.type === "atrule" ? `@${(rule.parent as postcss.AtRule).name} ${(rule.parent as postcss.AtRule).params}` : null;
		for (const sel of rule.selectors) {
			const r = match(sel, chain);
			if (r === "unmodelled") {
				const names = [...chain[0]!.classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(sel));
				if (names)
					rule.walkDecls((d) => {
						if (PLACING.includes(d.prop)) unmodelled.push(`${sel} { ${d.prop}: ${d.value} } @${rule.source?.start?.line}`);
					});
				continue;
			}
			if (r !== "hit") continue;
			rule.walkDecls((d) => {
				if (at) {
					if (PLACING.includes(d.prop) || props.includes(d.prop)) inAtRule.push(`${at} ${sel} { ${d.prop}: ${d.value} } @${rule.source?.start?.line}`);
					return;
				}
				if (!props.includes(d.prop)) return;
				const h: Hit = { prop: d.prop, value: d.value, important: d.important, spec: spec(sel), order, sel, line: rule.source?.start?.line };
				const cur = won[d.prop];
				const beats =
					!cur ||
					(h.important !== cur.important ? h.important : h.spec !== cur.spec ? h.spec > cur.spec : h.order >= cur.order);
				if (beats) won[d.prop] = h;
			});
		}
	});
	return { won, inAtRule, unmodelled };
}
/** px value of "Npx" or "calc(env(..., 0px) + Npx)" with env() = inset. */
function px(v: string | undefined, inset = 0): number {
	if (v === undefined) return NaN;
	const s = v.replace(/env\([^()]*\)/g, `${inset}px`).replace(/calc\(/g, "").replace(/\)/g, "");
	return s.split("+").reduce((sum, t) => sum + parseFloat(t.trim()), 0);
}
const firstPx = (v: string | undefined): number => parseFloat((v ?? "").trim().split(/\s+/)[0]!);

/** Box measured from the shared parent's top edge and RIGHT edge. */
interface Box {
	top: number;
	bottom: number;
	rNear: number; // right edge's distance from the parent's right edge
	rFar: number; // left edge's distance from the parent's right edge
	z: number;
}
const pane: N = { tag: "div", classes: new Set(["markdown-source-view"]) };
const body = (cls: string[]): N => ({ tag: "body", classes: new Set(cls) });

function zoomBar(bodyCls: string[]) {
	const chain = [{ tag: "div", classes: new Set(["handwriting-note-viewport-controls"]) }, pane, body(bodyCls)];
	const r = resolve(chain, ["top", "right", "z-index", "padding", "border", "gap", "position"]);
	const b = resolve([{ tag: "button", classes: new Set<string>() }, ...chain], ["height", "min-width"]);
	const w = r.won;
	const border = firstPx(w.border?.value);
	const pad = px(w.padding?.value);
	const gap = px(w.gap?.value);
	const bh = px(b.won.height?.value);
	const bw = px(b.won["min-width"]?.value);
	const top = px(w.top?.value);
	const right = px(w.right?.value);
	const box: Box = {
		top,
		bottom: top + 2 * border + 2 * pad + bh,
		rNear: right,
		rFar: right + 2 * border + 2 * pad + 4 * bw + 3 * gap, // lower bound: four buttons at min-width
		z: Number(w["z-index"]?.value),
	};
	// The 4th (last) button, Fit: lower-bound extent from the bar's right edge.
	const fit: Box = { top: top + border + pad, bottom: top + border + pad + bh, rNear: right + border + pad, rFar: right + border + pad + bw, z: box.z };
	return { box, fit, r, b };
}
function pill(bodyCls: string[], inset = 0) {
	const chain = [{ tag: "button", classes: new Set(["handwriting-pen-pill", "handwriting-corner-top-right", "is-showing"]) }, pane, body(bodyCls)];
	const r = resolve(chain, ["top", "right", "width", "height", "z-index", "display", "position"]);
	const w = r.won;
	const top = px(w.top?.value, inset);
	const right = px(w.right?.value, 0);
	const box: Box = { top, bottom: top + px(w.height?.value), rNear: right, rFar: right + px(w.width?.value), z: Number(w["z-index"]?.value) };
	return { box, r };
}
/** Rightmost strip button (flex-end row: the last shown button sits at the right end). */
function stripRightButton(bodyCls: string[], inset = 0) {
	const chain = [{ tag: "div", classes: new Set(["handwriting-mobile-tools", "handwriting-corner-top-right"]) }, pane, body(bodyCls)];
	const r = resolve(chain, ["top", "right", "padding", "border", "z-index", "position"]);
	const b = resolve([{ tag: "button", classes: new Set(["handwriting-mobile-tool"]) }, ...chain], ["width", "height"]);
	const top = px(r.won.top?.value, inset);
	const right = px(r.won.right?.value, 0);
	const pad = px(r.won.padding?.value);
	const border = firstPx(r.won.border?.value);
	const bw = px(b.won.width?.value);
	const bh = px(b.won.height?.value);
	const box: Box = { top: top + border + pad, bottom: top + border + pad + bh, rNear: right + border + pad, rFar: right + border + pad + bw, z: Number(r.won["z-index"]?.value) };
	return { box, r, b, stripBottom: top + 2 * border + 2 * pad + bh };
}
const centre = (b: Box) => ({ y: (b.top + b.bottom) / 2, r: (b.rNear + b.rFar) / 2 });
const inside = (p: { y: number; r: number }, b: Box) => p.y > b.top && p.y < b.bottom && p.r > b.rNear && p.r < b.rFar;
/** Would a tap at the centre of `under` land on `over` instead (same parent, both positioned)? */
const tapStolen = (under: Box, over: Box) => over.z > under.z && inside(centre(under), over);
const show = (o: Record<string, Hit | undefined>) =>
	Object.fromEntries(Object.entries(o).map(([k, h]) => [k, h ? `${h.value}  <- ${h.sel} (styles.css:${h.line})` : "none"]));

// ------------------------------------------------------------------ probe
describe("CSS-2: note zoom bar over the Android pen strip and pill", () => {
	beforeEach(() => {
		clearToolPicked();
		resetPenToolsForTest();
		resetNoteZoomControlsForTest();
		setCanvasNoteOverrideForTest(null);
	});
	afterEach(() => setCanvasNoteOverrideForTest(null));

	it("A. precondition (real MobileTools): bar, pill and strip share one parent; bar shows over a collapsed strip; nothing places the bar", () => {
		setZoomBarCanvasEnabled(true); // Infinite Canvas on (opt-in global)
		const fits: string[] = [];
		const parent = new FakeEl("div", new FakeDoc());
		const tools = new MobileTools(parent as unknown as HTMLElement, fakeHost({
			notePath: () => "note.md",
			noteViewport: {
				getNoteViewportState: () => ({ zoom: 1, busy: false, fitAvailable: true }),
				zoomNoteBy: () => true,
				resetNoteZoom: () => true,
				fitHandwriting: () => {
					fits.push("fit");
					return "ok";
				},
			},
		}));
		tools.setCorner(DEFAULT_TOOLBAR_CORNER);
		tools.setCollapsed(true); // what InkOverlay.ts:3210 does on every note switch
		const kids = parent.children;
		const bar = kids.find((c) => c.classes.has("handwriting-note-viewport-controls"));
		const pillEl = kids.find((c) => c.classes.has("handwriting-pen-pill"));
		const strip = kids.find((c) => c.classes.has("handwriting-mobile-tools"));
		console.log("[CSS-2] parent children:", JSON.stringify(kids.map((c) => `${c.tagName}.${[...c.classes].join(".")}`)));
		expect(DEFAULT_TOOLBAR_CORNER).toBe("top-right");
		expect(getNoteZoomControlsMode()).toBe("auto");
		expect(bar, "bar is a direct child of the parent").toBeTruthy();
		expect(pillEl, "pill is a direct child of the same parent").toBeTruthy();
		expect(strip, "strip is a direct child of the same parent").toBeTruthy();
		expect(strip!.classes.has("is-collapsed")).toBe(true);
		expect(pillEl!.classes.has("is-showing")).toBe(true);
		expect(pillEl!.classes.has("handwriting-corner-top-right")).toBe(true);
		expect(bar!.classes.has("is-hidden"), "bar is shown with Infinite Canvas on + auto").toBe(false);
		expect(bar!.classes.has("is-inking")).toBe(false);
		expect([...bar!.classes].filter((c) => c.startsWith("handwriting-corner-")), "bar has no corner class").toEqual([]);
		const inline = Object.keys(bar!.style).filter((k) => /^(top|right|bottom|left|inset|transform|translate)$/.test(k));
		expect(inline, "no inline placement on the bar").toEqual([]);
		// The bar's 4th button is Fit and runs fitHandwriting.
		const buttons = bar!.children.filter((c) => c.tagName === "button");
		expect(buttons.map((b) => b.textContent)).toEqual(["−", "100%", "+", "Fit"]);
		buttons[3]!.fire("click");
		expect(fits).toEqual(["fit"]);
		tools.destroy();
	});

	it("B0. styles.css: resolved placement of bar, Android pill and Android strip (and nothing unmodelled moves them)", () => {
		const bar = zoomBar(["is-mobile", "handwriting-android"]);
		const p = pill(["is-mobile", "handwriting-android"]);
		const s = stripRightButton(["is-mobile", "handwriting-android"]);
		console.log("[CSS-2] bar rules:", JSON.stringify(show(bar.r.won)), JSON.stringify(show(bar.b.won)));
		console.log("[CSS-2] android pill rules:", JSON.stringify(show(p.r.won)));
		console.log("[CSS-2] android strip rules:", JSON.stringify(show(s.r.won)), JSON.stringify(show(s.b.won)));
		console.log("[CSS-2] boxes (from parent top / parent right):", JSON.stringify({ bar: bar.box, fit: bar.fit, pill: p.box, stripRightButton: s.box, stripBottom: s.stripBottom }));
		for (const x of [bar.r, bar.b, p.r, s.r, s.b]) {
			if (x.inAtRule.length || x.unmodelled.length) console.log("[CSS-2] at-rule/unmodelled:", JSON.stringify({ at: x.inAtRule, un: x.unmodelled }));
		}
		// Nothing in an at-rule or an unmodelled selector sets a placing property on these.
		const placingUnmodelled = [bar.r, p.r, s.r].flatMap((x) => x.unmodelled.filter((u) => !/:(active|hover|focus|focus-visible)\b/.test(u)));
		expect(placingUnmodelled).toEqual([]);
		expect([bar.r, p.r, s.r].flatMap((x) => x.inAtRule.filter((a) => /\{ (top|right|bottom|left|inset|z-index|position): /.test(a)))).toEqual([]);
		// Precondition values the claim rests on.
		expect(bar.r.won.position?.value).toBe("absolute");
		expect(p.r.won.position?.value).toBe("absolute");
		expect(s.r.won.position?.value).toBe("absolute");
		// The fixed geometry: on Android the bar sits below the strip and the pill (was top 52, over both).
		expect([bar.box.top, bar.box.rNear, bar.box.z]).toEqual([100, 8, 30]);
		expect([p.box.top, p.box.rNear, p.box.z]).toEqual([55, 15, 12]);
		expect(p.r.won.display?.value).toBe("flex");
		expect([s.box.z]).toEqual([12]);
	});

	it("control: desktop (no mobile class) pill and strip are clear of the bar", () => {
		const bar = zoomBar([]).box;
		const p = pill([]).box;
		const s = stripRightButton([]);
		console.log("[CSS-2] desktop:", JSON.stringify({ bar, pill: p, stripBtn: s.box, stripBottom: s.stripBottom }));
		expect(tapStolen(p, bar)).toBe(false);
		expect(tapStolen(s.box, bar)).toBe(false);
		expect(p.bottom).toBeLessThanOrEqual(bar.top);
		expect(s.stripBottom).toBeLessThanOrEqual(bar.top);
	});

	it("control: iPad (is-mobile, inset 0) pill is clear, strip button centre is clear", () => {
		const bar = zoomBar(["is-mobile"]).box;
		const p = pill(["is-mobile"]).box;
		const s = stripRightButton(["is-mobile"]);
		console.log("[CSS-2] iPad:", JSON.stringify({ bar, pill: p, stripBtn: s.box, stripBottom: s.stripBottom, stripOverlapPx: Math.max(0, s.stripBottom - bar.top) }));
		expect(tapStolen(p, bar)).toBe(false);
		expect(tapStolen(s.box, bar)).toBe(false);
	});

	it("CLAIM 1: Android collapsed pill is not under the zoom bar (tap at its centre reaches the pill)", () => {
		const { box: bar, fit } = zoomBar(["is-mobile", "handwriting-android"]);
		const p = pill(["is-mobile", "handwriting-android"]).box;
		const fully = p.top >= bar.top && p.bottom <= bar.bottom && p.rNear >= bar.rNear && p.rFar <= bar.rFar;
		console.log("[CSS-2] Android pill", JSON.stringify(p), "bar", JSON.stringify(bar), "pill fully inside bar:", fully, "pill centre on Fit button:", inside(centre(p), fit));
		expect(tapStolen(p, bar), "Android: pill centre lies under the higher-z zoom bar").toBe(false);
	});

	it("CLAIM 2: Android expanded strip's rightmost button is not under the zoom bar", () => {
		const { box: bar } = zoomBar(["is-mobile", "handwriting-android"]);
		const s = stripRightButton(["is-mobile", "handwriting-android"]);
		const covered = Math.min(s.box.bottom, bar.bottom) - Math.max(s.box.top, bar.top);
		console.log("[CSS-2] Android strip right button", JSON.stringify(s.box), "strip y", s.box.top - 5, "-", s.stripBottom, "vertical px of the button under the bar:", covered);
		expect(tapStolen(s.box, bar), "Android: rightmost strip button centre lies under the zoom bar").toBe(false);
	});
});
