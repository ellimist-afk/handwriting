/**
 * The canvas surface must ink on WebKit too (audit, 2026-09-01).
 *
 * `pointerrawupdate` is Chromium-only. The canvas page view inks ONLY from
 * onPenRaw, which that event feeds, so on every iPad and iPhone a stroke was
 * pointerdown, nothing, pointerup - one point, drawn as a dot. The fallback
 * is the coalesced pointermove samples, and the decision is a capability
 * test on the engine.
 *
 * Why not a per-stroke "have we seen a raw update yet" latch: raw updates are
 * dispatched AHEAD of the pointermove they belong to, so on Chromium the
 * first move of every stroke would still slip through the latch and feed the
 * same samples down the pipe twice.
 */

import { describe, expect, it } from "vitest";

import { PointerRouter } from "./PointerRouter";

describe("PointerRouter.rawUpdatesSupported", () => {
	it("is true on an engine that exposes the handler (Chromium)", () => {
		const chromium = { onpointerrawupdate: null } as unknown as Window;
		expect(PointerRouter.rawUpdatesSupported(chromium)).toBe(true);
	});

	it("is false on one that does not (WebKit: every iPad and iPhone)", () => {
		const webkit = {} as unknown as Window;
		expect(PointerRouter.rawUpdatesSupported(webkit)).toBe(false);
	});

	it("tests presence, not truthiness - the handler is null until one is set", () => {
		// `"onpointerrawupdate" in win`, not `win.onpointerrawupdate`. The
		// property exists and is null on a supporting engine, so a truthiness
		// check would call Chromium unsupported and put every desktop on the
		// move-event fallback.
		const chromium = { onpointerrawupdate: null } as unknown as Window;
		expect((chromium as unknown as Record<string, unknown>).onpointerrawupdate).toBeNull();
		expect(PointerRouter.rawUpdatesSupported(chromium)).toBe(true);
	});
});
