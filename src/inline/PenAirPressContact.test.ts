/**
 * A pen with the side button held, against the same button pressed while the
 * pen hovers. A contact has pressure above zero, whatever its buttons; a press
 * in the air has pressure zero. The router claims the contact at its
 * pointerdown, leaves the air press unclaimed, and claims the tip landing that
 * follows an air press on the landing row.
 *
 * Driven through the real router's handlers on the shared harness element, so
 * a guard that is wired in one handler and not the other shows here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { captureInlinePenTrace, clearInlinePenTrace } from "./InlinePenRouterTrace";
import { setSideButtonErases } from "./TipMode";

/** The side button held, as the browser reports it on the pointer's own button. */
function sideButtonDown(ts: number, pressure: number): PointerEvent {
	return { ...penEvent("pointerdown", ts, { buttons: 2, pressure }), button: 2 } as unknown as PointerEvent;
}

/** The notes of every pointerdown the router traced since the last clear. */
function downNotes(): string[] {
	return captureInlinePenTrace({}).events.filter((r) => r.type === "pointerdown").map((r) => r.note);
}

describe("pen contact with the side button held", () => {
	let undoWindow: () => void;

	beforeAll(() => {
		undoWindow = installFakeWindow();
		setDiagnosticsEnabled(true);
	});
	afterAll(() => {
		setDiagnosticsEnabled(false);
		undoWindow();
	});

	beforeEach(() => {
		setSideButtonErases(false);
		clearInlinePenTrace();
	});

	it("a side-button contact at pressure above zero is claimed as the lasso", () => {
		const h = harness();
		h.fire(sideButtonDown(10, 0.5));
		expect(h.rec.downs).toBe(1);
		expect(downNotes().some((n) => n.includes("pen CLAIMED (side)"))).toBe(true);
	});

	it("with the side button set to erase, a side-button contact is claimed as the eraser", () => {
		setSideButtonErases(true);
		const h = harness();
		h.fire(sideButtonDown(10, 0.5));
		expect(h.rec.downs).toBe(1);
		expect(downNotes().some((n) => n.includes("pen CLAIMED (eraser)"))).toBe(true);
	});

	it("an air press followed by a side-button contact row at pressure above zero is claimed on that row", () => {
		const h = harness();
		h.fire(sideButtonDown(10, 0));
		expect(h.rec.downs).toBe(0);
		h.fire(penEvent("pointermove", 20, { buttons: 2, pressure: 0.6 }));
		expect(h.rec.downs).toBe(1);
	});

	it("an air press, then the tip landing, claims on the landing row; the next air press is not claimed", () => {
		const h = harness();
		h.fire(sideButtonDown(10, 0));
		expect(h.rec.downs).toBe(0);
		h.fire(penEvent("pointermove", 20, { buttons: 3, pressure: 0.6 }));
		expect(h.rec.downs).toBe(1);
		h.fire(penEvent("pointerup", 30, { buttons: 0, pressure: 0 }));
		h.fire(sideButtonDown(40, 0));
		expect(h.rec.downs).toBe(1);
	});

	it("a hover row reporting the tip with no air press before it is not a contact", () => {
		const h = harness();
		h.fire(penEvent("pointermove", 10, { buttons: 1, pressure: 0.5 }));
		expect(h.rec.downs).toBe(0);
	});

	it("an eraser-end contact is claimed as the eraser", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 10, { buttons: 32, pressure: 0.5 }));
		expect(h.rec.downs).toBe(1);
		expect(downNotes().some((n) => n.includes("pen CLAIMED (eraser)"))).toBe(true);
	});
});
