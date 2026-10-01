/**
 * SHRINKING THE EDITOR HOST WITH CSS `zoom`, NOT `transform: scale`.
 *
 * Below 100% the note viewport lays the editor host out at pane / k and
 * shrinks it back. Doing that with a scale TRANSFORM gives the host's effect
 * node a render surface as soon as it has composited descendants (the five
 * ink canvases), and that surface is drawn at LAYOUT resolution - the whole
 * counter-sized box - on every frame that touches ink. `zoom` is a layout
 * property with no transform node, so no surface is raised and the canvases
 * stay ordinary layers inside the scroller.
 *
 * `zoom` is only standard from Chromium 128 / WebKit 17.4, so the write is
 * gated on `CSS.supports("zoom", "0.5")` and the transform form is kept
 * byte-for-byte where the gate is closed. The gate is read once per overlay.
 *
 * These arms drive the real `applyViewportBox`, `prepareViewportLayout`,
 * `restoreViewportLayout` and `preparePinchComposite` on the real prototype;
 * only the DOM sinks and the window are controlled.
 */
import { describe, expect, it, vi } from "vitest";

// The overlay reaches window through winRef; the node environment has none,
// so mirror the other prototype suites' shim before the module graph loads.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { TailRenderer } from "../ink/TailRenderer";

type Fields = Record<string, unknown>;
type Styles = Record<string, string>;

/** camelCase as `setCssStyles` takes it -> the property name `style` uses. */
const dashed = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * One element's inline style, written through BOTH doors the overlay uses:
 * `setCssStyles` (camelCase bulk write) and `style.setProperty` /
 * `removeProperty` (dashed, one at a time). A real element has one
 * declaration behind both, so this keeps one map behind both - which is the
 * whole point of the teardown arm below.
 */
/**
 * The fake host's `classList`, backed by a real token set so `contains` answers
 * what was actually written. `classWrites` logs every call - a guarded write
 * that correctly does nothing leaves no entry, which is how the arms below tell
 * "the class is right" from "the class was written again".
 */
function tokenList(classes: Set<string>, writes: string[]): Record<string, unknown> {
	return {
		add: (...tokens: string[]): void => {
			writes.push(`add:${tokens.join(" ")}`);
			for (const token of tokens) classes.add(token);
		},
		remove: (...tokens: string[]): void => {
			writes.push(`remove:${tokens.join(" ")}`);
			for (const token of tokens) classes.delete(token);
		},
		contains: (token: string): boolean => classes.has(token),
		toggle: (token: string, on?: boolean): boolean => {
			writes.push(`toggle:${token}`);
			const want = on ?? !classes.has(token);
			if (want) classes.add(token);
			else classes.delete(token);
			return want;
		},
	};
}

function element(extra: Fields = {}): Fields & { props: Styles; priorities: Styles; calls: Styles[]; classes: Set<string>; classWrites: string[] } {
	const classes = new Set<string>();
	const classWrites: string[] = [];
	const props: Styles = {};
	const priorities: Styles = {};
	const calls: Styles[] = [];
	return {
		props,
		priorities,
		calls,
		// A REAL token set, not a hardwired `contains: () => false`. Both class writes in `applyViewportBox` are guarded -
		// the viewport token is added only when missing, the own-lines token toggled only when it differs - because an add
		// or a toggle of a token that is already right still queues a class mutation record, and the viewport style
		// observer then stamps on every preview frame. A stub that always answers false makes both guards take their write
		// branch every time, so it cannot tell a guarded write from an unguarded one; it also failed as a bare TypeError
		// the moment production reached for `toggle`, a member nobody had stubbed. Same shape as the fake elements in
		// MobileTools.test.ts and FoldOrderControl.test.ts. `classWrites` records every CALL, not every change, which is
		// what the guards actually suppress.
		classes,
		classWrites,
		classList: tokenList(classes, classWrites),
		style: {
			setProperty(name: string, value: string, priority = ""): void {
				props[name] = value;
				priorities[name] = priority;
			},
			removeProperty(name: string): void {
				delete props[name];
				delete priorities[name];
			},
			getPropertyValue: (name: string): string => props[name] ?? "",
			getPropertyPriority: (name: string): string => priorities[name] ?? "",
		},
		setCssStyles(styles: Styles): void {
			calls.push({ ...styles });
			// The empty string REMOVES a property on a real declaration, which
			// is how both branches clear what the other one wrote; a sink that
			// stored "" instead would hide exactly that.
			// A camelCase assignment also drops the declaration's PRIORITY -
			// `style.zoom = "0.125"` cannot be `!important` - so an inline
			// `zoom: 1.25 !important` stops winning the cascade the moment the
			// bulk write touches it. That is the whole of the restore below.
			for (const [name, value] of Object.entries(styles)) {
				if (value === "") { delete props[dashed(name)]; delete priorities[dashed(name)]; }
				else { props[dashed(name)] = value; priorities[dashed(name)] = ""; }
			}
		},
		...extra,
	};
}

interface Rig {
	overlay: Fields;
	host: ReturnType<typeof element>;
	supports: ReturnType<typeof vi.fn>;
	/** committed, wet, tail, highlight, highlightWet - the five ink layers. */
	canvases: ReturnType<typeof element>[];
}

/**
 * An overlay on the real prototype with the viewport already taken over.
 * `supports` null means the window has no `CSS` object at all (an engine that
 * predates the feature query), which must take the same fallback path.
 *
 * `themeZoom` stands in for a `zoom` the host already carries from a theme
 * stylesheet. The fake computed style resolves it the way a real one does -
 * an INLINE zoom wins over the stylesheet's - because the capture-after-release
 * arm turns on exactly that: after the restore the host's inline zoom is the
 * theme's own saved value again, and a capture then must read the theme's
 * factor rather than the shrink the overlay last wrote.
 *
 * `stuckZoom` models a stylesheet `zoom: ... !important`, which a NON-important
 * inline write cannot override: `true` means the sheet declares the theme's own
 * factor as important, and a STRING means the sheet declares that value as
 * important beside a different inline one - the shape that makes the fallback's
 * restore observable (inline `zoom: 1.25 !important`, sheet `zoom: 1 !important`:
 * the product write loses its priority, the sheet's 1 wins, verification fails,
 * and only replaying the saved value AND priority puts 1.25 back).
 *
 * The computed zoom is therefore the real cascade - inline-important, then
 * sheet-important, then inline, then the sheet's plain value - rather than the
 * two-case "stylesheet value / stylesheet wins" it modelled before.
 */
function rig(supported: boolean | null, baseTransform = "none", themeZoom?: string, stuckZoom: boolean | string = false): Rig {
	const supports = vi.fn((property: string, value: string) => property === "zoom" && value === "0.5" && supported === true);
	// The sheet's `!important` declaration, if it has one.
	const sheetImportant = stuckZoom === true ? themeZoom : (typeof stuckZoom === "string" ? stuckZoom : undefined);
	const cascadeZoom = (): string | undefined => {
		const value = host.props.zoom, priority = host.priorities.zoom ?? "";
		if (value && priority === "important") return value;
		if (sheetImportant !== undefined) return sheetImportant;
		return value ?? themeZoom;
	};
	const win: Fields = {
		CSS: supported === null ? undefined : { supports },
		getComputedStyle: (el?: unknown) => ({
			marginLeft: "24px", marginRight: "24px", transform: baseTransform, width: "640px", height: "480px",
			// Only the host resolves a zoom; contentDOM is asked for margins.
			...(el === host && (themeZoom !== undefined || sheetImportant !== undefined) ? { zoom: cascadeZoom() } : {}),
		}),
		cancelAnimationFrame: () => undefined,
	};
	const host = element({ clientWidth: 640, clientHeight: 480, ownerDocument: { defaultView: win } });
	const tailCtx = {
		setTransform: () => undefined, save: () => undefined, restore: () => undefined,
		clearRect: () => undefined, drawImage: () => undefined,
		getLineDash: () => [], setLineDash: () => undefined,
		lineCap: "butt", lineJoin: "miter", lineWidth: 1,
		strokeStyle: "#000", fillStyle: "#000", globalAlpha: 1,
		globalCompositeOperation: "source-over", lineDashOffset: 0,
		miterLimit: 10, filter: "none", imageSmoothingEnabled: true,
		shadowBlur: 0, shadowColor: "transparent", shadowOffsetX: 0, shadowOffsetY: 0,
		font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic",
	} as unknown as CanvasRenderingContext2D;
	const tailCanvas = element({
		width: 300, height: 150,
		ownerDocument: { defaultView: { devicePixelRatio: 1 } },
		getContext: () => tailCtx,
	});
	const tail = new TailRenderer(tailCanvas as unknown as HTMLCanvasElement);
	tail.configureInlineBacking(640, 480, 1, 1, true);
	tail.restoreFullSurface();
	const canvases = [element(), element(), tailCanvas, element(), element()];
	const pane = element({ scrollLeft: 0, scrollTop: 0, clientWidth: 640, clientHeight: 480 });
	(host as Fields).parentElement = pane;
	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	Object.assign(overlay, {
		view: {
			dom: host,
			contentDOM: { offsetWidth: 700 },
			// A SCROLLER PRODUCTION MEASURES, not a pair of scroll offsets. Both the layout capture
			// (InkOverlay.ts, `prepareViewportLayout`) and `applyViewportBox` read the painted scrollbar
			// off this element - `getBoundingClientRect().width`, `offsetWidth` and `clientWidth` - and a
			// stub carrying only the offsets threw a bare TypeError the moment either ran, exactly as the
			// class list above did when production first reached for `toggle`. Same fix, same shape as
			// ZoomFloorLock.test.ts's own scroller stub.
			// NO SCROLLBAR HERE, deliberately: `clientWidth` equals `offsetWidth` equals the rect's width,
			// so the gutter this rig reports is 0 - which is what these arms measured before the read
			// existed, and keeps every box write below asking about the box rather than about a scrollbar
			// the rig never painted. The gutter's own behaviour belongs with the suites that vary it.
			scrollDOM: {
				scrollLeft: 0, scrollTop: 0,
				offsetWidth: 640, clientWidth: 640,
				getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
			},
		},
		// Class FIELDS do not run under Object.create, so every field the
		// paths below read is set here rather than assumed.
		viewportPan: null,
		pinchScaleNow: 1,
		cssScale: 1,
		// The cached layer box the re-placement after a mid-takeover flip reads.
		// Zero until a test sets them, which is also the guard's own arm.
		cssWidth: 0,
		cssHeight: 0,
		committedCanvas: canvases[0], wetCanvas: canvases[1], tailCanvas: canvases[2],
		highlightCanvas: canvases[3], highlightWetCanvas: canvases[4],
		tail,
		viewportGeneration: 0,
		viewportPaneObserver: null,
		viewportStyleObserver: null,
		viewportStyleDirty: null,
		viewportStyleFrame: 0,
		pinchPreview: false,
		// Class FIELDS do not run under Object.create (see above), and the preview branch reads this
		// one: production initialises it to the same zeroes (InkOverlay.ts, `paperSnapResidual`), so a
		// frame with no snap residual writes no paper pan. Seeded here because an arm that puts the
		// fingers down reaches it, and a missing field is a bare TypeError rather than a verdict.
		paperSnapResidual: { x: 0, y: 0 },
		rasterColumnLocal: null,
		previewAnchorStale: false,
		viewportLayout: {
			parent: pane,
			paneWidth: 640,
			paneHeight: 480,
			externalScale: 1,
			baseTransform,
			// What the real capture stores for a host with no zoom of its own.
			// The arms that care about a pre-existing one run the real
			// `prepareViewportLayout` rather than seeding this by hand.
			baseZoom: 1,
			width: 640,
			height: 480,
			column: 700,
			left: "24px",
			right: "24px",
			columnLocal: 0,
			styles: new Map<string, { value: string; priority: string }>(),
		},
		// The column scan is a neighbouring measurement with its own suites;
		// these arms are about the box write and the save list. Takeover takes
		// it through `measureNaturalColumn`; stubbed to what the capture read
		// from this rig before (contentDOM's width and margins, no column).
		columnLocalAt: () => null,
		measureNaturalColumn: () => ({ column: 700, left: "24px", right: "24px", columnLocal: null, columnAuto: null }),
		releaseMeasures: () => undefined,
		clearViewportPan: () => undefined,
		clearPreviewInkOffset: () => undefined,
		clearDeferredRepaint: () => undefined,
		writeViewportPan: () => undefined,
	});
	return { overlay, host, supports, canvases };
}

const apply = (overlay: Fields, next: number): void =>
	(overlay as { applyViewportBox(next: number): void }).applyViewportBox(next);

/** The real capture, with the observer wiring skipped (no ResizeObserver here). */
function prepare(overlay: Fields): void {
	overlay.viewportLayout = null;
	overlay.viewportPaneObserver = { disconnect: () => undefined };
	expect((overlay as { prepareViewportLayout(): boolean }).prepareViewportLayout()).toBe(true);
}
const layoutOf = (overlay: Fields): { baseZoom?: number; zoomVerified?: boolean; ownLines?: boolean; styles: Map<string, { value: string; priority: string }> } =>
	overlay.viewportLayout as { baseZoom?: number; zoomVerified?: boolean; ownLines?: boolean; styles: Map<string, { value: string; priority: string }> };
type Inline = { setProperty(n: string, v: string, p?: string): void; getPropertyPriority(n: string): string };
const inline = (host: ReturnType<typeof element>): Inline => host.style as Inline;
const supportedNow = (overlay: Fields): boolean => (overlay as { hostZoomSupported(): boolean }).hostZoomSupported();
/**
 * WHICH ELEMENT WAS ASKED, not how many asks there were.
 *
 * These counts are about ONE question - how often the host's own zoom is read back - and a bare
 * call count answers a different one the moment production reads a computed style off anything
 * else. It does: the scrollbar measurement d88a5fac added reads the SCROLLER's computed style,
 * once per settle, guarded by `pinchPreview` so no preview frame pays for it (InkOverlay.ts,
 * `applyViewportBox`). Counting every call made the host cells red on a scroller read they were
 * never asking about. Split by element, so each cell says which read it is pinning.
 */
const readsOf = (reads: { mock: { calls: unknown[][] } }, el: unknown): number =>
	reads.mock.calls.filter(call => call[0] === el).length;

describe("applyViewportBox: zoom where the engine has it", () => {
	it("writes the counter-sized box, `zoom`, and no scale transform when zoom is supported", () => {
		const { overlay, host } = rig(true);
		// A leftover scale from an earlier run of the fallback path must go:
		// a transform scale under a zoom would shrink the host twice.
		host.props.transform = "scale(0.5)";
		apply(overlay, 0.1);
		expect(host.calls.at(-1)).toEqual({ width: "6400px", height: "4800px", zoom: "0.1", transform: "", transformOrigin: "" });
		expect(host.props.zoom).toBe("0.1");
		// Cleared, not set to a string: the empty write removes the property.
		expect(host.props.transform).toBeUndefined();
		expect(host.props["transform-origin"]).toBeUndefined();
	});

	it("keeps a theme's own transform, and only then an origin, under zoom", () => {
		const base = "matrix(1, 0, 0, 1, 5, 0)";
		const { overlay, host } = rig(true, base);
		apply(overlay, 0.25);
		expect(host.calls.at(-1)).toEqual({ width: "2560px", height: "1920px", zoom: "0.25", transform: base, transformOrigin: "0 0" });
		// The theme's transform is kept WHOLE: the shrink is not folded into it.
		expect(host.props.transform).toBe(base);
		expect(host.props.transform).not.toMatch(/scale/);
	});

	it("writes exactly today's transform form when the engine has no standard zoom", () => {
		for (const supported of [false, null] as const) {
			const { overlay, host } = rig(supported);
			apply(overlay, 0.1);
			const call = host.calls.at(-1)!;
			// The four properties today's line writes, with today's values.
			expect({ width: call.width, height: call.height, transform: call.transform, transformOrigin: call.transformOrigin }, `supports=${supported}`)
				.toEqual({ width: "6400px", height: "4800px", transform: "scale(0.1)", transformOrigin: "0 0" });
			// Plus the clear of the property the OTHER branch owns, which is
			// inert here: this path never sets a zoom, so removing it changes
			// nothing an engine without standard zoom can see.
			expect(call.zoom, `supports=${supported}: the other branch's property is cleared`).toBe("");
			expect(host.props.zoom, `supports=${supported}: no zoom left on the host`).toBeUndefined();
		}
	});

	/**
	 * SYMMETRY. Each branch must clear what the other one writes, or a host
	 * that changed paths carries both shrinks at once and lands at k squared.
	 * The gate is cached per overlay, so production cannot cross here today -
	 * but an instrument that stubs the feature query at runtime does exactly
	 * this, and a fixture that shrinks twice reports a coordinate fault that
	 * is really its own.
	 */
	it("the fallback branch clears a zoom the other branch left on the host", () => {
		const { overlay, host } = rig(true);
		apply(overlay, 0.1);
		expect(host.props.zoom, "the zoom branch wrote a zoom to clear").toBe("0.1");
		// The engine's answer changes under the overlay, as a runtime stub does.
		overlay.hostZoomSupport = false;
		apply(overlay, 0.1);
		expect(host.props.zoom, "a zoom survived the fallback write: the host is shrunk twice").toBeUndefined();
		expect(host.props.transform, "the fallback still writes its scale").toBe("scale(0.1)");
	});

	it("the zoom branch clears a transform the fallback left on the host", () => {
		const { overlay, host } = rig(false);
		apply(overlay, 0.1);
		expect(host.props.transform, "the fallback branch wrote a scale to clear").toBe("scale(0.1)");
		overlay.hostZoomSupport = true;
		apply(overlay, 0.1);
		expect(host.props.transform, "a scale survived the zoom write: the host is shrunk twice").toBeUndefined();
		expect(host.props.zoom, "the zoom branch still writes its zoom").toBe("0.1");
	});

	it("keeps the base transform in front of the scale on the fallback path", () => {
		const base = "matrix(1, 0, 0, 1, 5, 0)";
		const { overlay, host } = rig(false, base);
		apply(overlay, 0.1);
		expect(host.calls.at(-1)).toEqual({ width: "6400px", height: "4800px", zoom: "", transform: `${base} scale(0.1)`, transformOrigin: "0 0" });
	});

	it("asks the engine once, not once per frame", () => {
		const { overlay, supports } = rig(true);
		for (const k of [0.1, 0.2, 0.3, 0.4]) apply(overlay, k);
		expect(supports).toHaveBeenCalledTimes(1);
		expect(supports).toHaveBeenCalledWith("zoom", "0.5");
	});
});

/**
 * A HOST THAT ALREADY CARRIES A ZOOM.
 *
 * `zoom` is ONE property, so writing the requested k REPLACES whatever the
 * host had - a theme's `.cm-editor { zoom: 1.25 }`, or an inline one. The
 * transform fallback has no such problem: a stylesheet zoom and a scale
 * transform compose, so that branch has always kept the theme's factor.
 *
 * The captured layout carries the host's own factor and the write is the
 * PRODUCT, which leaves the ordinary host - the one with no zoom at all -
 * byte-for-byte where it was, because its factor is 1.
 */
describe("applyViewportBox: a zoom the host already had", () => {
	/**
	 * THE CONTROL, through the real capture rather than a seeded layout: a host
	 * with no zoom of its own must be written exactly what it is written today,
	 * property for property. A unit rig's computed style has no `zoom` key at
	 * all, which is the same NaN the string `normal` parses to, and both must
	 * land on a factor of 1.
	 */
	it("writes today's bytes when the host has no zoom of its own", () => {
		const { overlay, host } = rig(true);
		prepare(overlay);
		expect(layoutOf(overlay).baseZoom, "an unreadable zoom is a factor of 1").toBeCloseTo(1, 12);
		apply(overlay, 0.1);
		expect(host.calls.at(-1)).toEqual({ width: "6400px", height: "4800px", zoom: "0.1", transform: "", transformOrigin: "" });
	});

	it("multiplies the host's own zoom into the write instead of replacing it", () => {
		const { overlay, host } = rig(true, "none", "1.25");
		prepare(overlay);
		expect(layoutOf(overlay).baseZoom, "the host's own factor is captured").toBeCloseTo(1.25, 12);
		apply(overlay, 0.5);
		const call = host.calls.at(-1)!;
		// The VALUE, not the spelling: the product is arithmetic, and pinning a
		// string here would be a spelling test for `String(1.25 * 0.5)`.
		expect(Number.parseFloat(call.zoom!), "1.25 * 0.5 on screen, not 0.5").toBeCloseTo(0.625, 12);
		// Everything else is what today writes at this k.
		expect({ width: call.width, height: call.height, transform: call.transform, transformOrigin: call.transformOrigin })
			.toEqual({ width: "1280px", height: "960px", transform: "", transformOrigin: "" });
	});

	/**
	 * The release replays the host's SAVED inline zoom, so the next takeover's
	 * capture reads the theme's factor again. If it read the plugin's own last
	 * write instead, a second pinch would compose the shrink with the previous
	 * shrink and the host would leave the screen.
	 */
	it("re-captures the host's own zoom after a release, not the shrink it last wrote", () => {
		const { overlay, host } = rig(true, "none", "1.25");
		inline(host).setProperty("zoom", "1.25", "important");
		prepare(overlay);
		expect(layoutOf(overlay).styles.get("zoom")).toEqual({ value: "1.25", priority: "important" });
		apply(overlay, 0.5);
		expect(Number.parseFloat(host.props.zoom!), "the shrink is on the host while the overlay owns it").toBeCloseTo(0.625, 12);
		(overlay as { restoreViewportLayout(): void }).restoreViewportLayout();
		expect(host.props.zoom, "the host's own zoom came back").toBe("1.25");
		expect(inline(host).getPropertyPriority("zoom"), "with the priority it had").toBe("important");
		prepare(overlay);
		expect(layoutOf(overlay).baseZoom, "the second capture read the theme's factor, not 0.625 or 0.5").toBeCloseTo(1.25, 12);
	});

	/**
	 * A stylesheet `zoom: ... !important` cannot be overridden by an inline
	 * write. The host would then keep its full size behind a camera that
	 * believes it shrank - every screen point mapped at the wrong scale. One
	 * read-back per takeover catches it and hands the overlay back to the
	 * transform form, which out-specifies nothing and always applies.
	 */
	it("falls back to the transform form on the same call when the zoom write did not take", () => {
		const { overlay, host } = rig(true, "none", "1.25", true);
		prepare(overlay);
		apply(overlay, 0.5);
		expect(host.calls.at(-1), "the call ends in the fallback form")
			.toEqual({ width: "1280px", height: "960px", zoom: "", transform: "scale(0.5)", transformOrigin: "0 0" });
		expect(host.props.zoom, "no zoom left on a host that ignores it").toBeUndefined();
		expect(supportedNow(overlay), "and the overlay stays on the fallback").toBe(false);
	});

	it("reads the host's zoom back once per takeover, not once per frame", () => {
		const { overlay, host } = rig(true, "none", "1.25");
		const scroller = (overlay.view as { scrollDOM: unknown }).scrollDOM;
		const win = (host.ownerDocument as { defaultView: Fields }).defaultView;
		const real = win.getComputedStyle as (el?: unknown) => Record<string, string>;
		const reads = vi.fn(real);
		win.getComputedStyle = reads;
		prepare(overlay);
		const hostAfterCapture = readsOf(reads, host), scrollerAfterCapture = readsOf(reads, scroller);
		// A FRAME IS A PREVIEW FRAME. The rig sits at `pinchPreview: false`, which is a SETTLE - so a
		// loop of five `apply` calls on the default rig was five settles wearing the word "frame", and
		// it could not see a per-frame cost if one appeared. The fingers go down for the loop.
		overlay.pinchPreview = true;
		for (const k of [0.5, 0.4, 0.3, 0.2, 0.1]) apply(overlay, k);
		overlay.pinchPreview = false;
		expect(readsOf(reads, host) - hostAfterCapture, "five frames, one verification read").toBe(1);
		// THE SCROLLBAR READ IS THE SETTLE'S, AND ONLY THE SETTLE'S. It forces layout, so a frame that
		// paid for it would be a per-frame forced layout on the pinch path: the thing `pinchPreview`
		// guards against. Nothing is asserted about the read's VALUE here; the claim is its frequency.
		expect(readsOf(reads, scroller) - scrollerAfterCapture, "no frame pays for the scrollbar measurement").toBe(0);
		const beforeSettle = readsOf(reads, scroller);
		apply(overlay, 0.1);
		expect(readsOf(reads, scroller) - beforeSettle, "the settle measures it exactly once").toBe(1);
	});
});

describe("the viewport teardown", () => {
	/**
	 * The restore replays the host's SAVED inline styles, so a property the
	 * save list does not name is left on the element for ever - the host would
	 * keep a 0.1 zoom after the overlay let go of it, with no counter-sizing
	 * left to justify it. The save list is built in `prepareViewportLayout`,
	 * so this arm runs the real prepare rather than handing it a list.
	 */
	it("saves `zoom` with the other box properties and clears it on release", () => {
		const { overlay, host } = rig(true);
		// Force the real prepare to build the save list from scratch, and skip
		// the observer wiring (no ResizeObserver in this environment).
		overlay.viewportLayout = null;
		overlay.viewportPaneObserver = { disconnect: () => undefined };
		expect((overlay as { prepareViewportLayout(): boolean }).prepareViewportLayout()).toBe(true);
		const layout = overlay.viewportLayout as { styles: Map<string, unknown> };
		expect([...layout.styles.keys()]).toContain("zoom");
		apply(overlay, 0.1);
		expect(host.props.zoom).toBe("0.1");
		(overlay as { restoreViewportLayout(): void }).restoreViewportLayout();
		expect(host.props.zoom, "the host kept a zoom after the overlay released it").toBeUndefined();
		expect(host.props.transform, "the host kept a transform after release").toBeUndefined();
	});
});

describe("preparePinchComposite: the placement refusal under both paths", () => {
	/**
	 * The composite draws four canvas BACKINGS into one and shows only that
	 * one, so it is sound exactly when every input lands where the target
	 * lands. The check is therefore equality against the target's own
	 * placement, not against a constant: the zoom path writes no transform
	 * and the fallback writes `scale(1/k)`, and both are uniform across the
	 * five canvases. Anything else on one canvas is a foreign placement and
	 * refuses.
	 */
	function compositeRig(transforms: string[]): { overlay: Fields; drawn: number } {
		let drawn = 0;
		const ctx = {
			save: () => undefined,
			restore: () => undefined,
			setTransform: () => undefined,
			drawImage: () => void drawn++,
			globalAlpha: 1,
			globalCompositeOperation: "source-over",
			filter: "none",
		};
		const style = (transform: string): Styles => ({
			filter: "none", mixBlendMode: "normal", clipPath: "none", opacity: "1",
			visibility: "visible", display: "block", width: "1323px", height: "1056px",
			left: "0px", top: "0px", transform, transformOrigin: "0px 0px",
			translate: "none", rotate: "none", scale: "none",
		});
		const canvases = transforms.map((transform, i) => element({
			width: 640, height: 480,
			transformArm: transform,
			getContext: () => (i === 4 ? ctx : null),
		}));
		const computed = new Map(canvases.map((c, i) => [c, style(transforms[i]!)]));
		const win = { getComputedStyle: (el: object) => computed.get(el as never) };
		const [highlight, highlightWet, committed, tail, wet] = canvases;
		const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
		Object.assign(overlay, {
			view: { dom: { ownerDocument: { defaultView: win } } },
			frame: { locked: false },
			builder: null,
			pinchComposite: false,
			pinchHiddenCanvases: new Map<object, string>(),
			highlightCanvas: highlight, highlightWetCanvas: highlightWet,
			committedCanvas: committed, tailCanvas: tail, wetCanvas: wet,
			highlightBlank: false, committedBlank: false,
			wet: { provenBlank: true, notePixelsChanged: () => undefined, beforeWrite: undefined },
			highlightWet: { provenBlank: true, beforeWrite: undefined },
			tail: { provenBlank: true, beforeWrite: undefined },
		});
		return { overlay, get drawn() { return drawn; } };
	}
	const run = (overlay: Fields): boolean => (overlay as { preparePinchComposite(): boolean }).preparePinchComposite();

	it("accepts the plain canvases the zoom path writes", () => {
		const { overlay } = compositeRig(["none", "none", "none", "none", "none"]);
		expect(run(overlay)).toBe(true);
	});

	it("accepts the counter-scaled canvases the fallback path writes", () => {
		const scaled = "matrix(10, 0, 0, 10, 0, 0)";
		const { overlay } = compositeRig([scaled, scaled, scaled, scaled, scaled]);
		expect(run(overlay)).toBe(true);
	});

	it("refuses a planted scale on one canvas under either path", () => {
		for (const path of ["none", "matrix(10, 0, 0, 10, 0, 0)"]) {
			const { overlay } = compositeRig([path, path, "matrix(1.5, 0, 0, 1.5, 0, 0)", path, path]);
			expect(run(overlay), `planted scale under ${path}`).toBe(false);
			expect(overlay.pinchComposite, `planted scale under ${path}: nothing composited`).toBe(false);
		}
	});
});

/**
 * WHAT THE FALLBACK OWES THE HOST'S OWN INLINE `zoom`.
 *
 * Both ways into the transform form - an engine with no standard `zoom`, and a
 * verification that came back wrong - write `zoom: ""` in the bulk write. On a
 * host whose own `zoom` came from a STYLESHEET that clears nothing: the sheet's
 * declaration is still there and composes with the scale. On a host carrying an
 * INLINE one it clears the host's own property, and the overlay has taken a
 * shrink away from an element it never gave one to. With `!important` on it the
 * loss is visible even while the sheet declares a zoom of its own.
 *
 * The write order is unchanged - `zoom: ""` in the bulk call, exactly as the
 * shipping line does - and the saved value is replayed after it only when there
 * was one. A host with no inline zoom is written the same bytes it always was.
 */
describe("the transform fallback and a zoom the host carried inline", () => {
	it("replays the saved inline zoom when the verification fails", () => {
		// A PLAIN inline `zoom: 1.25` under a sheet's `zoom: 1 !important`: the
		// sheet already beats it, so the host is at 1 and the capture reads 1 -
		// and the product write, which inherits the saved declaration's
		// priority and therefore has none either, loses the same way. This is
		// the shape that still reaches the fallback: an inline declaration the
		// overlay CAN out-specify is one it can also verify.
		const { overlay, host } = rig(true, "none", "1.25", "1");
		inline(host).setProperty("zoom", "1.25");
		prepare(overlay);
		expect(layoutOf(overlay).baseZoom, "the sheet's important declaration is what the host is at").toBeCloseTo(1, 12);
		expect(layoutOf(overlay).styles.get("zoom"), "saved with its priority").toEqual({ value: "1.25", priority: "" });
		apply(overlay, 0.1);
		expect(supportedNow(overlay), "the write did not take, so the overlay took the transform form").toBe(false);
		// The bulk write's shape is untouched: `zoom` is still cleared there.
		expect(host.calls.at(-1)).toEqual({ width: "6400px", height: "4800px", zoom: "", transform: "scale(0.1)", transformOrigin: "0 0" });
		// And then the host's own declaration is put back.
		expect(host.props.zoom, "the host's own inline zoom survived the fallback").toBe("1.25");
		expect(inline(host).getPropertyPriority("zoom"), "with the priority it had").toBe("");
	});

	it("replays the saved inline zoom on an engine with no standard zoom", () => {
		for (const supported of [false, null] as const) {
			const { overlay, host } = rig(supported, "none", "1.25");
			inline(host).setProperty("zoom", "1.25", "important");
			prepare(overlay);
			apply(overlay, 0.1);
			expect(host.calls.at(-1), `supports=${supported}: today's bulk write`)
				.toEqual({ width: "6400px", height: "4800px", zoom: "", transform: "scale(0.1)", transformOrigin: "0 0" });
			expect(host.props.zoom, `supports=${supported}: the overlay took away a zoom it never gave`).toBe("1.25");
			expect(inline(host).getPropertyPriority("zoom"), `supports=${supported}: with its priority`).toBe("important");
		}
	});

	/**
	 * THE CONTROL, and the shipping case: no inline zoom to save, so the
	 * fallback's net effect is exactly `zoom: ""` and nothing else.
	 */
	it("leaves a host with no inline zoom exactly as it wrote it before", () => {
		const { overlay, host } = rig(false);
		prepare(overlay);
		apply(overlay, 0.1);
		expect(host.calls, "one write, not a write and a restore").toHaveLength(1);
		expect(host.props.zoom, "nothing put back on a host that had nothing").toBeUndefined();
	});
});

/**
 * THE CANVASES AFTER A MID-TAKEOVER FLIP.
 *
 * The five ink canvases are placed once per reallocation from
 * `canvasLayerBox(cssW, cssH, k, hostZoomSupported())`: under a zoom-shrunk
 * host they are the plain band box with no transform, and on the transform path
 * they are the band times k stretched back by `scale(1/k)`. That second form is
 * what keeps the compositor layers small - the whole reason the function
 * exists. A verification that fails mid-takeover moves the host to the
 * transform path with the canvases still placed for the zoom one, and the
 * layers stay at full band size until something else reallocates.
 *
 * Re-placing them costs no DOM read: the band box and the scale are already
 * cached on the overlay.
 */
describe("the canvas layer boxes after a mid-takeover flip", () => {
	it("does not rewrite unchanged tail placement on repeated preview frames", () => {
		const r = rig(false);
		const canvas = r.canvases[2] as Fields;
		const tail = r.overlay.tail as TailRenderer;
		tail.configureInlineBacking(640, 480, 1, 0.125, false);
		(tail as unknown as {
			resizeBacking(width: number, height: number, x: number, y: number, mode: "compact"): void;
		}).resizeBacking(128, 96, 40, 56, "compact");
		expect([canvas.width, canvas.height], "a live compact bitmap, not the full band").toEqual([128, 96]);
		const writes: string[] = [];
		canvas.style = new Proxy(canvas.style as object, {
			set(target, key, value) {
				writes.push(String(key));
				return Reflect.set(target, key, value);
			},
		});
		tail.placeInline(0.125, false);
		writes.length = 0;
		tail.placeInline(0.125, false);
		tail.placeInline(0.125, false);
		expect(writes, "unchanged layout must not mutate style on preview frames").toEqual([]);
	});

	it("does not rewrite unchanged full tail placement on repeated preview frames", () => {
		const r = rig(false);
		const canvas = r.canvases[2] as Fields;
		const tail = r.overlay.tail as TailRenderer;
		tail.configureInlineBacking(640, 480, 1, 0.125, false);
		tail.restoreFullSurface();
		expect([canvas.width, canvas.height], "a nonzero full backing").toEqual([640, 480]);
		const writes: string[] = [];
		canvas.style = new Proxy(canvas.style as object, {
			set(target, key, value) {
				writes.push(String(key));
				return Reflect.set(target, key, value);
			},
		});
		tail.placeInline(0.125, false);
		writes.length = 0;
		tail.placeInline(0.125, false);
		tail.placeInline(0.125, false);
		expect(writes, "unchanged full placement must not mutate style on preview frames").toEqual([]);
	});

	/** 1000 x 800 band at k 0.125: 125 x 100 css px stretched by scale(8). */
	const flipRig = (stuck: boolean | string): Rig => {
		const r = rig(true, "none", "1.25", stuck);
		Object.assign(r.overlay, { cssWidth: 1000, cssHeight: 800, cssScale: 0.125, pinchScaleNow: 0.125 });
		const tail = r.overlay.tail as TailRenderer;
		tail.configureInlineBacking(1000, 800, 1, 0.125, true);
		tail.restoreFullSurface();
		return r;
	};

	it("re-places all five canvases for the transform form when the zoom write did not take", () => {
		const r = flipRig("1");
		// A plain inline zoom, so the product write inherits no priority and the
		// sheet's `1 !important` still beats it: the flip the canvases must
		// follow.
		inline(r.host).setProperty("zoom", "1.25");
		prepare(r.overlay);
		for (const c of r.canvases) c.calls.length = 0;
		apply(r.overlay, 0.1);
		expect(supportedNow(r.overlay), "the flip happened").toBe(false);
		for (const [i, c] of r.canvases.entries()) {
			if (i === 2) continue;
			expect(c.calls.at(-1), `canvas ${i} placed for the form the path wrote`)
				.toEqual({ width: "125px", height: "100px", transform: "scale(8)", transformOrigin: "0 0" });
		}
		const tailCanvas = r.canvases[2];
		if (!tailCanvas) throw new Error("expected a tail canvas at r.canvases[2]");
		const style = tailCanvas.style as Record<string, string>;
		expect([tailCanvas.width, tailCanvas.height], "full tail backing").toEqual([1000, 800]);
		expect({
			left: style.left, top: style.top, width: style.width, height: style.height,
			transform: style.transform, transformOrigin: style.transformOrigin,
		}, "tail canvas placed by TailRenderer").toEqual({
			left: "0px", top: "0px", width: "125px", height: "100px",
			transform: "scale(8)", transformOrigin: "0 0",
		});
	});

	it("leaves the canvases alone when the zoom write took", () => {
		const r = flipRig(false);
		prepare(r.overlay);
		for (const c of r.canvases) c.calls.length = 0;
		apply(r.overlay, 0.1);
		expect(supportedNow(r.overlay), "no flip").toBe(true);
		for (const [i, c] of r.canvases.entries()) expect(c.calls, `canvas ${i} untouched`).toHaveLength(0);
	});

	it("writes no placement when the band box is not known yet", () => {
		const r = rig(true, "none", "1.25", "1");
		Object.assign(r.overlay, { cssScale: 0.125 });
		inline(r.host).setProperty("zoom", "1.25");
		prepare(r.overlay);
		for (const c of r.canvases) c.calls.length = 0;
		apply(r.overlay, 0.1);
		expect(supportedNow(r.overlay), "the flip still happened").toBe(false);
		for (const [i, c] of r.canvases.entries()) expect(c.calls, `canvas ${i} has no box to be given`).toHaveLength(0);
	});
});

/**
 * WHICH WRITE THE VERIFICATION IS ALLOWED TO BELIEVE.
 *
 * The read-back asks whether `baseZoom * k` reached the host. At k = 1 that
 * product IS the host's own factor, so the read agrees with the write whether
 * or not the overlay's write had any effect at all - a stylesheet
 * `zoom: ... !important` at the host's own factor passes it. Certifying there
 * and never reading again leaves the real shrink unverified: the host stays at
 * full size behind a counter-sized box and a camera that believes in k.
 *
 * So the verification waits for the first factor that actually asks the host to
 * move, and after one such read there are no more.
 */
describe("verification waits for a shrink that means something", () => {
	it("verifies at the shrink, not at a unity write that preceded it", () => {
		// The sheet pins the host at its own 1.25 with `!important`: a unity
		// write asks for 1.25 and reads 1.25 back while changing nothing.
		const { overlay, host } = rig(true, "none", "1.25", true);
		prepare(overlay);
		apply(overlay, 1);
		expect(supportedNow(overlay), "nothing has been certified by a unity write").toBe(true);
		expect(layoutOf(overlay).zoomVerified, "and nothing recorded as verified").not.toBe(true);
		apply(overlay, 0.1);
		expect(supportedNow(overlay), "the shrink was read back and refused").toBe(false);
		expect(host.calls.at(-1), "the same call ends in the fallback form")
			.toEqual({ width: "6400px", height: "4800px", zoom: "", transform: "scale(0.1)", transformOrigin: "0 0" });
	});

	it("verifies at the first shrink when no unity write preceded it", () => {
		const { overlay, host } = rig(true, "none", "1.25", true);
		prepare(overlay);
		apply(overlay, 0.1);
		expect(supportedNow(overlay), "the shrink was read back and refused").toBe(false);
		expect(host.calls.at(-1))
			.toEqual({ width: "6400px", height: "4800px", zoom: "", transform: "scale(0.1)", transformOrigin: "0 0" });
	});

	it("reads the computed style exactly once across unity and preview writes", () => {
		const { overlay, host } = rig(true, "none", "1.25");
		const win = (host.ownerDocument as { defaultView: Fields }).defaultView;
		const real = win.getComputedStyle as (el?: unknown) => Record<string, string>;
		const reads = vi.fn(real);
		win.getComputedStyle = reads;
		prepare(overlay);
		const afterCapture = readsOf(reads, host);
		apply(overlay, 1);
		expect(readsOf(reads, host) - afterCapture, "a unity write costs no read").toBe(0);
		// A pinch preview's frames, a return to 1, and more frames after it.
		for (const k of [0.9, 0.5, 0.2, 0.1, 1, 0.3]) apply(overlay, k);
		expect(readsOf(reads, host) - afterCapture, "one real verification, then none").toBe(1);
	});
});

/**
 * THE WRITE THAT VERIFIES NOTHING MUST STILL NOT DEMOTE THE HOST.
 *
 * A unity write is exempt from the read-back because `baseZoom * 1` is the
 * factor the host is already at - it asks for nothing and so certifies
 * nothing. That exemption is only sound if the write itself cannot MOVE the
 * host, and the bulk write is a camelCase assignment, which cannot carry
 * `!important`. On a host whose own `zoom` is inline AND important, beside a
 * stylesheet that declares a competing important one, that assignment replaces
 * the winning declaration with a losing one: the sheet takes over, the host is
 * at 1 rather than its own 1.25, and the exemption means nothing reads it back
 * until some later shrink.
 *
 * So the product write inherits the saved declaration's priority. At unity the
 * product IS the saved value, which makes the write a restore, and the
 * exemption is sound again. Where there was no important inline declaration to
 * inherit from, the bulk write is the whole write, byte for byte.
 */
describe("a unity write and a host whose own zoom is inline and important", () => {
	/** Inline `zoom: 1.25 !important`; sheet `.cm-editor { zoom: 1 !important }`. */
	const contested = (): Rig => {
		const r = rig(true, "none", "1.25", "1");
		inline(r.host).setProperty("zoom", "1.25", "important");
		Object.assign(r.overlay, { cssWidth: 1000, cssHeight: 800, cssScale: 0.125 });
		prepare(r.overlay);
		expect(layoutOf(r.overlay).baseZoom, "the inline important declaration is what the host is at").toBeCloseTo(1.25, 12);
		expect(layoutOf(r.overlay).styles.get("zoom")).toEqual({ value: "1.25", priority: "important" });
		return r;
	};
	const computedZoom = (host: ReturnType<typeof element>): string =>
		((host.ownerDocument as { defaultView: { getComputedStyle(el: unknown): { zoom?: string } } }).defaultView.getComputedStyle(host).zoom ?? "NaN");

	it("leaves the host at its own factor after a unity write", () => {
		const { overlay, host } = contested();
		apply(overlay, 1);
		expect(Number.parseFloat(computedZoom(host)), "the host is still at the factor it came with").toBeCloseTo(1.25, 12);
		expect(inline(host).getPropertyPriority("zoom"), "its declaration kept the priority that wins").toBe("important");
		expect(Number.parseFloat(host.props.zoom!), "and the value the unity product asked for").toBeCloseTo(1.25, 12);
	});

	it("then shrinks on the next real factor, reading it back exactly once", () => {
		const { overlay, host } = contested();
		const win = (host.ownerDocument as { defaultView: Fields }).defaultView;
		const reads = vi.fn(win.getComputedStyle as (el?: unknown) => Record<string, string>);
		win.getComputedStyle = reads;
		const before = readsOf(reads, host);
		apply(overlay, 1);
		expect(readsOf(reads, host) - before, "a unity write reads nothing").toBe(0);
		apply(overlay, 0.1);
		expect(readsOf(reads, host) - before, "one verification, at the shrink").toBe(1);
		// The important product out-specifies the sheet, so the zoom form holds.
		expect(supportedNow(overlay), "no fallback: the write took").toBe(true);
		expect(Number.parseFloat(computedZoom(host)), "1.25 * 0.1 on screen").toBeCloseTo(0.125, 12);
		expect(inline(host).getPropertyPriority("zoom"), "written with the priority it inherited").toBe("important");
		expect(host.calls.at(-1), "the bulk write is still the zoom form").toEqual({ width: "6400px", height: "4800px", zoom: "0.125", transform: "", transformOrigin: "" });
	});

	/**
	 * THE LIVENESS CONTROL: the same contested stylesheet with nothing inline
	 * to inherit from. There is no priority to carry, so the sheet wins, the
	 * unity write still reads nothing, and the shrink verifies, fails and takes
	 * the transform form with the canvases re-placed behind it.
	 */
	it("still falls back at the shrink when the host had no inline zoom to inherit", () => {
		const r = rig(true, "none", undefined, "1");
		Object.assign(r.overlay, { cssWidth: 1000, cssHeight: 800, cssScale: 0.125 });
		const tail = r.overlay.tail as TailRenderer;
		tail.configureInlineBacking(1000, 800, 1, 0.125, true);
		tail.restoreFullSurface();
		prepare(r.overlay);
		apply(r.overlay, 1);
		expect(supportedNow(r.overlay), "a unity write certifies nothing").toBe(true);
		for (const c of r.canvases) c.calls.length = 0;
		apply(r.overlay, 0.1);
		expect(supportedNow(r.overlay), "the shrink was refused").toBe(false);
		expect(r.host.calls.at(-1)).toEqual({ width: "6400px", height: "4800px", zoom: "", transform: "scale(0.1)", transformOrigin: "0 0" });
		expect(r.host.props.zoom, "nothing to put back on a host that had nothing").toBeUndefined();
		for (const [i, c] of r.canvases.entries()) {
			if (i === 2) continue;
			expect(c.calls.at(-1), `canvas ${i} re-placed for the transform form`)
				.toEqual({ width: "125px", height: "100px", transform: "scale(8)", transformOrigin: "0 0" });
		}
		const tailCanvas = r.canvases[2];
		if (!tailCanvas) throw new Error("expected a tail canvas at r.canvases[2]");
		const style = tailCanvas.style as Record<string, string>;
		expect([tailCanvas.width, tailCanvas.height], "full tail backing").toEqual([1000, 800]);
		expect({
			left: style.left, top: style.top, width: style.width, height: style.height,
			transform: style.transform, transformOrigin: style.transformOrigin,
		}, "tail canvas re-placed by TailRenderer").toEqual({
			left: "0px", top: "0px", width: "125px", height: "100px",
			transform: "scale(8)", transformOrigin: "0 0",
		});
	});
});

/**
 * THE TWO CLASS-MUTATION GUARDS IN `applyViewportBox`.
 *
 * `applyViewportBox` runs on every preview frame of a pinch. Both of its class
 * writes are guarded - the viewport token is added only when it is missing, the
 * own-lines token toggled only when it differs from the layout - because an add
 * or a toggle of a token that is already correct STILL queues a class mutation
 * record, and the viewport style observer then stamps on every frame for a class
 * that never changed. That is a per-frame cost in the pinch hot path, so the
 * guards are the point of the code, not a tidy-up.
 *
 * Nothing observed them until now: the fake host's `classList` hardwired
 * `contains` to false, so both guards took their write branch on every frame and
 * a removed guard read exactly the same. These arms count CALLS, not changes.
 */
describe("applyViewportBox: class writes only when the class changes", () => {
	it("writes each token once and leaves both alone on an unchanged second frame", () => {
		const { overlay, host } = rig(true);
		layoutOf(overlay).ownLines = true;

		apply(overlay, 0.5);
		expect(host.classWrites, "first frame writes both tokens")
			.toEqual(["add:handwriting-note-viewport", "toggle:handwriting-note-viewport-own-lines"]);
		expect(host.classes.has("handwriting-note-viewport")).toBe(true);
		expect(host.classes.has("handwriting-note-viewport-own-lines")).toBe(true);

		host.classWrites.length = 0;
		apply(overlay, 0.25);
		// The box is still written - only the CLASSES are left alone.
		expect(host.classWrites, "second frame changes no class, so it writes none").toEqual([]);
		expect(host.props.zoom, "the frame did run").toBe("0.25");
		expect(host.classes.has("handwriting-note-viewport")).toBe(true);
		expect(host.classes.has("handwriting-note-viewport-own-lines")).toBe(true);
	});

	it("still toggles the own-lines token on the frame the layout's answer changes", () => {
		const { overlay, host } = rig(true);
		layoutOf(overlay).ownLines = false;
		apply(overlay, 0.5);
		expect(host.classes.has("handwriting-note-viewport-own-lines"), "false needs no token").toBe(false);

		host.classWrites.length = 0;
		layoutOf(overlay).ownLines = true;
		apply(overlay, 0.5);
		expect(host.classWrites, "the answer changed, so the toggle runs")
			.toEqual(["toggle:handwriting-note-viewport-own-lines"]);
		expect(host.classes.has("handwriting-note-viewport-own-lines")).toBe(true);
	});
});
