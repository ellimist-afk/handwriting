import { describe, expect, it } from "vitest";

import { codeOnly } from "./CodeOnly";

const ALL_TS = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
	string,
	string
>;

const MAIN = codeOnly(ALL_TS["./main.ts"] ?? "");

/**
 * The background-freeze drain is WIRED, not merely present.
 *
 * On iOS and Android the webview is frozen or killed on background with no
 * further JS, so anything mid-debounce - ink sidecars, settings - is lost
 * unless something dispatches the writes synchronously first. `flushOnHide`
 * does that, and `PageStore.flushDispatch` has its own tests.
 *
 * WHAT NOBODY ASSERTED, until this file: that anything CALLS it. A review
 * found the two `registerDomEvent` lines deletable with the whole suite
 * green - every surface's protection against a swipe-away losing the last
 * strokes, held in place by nothing but the fact that no one had deleted the
 * line. It came out of a negative-control pass that found nine of nineteen
 * inference-based "this is present" verdicts fully vacuous, which is the rule
 * this file is written under: an assertion that a thing EXISTS proves nothing
 * unless someone has watched its absence go red. Both assertions below were.
 *
 * A SOURCE PROBE, deliberately, and this is the one place it is the honest
 * tool rather than the lazy one: the wiring is a `registerDomEvent` on the
 * plugin against the real `document` and `window`, inside `onload`, and a
 * test that constructed a plugin to observe it would be asserting against a
 * fake `registerDomEvent` of its own making - which is exactly the shape of
 * the vacuous verdicts this file exists because of. Read as CODE, never
 * comments, so the comment block above the wiring cannot satisfy it.
 */
describe("the background-freeze flush is wired to the events that mean 'frozen'", () => {
	it("visibilitychange drains on hidden", () => {
		expect(MAIN, "main.ts no longer registers visibilitychange").toContain(
			'this.registerDomEvent(document, "visibilitychange"'
		);
		const at = MAIN.indexOf('this.registerDomEvent(document, "visibilitychange"');
		const end = MAIN.indexOf("});", at);
		expect(end, "the visibilitychange handler has no end in main.ts any more").toBeGreaterThan(at);
		const body = MAIN.slice(at, end);
		expect(body, "the handler must ask whether the page is hidden").toContain(
			'document.visibilityState === "hidden"'
		);
		expect(body, "the handler must drain on the way out").toContain("this.flushOnHide()");
	});

	// BOTH events, because iOS does not reliably fire either one alone - the
	// reason the wiring is two lines rather than one, and so the reason a test
	// that only pinned the first would let half of it be deleted.
	it("pagehide drains too", () => {
		expect(MAIN, "main.ts no longer registers pagehide").toContain(
			'this.registerDomEvent(window, "pagehide", () => this.flushOnHide());'
		);
	});

	it("and what they call still dispatches the pending writes", () => {
		const at = MAIN.indexOf("private flushOnHide(): void {");
		expect(at, "flushOnHide is gone from main.ts").toBeGreaterThan(-1);
		const end = MAIN.indexOf("\n\t}", at);
		expect(end, "flushOnHide has no end in main.ts any more").toBeGreaterThan(at);
		expect(MAIN.slice(at, end), "the drain must reach the store").toContain(
			"this.store.flushDispatch()"
		);
	});
});
