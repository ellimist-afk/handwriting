/**
 * Ink is refused at contact, not discarded after the fact (audit, 2026-09-01).
 *
 * saveSpatial() has always refused to write in three states: the sidecar has
 * not loaded, a newer Handwriting wrote the file, or the file could not be
 * read. The pen paths never asked. A stroke was accepted, drawn, committed to
 * the in-memory page and then never persisted - it looked like it worked and
 * was gone on reload, with nothing said.
 *
 * The rule is pure and lives beside spatialWritable so it can be pinned here;
 * the view that calls it is DOM-bound and cannot be built in a test.
 */

import { describe, expect, it } from "vitest";

import { inkRefusal } from "./PageDocument";

const ready = { loaded: true, spatialFutureVersion: undefined, spatialDamaged: false };

describe("inkRefusal", () => {
	it("allows ink on a loaded, readable, current page", () => {
		expect(inkRefusal(ready)).toBeNull();
	});

	it("refuses while the sidecar is still loading", () => {
		// Drawing here would be composed against an empty page and then
		// overwritten by the load that is still in flight.
		expect(inkRefusal({ ...ready, loaded: false })).toMatch(/still loading/);
	});

	it("refuses on a page a newer Handwriting wrote", () => {
		expect(inkRefusal({ ...ready, spatialFutureVersion: 3 })).toMatch(/newer version/);
	});

	it("refuses on a page whose sidecar could not be read", () => {
		expect(inkRefusal({ ...ready, spatialDamaged: true })).toMatch(/cannot be read/);
	});

	it("names the newer version first when a page is both", () => {
		// Both are true often enough - a file from the future that also fails
		// to parse - and "a newer version wrote this" is the one that names
		// something the user can act on.
		const both = { loaded: true, spatialFutureVersion: 3, spatialDamaged: true };
		expect(inkRefusal(both)).toMatch(/newer version/);
	});

	it("says loading before anything else, because the verdict is not in yet", () => {
		// Not loaded means spatialDamaged is still its default false, so a
		// damaged file would otherwise read as writable for the whole load.
		const loading = { loaded: false, spatialFutureVersion: 3, spatialDamaged: true };
		expect(inkRefusal(loading)).toMatch(/still loading/);
	});

	it("gives every state a distinct message, so one cause cannot silence another", () => {
		// The view announces at most one refusal per distinct message. Two
		// states sharing wording would make the second one silent.
		const messages = [
			inkRefusal({ ...ready, loaded: false }),
			inkRefusal({ ...ready, spatialFutureVersion: 3 }),
			inkRefusal({ ...ready, spatialDamaged: true }),
		];
		expect(new Set(messages).size).toBe(3);
	});
});
