/**
 * The page half of the rendered-geometry harness: the real `MobileTools`
 * strip, built by the real constructor, inside a real browser.
 *
 * This file is BUNDLED BY ESBUILD AT TEST TIME and injected into a Playwright
 * page. It is never part of the plugin build. Its whole reason to exist is
 * that the boxes measured here must be the ones the shipped constructor and
 * the shipped stylesheet produce, not a reconstruction of them - a
 * reconstruction of the thing under test measures the reconstruction.
 *
 * WHAT IS REAL HERE
 *   - `MobileTools`, its `dropSlider`, and the three sliders' own
 *     min/max/step, read off the inputs the constructor built.
 *   - The pen and highlighter palettes, imported from `InkColor`.
 *   - The browser's layout.
 *   - `styles.css`, injected verbatim by the caller.
 *
 * WHAT IS STANDING IN
 *   - Obsidian's DOM helpers (`createDiv` and friends). Obsidian installs
 *     these on `HTMLElement.prototype` at runtime and they are not part of
 *     any DOM the browser ships, so a page without them cannot construct the
 *     strip at all. They build elements; none of them decides a width, and
 *     `setText` is the only one whose output the measurement reads.
 *   - `MobileToolsHost`, a no-op fake. The host is asked for state; nothing
 *     it returns reaches a stylesheet.
 */

import { MobileTools, type MobileToolsHost } from "../../src/inline/MobileTools";
import { PEN_COLORS, HIGHLIGHTER_COLORS } from "../../src/ink/InkColor";
import type { InkPreset } from "../../src/ink/InkPresets";
import type { ToolbarCorner } from "../../src/inline/ToolbarCorner";
import { installObsidianDom } from "./obsidianDom";
import { setPenToolsMode, type PenToolsMode } from "../../src/inline/PenToolsMode";
import { setNoteZoomControlsMode, type NoteZoomControlsMode } from "../../src/inline/NoteZoomControlsMode";

const fakeHost = (): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	// This harness measures a strip, it does not move one: the placement is
	// set straight through `setCorner` by the page that builds it.
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
	// Quick pens: no starred pens by default, so every strip a test builds
	// still has the row it had before this feature - one star chip and
	// nothing else.
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	// A render fixture, not a surface: this page measures the strip's layout,
	// and the pen inks in every screenshot it takes.
	penInksHere: () => true,
	// A render fixture measuring the WIDEST strip: false keeps the Pan button,
	// so the geometry this page reports is the full row's, not a phone's.
	hasTouch: () => false,
});

/** What one measured pop reports. */
export interface PopBox {
	/** Which pop, by the aria-label its own slider carries. */
	aria: string;
	/** The pop's border box - the number the redesign is judged on. */
	pop: { width: number; height: number };
	/** Its computed opacity, as a string, so "1" and "0.92" both read true. */
	opacity: string;
	/** Every direct child, as its class list or its tag, in order. */
	children: string[];
	/**
	 * The size slider's own box, and any transform it wears. A rotated slider
	 * reports a transform other than "none" here, which is the shape of the
	 * old pop and the thing a flat pop must not have.
	 */
	slider: { width: number; height: number; transform: string };
	/** The rendered box of each named row, and how many children it holds. */
	rows: Record<string, { width: number; height: number; count: number }>;
}

const box = (el: Element): { width: number; height: number } => {
	const r = el.getBoundingClientRect();
	return { width: +r.width.toFixed(2), height: +r.height.toFixed(2) };
};

/** A strip built, and one tool's pop opened on it, ready to be measured. */
interface OpenedPop {
	pane: HTMLElement;
	strip: MobileTools;
	input: HTMLInputElement;
	pop: HTMLElement;
	/** Which pop it is, by the aria-label its own slider carries. */
	aria: string;
}

/**
 * Build a strip whose host has a REAL palette and a full set of saved pens,
 * and open the named tool's pop.
 *
 * The full set matters: the pop's widest row has always been the preset row,
 * and it is 28px wider with four pens saved than with none, so a pop measured
 * on a fresh install is measured in its narrowest state and says nothing
 * about the state a user who has used the feature sees. `presets` is a
 * parameter here so both can be asserted.
 *
 * Two probes open a pop now - one measures the boxes it finds, the other
 * sweeps the slider inside it - and an opening written twice is an opening
 * that can drift, which would make the two probes measure two different
 * pops while looking like they measured one.
 */
function openPopFor(opts: { tool: "pen" | "highlighter" | "eraser"; presets: number }): OpenedPop {
	installObsidianDom();
	document.body.innerHTML = "";
	const pane = document.createElement("div");
	pane.style.cssText = "position:relative;width:1200px;height:800px;";
	document.body.appendChild(pane);

	const nib = opts.tool === "eraser" ? "pen" : opts.tool;
	const palette = nib === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
	const saved: InkPreset[] = palette.slice(0, opts.presets).map((c) => ({
		tool: nib,
		hex: c.hex,
		name: c.name,
		size: 1,
	}));
	let eraserOn = false;
	const strip = new MobileTools(pane, {
		...fakeHost(),
		activeTool: () => nib,
		eraserOn: () => eraserOn,
		toolColor: () => palette[0]!.hex,
		paletteFor: () => palette,
		presetsFor: () => saved,
	});

	const aria =
		opts.tool === "eraser" ? "Eraser size" : nib === "pen" ? "Pen size" : "Highlighter size";
	if (opts.tool === "eraser") {
		// The eraser's pop rides the MODE and opens on the off-to-on edge,
		// which is a refresh rather than a tap.
		eraserOn = true;
		strip.refreshNow();
	} else {
		// A nib's pop opens from its own strip button. TOUCH, because touch
		// has no hover and the tap is therefore the toggle - and because a
		// hover would also arm the tooltip.
		const want = nib === "pen" ? "Pen" : "Highlighter";
		const btn = [...pane.querySelectorAll<HTMLElement>(".handwriting-mobile-tool")].find((b) =>
			(b.dataset.tipLabel ?? "").startsWith(want)
		);
		if (!btn) throw new Error(`no ${want} button was built`);
		btn.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
		strip.refreshNow();
	}

	const input = pane.querySelector<HTMLInputElement>(`input[aria-label="${aria}"]`);
	if (!input) throw new Error(`no slider input with aria-label ${aria}`);
	const pop = input.closest<HTMLElement>(".handwriting-slider-pop");
	if (!pop) throw new Error(`${aria} slider is not inside a slider pop`);
	// A pop that never opened is `display: none`, which has no box at all, so
	// every measurement below would be zero and every assertion would pass for
	// nothing. This is the precondition, not a fix-up: `is-showing` is what
	// `hangUnder` sets, and if it is missing the pop did not open.
	if (!pop.classList.contains("is-showing")) {
		throw new Error(`the ${aria} pop did not open`);
	}
	return { pane, strip, input, pop, aria };
}

/** Open one tool's pop and measure it. */
function popProbe(opts: { tool: "pen" | "highlighter" | "eraser"; presets: number }): PopBox {
	const { input, pop, aria } = openPopFor(opts);

	const rows: PopBox["rows"] = {};
	for (const cls of [
		"handwriting-pop-presets",
		"handwriting-pop-colors",
		"handwriting-mode-chips",
	]) {
		const row = pop.querySelector(`.${cls}`);
		if (row) rows[cls] = { ...box(row), count: row.children.length };
	}

	return {
		aria,
		pop: box(pop),
		opacity: getComputedStyle(pop).opacity,
		children: [...pop.children].map((k) =>
			k.classList.length > 0 ? [...k.classList].join(".") : k.tagName.toLowerCase()
		),
		slider: { ...box(input), transform: getComputedStyle(input).transform },
		rows,
	};
}

/** One step of a sweep across a slider's whole range, measured. */
export interface ReadoutStep {
	value: string;
	text: string;
	popWidth: number;
	popHeight: number;
	trackLeft: number;
	trackWidth: number;
	numWidth: number;
	/** The rendered ink of the digits, from a Range; must fit numWidth. */
	textWidth: number;
}

export interface ReadoutProbe {
	aria: string;
	min: string;
	max: string;
	steps: ReadoutStep[];
}

/**
 * Sweep one slider from its own minimum to its own maximum, a step at a time,
 * and record what the readout says and where everything sits.
 *
 * THE POINT OF THE SWEEP is the digits: "3" and "64" are different widths of
 * text, and the whole reason the value readout was deleted in 1.4.12 is that
 * a change in that width used to be a change in the pop's width, which moved
 * the pop - and the slider inside it - sideways under the finger. So every
 * step reports the pop's box and the track's box as well as the readout's,
 * and the test compares them across the sweep rather than trusting either
 * the declared width or the reserved one.
 *
 * The value is what the BROWSER holds, read back off the input after the
 * write: a range input snaps what it is given onto its own step grid, and the
 * readout is asserted to say what the control holds, not what this page asked
 * for. The step arithmetic is rounded to 3dp for the same reason `pxToMult`
 * is - the pen's step lands on values whose float sum drifts.
 */
function readoutProbe(opts: { tool: "pen" | "highlighter" | "eraser"; presets: number }): ReadoutProbe {
	const { input, pop, aria } = openPopFor(opts);
	const num = pop.querySelector<HTMLElement>(".handwriting-slider-num");
	if (!num) throw new Error(`no readout in the ${aria} pop`);

	const min = input.min;
	const max = input.max;
	const step = Number(input.step);
	const steps: ReadoutStep[] = [];
	for (let v = Number(min); v <= Number(max) + 1e-9; v = Math.round((v + step) * 1000) / 1000) {
		input.value = String(v);
		const value = input.value;
		// The event the strip actually listens to, dispatched the way a drag
		// would: this page never calls the paint helper itself, or it would
		// be measuring its own call rather than the wiring.
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const popBox = pop.getBoundingClientRect();
		const trackBox = input.getBoundingClientRect();
		const numBox = num.getBoundingClientRect();
		// The INK, not the box: a Range over the readout's contents reports
		// what the glyphs actually occupy, which is what has to fit inside
		// the width the stylesheet reserved.
		const range = document.createRange();
		range.selectNodeContents(num);
		const ink = range.getBoundingClientRect();
		steps.push({
			value,
			text: num.textContent ?? "",
			popWidth: +popBox.width.toFixed(2),
			popHeight: +popBox.height.toFixed(2),
			trackLeft: +trackBox.left.toFixed(2),
			trackWidth: +trackBox.width.toFixed(2),
			numWidth: +numBox.width.toFixed(2),
			textWidth: +ink.width.toFixed(2),
		});
	}
	return { aria, min, max, steps };
}

function buildStrip(): HTMLElement {
	installObsidianDom();
	const pane = document.createElement("div");
	// Wide and relative: the pop is absolutely positioned, so its shrink-to-fit
	// width is capped by its containing block. A narrow pane would measure the
	// pane, not the chip.
	pane.style.cssText = "position:relative;width:1200px;height:800px;";
	document.body.appendChild(pane);
	new MobileTools(pane, fakeHost());
	return pane;
}

/**
 * A computed-style check of `.handwriting-note-viewport-controls.is-inking`,
 * real engine, real stylesheet - the render harness `fakeHost()`'s own
 * `MobileTools.test.ts:132` note says the group has never been built in a
 * unit test at all (`noteViewport` unset there), so this is also the
 * baseline fixture under a real engine.
 */
let lastNoteZoomStrip: MobileTools | null = null;

function buildNoteZoomStrip(): HTMLElement {
	installObsidianDom();
	const pane = document.createElement("div");
	pane.style.cssText = "position:relative;width:1200px;height:800px;";
	document.body.appendChild(pane);
	lastNoteZoomStrip = new MobileTools(pane, {
		...fakeHost(),
		noteViewport: {
			getNoteViewportState: () => ({ zoom: 1, busy: false, fitAvailable: true }),
			zoomNoteBy: () => true,
			resetNoteZoom: () => true,
			fitHandwriting: () => "ok",
		},
	});
	return pane;
}

interface NoteZoomVisibilityProbe {
	/** Whether the group exists at all - the baseline fact under test. */
	exists: boolean;
	opacity: string;
	visibility: string;
	display: string;
	buttonCount: number;
	/**
	 * The first button's own `.focus()` really lands on it, or not - a
	 * behavioural check that a hidden zoom button cannot take focus, not just
	 * a class name: `querySelectorAll` still finds a `display:none` ancestor's
	 * children (they are not REMOVED from the DOM), so counting nodes proves
	 * nothing about focusability. The browser's own focus algorithm does.
	 */
	firstButtonFocusable: boolean;
}

/**
 * `.is-inking`'s CSS transition (`opacity 40ms linear, visibility 0s linear
 * 40ms`, styles.css) is real, and headless Chromium's rendering pipeline does
 * not reliably tick its timeline forward on a plain wall-clock wait in this
 * harness (measured: `document.getAnimations()` still reports the transition
 * "running" at localTime 0 after 200ms of `page.waitForTimeout`, M). This
 * cell's own claim is about the RESOLVED value, not the animation's timing,
 * so every transition on the element is force-finished via the Web
 * Animations API (`Animation.finish()`) before reading computed style -
 * exact, and independent of whether this environment's compositor is
 * actually producing frames.
 */
function noteZoomVisibilityProbe(pane: HTMLElement, opts: { mode: NoteZoomControlsMode; inking: boolean }): NoteZoomVisibilityProbe {
	setNoteZoomControlsMode(opts.mode);
	lastNoteZoomStrip!.setInking(opts.inking);
	for (const a of document.getAnimations()) a.finish();
	const el = pane.querySelector<HTMLElement>(".handwriting-note-viewport-controls");
	if (!el) return { exists: false, opacity: "", visibility: "", display: "", buttonCount: 0, firstButtonFocusable: false };
	const cs = getComputedStyle(el);
	const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
	const first = buttons[0] ?? null;
	first?.focus();
	const firstButtonFocusable = first !== null && document.activeElement === first;
	first?.blur();
	return {
		exists: true,
		opacity: cs.opacity,
		visibility: cs.visibility,
		display: cs.display,
		buttonCount: buttons.length,
		firstButtonFocusable,
	};
}

/** What the folded second row looks like, measured. */
export interface MoreRowProbe {
	/** Whether the strip decided it needed a second row at all. */
	needed: boolean;
	/** Whether the second row is showing. */
	open: boolean;
	/** How many buttons ended up on each row. */
	firstRow: number;
	secondRow: number;
	/** The strip's own content box - inside its padding and border. */
	content: { left: number; right: number };
	/** The span the second row's buttons actually occupy. */
	buttons: { left: number; right: number };
	/** Free space to the left of those buttons, and to the right of them. */
	slackLeft: number;
	slackRight: number;
}

/**
 * Build a strip in a pane too narrow for its full row, open the fold, and
 * measure where the folded buttons sit.
 *
 * A REAL WIDTH is the whole point: `layoutOverflow` bails when the pane
 * measures zero, which is every element in the unit suite, so the folded row
 * only exists in a browser.
 */
function moreRowProbe(width: number): MoreRowProbe {
	installObsidianDom();
	document.body.innerHTML = "";
	const pane = document.createElement("div");
	pane.style.cssText = `position:relative;width:${width}px;height:600px;`;
	document.body.appendChild(pane);
	const strip = new MobileTools(pane, fakeHost());
	strip.refreshNow();

	const el = pane.querySelector<HTMLElement>(".handwriting-mobile-tools");
	if (!el) throw new Error("no strip was built");
	const face = el.querySelector<HTMLElement>(":scope > .handwriting-mobile-tools-face");
	if (!face) throw new Error("no strip face was built");
	// The chevron is the only way in: `setMoreOpen` is private, and driving
	// the control the user drives is the point of a render harness.
	const chevron = el.querySelector<HTMLElement>(".handwriting-tools-more");
	if (!chevron) throw new Error("no More chevron was built");
	chevron.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));

	const row = el.querySelector<HTMLElement>(".handwriting-mobile-tools-more");
	if (!row) throw new Error("no second row was built");
	const kids = [...row.children] as HTMLElement[];
	const rects = kids.map((k) => k.getBoundingClientRect());
	const stripRect = face.getBoundingClientRect();
	const cs = getComputedStyle(face);
	// The CONTENT box, not the border box: the row is centred inside the
	// strip's padding, so comparing against the border box would report every
	// symmetric layout as off by the padding.
	const content = {
		left: stripRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
		right: stripRect.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
	};
	const buttons = {
		left: Math.min(...rects.map((r) => r.left)),
		right: Math.max(...rects.map((r) => r.right)),
	};
	return {
		needed: el.classList.contains("is-more-needed"),
		open: el.classList.contains("is-more-open"),
		firstRow: face.querySelectorAll(":scope > .handwriting-mobile-tool").length,
		secondRow: kids.length,
		content,
		buttons,
		slackLeft: +(buttons.left - content.left).toFixed(2),
		slackRight: +(content.right - buttons.right).toFixed(2),
	};
}

/** One line of the strip, as the engine actually laid it out. */
export interface StripLine {
	/** Its vertical centre, rounded - what groups children into lines. */
	top: number;
	/** How many in-flow children sit on it. */
	count: number;
	/** The span its children occupy. */
	left: number;
	right: number;
	/** `right - left`. Equal across lines is what "even" means here. */
	width: number;
	/** Each child's class list, in order, so an orphan can be named. */
	items: string[];
}

/** What the wrapped strip looks like, measured. */
export interface StripGridProbe {
	/** The pane width it was built in. */
	width: number;
	/** The class list the strip ended up wearing. */
	classes: string[];
	/** Whether the strip says its first row did not fit on one line. */
	wrapped: boolean;
	/**
	 * Every group divider's RENDERED width. A divider that is not painted
	 * reports 0; a painted one reports its hairline plus nothing else, which
	 * is why the count of non-zero entries is the assertion and not the sum.
	 */
	dividerWidths: number[];
	/** Each divider's computed `display`. "none" is the owner's first ruling. */
	dividerDisplays: string[];
	/** The strip's own computed `display` - "flex" in a row, "grid" wrapped. */
	display: string;
	/** The strip's own border box height - one number per extra line. */
	stripHeight: number;
	/** The first row, grouped into the lines the engine put it on. */
	lines: StripLine[];
	/** The folded row's own line - it is `width: 100%` and never shares one. */
	moreRow: { count: number; width: number; open: boolean } | null;
	/** The strip's content box, inside its padding and border. */
	content: { left: number; right: number; width: number };
}

/**
 * Build a strip in a pane of the given width and report what the browser did
 * with its first row.
 *
 * IN-FLOW CHILDREN ONLY. The strip also holds the shared tooltip and three
 * slider pops, all absolutely positioned and all `display: none` at rest;
 * they are on no line and would otherwise be counted as one.
 */
function gridProbe(opts: { width: number; open?: boolean }): StripGridProbe {
	installObsidianDom();
	document.body.innerHTML = "";
	const pane = document.createElement("div");
	pane.style.cssText = `position:relative;width:${opts.width}px;height:600px;`;
	document.body.appendChild(pane);
	const strip = new MobileTools(pane, fakeHost());
	strip.refreshNow();

	const el = pane.querySelector<HTMLElement>(".handwriting-mobile-tools");
	if (!el) throw new Error("no strip was built");
	if (opts.open) {
		const chevron = el.querySelector<HTMLElement>(".handwriting-tools-more");
		if (!chevron) throw new Error("no More chevron was built");
		chevron.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
	}

	// The row lives in the strip's face; the pops hang beside it.
	const face = el.querySelector<HTMLElement>(":scope > .handwriting-mobile-tools-face");
	if (!face) throw new Error("no strip face was built");
	const inFlow = ([...face.children] as HTMLElement[]).filter((k) => {
		const cs = getComputedStyle(k);
		return cs.display !== "none" && cs.position === "static";
	});
	const row = el.querySelector<HTMLElement>(".handwriting-mobile-tools-more");
	// GROUPED BY VERTICAL CENTRE, not by top. A group divider carries
	// `margin: 6px 4px`, so its box starts 6px below the buttons it sits
	// between while being on the same line as them; grouping by `top` reports
	// every divider as a line of its own and would make a one-line strip look
	// like three.
	const lines = new Map<number, HTMLElement[]>();
	for (const k of inFlow) {
		if (k === row) continue;
		const r = k.getBoundingClientRect();
		const mid = Math.round(r.top + r.height / 2);
		const held = lines.get(mid);
		if (held) held.push(k);
		else lines.set(mid, [k]);
	}
	const stripRect = face.getBoundingClientRect();
	const cs = getComputedStyle(face);
	const content = {
		left: stripRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
		right: stripRect.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
		width: 0,
	};
	content.width = +(content.right - content.left).toFixed(2);

	return {
		width: opts.width,
		classes: [...el.classList],
		wrapped: el.classList.contains("is-wrapped"),
		dividerWidths: [...el.querySelectorAll(".handwriting-mobile-tools-divider")].map(
			(d) => +(d as HTMLElement).getBoundingClientRect().width.toFixed(2)
		),
		dividerDisplays: [...el.querySelectorAll(".handwriting-mobile-tools-divider")].map(
			(d) => getComputedStyle(d).display
		),
		display: cs.display,
		stripHeight: +stripRect.height.toFixed(2),
		lines: [...lines.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([mid, kids]) => {
				const top = mid;
				const rects = kids.map((k) => k.getBoundingClientRect());
				const left = Math.min(...rects.map((r) => r.left));
				const right = Math.max(...rects.map((r) => r.right));
				return {
					top,
					count: kids.length,
					left: +left.toFixed(2),
					right: +right.toFixed(2),
					width: +(right - left).toFixed(2),
					items: kids.map((k) => [...k.classList].join(".")),
				};
			}),
		moreRow:
			row && getComputedStyle(row).display !== "none"
				? {
						count: row.children.length,
						width: +row.getBoundingClientRect().width.toFixed(2),
						open: el.classList.contains("is-more-open"),
					}
				: null,
		content,
	};
}

/** One frame of a narrowing drag, as the frame before it painted. */
export interface DragStep {
	/** The pane width in force for the frame this describes. */
	width: number;
	/** The strip's border-box height - one line's worth per extra line. */
	height: number;
	/** How many lines its first row was on. */
	lines: number;
	/** Whether it was wearing `is-wrapped`. */
	wrapped: boolean;
	/**
	 * Whether it was wearing `is-more-open` AT THE FRAME BOUNDARY.
	 *
	 * `layoutOverflow` forces that class on to measure two boxes the
	 * stylesheet hides, and restores it in a `finally`. If the restore could
	 * ever be missed - or the forced state could ever outlive the task that
	 * set it - the second row would paint for a frame nobody asked for, which
	 * is what a flicker is. This is the frame-boundary witness to that.
	 */
	open: boolean;
}

export interface DragProbe {
	steps: DragStep[];
	/**
	 * Every DISTINCT class list the strip was left holding at the end of a
	 * task, in order, as a MutationObserver saw it.
	 *
	 * A MutationObserver batch is delivered as a microtask at the end of the
	 * task that wrote the attributes, and paint happens after that. So this is
	 * the SETTLED state of every task in the drag: a forced class that is
	 * restored inside the same synchronous block never appears here, and one
	 * that leaked would appear as its own entry.
	 */
	settled: string[];
	/**
	 * How many class mutations the observer saw in total - the proof that the
	 * instrument above was watching something. `layoutOverflow` writes the
	 * class attribute six times per pass it does not bail on.
	 */
	mutations: number;
	/**
	 * What the drag COST, counted the way `RefoldCost.test.ts` counts it: the
	 * ResizeObserver callbacks the run delivered, the scripted milliseconds
	 * inside them, and the number of times the engine gave up on settling a
	 * frame ("ResizeObserver loop completed with undelivered notifications").
	 *
	 * `loops` is the one worth asserting: a strip whose own layout fed back
	 * into the box its observer watches could not settle inside a frame, and
	 * every deferred frame is one the user paid for. The milliseconds are
	 * reported and never asserted - a threshold in ms measures the machine.
	 */
	cost: { callbacks: number; ms: number; loops: number };
}

/**
 * Count what the resize path costs, by wrapping the ResizeObserver every
 * strip on this page will construct. Armed BEFORE the strip is built: an
 * observer already created is already native.
 */
let dragCost = { callbacks: 0, ms: 0, loops: 0 };
let dragArmed = false;
function armDragCost(): void {
	dragCost = { callbacks: 0, ms: 0, loops: 0 };
	if (dragArmed) return;
	dragArmed = true;
	const Native = window.ResizeObserver;
	class Counting extends Native {
		constructor(cb: ResizeObserverCallback) {
			super((entries, self) => {
				const t0 = performance.now();
				try {
					cb(entries, self);
				} finally {
					dragCost.callbacks += 1;
					dragCost.ms += performance.now() - t0;
				}
			});
		}
	}
	window.ResizeObserver = Counting as unknown as typeof ResizeObserver;
	// Chrome reports the undelivered-notification loop as a window error
	// rather than a rejection or a console line, so this is where it can be
	// caught. Matched on the text because the engine gives it no code.
	window.addEventListener("error", (ev) => {
		if (String(ev.message).includes("ResizeObserver loop")) dragCost.loops += 1;
	});
}

/**
 * DRAG A PANE NARROWER, one step per frame, and record what each frame left
 * on screen.
 *
 * Not a sweep of independent layouts: ONE strip, one ResizeObserver, and the
 * pane's width written in consecutive animation frames - the shape of a hand
 * on a window's edge, which is the only way the reported defect happens.
 *
 * THE FRAME ACCOUNTING. A ResizeObserver's callbacks run after that frame's
 * animation-frame callbacks and before its paint. So the width written in
 * frame N is reacted to and painted in frame N, and the geometry read at the
 * top of frame N+1 is what frame N put on screen. Each step therefore records
 * the width that was in force for the frame it describes, read one frame
 * later.
 */
function dragProbe(opts: { from: number; to: number; step: number }): Promise<DragProbe> {
	installObsidianDom();
	armDragCost();
	document.body.innerHTML = "";
	const pane = document.createElement("div");
	pane.style.cssText = `position:relative;width:${opts.from}px;height:600px;`;
	document.body.appendChild(pane);
	const strip = new MobileTools(pane, fakeHost());
	strip.refreshNow();
	const el = pane.querySelector<HTMLElement>(".handwriting-mobile-tools");
	if (!el) throw new Error("no strip was built");
	const face = el.querySelector<HTMLElement>(":scope > .handwriting-mobile-tools-face");
	if (!face) throw new Error("no strip face was built");

	const settled: string[] = [];
	let mutations = 0;
	const watch = new MutationObserver((records) => {
		mutations += records.length;
		const now = [...el.classList].sort().join(" ");
		if (settled[settled.length - 1] !== now) settled.push(now);
	});
	watch.observe(el, { attributes: true, attributeFilter: ["class"] });

	const steps: DragStep[] = [];
	return new Promise<DragProbe>((done) => {
		let w = opts.from;
		const tick = (): void => {
			const r = el.getBoundingClientRect();
			const mids = new Set<number>();
			for (const k of [...face.children] as HTMLElement[]) {
				const cs = getComputedStyle(k);
				if (cs.display === "none" || cs.position !== "static") continue;
				const b = k.getBoundingClientRect();
				mids.add(Math.round(b.top + b.height / 2));
			}
			steps.push({
				width: w,
				height: +r.height.toFixed(2),
				lines: mids.size,
				wrapped: el.classList.contains("is-wrapped"),
				open: el.classList.contains("is-more-open"),
			});
			if (w <= opts.to) {
				watch.disconnect();
				done({ steps, settled, mutations, cost: { ...dragCost } });
				return;
			}
			w -= opts.step;
			pane.style.width = `${w}px`;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}

/**
 * What one overlap probe reports: the two boxes, in page coordinates, after
 * the strip has been given its chance to dodge.
 */
export interface ClearanceProbe {
	strip: { left: number; right: number; top: number; bottom: number };
	/**
	 * Where the strip would sit with NO dodge applied - measured by clearing
	 * the transform, reading the box and putting it back.
	 *
	 * This is what makes "the fix worked" mean something: without it a green
	 * run cannot tell a strip that dodged from a strip that was never in the
	 * way, and the test would pass just as well on a build with no fix in it.
	 */
	undodged: { left: number; right: number; top: number; bottom: number };
	actions: { left: number; right: number; top: number; bottom: number };
	/** The `transform` the strip ended up wearing; "" or "none" for no dodge. */
	transform: string;
	/** Whether the two boxes intersect on both axes, AFTER the dodge. */
	overlaps: boolean;
	/** Whether they WOULD have, without it. */
	wouldOverlap: boolean;
}

/** Browser-measured boxes for the phone chrome placement regression. */
export interface MobileChromeProbe {
	viewport: { width: number; height: number; dpr: number };
	pane: { left: number; right: number; top: number; bottom: number };
	strip: { left: number; right: number; top: number; bottom: number };
	grid: {
		columns: string;
		cell: string;
		buttonWidth: number;
		buttonHeight: number;
		startupColumns?: string;
		startupCell?: string;
		startupButtonWidth?: number;
	};
	header: { left: number; right: number; top: number; bottom: number };
	bottomNav: { left: number; right: number; top: number; bottom: number };
	hitsHeader: boolean;
	hitsBottomNav: boolean;
}

/**
 * A Samsung-sized editor pane with host chrome over both usable extremes.
 *
 * The obstruction boxes are parameters, not an Obsidian copy: their only job
 * is to make the reported top and bottom collisions real in Chromium, so the
 * middle-row assertions cannot pass through zero boxes or an inert fixture.
 */
function buildMobileChrome(platform: "android" | "ios" = "android"): HTMLElement {
	installObsidianDom();
	document.body.innerHTML = "";
	document.body.className =
		platform === "ios"
			? "is-mobile is-tablet is-phone is-ios"
			: "is-mobile is-tablet handwriting-android";
	const pane = document.createElement("div");
	pane.className = "mobile-placement-pane";
	pane.style.cssText = "position:relative;width:100vw;height:100vh;";
	document.body.appendChild(pane);

	const header = document.createElement("div");
	header.className = "mobile-header-obstruction";
	header.style.cssText =
		"position:fixed;z-index:20;left:0;right:0;top:0;height:104px;pointer-events:none;";
	document.body.appendChild(header);

	const bottomNav = document.createElement("div");
	bottomNav.className = "mobile-bottom-nav-obstruction";
	bottomNav.style.cssText =
		"position:fixed;z-index:20;left:0;right:0;bottom:0;height:80px;pointer-events:none;";
	document.body.appendChild(bottomNav);

	const tools = new MobileTools(pane, fakeHost());
	tools.setCollapsed(false);
	tools.setCorner("top-right");
	built = tools;
	return pane;
}

/** Select and measure either toolbar form against both synthetic host-chrome bands. */
function setMobileChromeState(corner: ToolbarCorner, collapsed: boolean): void {
	if (!built) throw new Error("no mobile toolbar has been built");
	built.setCollapsed(collapsed);
	built.setCorner(corner);
}

function mobileChromeProbe(pane: HTMLElement, collapsed: boolean): MobileChromeProbe {
	const strip = pane.querySelector<HTMLElement>(
		collapsed ? ".handwriting-pen-pill" : ".handwriting-mobile-tools"
	);
	const expandedStrip = pane.querySelector<HTMLElement>(".handwriting-mobile-tools");
	const header = document.querySelector<HTMLElement>(".mobile-header-obstruction");
	const bottomNav = document.querySelector<HTMLElement>(".mobile-bottom-nav-obstruction");
	if (!strip || !expandedStrip || !header || !bottomNav) {
		throw new Error("the mobile placement fixture is incomplete");
	}
	const button = expandedStrip.querySelector<HTMLElement>("button.handwriting-mobile-tool");
	if (!button) throw new Error("the mobile toolbar has no tool button");
	const box = (r: DOMRect): MobileChromeProbe["strip"] => ({
		left: r.left,
		right: r.right,
		top: r.top,
		bottom: r.bottom,
	});
	const paneBox = box(pane.getBoundingClientRect());
	const stripBox = box(strip.getBoundingClientRect());
	const headerBox = box(header.getBoundingClientRect());
	const navBox = box(bottomNav.getBoundingClientRect());
	const buttonBox = button.getBoundingClientRect();
	const stripStyle = getComputedStyle(expandedStrip);
	const intersects = (a: MobileChromeProbe["strip"], b: MobileChromeProbe["strip"]): boolean =>
		a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	return {
		viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
		pane: paneBox,
		strip: stripBox,
		grid: {
			columns: stripStyle.getPropertyValue("--hw-strip-cols").trim(),
			cell: stripStyle.getPropertyValue("--hw-strip-cell").trim(),
			buttonWidth: buttonBox.width,
			buttonHeight: buttonBox.height,
			...(expandedStrip.dataset.startupColumns === undefined
				? {}
				: { startupColumns: expandedStrip.dataset.startupColumns }),
			...(expandedStrip.dataset.startupCell === undefined
				? {}
				: { startupCell: expandedStrip.dataset.startupCell }),
			...(expandedStrip.dataset.startupButtonWidth === undefined
				? {}
				: { startupButtonWidth: Number(expandedStrip.dataset.startupButtonWidth) }),
		},
		header: headerBox,
		bottomNav: navBox,
		hitsHeader: intersects(stripBox, headerBox),
		hitsBottomNav: intersects(stripBox, navBox),
	};
}

/**
 * A pane shaped like a real Obsidian leaf, for item 5.
 *
 * WHAT IS REAL: `MobileTools`, its `setCorner`, its clearance path, and
 * `styles.css`. The BOXES are the browser's.
 *
 * WHAT IS STANDING IN: Obsidian's leaf markup, rebuilt here from the class
 * names the app actually uses - `.workspace-leaf-content > .view-header >
 * .view-actions`, with the header laid out the way Obsidian lays it out (a
 * fixed-height bar whose actions sit at its right end). This is a
 * PARAMETER of the measurement, not part of it: if Obsidian renames
 * `.view-actions` or stops putting it in the header, this page keeps passing
 * and the plugin stops working. That is the honest limit of what a harness
 * with no Obsidian in it can say, and it is the reason the class name is
 * written here exactly once, beside the note saying so.
 *
 * `header` false builds the NOTE's arrangement instead: the strip is mounted
 * inside the content area. Normally that content starts below the header;
 * `overlayHeader` models the mobile arrangement where host actions float over
 * it, which is the case where the note must find its row through the leaf.
 */
function buildLeaf(opts: {
	header: boolean;
	overlayHeader?: boolean;
	platform?: "android" | "ios";
	corner: ToolbarCorner;
	collapsed: boolean;
	/** The pane's width. A phone's and a desktop's take different branches. */
	width: number;
}): HTMLElement {
	installObsidianDom();
	document.body.innerHTML = "";
	document.body.className =
		opts.platform === "ios"
			? "is-mobile is-tablet is-phone is-ios"
			: opts.platform === "android"
				? "is-mobile is-tablet handwriting-android"
				: "";
	const leaf = document.createElement("div");
	leaf.className = "workspace-leaf-content";
	leaf.style.cssText = `position:relative;width:${opts.width}px;height:700px;`;
	const head = document.createElement("div");
	head.className = "view-header";
	head.style.cssText =
		"display:flex;align-items:center;justify-content:flex-end;height:40px;width:100%;" +
		(opts.overlayHeader ? "position:absolute;z-index:20;top:0;right:0;pointer-events:none;" : "");
	const actions = document.createElement("div");
	actions.className = "view-actions";
	actions.style.cssText =
		"display:flex;gap:4px;padding-right:8px;" +
		(opts.overlayHeader
			? "pointer-events:auto;background:var(--background-secondary);border-radius:20px;"
			: "");
	for (let i = 0; i < 2; i++) {
		const a = document.createElement("div");
		a.className = "clickable-icon view-action";
		a.style.cssText = "width:26px;height:26px;";
		actions.appendChild(a);
	}
	head.appendChild(actions);
	leaf.appendChild(head);
	const content = document.createElement("div");
	content.className = "view-content";
	content.style.cssText = "position:relative;width:100%;height:660px;";
	leaf.appendChild(content);
	document.body.appendChild(leaf);
	// THE MOUNT POINT is the difference between the two surfaces, and it is
	// the whole defect: main.ts hands the pdf controller `leaf.view
	// .containerEl` (the leaf, header included) while InkOverlay's
	// `chromeHost` uses `view.dom.parentElement` (inside the content).
	const pane = opts.header ? leaf : content;
	const tools = new MobileTools(pane, fakeHost());
	tools.setCorner(opts.corner);
	tools.setCollapsed(opts.collapsed);
	built = tools;
	return pane;
}

/**
 * The strip `buildLeaf` last made, so `reapplyCorner` can drive it again.
 *
 * One page builds one leaf, and `buildLeaf` empties the body first, so there
 * is never a second live strip for this to be ambiguous about.
 */
let built: MobileTools | null = null;

function setWritingVisibility(mode: PenToolsMode, inking: boolean, collapsed: boolean): void {
	if (!built) throw new Error("no leaf has been built");
	setPenToolsMode(mode);
	built.setCollapsed(collapsed);
	built.setInking(inking);
}

/**
 * Run the clearance a second time, through the same public entry point a
 * settings change would use.
 *
 * This is the compounding check: the dodge is a `transform`, and a pass that
 * measured the already-shifted box would shift it again, and again on every
 * resize.
 */
function reapplyCorner(corner: ToolbarCorner): void {
	if (!built) throw new Error("no leaf has been built");
	built.setCorner(corner);
}

/** Measure the strip (or its pill) against the pane's actions row. */
function clearanceProbe(pane: HTMLElement, collapsed: boolean): ClearanceProbe {
	const el = pane.querySelector<HTMLElement>(
		collapsed ? ".handwriting-pen-pill" : ".handwriting-mobile-tools"
	);
	if (!el) throw new Error("no strip was built");
	// `.view-actions` may live above the mount point (the note case), so this
	// searches the whole document rather than the pane.
	const actions = document.querySelector<HTMLElement>(".view-actions");
	if (!actions) throw new Error("no view-actions was built");
	const s = el.getBoundingClientRect();
	const a = actions.getBoundingClientRect();
	// The undodged box: clear the transform, measure, put it back. Reading
	// the rect forces layout, so the restored value is in place before
	// anything paints.
	const held = el.style.transform;
	el.style.transform = "";
	const bare = el.getBoundingClientRect();
	el.style.transform = held;
	const box = (r: DOMRect): ClearanceProbe["strip"] => ({
		left: r.left,
		right: r.right,
		top: r.top,
		bottom: r.bottom,
	});
	const hits = (r: DOMRect): boolean =>
		r.left < a.right && a.left < r.right && r.top < a.bottom && a.top < r.bottom;
	return {
		strip: box(s),
		undodged: box(bare),
		actions: box(a),
		transform: getComputedStyle(el).transform,
		overlaps: hits(s),
		wouldOverlap: hits(bare),
	};
}

/**
 * The strip in the pane Obsidian really gives it: `chromeHost()` is the
 * editor's `div.markdown-source-view`, which sits straight inside
 * `div.view-content`. Every other builder here uses a bare div, so a theme
 * rule keyed on that pair of classes (issue 54, the ITS theme's
 * `.view-content > div:is(.markdown-source-view, ...) > div`) never matches
 * in this harness without it. Built with a note viewport so the zoom bar is
 * one of the pane's children too, as it is in a note.
 */
function buildSourceViewStrip(): HTMLElement {
	installObsidianDom();
	const content = document.createElement("div");
	content.className = "view-content";
	content.style.cssText = "position:relative;width:1200px;height:800px;";
	document.body.appendChild(content);
	const pane = document.createElement("div");
	pane.className = "markdown-source-view";
	pane.style.cssText = "position:relative;width:1200px;height:800px;";
	content.appendChild(pane);
	new MobileTools(pane, {
		...fakeHost(),
		noteViewport: {
			getNoteViewportState: () => ({ zoom: 1, busy: false, fitAvailable: true }),
			zoomNoteBy: () => true,
			resetNoteZoom: () => true,
			fitHandwriting: () => "ok",
		},
	});
	return pane;
}

export interface SourceViewBox {
	/** Found as a direct child of the pane. */
	found: boolean;
	width: number;
	height: number;
	containerType: string;
}

export interface SourceViewStripProbe {
	strip: SourceViewBox;
	/** Centre y of every shown control on the strip's face, in order. */
	controlYs: number[];
	pillTip: SourceViewBox;
	zoomBar: SourceViewBox;
}

async function sourceViewStripProbe(pane: HTMLElement): Promise<SourceViewStripProbe> {
	await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
	const read = (cls: string): SourceViewBox => {
		const el = pane.querySelector<HTMLElement>(`:scope > .${cls}`);
		if (!el) return { found: false, width: 0, height: 0, containerType: "" };
		const r = el.getBoundingClientRect();
		return {
			found: true,
			width: +r.width.toFixed(2),
			height: +r.height.toFixed(2),
			containerType: getComputedStyle(el).containerType,
		};
	};
	const face = pane.querySelector<HTMLElement>(":scope > .handwriting-mobile-tools > .handwriting-mobile-tools-face");
	const controlYs = face
		? Array.from(face.children)
				.filter((c): c is HTMLElement => c instanceof HTMLElement && c.getBoundingClientRect().width > 0)
				.map((c) => {
					const r = c.getBoundingClientRect();
					return +(r.top + r.height / 2).toFixed(2);
				})
		: [];
	return {
		strip: read("handwriting-mobile-tools"),
		controlYs,
		pillTip: read("handwriting-pill-tip"),
		zoomBar: read("handwriting-note-viewport-controls"),
	};
}

declare global {
	interface Window {
		__hw: {
			buildSourceViewStrip: typeof buildSourceViewStrip;
			sourceViewStripProbe: typeof sourceViewStripProbe;
			setWritingVisibility: typeof setWritingVisibility;
			buildStrip: typeof buildStrip;
			buildLeaf: typeof buildLeaf;
			buildMobileChrome: typeof buildMobileChrome;
			setMobileChromeState: typeof setMobileChromeState;
			clearanceProbe: typeof clearanceProbe;
			mobileChromeProbe: typeof mobileChromeProbe;
			reapplyCorner: typeof reapplyCorner;
			popProbe: typeof popProbe;
			readoutProbe: typeof readoutProbe;
			moreRowProbe: typeof moreRowProbe;
			gridProbe: typeof gridProbe;
			dragProbe: typeof dragProbe;
			buildNoteZoomStrip: typeof buildNoteZoomStrip;
			noteZoomVisibilityProbe: typeof noteZoomVisibilityProbe;
		};
	}
}

window.__hw = {
	buildSourceViewStrip,
	sourceViewStripProbe,
	setWritingVisibility,
	buildStrip,
	buildLeaf,
	buildMobileChrome,
	setMobileChromeState,
	clearanceProbe,
	mobileChromeProbe,
	reapplyCorner,
	popProbe,
	readoutProbe,
	moreRowProbe,
	gridProbe,
	dragProbe,
	buildNoteZoomStrip,
	noteZoomVisibilityProbe,
};
