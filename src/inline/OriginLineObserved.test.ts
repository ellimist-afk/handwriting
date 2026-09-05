/**
 * The ORIGIN-LINE observer, pinned - a WIRING guard, exactly like its sibling
 * `ContentResizeObserved.test.ts`, and for the same reason: the wiring lives
 * in `mount()` and `syncCamera()`, and fixturing `mount()` would buy a rig
 * that breaks whenever mount changes and would still not be an editor.
 *
 * WHAT BROKE. 1.4.9 fixed the MEASUREMENT half of the Minimal defect:
 * `contentOriginLeft` reads the left edge of the text column rather than
 * `.cm-content`'s own edge, which is the same number under stock Obsidian and
 * a different one under Minimal. samuelbits reported the ink still wrong on
 * the real 1.4.9, and the reason is the other half. Minimal forces
 * `.cm-content` to `width: 100%` and centres the LINE divs inside it
 * (theme.css 9.0.2:1852-1867), so the two `ResizeObserver`s the overlay had -
 * on `.cm-editor` and on `.cm-content` - are pointed at precisely the two
 * elements Minimal holds still. `test/render/MinimalResync.test.ts` measures
 * it in a real browser under the real theme rules: on a note whose lines are
 * short enough not to rewrap, the readable-line-length toggle, a
 * `--line-width` change by either delivery route, and a per-note `cssclasses:
 * wide` each move the column by more than a pixel while every observer the
 * overlay installed fires zero times. The camera keeps the stale origin until
 * the user scrolls or puts the pen down; a user who changes a setting and
 * LOOKS sees ink sitting off the words in between.
 *
 * WHY A THIRD OBSERVER AND NOT A CHEAPER ONE. Measured coverage of those three
 * gaps, from the same render file: the line's own size, 3 of 3; a class
 * MutationObserver on `.markdown-source-view`, 2 of 3 (both `--line-width`
 * routes change no class anywhere); a `<style>` observer on `document.head`,
 * 1 of 3. Only the line's rendered size is downstream of every route a theme
 * or a settings plugin can use, which is the property that matters.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated as plainly as the sibling states it:
 * that the browser delivers the callback, or that the repaint lands. The
 * render suite shows the trigger fires in Chromium under the real rules; this
 * file shows the plugin is wired to it, so deleting the observer, pointing it
 * at a fixed element, or arming it once instead of re-arming fails a test
 * instead of silently restoring a shipped defect.
 *
 * COMMENTS ARE BLANKED before every assertion, for the reason `CodeOnly.ts`
 * exists: the markers below are call shapes, and the doc comments in
 * `InkOverlay.ts` quote several of them verbatim.
 */

import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";

// The behavioural half of this file drives the real `syncCamera` and the real
// `originLineResized` off the prototype. The overlay reaches window's timers
// through `winRef` and the node environment has no window, so mirror
// `PaneWidthGeometry.test.ts`'s shim before the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { Camera } from "../camera/Camera";
import { InkOverlayPlugin } from "./InkOverlay";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const OVERLAY = "/src/inline/InkOverlay.ts";
const ORIGIN = "/src/inline/ContentOrigin.ts";

/** Source with comments blanked. Throws on a rename rather than passing vacuously. */
function code(path: string): string {
	const text = ALL_TS[path];
	if (text === undefined) throw new Error(`not in the source scan: ${path}`);
	return codeOnly(text);
}

/**
 * The body of a block that starts at `start` and ends at the first `end`,
 * with line endings normalised so a CRLF checkout and a LF one probe the same
 * text. Both markers are ASSERTED rather than assumed: a slice to an
 * `indexOf` of -1 silently becomes "the rest of the file", and a probe that
 * matches the whole file passes no matter what the block actually says.
 */
function block(source: string, start: string, end: string): string {
	const text = source.replace(/\r\n/g, "\n");
	const from = text.indexOf(start);
	expect(from, `marker not found: ${start}`).toBeGreaterThanOrEqual(0);
	const rest = text.slice(from);
	const to = rest.indexOf(end);
	expect(to, `block end not found after: ${start}`).toBeGreaterThanOrEqual(0);
	return rest.slice(0, to);
}

describe("the origin-line resize observer", () => {
	it("watches the element the origin scan measured, not a fixed one", () => {
		// The whole point in two lines. `observe(this.view.contentDOM)` and
		// `observe(host)` are the two that already existed and are blind to
		// Minimal; this one takes its target from the scan's own answer, so
		// it follows the column wherever the theme decides the column is.
		const body = block(code(OVERLAY), "private watchOriginLine(", "\n\t}");
		expect(body).toContain("observer.observe(line)");
		expect(body).toContain("this.originLine = line");
	});

	it("takes that element from the same scan syncCamera already ran", () => {
		// Not a second `getBoundingClientRect` sweep. `contentOrigin` returns
		// the left edge and the element together precisely so the re-arm
		// costs no layout: syncCamera runs on resize and scroll ticks and at
		// pen-down, and a second scan there would double its forced reads.
		const body = block(code(OVERLAY), "private syncCamera(): void {", "\n\t}");
		expect(body).toContain("const origin = contentOrigin(this.view.contentDOM)");
		// The left edge travels with the element, so the re-arm can decide
		// whether the column MOVED without a rect read of its own.
		expect(body).toContain("this.watchOriginLine(origin.line, contentLeft)");
		expect(body).not.toContain("contentOriginLeft(");
		// And there is ONE scan rule, not two that can drift: the left-only
		// entry point is a wrapper over the same function.
		expect(code(ORIGIN)).toContain("return contentOrigin(contentDOM).left");
	});

	it("re-arms on a reference compare, so a recycled line costs nothing", () => {
		// CodeMirror recycles `.cm-line` divs, so the watch cannot be
		// installed once at mount. It is re-pointed from `syncCamera`, and on
		// the frames where the line did not change the entire cost is this
		// early return - no layout read, nothing that scales with the note.
		const body = block(code(OVERLAY), "private watchOriginLine(", "\n\t}");
		expect(body).toContain("if (line === this.originLine) return");
		// The old target is released rather than left observed: a stale
		// observation on a recycled div is a callback for a line that is no
		// longer the column.
		expect(body).toContain("observer.unobserve(this.originLine)");
	});

	it("re-syncs the camera rather than routing through handleResize", () => {
		// Same reasoning as the `.cm-content` observer beside it: routing
		// through `handleResize` would hit its `unchanged` early-return on
		// exactly the case this exists for, and land a no-op that reads like
		// a fix.
		const body = block(code(OVERLAY), "private originLineResized(): void {", "\n\t}");
		expect(body).toContain("this.syncCamera()");
		expect(body).toContain("this.scheduleRepaint(");
		expect(body).not.toContain("this.handleResize()");
	});

	it("holds its own frame guard, so a stroke in flight keeps its coordinates", () => {
		// A mid-stroke line resize must not move the camera under the pen.
		const body = block(code(OVERLAY), "private originLineResized(): void {", "\n\t}");
		expect(body).toContain("frame.locked");
	});

	it("routes the observer at that method, so the two cannot drift apart", () => {
		// The callback body was a closure until 1.4.10. It is a named method
		// now so the repaint decision below can be CALLED rather than
		// grepped; this is the seam that keeps the two guards above pointed
		// at the code the browser actually runs.
		expect(code(OVERLAY)).toContain(
			"new ResizeObserver(() => this.originLineResized())"
		);
	});

	it("is disconnected on unmount, like the two observers beside it", () => {
		// A leaked observer on a detached `.cm-line` keeps the overlay
		// reachable, and this one is the easiest of the three to forget
		// because it is the only one never armed inside `mount()` itself.
		const overlay = code(OVERLAY);
		expect(overlay).toContain("this.originLineObserver?.disconnect()");
		expect(overlay).toContain("this.originLine = null");
	});

	it("leaves the metadata observer's attributeFilter alone", () => {
		// The cheaper fix that was rejected on cost, pinned so it cannot be
		// reintroduced by someone reaching for the observer that is already
		// there. `metadataObserver` is registered with `subtree: true`, so
		// adding "class" to its filter would deliver a callback on every
		// `cm-activeLine` toggle - once per cursor move, with a records array
		// that grows with the edit batch. That is the per-keystroke cost the
		// hot-path rule forbids, and its callback only calls
		// `updateMetadataVisibility`, so it would not have re-synced anything
		// even then.
		const options = block(code(OVERLAY), "this.metadataObserver.observe(", "});");
		expect(options).toContain('attributeFilter: ["data-property-key"]');
		expect(options).not.toContain("class");
	});

	it("blanks comments before asserting, so a doc comment cannot satisfy it", () => {
		// InkOverlay's own doc comment for this observer quotes
		// `attributeFilter` and names `syncCamera`; without the blanking pass
		// the guards above could be satisfied by prose alone.
		const withComment = `
			// observer.observe(line)
			/* this.originLineObserver?.disconnect() */
			const unrelated = 1;
		`;
		const stripped = codeOnly(withComment);
		expect(stripped).not.toContain("observer.observe(line)");
		expect(stripped).not.toContain("this.originLineObserver?.disconnect()");
		expect(stripped).toContain("const unrelated = 1;");
	});
});

/**
 * WHAT THE OBSERVER COSTS, driven rather than grepped.
 *
 * The wiring guards above prove the third observer exists and is pointed at
 * the scan's own answer. They say nothing about what it does when it fires,
 * and what it did was the expensive half.
 *
 * `ResizeObserver.observe()` delivers one callback for a newly observed
 * element on the next frame regardless of its size - the spec starts
 * `lastReportedSize` at 0x0, so the first delivery is unconditional and is
 * not evidence of a resize. The watch is re-pointed from `syncCamera`, which
 * runs on every scroll tick, so a scroll that replaces the leading `.cm-line`
 * div (CodeMirror re-renders the viewport) armed a fresh delivery per tick.
 * Each delivery called `scheduleRepaint("content-resize")`, and anything but
 * "scroll"/"partial" means `damage.addAll()` plus `indexDirty = true`: every
 * visible stroke re-rasterized and the index rebuilt. At 83b9a27 a scroll
 * cost one partial repaint.
 *
 * The rig below is the smallest DOM the real `syncCamera` will run against:
 * `.cm-line` children whose left edge the test moves, a counting stand-in for
 * `ResizeObserver`, and a `scheduleRepaint` that records its `via`. Nothing
 * here models the browser DELIVERING a callback - that is the render suite's
 * job (`MinimalResync.test.ts`); this models what happens once it does.
 */

type Fields = Record<string, unknown>;

interface Line {
	el: Fields;
	setLeft(left: number): void;
	detach(): void;
}

/** A `.cm-line` the scan will accept, at a left edge the test controls. */
function fakeLine(left: number): Line {
	let x = left;
	let connected = true;
	const el: Fields = {
		classList: { contains: (c: string) => c === "cm-line" },
		children: [] as unknown[],
		// The block-widget probe, in both the shape it had (a subtree
		// `querySelector`) and the one it has (immediate children only), so
		// this rig does not have to change when the scan's cost does.
		querySelector: () => null,
		matches: () => false,
		getBoundingClientRect: () => ({ left: x, width: 400, height: 20 }),
	};
	Object.defineProperty(el, "isConnected", { get: () => connected });
	return {
		el,
		setLeft(next: number) {
			x = next;
		},
		detach() {
			connected = false;
		},
	};
}

interface ObserverRig {
	/** The `.cm-content` children the scan walks. Replaceable, as CM's are. */
	setLines(lines: Line[]): void;
	/** The real `syncCamera`, which is what re-arms the watch. */
	sync(): void;
	/** The real observer callback. */
	fire(): void;
	lock(locked: boolean): void;
	/** Every `scheduleRepaint` reason since the last `reset`. */
	repaints(): string[];
	observed(): unknown[];
	unobserved(): unknown[];
	reset(): void;
}

function observerRig(lines: Line[]): ObserverRig {
	let children: Fields[] = lines.map((l) => l.el);
	const repaints: string[] = [];
	const observed: unknown[] = [];
	const unobserved: unknown[] = [];

	const container: Fields = {
		getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 600 }),
		offsetWidth: 800,
		offsetHeight: 600,
	};

	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.container = container;
	o.view = {
		contentDOM: {
			get children() {
				return children;
			},
			getBoundingClientRect: () => ({ left: 0, width: 800, height: 3000 }),
		},
		scrollDOM: { scrollLeft: 0, scrollTop: 0 },
		scaleX: 1,
		scaleY: 1,
		documentTop: 50,
	};
	o.camera = new Camera();
	o.frame = { locked: false };
	o.originLine = null;
	o.originLineObserver = {
		observe: (el: unknown) => observed.push(el),
		unobserve: (el: unknown) => unobserved.push(el),
		disconnect: () => undefined,
	};
	// Null, so `syncCamera`'s font branch is skipped: this file is about the
	// repaint decision, and the font path is pinned in PaneWidthGeometry.
	o.contentStyle = null;
	o.refFontPx = 16;
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.lastSyncRectLeft = 0;
	o.lastSyncRectTop = 0;
	o.lastSyncContentLeft = 0;
	o.lastSyncDocumentTop = 0;
	o.lastSyncScrollLeft = 0;
	o.lastSyncScrollTop = 0;
	o.lastGoodColumnLeft = null;
	o.scheduleRepaint = (via = "other") => {
		repaints.push(via);
	};

	const proto = InkOverlayPlugin.prototype as unknown as {
		syncCamera: () => void;
		originLineResized: () => void;
	};

	return {
		setLines(next: Line[]) {
			children = next.map((l) => l.el);
		},
		sync: () => proto.syncCamera.call(o),
		fire: () => proto.originLineResized.call(o),
		lock(locked: boolean) {
			(o.frame as { locked: boolean }).locked = locked;
		},
		repaints: () => [...repaints],
		observed: () => [...observed],
		unobserved: () => [...unobserved],
		reset() {
			repaints.length = 0;
			observed.length = 0;
			unobserved.length = 0;
		},
	};
}

describe("the origin-line observer's repaint decision", () => {
	it("schedules NO repaint when the column did not move", () => {
		// The scroll path, in one call. `observe()`'s unconditional first
		// delivery lands here on a frame where nothing about the column
		// changed; repainting would mark the whole surface damaged and the
		// index dirty for a scroll tick.
		const rig = observerRig([fakeLine(380)]);
		rig.sync();
		rig.reset();
		rig.fire();
		expect(rig.repaints()).not.toContain("content-resize");
		expect(rig.repaints()).toEqual([]);
	});

	it("schedules exactly one repaint when the column DID move", () => {
		// And the reason the observer exists is intact: Minimal moves the
		// column by three routes that fire no other observer
		// (`MinimalResync.test.ts`), and each of them lands here.
		const line = fakeLine(380);
		const rig = observerRig([line]);
		rig.sync();
		rig.reset();
		line.setLeft(451.5);
		rig.fire();
		expect(rig.repaints()).toEqual(["content-resize"]);
	});

	it("ignores sub-pixel rect wobble, the way handleResize's guard does", () => {
		// `getBoundingClientRect().left` is fractional and its last decimals
		// move every frame. An exact compare would defeat the guard as
		// completely as not having one.
		const line = fakeLine(380);
		const rig = observerRig([line]);
		rig.sync();
		rig.reset();
		line.setLeft(380.4);
		rig.fire();
		expect(rig.repaints()).toEqual([]);
	});

	it("moves no camera while a stroke owns the frame", () => {
		const rig = observerRig([fakeLine(380)]);
		rig.sync();
		rig.reset();
		rig.lock(true);
		rig.fire();
		expect(rig.repaints()).toEqual([]);
	});
});

describe("re-arming the origin-line watch", () => {
	it("keeps the observation when CM swaps the line for one at the same left", () => {
		// THE CHURN. CodeMirror replaces the leading `.cm-line` div on every
		// viewport re-render, and where the sampled lines share a left edge
		// the tie rule keeps the first one scanned - so a scroll offers the
		// scan a fresh element at the identical position, tick after tick.
		// Re-pointing there arms a delivery per tick, because `observe()`
		// always reports a newly observed element once.
		const first = fakeLine(380);
		const rig = observerRig([first]);
		rig.sync();
		expect(rig.observed()).toEqual([first.el]);
		rig.reset();
		rig.setLines([fakeLine(380)]);
		rig.sync();
		expect(rig.observed()).toEqual([]);
		expect(rig.unobserved()).toEqual([]);
	});

	it("re-points when the swapped-in line is at a DIFFERENT left", () => {
		// The column really moved, so the watch has to follow it - the old
		// div's size no longer says anything about where the text is.
		const first = fakeLine(380);
		const rig = observerRig([first]);
		rig.sync();
		rig.reset();
		const moved = fakeLine(451.5);
		rig.setLines([moved]);
		rig.sync();
		expect(rig.unobserved()).toEqual([first.el]);
		expect(rig.observed()).toEqual([moved.el]);
	});

	it("re-points when the watched line has left the document", () => {
		// A detached div is a watch on nothing: the browser will never report
		// it again, so keeping it would disarm the only trigger that notices
		// Minimal moving the column.
		const first = fakeLine(380);
		const rig = observerRig([first]);
		rig.sync();
		rig.reset();
		first.detach();
		const fresh = fakeLine(380);
		rig.setLines([fresh]);
		rig.sync();
		expect(rig.observed()).toEqual([fresh.el]);
	});
});
