/**
 * The move-rate instrument, actually wired - not just spelled.
 *
 * `beb6fbb` fixed the pdf surface so a stroke counts its own move events:
 *
 *     - onPenMove: () => {},
 *     + onPenMove: (_ev, count) => this.metrics.recordEvent("move", count, 0, false),
 *
 * `InkSurfaceRules.test.ts` now carries a registry row for the marker
 * (`recordEvent("move"`), which proves the string is present once per
 * surface. It does NOT prove the string is reached: a marker row is a text
 * scan, and reverting either surface's `onPenMove` back to `() => {}` leaves
 * `recordEvent("move"` sitting dead in a comment three lines above the real
 * call (InkOverlay.ts and PdfInkController.ts both narrate the fix at length
 * right above the call site) - a marker keyed on that same substring would
 * still find it. `StrokeMetrics.test.ts` is no help either: it drives the
 * `StrokeMetrics` class directly and never touches the closure a surface
 * registers as `onPenMove`. Nothing before this file drove the wiring.
 *
 * WHAT THIS DRIVES, AND WHY BOTH SURFACES ARE MOCKED THE SAME WAY.
 * Both note and pdf build the real `InlinePenRouter` inside a mount/bind
 * method that is too heavy to fixture whole - the note's `mount()` builds
 * five canvases and their 2d contexts against a CodeMirror `EditorView`,
 * and this project's vitest config sets no `test.environment`, so these
 * suites run in plain Node with no `document`, no `HTMLCanvasElement`, and
 * no `CanvasRenderingContext2D` to fake convincingly. So `InlinePenRouter`
 * itself is replaced with a capturing stub - its own event-dispatch
 * correctness is TraceReplay.test.ts's job, not this file's - and each
 * surface's real `bindTo`/`mount` method is run far enough to construct it.
 * The THIRD constructor argument is the callbacks object each surface
 * builds by hand at its own call site; capturing it and calling
 * `.onPenMove(...)` directly invokes the exact closure that ships, with no
 * synthetic DOM dispatch standing in for it. What is proven is the wiring
 * from that closure to `StrokeMetrics`, not whether `InlinePenRouter` would
 * ever actually call it on a real pointermove.
 *
 * Mutation-verified (see the design report, not restated here): reverting
 * either surface's `onPenMove` to `() => {}` fails the matching "records a
 * move event" test below and leaves every other suite, including the
 * registry row, green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { StrokeMetrics } from "../ink/StrokeMetrics";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

/** Captured third argument of `new InlinePenRouter(scrollEl, rectEl, cb, ...)`. */
const captured = vi.hoisted(() => ({ cb: null as unknown }));

/**
 * `InlinePenRouter` replaced with a stub that only records what it was
 * handed. Everything else the module exports (`bandEraserIntent`,
 * `contextMenuSuppressed`, ...) stays real via `importOriginal`, so the
 * pdf and note callback objects - which reference those functions in
 * their OTHER callbacks - still build without throwing.
 */
vi.mock("./InlinePenRouter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./InlinePenRouter")>();
	class CapturingRouter {
		isStroking = false;
		constructor(_scrollEl: unknown, _rectEl: unknown, cb: unknown) {
			captured.cb = cb;
		}
		dispose(): void {}
		refreshRect(): void {}
	}
	return { ...actual, InlinePenRouter: CapturingRouter };
});

/** Same seam PdfInkController.test.ts uses to avoid a real PDF.js viewer. */
const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { InkOverlayPlugin } from "./InkOverlay";
import { PdfInkController } from "../pdf/PdfInkController";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A DOM-free stand-in good enough for `createDiv`/`createEl`/`setCssStyles`. */
function fakeEl(): Record<string, unknown> {
	const el: Record<string, unknown> = {
		setCssStyles: () => {},
		setAttribute: () => {},
		createDiv: () => fakeEl(),
		createEl: () => fakeEl(),
		// Truthy and otherwise inert: WetInkRenderer/TailRenderer only check
		// that a context came back, never call anything on it during mount.
		getContext: () => ({}),
	};
	return el;
}

describe("note: onPenMove really calls StrokeMetrics.recordEvent", () => {
	beforeEach(() => {
		captured.cb = null;
		resetPenToolsForTest();
	});

	/**
	 * `mount()` is public but far too heavy to run to completion in this
	 * Node-only suite - past the router construction it wires a scroll
	 * listener, a resize handler and a hit-probe context, none of which
	 * this harness fakes. That is fine: `InlinePenRouter` is captured
	 * BEFORE any of that runs, so a throw afterward (there usually is one)
	 * is swallowed here rather than pretending the rest of mount succeeded.
	 */
	function mountFake(): void {
		const win = { getComputedStyle: () => ({ position: "relative" }) };
		const dom = { ...fakeEl(), ownerDocument: { defaultView: win } };
		const view = {
			state: { field: () => ({}) }, // truthy, no `.app` - ensurePenTools bails itself
			dom,
			scrollDOM: fakeEl(),
		};
		const plugin = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
		plugin.view = view;
		try {
			(plugin as unknown as { mount(): void }).mount();
		} catch {
			// Expected past the router line - see the comment above.
		}
	}

	it("wires a real onPenMove callback, not a no-op", () => {
		mountFake();
		const cb = captured.cb as { onPenMove?: unknown } | null;
		expect(cb?.onPenMove).toBeTypeOf("function");
	});

	it("records a move event through the module's shared StrokeMetrics", () => {
		const recordEvent = vi.spyOn(StrokeMetrics.prototype, "recordEvent");
		mountFake();
		const cb = captured.cb as { onPenMove: (ev: unknown, count: number) => void };
		cb.onPenMove(undefined, 7);
		// `metrics` (InkOverlay.ts) is a module-private singleton, not
		// exported, and its own `recordEvent` no-ops unless a stroke is
		// `active` (StrokeMetrics.ts: "if (!this.active) return;") - a gate
		// this file has no seam to arm from outside. Spying on the shared
		// prototype method sidesteps both: it proves the WIRING calls
		// `recordEvent("move", 7, 0, false)` regardless of whether a stroke
		// happens to be live, which is exactly the fact `() => {}` would
		// falsify. `StrokeMetrics.test.ts` already covers what `recordEvent`
		// does once `active`; this is only about whether it is called.
		expect(recordEvent).toHaveBeenCalledWith("move", 7, 0, false);
		recordEvent.mockRestore();
	});
});

describe("pdf: onPenMove really calls StrokeMetrics.recordEvent", () => {
	let controller: PdfInkController;

	beforeEach(() => {
		captured.cb = null;
		resetPenToolsForTest();
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		probe.current = {
			scroller,
			scaleFactor: 2,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			// `bindTo` reads `this.win.navigator` unconditionally
			// (`palmRadiusTrustworthy`/`isAppleTouchPlatform`) before it ever
			// reaches the router construction; an absent `navigator` throws
			// there instead, before `InlinePenRouter` is ever built.
			navigator: {},
			clearTimeout: () => {},
			setTimeout: () => 0,
			requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		// `bindTo` is where the pdf's `onPenMove` closure is written, and it
		// is private - reached the same way PdfInkController.test.ts reaches
		// `penDown`/`penRaw`/`penUp`: a cast, not a parallel public API.
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(scroller);
	});

	it("wires a real onPenMove callback, not a no-op", () => {
		const cb = captured.cb as { onPenMove?: unknown } | null;
		expect(cb?.onPenMove).toBeTypeOf("function");
	});

	it("recordEvent runs and the stroke's own move count advances", () => {
		const cb = captured.cb as { onPenMove: (ev: unknown, count: number) => void };
		const pen = controller as unknown as { penDown(s: PenSample): void };
		// Arms `this.metrics` for real via the controller's own `penDown`
		// (`this.metrics.begin("pdf-ink", ...)`), rather than reaching past
		// StrokeMetrics' privacy to force `active` - the same real path a
		// stroke takes in the app.
		pen.penDown(sample(200, 200));
		cb.onPenMove(undefined, 4);
		cb.onPenMove(undefined, 3);
		const metrics = (controller as unknown as { metrics: StrokeMetrics }).metrics;
		const summary = metrics.end(performance.now());
		// The number that used to be an unconditional, silent 0: this is the
		// counter `moveHz` in a pdf's diagnostics report is computed from.
		expect(summary.moveEvents).toBe(2);
	});
});
