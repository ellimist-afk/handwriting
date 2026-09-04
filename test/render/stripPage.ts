/**
 * The page half of the rendered-geometry harness: the real `MobileTools`
 * strip, built by the real constructor, inside a real browser.
 *
 * This file is BUNDLED BY ESBUILD AT TEST TIME and injected into a Playwright
 * page. It is never part of the plugin build. Its whole reason to exist is
 * that the label strings the chip has to hold must come from the shipped
 * `constantWidthLabel` code path, not from a test's idea of what that code
 * produces - a reconstruction of the thing under test measures the
 * reconstruction.
 *
 * WHAT IS REAL HERE
 *   - `MobileTools`, its `dropSlider`, its `constantWidthLabel`, and the
 *     three sliders' own min/max/step, read off the inputs the constructor
 *     built.
 *   - The browser's layout and font shaping.
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

interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

/**
 * Obsidian's element helpers, faithful to the parts this strip uses: `cls` is
 * a space-separated class list, `text` is textContent, `attr` is setAttribute
 * per key, and every creator appends to the receiver and returns the element.
 */
function installObsidianDom(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const make = (parent: HTMLElement, tag: string, o: ElOpts = {}): HTMLElement => {
		const el = document.createElement(tag);
		if (o.cls) for (const c of o.cls.split(/\s+/).filter(Boolean)) el.classList.add(c);
		if (o.text !== undefined) el.textContent = o.text;
		if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
		parent.appendChild(el);
		return el;
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
		return make(this, tag, o);
	};
	proto.createDiv = function (this: HTMLElement, o?: ElOpts | string): HTMLElement {
		return make(this, "div", typeof o === "string" ? { cls: o } : o);
	};
	proto.createSpan = function (this: HTMLElement, o?: ElOpts | string): HTMLElement {
		return make(this, "span", typeof o === "string" ? { cls: o } : o);
	};
	proto.setText = function (this: HTMLElement, t: string): void {
		this.textContent = t;
	};
	proto.empty = function (this: HTMLElement): void {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.detach = function (this: HTMLElement): void {
		this.remove();
	};
	proto.addClass = function (this: HTMLElement, ...c: string[]): void {
		this.classList.add(...c);
	};
	proto.removeClass = function (this: HTMLElement, ...c: string[]): void {
		this.classList.remove(...c);
	};
	proto.toggleClass = function (this: HTMLElement, c: string | string[], on: boolean): void {
		for (const one of Array.isArray(c) ? c : [c]) this.classList.toggle(one, on);
	};
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	};
}

const fakeHost = (): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	activeColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	setMouseInk: () => {},
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	palette: () => [],
	pickColor: () => {},
});

/** One measured sweep of one slider. */
export interface Sweep {
	aria: string;
	min: number;
	max: number;
	step: number;
	/** Every label the shipped formatter produced, in slider order. */
	labels: string[];
	/** The chip's rendered border-box width for each of those labels, in px. */
	widths: number[];
	/**
	 * The same labels in the INHERITED interface font, keeping the chip's own
	 * font-size and font-variant-numeric - i.e. the chip with only its
	 * `font-family` line removed.
	 */
	inheritedWidths: number[];
	/** What the chip's font-family actually resolved to. */
	chipFont: string;
	/** What the surrounding page's font-family actually resolved to. */
	pageFont: string;
	chipBoxSizing: string;
}

/** What one `min-width` candidate did to the real chip. */
export interface FloorProbe {
	candidate: string;
	natural: number;
	floored: number;
	binds: boolean;
	boxSizing: string;
	label: string;
}

function chipOf(pane: HTMLElement, aria: string): { input: HTMLInputElement; chip: HTMLElement } {
	const input = pane.querySelector<HTMLInputElement>(`input[aria-label="${aria}"]`);
	if (!input) throw new Error(`no slider input with aria-label ${aria}`);
	const pop = input.closest<HTMLElement>(".handwriting-slider-pop");
	if (!pop) throw new Error(`${aria} slider is not inside a slider pop`);
	// A display:none element has no box at all, so an unshown pop measures
	// zero for every label and every assertion below passes for nothing.
	pop.classList.add("is-showing");
	const chip = pop.querySelector<HTMLElement>(".handwriting-slider-val");
	if (!chip) throw new Error(`${aria} pop has no value chip`);
	return { input, chip };
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

/** Walks one slider across its own full range and measures the chip each step. */
function sweepSlider(pane: HTMLElement, aria: string): Sweep {
	const { input, chip } = chipOf(pane, aria);

	// The control: a span outside the pop, inheriting the PAGE font. It stands
	// for the chip AS IT WOULD BE with its `font-family` line deleted, which is
	// the only comparison that says whether that line is doing anything.
	const bare = document.createElement("span");
	bare.style.cssText = "position:absolute;left:-9999px;white-space:pre;";
	// Everything the chip's own rule gives it EXCEPT the pinned family, so
	// this models the chip as it would be with the `font-family` line gone -
	// not a bare span, which would also silently drop `tabular-nums` and
	// blame the wrong declaration.
	bare.style.fontSize = getComputedStyle(chip).fontSize;
	bare.style.fontVariantNumeric = getComputedStyle(chip).fontVariantNumeric;
	document.body.appendChild(bare);

	const min = Number(input.getAttribute("min"));
	const max = Number(input.getAttribute("max"));
	const step = Number(input.getAttribute("step"));
	const labels: string[] = [];
	const widths: number[] = [];
	const inheritedWidths: number[] = [];
	for (let v = min; v <= max + 1e-9; v = Math.round((v + step) * 1000) / 1000) {
		input.value = String(v);
		input.dispatchEvent(new Event("input"));
		const text = chip.textContent ?? "";
		labels.push(text);
		widths.push(chip.getBoundingClientRect().width);
		bare.textContent = text;
		inheritedWidths.push(bare.getBoundingClientRect().width);
	}
	const out: Sweep = {
		aria,
		min,
		max,
		step,
		labels,
		widths,
		inheritedWidths,
		chipFont: getComputedStyle(chip).fontFamily,
		pageFont: getComputedStyle(bare).fontFamily,
		chipBoxSizing: getComputedStyle(chip).boxSizing,
	};
	bare.remove();
	return out;
}

/**
 * Does a candidate `min-width` actually change the rendered width of the real
 * chip holding a real label?
 *
 * This is the check `5ch` failed silently. The chip is border-box with 6px of
 * side padding and a 1px border each side, so a floor stated in `ch` has to
 * clear the whole border box, not the text inside it.
 */
function floorProbe(
	pane: HTMLElement,
	aria: string,
	candidate: string,
	boxSizing?: string
): FloorProbe {
	const { chip } = chipOf(pane, aria);
	const before = chip.style.minWidth;
	const beforeBox = chip.style.boxSizing;
	// `0`, not `""`. Clearing the inline value would leave a `min-width` the
	// STYLESHEET declares in force, so `natural` would already be floored and
	// the probe would report every floor as inert - including a real one.
	// (`min-width: auto` is the flex-item default, but the automatic minimum
	// size applies on the main axis only, and this pop is a column, so 0 and
	// auto are the same number here.)
	// Overridable so the suite can pin the box model's role rather than assume
	// it: the same floor answers differently under content-box, which is how a
	// no-op got measured as a fix.
	if (boxSizing) chip.style.boxSizing = boxSizing;
	chip.style.minWidth = "0";
	const natural = chip.getBoundingClientRect().width;
	chip.style.minWidth = candidate;
	const floored = chip.getBoundingClientRect().width;
	const observedBox = getComputedStyle(chip).boxSizing;
	chip.style.minWidth = before;
	chip.style.boxSizing = beforeBox;
	return {
		candidate,
		natural,
		floored,
		// Sub-pixel on purpose: a floor that moves the box by a hundredth of a
		// pixel has bound, and the point of this probe is that "did nothing"
		// and "did almost nothing" are different answers.
		binds: floored > natural + 0.01,
		boxSizing: observedBox,
		label: chip.textContent ?? "",
	};
}

/**
 * Advance width of each given string in the INHERITED interface font, with no
 * `tabular-nums` asked for - the shape a bare theme label has.
 *
 * Here to tell two different causes of an uneven label apart: digits that are
 * not the same width as each other, and a pad character that is not the same
 * width as a digit. `constantWidthLabel`'s comment asserts U+2007 FIGURE SPACE
 * is "by definition a digit's width"; that is a claim about the spec, and a
 * font is free to disagree.
 */
function measureGlyphs(samples: string[], fontVariantNumeric = "normal"): Record<string, number> {
	const span = document.createElement("span");
	span.style.cssText = "position:absolute;left:-9999px;white-space:pre;font-size:11px;";
	span.style.fontVariantNumeric = fontVariantNumeric;
	document.body.appendChild(span);
	const out: Record<string, number> = {};
	for (const s of samples) {
		span.textContent = s;
		out[s] = span.getBoundingClientRect().width;
	}
	span.remove();
	return out;
}

declare global {
	interface Window {
		__hw: {
			buildStrip: typeof buildStrip;
			sweepSlider: typeof sweepSlider;
			floorProbe: typeof floorProbe;
			measureGlyphs: typeof measureGlyphs;
		};
	}
}

window.__hw = { buildStrip, sweepSlider, floorProbe, measureGlyphs };
