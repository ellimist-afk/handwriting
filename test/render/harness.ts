/**
 * A rendered-geometry harness: measure what the engine actually paints, from
 * the plugin's OWN stylesheet.
 *
 * Every CSS assertion in this repo before this file was a text match against
 * `styles.css`. A text match cannot see a declaration the engine ignores, and
 * it cannot see a size at all - which is most of what the strip's chrome is
 * judged on. Two real defects walked past a green text-matching suite: a
 * `min-width: 5ch` floor that sat below the element's own border-box width
 * and never bound, and `font-variant-numeric: tabular-nums` under a face with
 * no `tnum` feature, where the engine simply declines.
 *
 * WHAT THIS CAN ANSWER
 *   - the rendered box of a real element built by real plugin code, under the
 *     real `styles.css`: how big a pop is, where a folded row's buttons sit,
 *     whether a strip dodges the pane's header
 *   - what a declaration RESOLVED to (`getComputedStyle`), not what it said
 *   - what a LAYOUT-DEPENDENT code path does. `layoutOverflow` bails when the
 *     pane measures zero, which is every element in the unit suite, so the
 *     folded second row exists only here.
 *
 * WHAT THIS CANNOT ANSWER
 *   - anything about Obsidian. There is no Obsidian here. The theme
 *     variables below are INJECTED by this file, and an injected value is a
 *     parameter, not a measurement: a real theme sets different ones.
 *     The host's OWN RULES are not here either unless a test brings them:
 *     `hostCss` layers a hand-reduced fixture of them UNDER the plugin's
 *     sheet, in the order Obsidian loads a plugin's stylesheet, which is
 *     the only way this harness can see a host declaration the plugin
 *     forgot to override (the slider thumb's `top`, 2026-09-06, reached two
 *     users with every file here green).
 *   - anything about iOS or Android. Chromium is the default; the startup
 *     regression also runs in Playwright's desktop WebKit, but that is a
 *     patched build and its font stack is not iOS Safari's.
 *   - whether a pop is PLACED correctly. It measures the pop's own box;
 *     `hangUnder`'s re-centring and `popRightOffset`'s clamping are pinned
 *     separately, against rects rather than a render.
 *   - anything about a real device's pixel ratio, zoom, or accessibility text
 *     scaling.
 *   - correctness of anything the fake host stands in for.
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium, webkit, type Browser, type Page } from "playwright";
import type {
	ClearanceProbe,
	DragProbe,
	MobileChromeProbe,
	MoreRowProbe,
	PopBox,
	ReadoutProbe,
	SourceViewStripProbe,
	StripGridProbe,
} from "./stripPage";
import type {
	FoldOrderOptions,
	FoldProbe,
	HiddenBoxProbe,
	ReflowProbe,
	RowWidthProbe,
} from "./foldOrderPage";
import type { ToolbarCorner } from "../../src/inline/ToolbarCorner";
import rawStyles from "../../styles.css?raw";

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * The stylesheet is read from disk, verbatim, and injected whole. This is the
 * non-negotiable property of the whole facility: a harness built from a
 * hand-written copy of the rules measures the copy.
 */
export const stylesCss = (): string => rawStyles;

export async function openPaperPicker(browser: Browser, width: number, current = "lines", global = "dots", dark = false): Promise<Page> {
	const page = await browser.newPage({ viewport: { width, height: 700 } });
	await injectSheets(page, "paper picker", {});
	// Approximate Obsidian's Modal shell, including its normal generous width.
	await page.addStyleTag({ content: `body { margin:0; padding:12px; box-sizing:border-box; background:${dark ? "#181818" : "#eeeeee"}; }
body { --background-primary:${dark ? "#242424" : "#ffffff"}; --background-secondary:${dark ? "#303030" : "#f6f6f6"}; --background-modifier-border:${dark ? "#606060" : "#cccccc"}; --text-normal:${dark ? "#eeeeee" : "#222222"}; --text-muted:${dark ? "#bbbbbb" : "#666666"}; --text-on-accent:#ffffff; }
.modal { position:relative; box-sizing:border-box; width:700px; margin:12px auto; padding:20px; border:1px solid var(--background-modifier-border); border-radius:12px; background:var(--background-primary); color:var(--text-normal); }
.modal-title { font:600 20px sans-serif; margin:0 32px 6px 0; } .modal-close-button { position:absolute; right:8px; top:8px; } #picker-opener { position:absolute; opacity:0; }
` });
	await page.addScriptTag({ content: await pageBundle("./paperPickerPage.ts") });
	await page.evaluate(({current,global}) => { window.__paperPicker = window.openPaperPicker(current,global); }, {current,global});
	return page;
}

/**
 * One of the host's stylesheets, as this suite keeps them: a HAND REDUCTION
 * in `test/render/fixtures/`, naming its source, its values and the date it
 * was read, never a dump of the app's CSS. Read from disk at call time so a
 * fixture edited to match a new app build is what the next run injects.
 */
export const hostFixture = (name: string): string =>
	readFileSync(here(`./fixtures/${name}`), "utf8");

/**
 * A `:root` block setting host tokens, for the value a fixture leaves as a
 * parameter - the app ships `--slider-thumb-y` twice, and the test that
 * loads the range fixture runs at both. Goes in `hostCss` beside the fixture.
 */
export const hostVars = (vars: Readonly<Record<string, string>>): string =>
	`:root {\n${Object.entries(vars)
		.map(([k, v]) => `\t${k}: ${v};`)
		.join("\n")}\n}`;

/**
 * EVERY value this harness supplies that Obsidian would have supplied.
 *
 * Each one is a parameter of the measurement, not part of it. They are
 * grouped by whether they can move a number, because that is the only
 * distinction that matters when reading a result.
 */
export const INJECTED = {
	/**
	 * Load-bearing: change one of these and a measured box changes.
	 *
	 * `--background-modifier-border` is inside the pop's, the swatch's and the
	 * preset chip's `border: 1px solid var(...)`. Unset, that shorthand is
	 * invalid at computed-value time and border-width reverts to `medium` -
	 * 3px a side, 6px on the pop's border box.
	 *
	 * `--font-monospace` is no longer read by anything in the pop; the value
	 * readout that pinned it went with the rotated slider. Kept injected
	 * because a page is cheaper to leave complete than to trim to whatever the
	 * current stylesheet happens to reference.
	 */
	loadBearing: {
		"--font-monospace": "monospace",
		"--background-modifier-border": "#dcddde",
	},
	/**
	 * Cosmetic: referenced by the pop and its rows, cannot move a box.
	 * Injected so the page is a render rather than a pile of invalid
	 * declarations.
	 */
	cosmetic: {
		"--background-primary": "#ffffff",
		"--background-secondary": "#f2f3f5",
		"--text-normal": "#1f1f1f",
		"--text-muted": "#6a6a6a",
		/*
		 * The FAINTEST token, and the one thing here that has to stay
		 * distinguishable from `--text-muted` above rather than merely be
		 * present: `KnobAndDots.test.ts` asserts which of the two the grip's
		 * dots resolve to, and two equal values would make that assertion
		 * pass whichever token the stylesheet named.
		 */
		"--text-faint": "#adadad",
		"--text-on-accent": "#ffffff",
		"--interactive-accent": "#7b6cd9",
	},
} as const;

/**
 * Obsidian's app.css applies a border-box reset, and the swatches, chips and
 * rows inside the pop are all sized on the assumption that it is in force -
 * a 22px swatch with a 1px border is 24px under content-box, and a row of
 * four of them then no longer fits the pop. Stated here as a parameter, and
 * asserted to have taken effect rather than assumed.
 *
 * The POP's own width does not depend on this: it declares `box-sizing`
 * itself, precisely so the one number the layout hangs on cannot be changed
 * by a host stylesheet. See `.handwriting-slider-pop` in styles.css.
 */
export const BOX_SIZING_RESET = "*, *::before, *::after { box-sizing: border-box; }";

const bundles = new Map<string, string>();

/**
 * Bundles one harness page - and with it the real plugin code it imports - for
 * injection into a Playwright page. `obsidian` is aliased to the suite's
 * existing runtime stub; the real package ships types and no runtime entry, so
 * nothing importing it can be bundled.
 *
 * Keyed by entry rather than a single cached string: there are two pages now,
 * and each installs its own global. Bundling both into one page would run both
 * top-level installs, which is a way for one harness to change what another
 * measures.
 */
async function pageBundle(entry: string): Promise<string> {
	const held = bundles.get(entry);
	if (held !== undefined) return held;
	const out = await build({
		entryPoints: [here(entry)],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: here(entry === "./paperPickerPage.ts" ? "./paperPickerObsidian.ts" : "../obsidian-stub.ts") },
	});
	const file = out.outputFiles[0];
	if (!file) throw new Error(`esbuild produced no output for ${entry}`);
	bundles.set(entry, file.text);
	return file.text;
}

/** The strip page, which every measurement before the fold order used. */
const stripBundle = (): Promise<string> => pageBundle("./stripPage.ts");

export interface Harness {
	page: Page;
	close(): Promise<void>;
	/** Open one tool's pop with `presets` pens saved, and measure it. */
	pop(opts: { tool: "pen" | "highlighter" | "eraser"; presets: number }): Promise<PopBox>;
	/** Sweep one tool's slider end to end, and measure it at every step. */
	readout(opts: { tool: "pen" | "highlighter" | "eraser"; presets: number }): Promise<ReadoutProbe>;
	/** Fold the strip into a pane `width` wide, open the row, measure it. */
	moreRow(width: number): Promise<MoreRowProbe>;
	/** The strip's own lines at `width`: how they wrapped, and what shows. */
	grid(opts: { width: number; open?: boolean }): Promise<StripGridProbe>;
	/** Narrow one live pane a step per frame, and record every frame. */
	drag(opts: { from: number; to: number; step: number }): Promise<DragProbe>;
}

export interface OpenOptions {
	/**
	 * The interface font the PAGE inherits. The pop's own rows carry no
	 * text, so this cannot move a measured box; it is here so the page is a
	 * render of something rather than of nothing.
	 */
	interfaceFont?: string;
	/** Overrides the on-disk stylesheet. Only the teeth demonstrations use it. */
	css?: string;
	/**
	 * Host stylesheets to lay UNDER the plugin's, each in its own `<style>`,
	 * in the order given, all before `styles.css` - the order Obsidian loads
	 * a plugin's sheet after its own. Specificity decides the conflicts
	 * either way; the order is kept so the page is the real cascade. Use
	 * `hostFixture` for the sheet and `hostVars` for its parameters rather
	 * than concatenating strings into `css`, which REPLACES the plugin's
	 * sheet and so measures whatever the caller pasted.
	 */
	hostCss?: string | readonly string[];
	/**
	 * The page's device pixel ratio. Left unset it is 1, which is every
	 * measurement here before `KnobAndDots.test.ts` - and which is exactly
	 * the machine on which the two defects that file covers are invisible.
	 *
	 * It is real: playwright hands the ratio to the browser, the engine snaps
	 * painted edges to whole DEVICE pixels against it, and a screenshot comes
	 * back at that resolution. A CSS length that lands on a fraction of a
	 * device pixel is where a hand-computed offset stops halving.
	 */
	deviceScaleFactor?: number;
}

/**
 * Every sheet a harness page carries, in cascade order: the reset and the
 * injected tokens, then any host sheets, then the plugin's. One function so
 * the three page openers below cannot drift apart on what "under the plugin's
 * stylesheet" means.
 */
async function injectSheets(
	page: Page,
	title: string,
	opts: {
		interfaceFont?: string;
		css?: string;
		hostCss?: string | readonly string[];
		skipPluginCss?: boolean;
	}
): Promise<void> {
	const vars = Object.entries({ ...INJECTED.loadBearing, ...INJECTED.cosmetic })
		.map(([k, v]) => `${k}: ${v};`)
		.join("\n\t");
	await page.setContent(`<!doctype html><meta charset=utf-8><title>${title}</title>`);
	await page.addStyleTag({
		content: [
			BOX_SIZING_RESET,
			`:root {\n\t${vars}\n}`,
			// 16px is the browser default, written down rather than inherited
			// by accident. The chip sets its own 11px, so this reaches the
			// control span only.
			`body { margin: 0; font-size: 16px; font-family: ${
				opts.interfaceFont ?? "Arial, sans-serif"
			}; }`,
		].join("\n"),
	});
	const host =
		opts.hostCss === undefined
			? []
			: typeof opts.hostCss === "string"
				? [opts.hostCss]
				: opts.hostCss;
	for (const sheet of host) await page.addStyleTag({ content: sheet });
	if (!opts.skipPluginCss) {
		await page.addStyleTag({ content: opts.css ?? stylesCss() });
	}
}

/** Opens a page holding the real strip under the real stylesheet. */
export async function openStrip(browser: Browser, opts: OpenOptions = {}): Promise<Harness> {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
		...(opts.deviceScaleFactor === undefined
			? {}
			: { deviceScaleFactor: opts.deviceScaleFactor }),
	});
	await injectSheets(page, "chip geometry", opts);
	await page.addScriptTag({ content: await stripBundle() });
	await page.evaluate(() => {
		(window as unknown as { __pane: HTMLElement }).__pane = window.__hw.buildStrip();
	});
	return {
		page,
		close: () => page.close(),
		pop: (o) => page.evaluate((a) => window.__hw.popProbe(a), o),
		readout: (o) => page.evaluate((a) => window.__hw.readoutProbe(a), o),
		moreRow: (w) => page.evaluate((a) => window.__hw.moreRowProbe(a), w),
		grid: (o) => page.evaluate((a) => window.__hw.gridProbe(a), o),
		drag: (o) => page.evaluate((a) => window.__hw.dragProbe(a), o),
	};
}

export interface NoteZoomHarness {
	page: Page;
	close(): Promise<void>;
	/** Sets the mode, applies inking, reads the group's computed style. */
	probe(o: { mode: "auto" | "show" | "hide"; inking: boolean }): Promise<{
		exists: boolean;
		opacity: string;
		visibility: string;
		display: string;
		buttonCount: number;
		firstButtonFocusable: boolean;
	}>;
}

/**
 * Opens a page holding the real strip, built with `noteViewport` set - the
 * baseline `MobileTools.test.ts`'s own `fakeHost()` never builds - under the
 * real stylesheet.
 */
export async function openNoteZoomStrip(browser: Browser, opts: OpenOptions = {}): Promise<NoteZoomHarness> {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await injectSheets(page, "note zoom controls", opts);
	await page.addScriptTag({ content: await stripBundle() });
	await page.evaluate(() => {
		(window as unknown as { __pane: HTMLElement }).__pane = window.__hw.buildNoteZoomStrip();
	});
	return {
		page,
		close: () => page.close(),
		probe: (o) =>
			page.evaluate(
				a => window.__hw.noteZoomVisibilityProbe((window as unknown as { __pane: HTMLElement }).__pane, a),
				o,
			),
	};
}

/**
 * Opens a page holding the real strip inside `div.markdown-source-view` in
 * `div.view-content`, the pane Obsidian gives it, under the real stylesheet
 * and any host sheets, and measures the pane's three direct children.
 */
export async function openSourceViewStrip(browser: Browser, opts: OpenOptions = {}): Promise<{
	page: Page;
	close(): Promise<void>;
	probe(): Promise<SourceViewStripProbe>;
}> {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	await injectSheets(page, "source view strip", opts);
	await page.addScriptTag({ content: await stripBundle() });
	await page.evaluate(() => {
		(window as unknown as { __pane: HTMLElement }).__pane = window.__hw.buildSourceViewStrip();
	});
	return {
		page,
		close: () => page.close(),
		probe: () =>
			page.evaluate(() => window.__hw.sourceViewStripProbe((window as unknown as { __pane: HTMLElement }).__pane)),
	};
}

export type BrowserEngine = "chromium" | "webkit";

export async function launch(engine: BrowserEngine = "chromium"): Promise<Browser> {
	return (engine === "webkit" ? webkit : chromium).launch();
}

export type { Browser };

/**
 * A page holding a leaf-shaped pane with a real `.view-actions`, for item 5.
 *
 * Same injected theme variables and same verbatim stylesheet as `openStrip`
 * above, and for the same reason: the strip's own rules read
 * `--background-modifier-border` inside a `border` shorthand, and an invalid
 * shorthand reverts to `medium` - 3px a side, which would move every edge
 * this measures.
 *
 * The viewport is a PHONE's, because the collision was reported on one. The
 * overlap is not really a width problem - a top-right strip shares a corner
 * with a top-right actions row at any width - but measuring it at the size it
 * was reported at is the honest thing to do.
 */
export interface LeafHarness {
	page: Page;
	close(): Promise<void>;
	probe(): Promise<ClearanceProbe>;
	/** Run the clearance again, for the compounding check. */
	reapply(): Promise<void>;
}

export interface LeafOptions {
	/** True mounts on the leaf (the pdf's arrangement); false, in the content. */
	header: boolean;
	/** Let the host header float over note content, as Obsidian mobile chrome can. */
	overlayHeader?: boolean;
	/** Apply the host's mobile platform classes to the leaf fixture. */
	platform?: "android" | "ios";
	corner: ToolbarCorner;
	collapsed: boolean;
	/** The pane's width. A phone and a desktop take different branches. */
	width: number;
	/** Host sheets under the plugin's; see `OpenOptions.hostCss`. */
	hostCss?: string | readonly string[];
}

export async function openLeaf(browser: Browser, opts: LeafOptions): Promise<LeafHarness> {
	const page = await browser.newPage({
		viewport: { width: Math.max(opts.width + 60, 480), height: 800 },
		...(opts.platform ? { deviceScaleFactor: 3 } : {}),
	});
	await injectSheets(page, "header clearance", { hostCss: opts.hostCss });
	await page.addScriptTag({ content: await stripBundle() });
	await page.evaluate((o) => {
		(window as unknown as { __pane: HTMLElement }).__pane = window.__hw.buildLeaf(o);
	}, opts);
	return {
		page,
		close: () => page.close(),
		probe: () =>
			page.evaluate(
				(c) =>
					window.__hw.clearanceProbe(
						(window as unknown as { __pane: HTMLElement }).__pane,
						c
					),
				opts.collapsed
			),
		// Through `setCorner`, a public entry point that ends in the
		// clearance, rather than reaching for a private method a test has no
		// business knowing the name of.
		reapply: async () => {
			await page.evaluate((c) => window.__hw.reapplyCorner(c), opts.corner);
		},
	};
}

/** The exact viewport/device-scale fixture for issue #10's mobile report. */
export interface MobileChromeHarness {
	page: Page;
	close(): Promise<void>;
	probe(corner: ToolbarCorner, collapsed?: boolean): Promise<MobileChromeProbe>;
	/** Read startup geometry without calling a setter that itself re-plans it. */
	probeCurrent(collapsed?: boolean): Promise<MobileChromeProbe>;
}

export async function openMobileChrome(
	browser: Browser,
	opts: {
		hostCss?: string | readonly string[];
		platform?: "android" | "ios";
		width?: number;
		height?: number;
		latePluginCss?: boolean;
	} = {}
): Promise<MobileChromeHarness> {
	const page = await browser.newPage({
		viewport: { width: opts.width ?? 360, height: opts.height ?? 780 },
		deviceScaleFactor: 3,
	});
	await injectSheets(page, "mobile toolbar placement", {
		hostCss: opts.hostCss,
		skipPluginCss: opts.latePluginCss,
	});
	await page.addScriptTag({ content: await stripBundle() });
	if (opts.latePluginCss) {
		// Wait for the observer's FIRST delivery explicitly. Two animation
		// frames are not a portable substitute: WebKit is allowed to deliver a
		// newly observed box after the rAF callback in that rendering update.
		await page.evaluate(() => {
			const NativeObserver = window.ResizeObserver;
			let delivered!: () => void;
			const firstDelivery = new Promise<void>((resolve) => {
				delivered = resolve;
			});
			let pending = true;
			class DeliveryTrackedObserver extends NativeObserver {
				constructor(callback: ResizeObserverCallback) {
					super((entries, observer) => {
						callback(entries, observer);
						if (pending) {
							pending = false;
							delivered();
						}
					});
				}
			}
			Object.defineProperty(window, "ResizeObserver", {
				configurable: true,
				value: DeliveryTrackedObserver,
			});
			(
				window as unknown as { __hwFirstResizeDelivery: Promise<void> }
			).__hwFirstResizeDelivery = firstDelivery;
		});
	}
	await page.evaluate((platform) => {
		(window as unknown as { __pane: HTMLElement }).__pane =
			window.__hw.buildMobileChrome(platform);
	}, opts.platform ?? "android");
	if (opts.latePluginCss) {
		// Let the constructor's parent ResizeObserver deliver while only host
		// CSS exists, then record the poisoned measurement as a positive control.
		await page.evaluate(async () => {
			await (
				window as unknown as { __hwFirstResizeDelivery: Promise<void> }
			).__hwFirstResizeDelivery;
			const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools");
			const button = document.querySelector<HTMLElement>(".handwriting-tools-collapse");
			if (!strip || !button) throw new Error("mobile toolbar startup fixture is incomplete");
			const style = getComputedStyle(strip);
			strip.dataset.startupColumns = style.getPropertyValue("--hw-strip-cols").trim();
			strip.dataset.startupCell = style.getPropertyValue("--hw-strip-cell").trim();
			strip.dataset.startupButtonWidth = String(button.getBoundingClientRect().width);
		});
		await page.addStyleTag({ content: stylesCss() });
		// A child ResizeObserver should now see the collapse button settle from
		// its host-sized label box to the plugin's square button and re-plan.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
	}
	return {
		page,
		close: () => page.close(),
		probeCurrent: (collapsed = false) =>
			page.evaluate(
				(folded) =>
					window.__hw.mobileChromeProbe(
						(window as unknown as { __pane: HTMLElement }).__pane,
						folded
					),
				collapsed
			),
		probe: async (corner, collapsed = false) => {
			// Public placement path first, then two frames for ResizeObserver and
			// the strip's overflow pass to settle before geometry is read.
			await page.evaluate(
				({ placement, folded }) => window.__hw.setMobileChromeState(placement, folded),
				{ placement: corner, folded: collapsed }
			);
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);
			return page.evaluate(
				(folded) =>
					window.__hw.mobileChromeProbe(
						(window as unknown as { __pane: HTMLElement }).__pane,
						folded
					),
				collapsed
			);
		},
	};
}

/**
 * A page holding the real `FoldOrderControl` in a settings modal over a note.
 *
 * The only harness that can see a resize defect: it has a real window whose
 * `resize` fires, a real `ResizeObserver`, and a workspace whose panes really
 * do get narrower. See `foldOrderPage.ts` for what is real and what stands in.
 */
export interface FoldHarness {
	page: Page;
	close(): Promise<void>;
	probe(): Promise<FoldProbe>;
	/** How wide each reorder row is, and how much of that width is ink. */
	rowWidths(): Promise<RowWidthProbe>;
	/** The list's width at rest and with a row picked up: they must match. */
	pickUpWidth(): Promise<{ idle: number; dragging: number }>;
	/** What the chevron and the folded buttons measure, hidden and forced. */
	hidden(): Promise<HiddenBoxProbe>;
	/** Narrow (or widen) the window, then let the page finish reacting. */
	setWidth(width: number): Promise<void>;
	/**
	 * The same, WITHOUT waiting for a frame. A control that is one frame behind
	 * looks identical to one that never catches up unless the two are asked
	 * separately.
	 */
	setWidthUnsettled(width: number): Promise<void>;
	/** Start counting resize work. Call before the sweep it is counting. */
	armReflow(): Promise<void>;
	/** What the sweep since `armReflow` cost. */
	readReflow(): Promise<ReflowProbe>;
}

export async function openFoldOrder(
	browser: Browser,
	opts: FoldOrderOptions & { viewport: number; hostCss?: string | readonly string[] }
): Promise<FoldHarness> {
	const page = await browser.newPage({ viewport: { width: opts.viewport, height: 900 } });
	await injectSheets(page, "fold order", { hostCss: opts.hostCss });
	await page.addScriptTag({ content: await pageBundle("./foldOrderPage.ts") });
	const { viewport: _viewport, hostCss: _hostCss, ...build } = opts;
	// Armed BEFORE the control is built: it patches the ResizeObserver
	// constructor, and an observer already created is already native.
	await page.evaluate(() => window.__fold.armReflowCounter());
	await page.evaluate((o) => window.__fold.buildFoldOrder(o), build);
	// TWO frames, not one. A ResizeObserver's callback is delivered before
	// paint of the frame AFTER the size change, and that callback writes styles
	// of its own; a single frame can read the page half-way through its
	// reaction and report a state nothing ever paints.
	const settle = async (): Promise<void> => {
		await page.evaluate(
			() =>
				new Promise<void>((done) => {
					requestAnimationFrame(() => requestAnimationFrame(() => done()));
				})
		);
	};
	await settle();
	return {
		page,
		close: () => page.close(),
		probe: () => page.evaluate(() => window.__fold.foldProbe()),
		rowWidths: () => page.evaluate(() => window.__fold.rowWidths()),
		pickUpWidth: () => page.evaluate(() => window.__fold.pickUpWidth()),
		hidden: () => page.evaluate(() => window.__fold.hiddenBoxes()),
		armReflow: () => page.evaluate(() => window.__fold.resetReflowCounter()),
		readReflow: () => page.evaluate(() => window.__fold.readReflowCounter()),
		setWidth: async (width) => {
			await page.setViewportSize({ width, height: 900 });
			await settle();
		},
		setWidthUnsettled: async (width) => {
			await page.setViewportSize({ width, height: 900 });
		},
	};
}
