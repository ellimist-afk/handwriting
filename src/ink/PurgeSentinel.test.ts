/**
 * The purged-canvas sentinel: the decision, and where the readback is
 * allowed to happen.
 *
 * The condition it heals cannot be induced here - it needs WebKit under
 * memory pressure on an iPad - so what is testable is the decision table
 * around it and the guards it sits behind. Both matter more than usual,
 * because the readback is a synchronous `getImageData` and the whole reason
 * it ships switched off is that nobody could establish what it costs on the
 * device (PurgeSentinel.ts, and 1.4.12-design.md §14).
 *
 * The guards at the bottom run: a real `InkOverlay.repaint`, driven by the
 * repaint rig (overlayRig.testutil.ts), with the PurgeSentinel exports
 * watched. Two checks still read source, both on `codeOnly` output so prose
 * cannot stand in for code (the lesson DeferredUnloadGuard.test.ts wrote
 * down): StrokeRenderer's own sentinel switch, and the repo-wide rule that
 * there is one `getImageData` in production code, read across every file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

// Every PurgeSentinel export is the real one; the four the overlay calls are
// wrapped so a cell can watch them and, for the two gates, answer for them.
vi.mock("./PurgeSentinel", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const wrapped: Record<string, unknown> = { ...actual };
	for (const name of ["paintPurgeSentinel", "readPurgeSentinel", "purgeProbeArmed", "purgeProbeDue"]) {
		wrapped[name] = vi.fn(actual[name] as (...a: unknown[]) => unknown);
	}
	return wrapped;
});

import { Platform } from "obsidian";
import rendererSrc from "./StrokeRenderer.ts?raw";
import { codeOnly } from "../CodeOnly";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { openRepaintRig } from "../inline/overlayRig.testutil";
import {
	PURGE_PROBE_INTERVAL_MS,
	PURGE_SENTINEL_ALPHA,
	PURGE_SENTINEL_CSS,
	PurgeProbeGate,
	paintPurgeSentinel,
	purgeDetected,
	purgeProbeArmed,
	purgeProbeDue,
	readPurgeSentinel,
} from "./PurgeSentinel";

/** Every production source file, as text: tests and test utilities left out. */
const PRODUCTION_SOURCES = Object.fromEntries(
	Object.entries(
		import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true, import: "default" }) as Record<string, string>
	).filter(([file]) => !/\.test\.ts$|\.testutil\.ts$|\.test\.util\.ts$|^\/src\/testUtils\//.test(file))
);

/** The one shape where a probe is due; each test breaks exactly one term. */
const DUE: PurgeProbeGate = {
	armed: true,
	scrollRepaint: true,
	foundWork: false,
	strokeOwnsFrame: false,
	noteHasInk: true,
	now: 10_000,
	lastProbe: 9_000,
};

describe("purgeProbeArmed", () => {
	it("needs mobile AND a recording session", () => {
		expect(purgeProbeArmed(true, true)).toBe(true);
		expect(purgeProbeArmed(true, false)).toBe(false);
		expect(purgeProbeArmed(false, true)).toBe(false);
		expect(purgeProbeArmed(false, false)).toBe(false);
	});
});

describe("purgeProbeDue", () => {
	it("is due on a scroll repaint that drew nothing", () => {
		expect(purgeProbeDue(DUE)).toBe(true);
	});

	it("is refused by every guard on its own", () => {
		// Each row is DUE with one term spoiled, so a guard that stopped
		// being read shows up as exactly one failure and names itself.
		const spoilt: [string, Partial<PurgeProbeGate>][] = [
			["not armed (desktop, or not recording)", { armed: false }],
			["something other than scrolling asked", { scrollRepaint: false }],
			["the frame actually drew", { foundWork: true }],
			["a stroke owns the frame", { strokeOwnsFrame: true }],
			["the note has no ink", { noteHasInk: false }],
		];
		for (const [why, patch] of spoilt) {
			expect(purgeProbeDue({ ...DUE, ...patch }), why).toBe(false);
		}
	});

	it("throttles to one readback per interval, and no faster", () => {
		const last = 1_000;
		expect(purgeProbeDue({ ...DUE, lastProbe: last, now: last })).toBe(false);
		expect(
			purgeProbeDue({ ...DUE, lastProbe: last, now: last + PURGE_PROBE_INTERVAL_MS - 1 })
		).toBe(false);
		expect(
			purgeProbeDue({ ...DUE, lastProbe: last, now: last + PURGE_PROBE_INTERVAL_MS })
		).toBe(true);
	});

	it("is due at once on the first frame of a session", () => {
		// The field starts at -Infinity precisely so a clock that has barely
		// started does not hold the first probe back by 300ms.
		expect(purgeProbeDue({ ...DUE, lastProbe: -Infinity, now: 0 })).toBe(true);
	});
});

describe("purgeDetected", () => {
	it("treats only a zero read as a purge", () => {
		expect(purgeDetected(0)).toBe(true);
		expect(purgeDetected(1)).toBe(false);
		// countPaintedPixels reports a refused readback as -1. A canvas that
		// would not be read is not a canvas that was reclaimed, and healing
		// on it would repaint the world on every probe forever.
		expect(purgeDetected(-1)).toBe(false);
	});
});

describe("paintPurgeSentinel", () => {
	const fakeCtx = () => {
		const calls: string[] = [];
		const ctx = {
			globalAlpha: 1,
			globalCompositeOperation: "xor",
			fillStyle: "#ff0000",
			save: () => void calls.push("save"),
			restore: () => void calls.push("restore"),
			clearRect: vi.fn(() => void calls.push("clear")),
			fillRect: vi.fn(() => void calls.push("fill")),
		};
		return { ctx, calls };
	};

	it("clears before it fills, so painting twice is painting once", () => {
		const { ctx, calls } = fakeCtx();
		paintPurgeSentinel(ctx as unknown as CanvasRenderingContext2D);
		expect(calls).toEqual(["save", "clear", "fill", "restore"]);
		expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, PURGE_SENTINEL_CSS, PURGE_SENTINEL_CSS);
		expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, PURGE_SENTINEL_CSS, PURGE_SENTINEL_CSS);
	});

	it("paints at the band's top-left corner, never anywhere on screen", () => {
		const { ctx } = fakeCtx();
		paintPurgeSentinel(ctx as unknown as CanvasRenderingContext2D);
		const [x, y] = ctx.fillRect.mock.calls[0] as number[];
		expect(x).toBe(0);
		expect(y).toBe(0);
	});

	it("sets its own alpha and compositing rather than inheriting them", () => {
		const { ctx } = fakeCtx();
		paintPurgeSentinel(ctx as unknown as CanvasRenderingContext2D);
		expect(ctx.globalAlpha).toBe(PURGE_SENTINEL_ALPHA);
		expect(ctx.globalCompositeOperation).toBe("source-over");
		expect(ctx.fillStyle).toBe("#000000");
	});

	it("is exactly one 8-bit alpha step: invisible, and it survives the byte", () => {
		expect(PURGE_SENTINEL_ALPHA * 255).toBeCloseTo(1, 12);
		expect(Math.round(PURGE_SENTINEL_ALPHA * 255)).toBe(1);
	});

	it("covers a whole device pixel even where the area budget trimmed below 1", () => {
		// ZoomScale's budget can now hand back a backing scale under 1, so a
		// 1 CSS px marker could cover less than one device pixel.
		expect(PURGE_SENTINEL_CSS).toBeGreaterThanOrEqual(2);
	});
});

describe("the readback is behind the guards", () => {
	// Run, not read. A real InkOverlay is driven through real repaints by the
	// repaint rig (overlayRig.testutil.ts), with every PurgeSentinel export
	// wrapped (see the mock at the top) so a cell can watch the calls the
	// overlay makes and, for the two gates, answer for them.
	const noHooks = { onCommittedDraw: () => undefined, onPostDraw: () => undefined };
	const armedGate = vi.mocked(purgeProbeArmed);
	const dueGate = vi.mocked(purgeProbeDue);
	const read = vi.mocked(readPurgeSentinel);
	const paint = vi.mocked(paintPurgeSentinel);

	afterEach(() => {
		Platform.isMobileApp = false;
		setDiagnosticsEnabled(false);
		// Back to the real implementation, any unspent one-off answer dropped.
		for (const fn of [armedGate, dueGate, read, paint]) fn.mockReset();
	});

	it("the overlay reads the sentinel exactly once, and only under purgeProbeDue", async () => {
		const rig = await openRepaintRig(3, noHooks);
		const ctx = rig.overlay.committedCtx as CanvasRenderingContext2D;
		// Every readback on the committed context, and whether it happened
		// inside the sentinel read.
		let inRead = false;
		const readbacks: boolean[] = [];
		const realGetImageData = ctx.getImageData.bind(ctx);
		ctx.getImageData = ((...a: Parameters<CanvasRenderingContext2D["getImageData"]>) => {
			readbacks.push(inRead);
			return realGetImageData(...a);
		}) as CanvasRenderingContext2D["getImageData"];
		const actual = await vi.importActual<typeof import("./PurgeSentinel")>("./PurgeSentinel");
		read.mockImplementation((c) => {
			inRead = true;
			try {
				return actual.readPurgeSentinel(c);
			} finally {
				inRead = false;
			}
		});
		read.mockClear();
		dueGate.mockClear();
		dueGate.mockReturnValueOnce(false);
		rig.damageAll();
		rig.repaintNow();
		expect(dueGate, "the repaint never asked purgeProbeDue").toHaveBeenCalledTimes(1);
		expect(read, "the sentinel was read without purgeProbeDue's yes").not.toHaveBeenCalled();
		expect(readbacks, "a readback ran on a repaint whose probe was not due").toEqual([]);

		dueGate.mockReturnValueOnce(true);
		rig.damageAll();
		rig.repaintNow();
		expect(read, "a due probe did not read the sentinel exactly once").toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith(ctx);
		expect(readbacks.length, "precondition: the sentinel read reads the canvas back").toBeGreaterThan(0);
		expect(readbacks.every(Boolean), "a readback ran outside the sentinel read").toBe(true);
	});

	it("the armed flag is the mobile AND recording pair, read at the paint", async () => {
		const rig = await openRepaintRig(3, noHooks);
		for (const [mobile, recording] of [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		] as const) {
			Platform.isMobileApp = mobile;
			setDiagnosticsEnabled(recording);
			armedGate.mockClear();
			dueGate.mockReturnValueOnce(false);
			rig.damageAll();
			rig.repaintNow();
			// One call, feeding both the marker and the gate, so the paint and
			// the read can never disagree.
			expect(armedGate, `mobile=${mobile} recording=${recording}: not asked exactly once per paint`).toHaveBeenCalledTimes(1);
			expect(armedGate, `mobile=${mobile} recording=${recording}: armed from something else`).toHaveBeenCalledWith(mobile, recording);
		}
	});

	it("the marker is painted only when armed, on both the full and partial paths", async () => {
		const rig = await openRepaintRig(3, noHooks);
		const ctx = rig.overlay.committedCtx;
		for (const path of ["full", "partial"] as const) {
			for (const armed of [true, false]) {
				armedGate.mockReturnValueOnce(armed);
				dueGate.mockReturnValueOnce(false);
				paint.mockClear();
				// The full path records how many strokes it painted; the partial
				// path never touches that count, so it tells the two apart.
				rig.overlay.paintedStrokeCount = -1;
				if (path === "full") rig.damageAll();
				else rig.damageRect({ x: 100, y: 50, width: 80, height: 10 });
				rig.repaintNow();
				expect(rig.overlay.paintedStrokeCount === -1, `precondition: the ${path} path ran`).toBe(path === "partial");
				const marks = paint.mock.calls.filter(([c]) => c === ctx).length;
				if (armed) expect(marks, `the ${path} path did not paint the marker while armed`).toBeGreaterThan(0);
				else expect(marks, `the ${path} path painted the marker while disarmed`).toBe(0);
			}
		}
	});

	it("drawCommitted paints it only when its caller asks", () => {
		const renderer = codeOnly(rendererSrc);
		expect(renderer).toMatch(/sentinel = false/);
		expect(renderer).toMatch(/if \(sentinel\) paintPurgeSentinel\(ctx\);/);
	});

	it("stays the only getImageData in production source, through countPaintedPixels", () => {
		// This repo has exactly one readback call site and a comment on the
		// wet renderer saying "never on the hot path". The heal must not
		// become the second one. Read across every production file, so code
		// moving between files cannot carry a second site past this check.
		const sites = Object.entries(PRODUCTION_SOURCES).flatMap(([file, text]) =>
			(codeOnly(text).match(/getImageData\(/g) ?? []).map(() => file)
		);
		expect(Object.keys(PRODUCTION_SOURCES).length, "precondition: the glob found the source tree").toBeGreaterThan(50);
		expect(sites).toEqual(["/src/diag/Raster.ts"]);
	});
});
