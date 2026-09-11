/**
 * The pure half of the slides ink surface (design §7).
 *
 * Everything asserted here is a rule the device cannot check cheaply: where a
 * screen point lands in deck-logical units, whether a contact was a tap or a
 * stroke, which section a stored slide's ink belongs to after the note has been
 * edited, and - the backward-compatibility promise - that nothing can load a
 * `<pageId>.slides` sidecar as a note page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import stylesSrc from "../../styles.css?raw";
import surfaceSrc from "./SlidesInkSurface.ts?raw";
import mainSrc from "../main.ts?raw";
import { codeOnly } from "../CodeOnly";
import {
	IDLE_SESSION,
	NOTE_CHECK_CHARS,
	NOTE_CHECK_NEEDLE_CHARS,
	PALM_CONTACT_SWALLOW_PX,
	ScreenRect,
	SlidesDeck,
	SlidesInkHost,
	PEN_CONTACT_GUARDED_EVENTS,
	PEN_GUARDED_EVENTS,
	PEN_GUARD_TAIL_MS,
	PEN_NEAR_TAIL_MS,
	PEN_RELEASE_TAIL_MS,
	SILENT_LIFT_QUIET_MS,
	SLIDES_DESYNCHRONIZED,
	SLIDES_SIDECAR_SUFFIX,
	STROKE_HOLD_MS,
	StrokeSession,
	TAP_MS,
	TAP_SLOP_PX,
	claimsContact,
	contactBecameStroke,
	deckSectionText,
	eraserHitsInSlide,
	eraserIntent,
	insideRect,
	isEraserContact,
	isPenHoverEvent,
	palmShapedContact,
	penIsNear,
	suppressDeckContextMenu,
	withinPalmReleaseTail,
	keptSlides,
	mapScreenToSlide,
	noteMatchesDeck,
	onSlidesCssChange,
	pageOfSlide,
	partialEraseInSlide,
	presentIndex,
	remapSlides,
	remapStrokes,
	settleSlidesInk,
	reloadSlidesExternal,
	scanForSlides,
	sectionHash,
	sectionHashes,
	setSlidesInk,
	silentLift,
	slideCamera,
	slideEraseCircle,
	slideOfPage,
	slideScale,
	slidesBackingScale,
	slidesSidecarId,
	splitSlideSections,
	strokeSessionReducer,
	swallowDuringPenContact,
} from "./SlidesInkSurface";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { silentLift as routerSilentLift } from "../input/PointerRouter";
import { GUARD_SUBTREE_CLASS } from "../inline/GuardStyle";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { claimMarkdown } from "../inline/InlineClaim";
import { MAX_BACKING_AREA } from "../inline/ZoomScale";
import { setMouseInk } from "../inline/MouseInk";
import { setPredictionEink } from "../inline/StrokePrediction";
import { PageData, ParseResult, emptyPage, isSafePageId } from "../model/PageData";
import { inkThemeOverride, setInkThemeOverride } from "../ink/InkTheme";
import { InkStroke } from "../ink/Stroke";
import { TailRenderer } from "../ink/TailRenderer";

/**
 * A bounded slice of the module's own source, for the assertions that can only
 * be made against the text. Both ends are asserted, so a probe that silently
 * returned the rest of the file cannot pass: that is the failure mode that
 * makes source tests worthless (see inline/overlaySource.testutil.ts).
 */
/** The fixed `buildId` every fake host in this file reports. */
const TEST_BUILD_ID = "test-build";

function slice(from: string, to: string): string {
	const src = surfaceSrc.replace(/\r\n/g, "\n");
	const start = src.indexOf(from);
	expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
	const rest = src.slice(start + from.length);
	const end = rest.indexOf(to);
	expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(-1);
	return rest.slice(0, end);
}

describe("the mapping", () => {
	it("inverts reveal's scale and letterbox offset", () => {
		// A 960x700 deck painted at (100,200) at 480x350 is k=0.5, so screen
		// (340,375) is logical (480,350) - the middle of the deck.
		const rect = { left: 100, top: 200, width: 480, height: 350 };
		expect(slideScale(rect, 960)).toBe(0.5);
		expect(mapScreenToSlide(340, 375, rect, 960)).toEqual({ x: 480, y: 350 });
	});

	it("keeps the letterbox negative rather than clamping it", () => {
		const rect = { left: 100, top: 200, width: 480, height: 350 };
		// 20 screen px left of the deck at k=0.5 is 40 logical units left of it.
		expect(mapScreenToSlide(80, 200, rect, 960)).toEqual({ x: -40, y: 0 });
	});

	it("returns k=1 rather than NaN for a deck with no layout yet", () => {
		expect(slideScale({ left: 0, top: 0, width: 0, height: 0 }, 960)).toBe(1);
		expect(slideScale({ left: 0, top: 0, width: 480, height: 0 }, 0)).toBe(1);
	});

	it("places the camera so deck-logical ink lands on a viewport canvas", () => {
		const deck = { left: 100, top: 200, width: 480, height: 350 };
		const viewport = { left: 20, top: 50, width: 640, height: 480 };
		const cam = slideCamera(deck, viewport, 0.5);
		// Logical (0,0) must paint at the deck's corner inside the viewport:
		// (0 - cam.x) * zoom = 80, which is deck.left - viewport.left.
		expect((0 - cam.x) * cam.zoom).toBeCloseTo(80);
		expect((0 - cam.y) * cam.zoom).toBeCloseTo(150);
		expect(cam.zoom).toBe(0.5);
	});

	it("includes the edges of the viewport in the hit test", () => {
		const r = { left: 10, top: 10, width: 100, height: 50 };
		expect(insideRect(10, 10, r)).toBe(true);
		expect(insideRect(110, 60, r)).toBe(true);
		expect(insideRect(9.9, 30, r)).toBe(false);
	});

	it("finds the present slide, and answers -1 before reveal marks one", () => {
		const s = (...classes: string[]) => ({ classList: { contains: (c: string) => classes.includes(c) } });
		expect(presentIndex([s("past"), s("present"), s("future")])).toBe(1);
		expect(presentIndex([s("future"), s("future")])).toBe(-1);
		// Two `present` classes mid-transition: the first wins, deterministically.
		expect(presentIndex([s("present"), s("present")])).toBe(0);
	});
});

describe("tap vs stroke (Alan's ruling, §3.3)", () => {
	it("is a tap when the pen neither moved nor lingered", () => {
		expect(contactBecameStroke(0, 0, 10)).toBe(false);
		expect(contactBecameStroke(3, 3, 200)).toBe(false);
		expect(contactBecameStroke(TAP_SLOP_PX, 0, TAP_MS)).toBe(false);
	});

	it("is a stroke past the slop, whatever the clock says", () => {
		expect(contactBecameStroke(TAP_SLOP_PX + 0.1, 0, 1)).toBe(true);
		expect(contactBecameStroke(0, -20, 5)).toBe(true);
		expect(contactBecameStroke(5, 5, 0)).toBe(true); // hypot 7.07 > 6
	});

	it("is a stroke past the clock, even with no movement: the deliberate dot", () => {
		expect(contactBecameStroke(0, 0, TAP_MS + 1)).toBe(true);
	});

	it("swallows reveal's navigation only while a stroke is live", () => {
		// `penDown` false on both rows on purpose: it isolates the STROKE rule
		// from the palm rule, which would otherwise swallow the touch three on
		// the second row and say nothing about the ruling under test.
		for (const type of PEN_GUARDED_EVENTS) {
			expect(swallowDuringPenContact(false, true, type, "pen")).toBe(true);
			// The whole of the ruling: a TAP's click reaches `.navigate-right`
			// and `.slides-close-btn` exactly as a mouse click does.
			expect(swallowDuringPenContact(false, false, type, "pen")).toBe(false);
		}
	});

	// RENAMED, was "never swallows pointerdown, or the deck loses its
	// keyboard". It used to assert that NO pointerdown is ever swallowed, and
	// that was too wide: the palm guard has to swallow a TOUCH pointerdown
	// while the pen is already down, or a palm landing mid-stroke starts a
	// Reveal swipe. S4 is about the deck's FOCUS, and only a pen or mouse
	// pointerdown can carry that - by the time the palm's arrives the pen's own
	// has already bubbled and kept it. The narrower claim is the true one.
	it("never swallows a PEN or MOUSE pointerdown, or the deck loses its keyboard", () => {
		expect(PEN_GUARDED_EVENTS).not.toContain("pointerdown");
		for (const penDown of [false, true]) {
			for (const strokeLive of [false, true]) {
				expect(swallowDuringPenContact(penDown, strokeLive, "pointerdown", "pen")).toBe(false);
				expect(swallowDuringPenContact(penDown, strokeLive, "pointerdown", "mouse")).toBe(false);
			}
		}
		expect(swallowDuringPenContact(true, true, "keydown", undefined)).toBe(false);
	});

	it("has no target whitelist: the two flags are the only gate", () => {
		const guard = slice("private onGuardedEvent(ev: Event): void {", "\n\t}\n");
		expect(guard).toContain("swallowDuringPenContact(");
		expect(guard).toContain("this.penContact && this.penStroke");
		expect(guard).toContain("ev.type");
		expect(guard).toContain("pointerType");
		expect(guard).toContain("ev.stopPropagation()");
		expect(guard).not.toContain("closest");
		expect(guard).not.toContain("preventDefault");
	});
});

describe("palm guard (Alan, 2026-09-05: \"palm during a stroke ... so it is bullet proof\")", () => {
	// Reveal 4 forwards a `pointerType === "touch"` pointermove into its own
	// touch swipe, so a palm dragged while the pen writes turned the slide
	// through a path the stroke guard never looked at. These are the pure
	// predicate rows; the capture-path ones are in the rig describe below.

	it("swallows a touch pointermove while the pen is down: the palm cannot swipe", () => {
		expect(swallowDuringPenContact(true, true, "pointermove", "touch")).toBe(true);
	});

	it("swallows a touch pointerdown while the pen is down", () => {
		expect(swallowDuringPenContact(true, true, "pointerdown", "touch")).toBe(true);
		expect(swallowDuringPenContact(true, true, "pointerup", "touch")).toBe(true);
		expect(swallowDuringPenContact(true, true, "pointercancel", "touch")).toBe(true);
	});

	it("swallows the touch* three while the pen is down, pointerType or not", () => {
		for (const type of ["touchstart", "touchmove", "touchend"]) {
			expect(swallowDuringPenContact(true, false, type, undefined)).toBe(true);
		}
	});

	it("swallows a touch pointermove for an UNPROMOTED contact: contact, not stroke", () => {
		// A pen tap in progress owns the glass just as much as a stroke does,
		// and this is the window the old guard had no answer for at all.
		expect(swallowDuringPenContact(true, false, "pointermove", "touch")).toBe(true);
	});

	it("swallows nothing touch-shaped with no pen down: a finger alone still swipes", () => {
		for (const type of PEN_CONTACT_GUARDED_EVENTS) {
			expect(swallowDuringPenContact(false, false, type, "touch")).toBe(false);
		}
		expect(swallowDuringPenContact(false, false, "pointermove", "touch")).toBe(false);
	});

	it("never swallows pen or mouse by the palm rule", () => {
		for (const type of PEN_CONTACT_GUARDED_EVENTS.filter((t) => t.startsWith("pointer"))) {
			expect(swallowDuringPenContact(true, false, type, "pen")).toBe(false);
			expect(swallowDuringPenContact(true, false, type, "mouse")).toBe(false);
		}
		// pointerup is the one row the STROKE rule owns for every type, so it
		// is swallowed once promoted - that is A1, not the palm rule.
		expect(swallowDuringPenContact(true, true, "pointerup", "pen")).toBe(true);
		expect(swallowDuringPenContact(true, true, "pointermove", "pen")).toBe(false);
	});

	it("reads a pen pointermove with no buttons as a hover sample, and nothing else", () => {
		expect(isPenHoverEvent("pointermove", "pen", 0)).toBe(true);
		expect(isPenHoverEvent("pointermove", "pen", 1)).toBe(false);
		expect(isPenHoverEvent("pointermove", "touch", 0)).toBe(false);
		expect(isPenHoverEvent("pointermove", "mouse", 0)).toBe(false);
		expect(isPenHoverEvent("pointerdown", "pen", 0)).toBe(false);
		expect(isPenHoverEvent("pointermove", undefined, undefined)).toBe(false);
	});

	it("keeps PalmGate's two windows: 300 ms of hover, 250 ms after a lift", () => {
		// PalmGate.ts is the source of truth for both; these two rows are what
		// would go red if this file's copies drifted from it.
		expect(PEN_NEAR_TAIL_MS).toBe(300);
		expect(PEN_RELEASE_TAIL_MS).toBe(250);
		expect(penIsNear(1000, 1000 + PEN_NEAR_TAIL_MS - 1)).toBe(true);
		expect(penIsNear(1000, 1000 + PEN_NEAR_TAIL_MS)).toBe(false);
		expect(withinPalmReleaseTail(1000, 1000 + PEN_RELEASE_TAIL_MS - 1)).toBe(true);
		expect(withinPalmReleaseTail(1000, 1000 + PEN_RELEASE_TAIL_MS)).toBe(false);
		// Never hovered, never lifted: the -Infinity seed answers plainly.
		expect(penIsNear(-Infinity, 0)).toBe(false);
		expect(withinPalmReleaseTail(-Infinity, 0)).toBe(false);
	});

	it("reads PalmShield's radius threshold as a pointer DIAMETER", () => {
		// Touch.radiusX is a radius; PointerEvent.width is the full extent.
		expect(PALM_CONTACT_SWALLOW_PX).toBe(32);
		expect(palmShapedContact(PALM_CONTACT_SWALLOW_PX, 4)).toBe(true);
		expect(palmShapedContact(4, PALM_CONTACT_SWALLOW_PX)).toBe(true);
		expect(palmShapedContact(PALM_CONTACT_SWALLOW_PX - 1, 4)).toBe(false);
		// The spec default, and the absent case: unknown geometry is not a palm.
		expect(palmShapedContact(1, 1)).toBe(false);
		expect(palmShapedContact(undefined, undefined)).toBe(false);
	});

	it("keeps the two lists separate, which is what makes S4 survivable", () => {
		// If these were one list the stroke rule, which matches every pointer
		// type, would swallow the pen's own pointerdown.
		expect(PEN_GUARDED_EVENTS).not.toContain("pointerdown");
		expect(PEN_CONTACT_GUARDED_EVENTS).toContain("pointerdown");
		expect(PEN_CONTACT_GUARDED_EVENTS).toContain("pointermove");
		expect(PEN_CONTACT_GUARDED_EVENTS).toContain("pointercancel");
	});
});

describe("suppressDeckContextMenu (InlinePenRouter.contextMenuSuppressed's shape)", () => {
	const base = { penDown: false, strokeLive: false, penNear: false, pointerType: "mouse" };

	it("suppresses while a claimed gesture owns the moment", () => {
		expect(suppressDeckContextMenu({ ...base, strokeLive: true })).toBe(true);
		expect(suppressDeckContextMenu({ ...base, penDown: true })).toBe(true);
	});

	it("suppresses a pen-sourced menu and one raised while the pen hovers", () => {
		expect(suppressDeckContextMenu({ ...base, pointerType: "pen" })).toBe(true);
		expect(suppressDeckContextMenu({ ...base, penNear: true, pointerType: "touch" })).toBe(true);
	});

	it("never suppresses an ordinary right-click away from the pen", () => {
		expect(suppressDeckContextMenu(base)).toBe(false);
		expect(suppressDeckContextMenu({ ...base, pointerType: "touch" })).toBe(false);
		expect(suppressDeckContextMenu({ ...base, pointerType: undefined })).toBe(false);
	});
});

describe("mouse ink claim (roadmap: mouse input; Alan/Paladin, mouse-only, 2026-09-05)", () => {
	it("claims a primary pen contact whether or not mouse ink is on", () => {
		expect(claimsContact("pen", true, 0, false)).toBe(true);
		expect(claimsContact("pen", true, 0, true)).toBe(true);
	});

	it("does not claim a mouse contact while mouse ink is off - today's behaviour, unchanged", () => {
		expect(claimsContact("mouse", true, 1, false)).toBe(false);
	});

	it("claims a mouse LEFT-button contact once mouse ink is on", () => {
		expect(claimsContact("mouse", true, 1, true)).toBe(true);
	});

	it("never claims a mouse right or middle button, mouse ink on or not", () => {
		expect(claimsContact("mouse", true, 2, true)).toBe(false); // right only
		expect(claimsContact("mouse", true, 4, true)).toBe(false); // middle only
	});

	it("never claims touch, mouse ink on or not", () => {
		expect(claimsContact("touch", true, 1, false)).toBe(false);
		expect(claimsContact("touch", true, 1, true)).toBe(false);
	});
});

describe("mouse ink: the tap rule applies unchanged (§3.3, A1)", () => {
	// A1's rule (contactBecameStroke / swallowDuringPenContact's STROKE half)
	// takes no device parameter at all, so a claimed mouse contact runs through
	// the exact same two functions a pen contact does - these compose them the way
	// `onPointerMove`/`onGuardedEvent` do, with mouse-shaped numbers, to pin
	// that nothing downstream had to be taught about the mouse.
	it("a mouse tap passes its click through: no movement, no lingering, not swallowed", () => {
		expect(claimsContact("mouse", true, 1, true)).toBe(true);
		const becameStroke = contactBecameStroke(2, 1, 40);
		expect(becameStroke).toBe(false);
		expect(swallowDuringPenContact(true, becameStroke, "click", "mouse")).toBe(false);
	});

	it("a mouse drag swallows its click: past the slop, the stroke owns the contact", () => {
		expect(claimsContact("mouse", true, 1, true)).toBe(true);
		const becameStroke = contactBecameStroke(40, 0, 60);
		expect(becameStroke).toBe(true);
		expect(swallowDuringPenContact(true, becameStroke, "click", "mouse")).toBe(true);
	});
});

describe("eraser (§3.7, item B1)", () => {
	it("classifies both browsers' encodings of the tail eraser end as erasing, same as InlinePenRouter", () => {
		// The exact test InlinePenRouter.ts uses for its "eraser" arm:
		// (buttons & 32) !== 0 || button === 5 - two ways of reporting the
		// SAME physical contact, not two different gestures.
		expect(isEraserContact(32, 0)).toBe(true);
		expect(isEraserContact(0, 5)).toBe(true);
		expect(isEraserContact(32 | 1, 0)).toBe(true); // eraser end plus a stray bit
	});

	it("does not classify the tip or a barrel-held side button as erasing", () => {
		expect(isEraserContact(1, 0)).toBe(false); // bare tip
		expect(isEraserContact(2, 0)).toBe(false); // side/barrel button (lasso elsewhere)
		expect(isEraserContact(0, -1)).toBe(false);
	});

	// eraserIntent restates InlinePenRouter's bandEraserIntent rather than
	// importing it (see eraserIntent's own comment for why); these vectors are
	// copied verbatim from InlinePenRouter's BandEraser.test.ts - BOTH arms,
	// so the two rules cannot drift without a red test on one side or the
	// other. The pen arm used to diverge deliberately; it no longer does.
	it("erases with the mouse only under eraser mode, mouse ink, and the left button (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("mouse", 1, 0, true, true)).toBe(true);
		expect(eraserIntent("mouse", 1, 0, true, false)).toBe(false); // mouse ink off
		expect(eraserIntent("mouse", 1, 0, false, true)).toBe(false); // eraser mode off
		expect(eraserIntent("mouse", 2, 2, true, true)).toBe(false); // right button, not left
		expect(eraserIntent("touch", 1, 0, true, true)).toBe(false); // never touch
	});

	it("gives the pen arm eraser-mode widening too, exactly as bandEraserIntent has it", () => {
		// This used to assert the opposite, and its old name said the
		// divergence was deliberate: slides offered only the physical tail
		// end, never the tip. Alan overruled that ("slides needs to be able to
		// be erased with eraser end", "with a pen", "it should work
		// seamlessly") - and the mode arm is what makes it possible at all for
		// a pen with no tail end, or a pen on remote desktop, where the
		// eraser-end flag is dropped in transit. Both arms are now
		// `eraserEnd || eraserMode`, byte for byte.
		expect(eraserIntent("pen", 32, 0, false, false)).toBe(true); // tail end
		expect(eraserIntent("pen", 1, 0, true, false)).toBe(true); // eraserMode alone: yes now
	});

	// BandEraser.test.ts's own five pen vectors, restated against this
	// function so the pen arm is pinned from here on the way the mouse arm
	// already was.
	it("pen eraser end claims: buttons bit (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("pen", 32, 0, false, false)).toBe(true);
	});

	it("pen eraser end claims: button 5 on the transition event (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("pen", 0, 5, false, false)).toBe(true);
	});

	it("pen tip in eraser mode claims (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("pen", 1, 0, true, false)).toBe(true);
	});

	it("pen tip outside eraser mode inks instead (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("pen", 1, 0, false, false)).toBe(false);
	});

	it("pen side button is not an eraser (pinned to BandEraser.test.ts)", () => {
		expect(eraserIntent("pen", 2, 0, false, false)).toBe(false);
	});

	it("does not import the router to get that rule - src/slides restates it", () => {
		// Importing bandEraserIntent would drag InlinePenRouter's eighteen
		// imports into the slides bundle, silently and with a green gate. The
		// router is named in prose above; what must not appear is an import.
		expect(surfaceSrc.replace(/\r\n/g, "\n")).not.toMatch(
			/^import[^\n]*InlinePenRouter/m
		);
	});

	function stroke(id: string, x: number, y: number): InkStroke {
		const p = { x, y, pressure: 0.5, t: 0 };
		return {
			id,
			tool: "pen",
			color: "#000",
			width: 2,
			points: [p, { ...p, x: x + 1 }],
			bbox: { x, y, width: 1, height: 0 },
			createdAt: 0,
		};
	}

	it("hits a stroke under the eraser circle, in deck-logical coordinates", () => {
		// A 960x700 deck painted at (100,200) at 480x350 is k=0.5 (same rig as
		// "the mapping" above), so radiusPx is divided by k before the circle
		// test, exactly like the inline eraser's visualToNote.
		const rect = { left: 100, top: 200, width: 480, height: 350 };
		const s = stroke("a", 490, 360); // near deck-logical centre (480, 350)
		const clientX = 100 + 490 * 0.5; // screen point directly over that stroke
		const clientY = 200 + 360 * 0.5;
		const hits = eraserHitsInSlide([s], clientX, clientY, rect, 960, 14);
		expect(hits).toEqual(["a"]);
	});

	it("misses a stroke outside the circle once the radius is scaled by k", () => {
		const rect = { left: 100, top: 200, width: 480, height: 350 };
		// This stroke sits 200 logical units from the contact point - at k=0.5
		// a 14px screen radius is only 28 logical units, nowhere close.
		const s = stroke("far", 690, 360);
		const clientX = 100 + 490 * 0.5;
		const clientY = 200 + 360 * 0.5;
		expect(eraserHitsInSlide([s], clientX, clientY, rect, 960, 14)).toEqual([]);
	});

	it("scales the radius with k exactly like the tip's own mapping", () => {
		// At k=1 (no scale), a screen radius equals the same number of
		// logical units, so 14 reaches a stroke 10 units away and 8 does not.
		const rect = { left: 0, top: 0, width: 960, height: 700 };
		const s = stroke("close", 10, 0);
		expect(eraserHitsInSlide([s], 0, 0, rect, 960, 14)).toEqual(["close"]);
		expect(eraserHitsInSlide([s], 0, 0, rect, 960, 8)).toEqual([]);
	});
});

describe("the eraser move path costs one repaint (§3.2)", () => {
	// One pointermove carries several coalesced samples. A repaint inside the
	// hit test meant a whole-canvas clear plus a redraw of every surviving
	// stroke per SAMPLE, several times inside one JS turn before the browser
	// painted once. The hits accumulate; the repaint happens after the loop.
	it("leaves the repaint to the caller instead of doing one per hit sample", () => {
		const eraseAt = slice("private eraseAt(clientX: number, clientY: number): boolean {", "\n\t}\n");
		expect(eraseAt).toContain("eraserHitsInSlide(");
		expect(eraseAt).not.toContain("this.repaint()");
	});

	it("marks the slide dirty once AFTER the coalesced loop, and never repaints inside it", () => {
		const branch = slice("if (this.erasing) {", "ev.preventDefault();");
		expect(branch).toContain("for (const s of list) {");
		expect(branch).toContain("if (this.eraseAt(s.clientX, s.clientY)) erased = true;");
		// No repaint anywhere on the move path: the frame owns it now.
		expect(branch).not.toContain("this.repaint()");
		expect(branch.split("this.markErased()").length - 1).toBe(1);
		expect(branch.indexOf("if (erased) this.markErased();")).toBeGreaterThan(
			branch.indexOf("for (const s of list) {")
		);
	});

	it("no longer touches anything on pointerdown - promotion decides it (regression: eraser ate the close button)", () => {
		// Alan, Orion, pen: the eraser used to hit-test at pointerdown and
		// capture immediately, which swallowed the navigation click under a
		// tap. B1 now waits on the same slop/clock promotion as ink (A1), so
		// pointerdown's erase arm does nothing but arm the gesture.
		const down = slice("this.erasedCount = 0;", "return;");
		expect(down).not.toContain("eraseAt(");
		expect(down).not.toContain("markErased(");
	});

	it("measures the deck on no move at all: the ink path reads the cache", () => {
		const ink = slice("const style = this.activeStyle;", "ev.preventDefault();");
		// One read of the cache, and nothing that forces layout. The runtime
		// count is asserted too ("takes zero getBoundingClientRect across 100
		// pointermoves"); this is the same rule stated where a reader editing
		// the loop will trip over it.
		expect(ink.split("this.geometry()").length - 1).toBe(1);
		expect(ink).not.toContain(".getBoundingClientRect()");
		expect(ink).toContain("this.samplePoint");
	});
});

describe("the touch guard styles.css arms for this surface", () => {
	/**
	 * THE SUBTREE RULE IS GONE, AND THAT IS THE FIX. It forced
	 * `touch-action: none` on every descendant of the deck for every user,
	 * which is what cost a finger its scrolling and its pinch. The surface now
	 * decides at contact with a non-passive `touchstart`, so there is no
	 * `touch-action` for Blink to OR pan-x/pan-y back into and nothing for a
	 * subtree rule to close.
	 *
	 * The editor and pdf rules stay: those surfaces still take the
	 * touch-action route and still need their subtree halves.
	 */
	it("no longer carries a subtree rule for the deck, and still names the right file", () => {
		const css = stylesSrc.replace(/\r\n/g, "\n");
		expect(css).not.toContain(`.reveal.${GUARD_SUBTREE_CLASS} * {`);
		// The other two surfaces are untouched by this route.
		expect(css).toContain(`.cm-scroller.${GUARD_SUBTREE_CLASS} * {`);
		expect(css).toContain(`.pdfViewer.${GUARD_SUBTREE_CLASS} *`);
		// SlidesInkProbe.ts is gone; a comment still pointing at it sends the
		// next reader to a file that does not exist.
		expect(css).not.toContain("SlidesInkProbe");
		expect(css).toContain("SlidesInkSurface");
	});
});

describe("section identity", () => {
	const note = `---
title: deck
---
# one

body one

---

# two

---

# three
`;

	it("splits the body on `---` lines outside the frontmatter", () => {
		const sections = splitSlideSections(note);
		expect(sections).toHaveLength(3);
		expect(sections[0]).toContain("# one");
		expect(sections[1]).toContain("# two");
		expect(sections[2]).toContain("# three");
		// The frontmatter's own fences are not slide breaks.
		expect(sections[0]).not.toContain("title: deck");
	});

	// Obsidian's presenter parses the note to mdast, splits the top-level
	// children on `thematicBreak` and skips empty groups. The index this
	// produces is a stroke's `page`, so ours has to agree exactly.
	describe("counting the way Obsidian's presenter counts", () => {
		it("keeps the empty group a leading `---` under the frontmatter makes", () => {
			// The presenter renders the frontmatter into this exact slide, so
			// it is on screen and must be counted (owner report, 2026-09-05).
			// This used to assert the group was DROPPED, which was the bug: a
			// bare `---` typed under the properties block made the note and
			// deck section counts disagree and every slide's ink went
			// memory-only.
			expect(splitSlideSections("---\ntitle: d\n---\n\n---\n\n# one\n\n---\n\n# two\n")).toEqual([
				"",
				"\n# one\n",
				"\n# two\n",
			]);
		});

		it("drops the empty group between doubled breaks", () => {
			expect(splitSlideSections("a\n\n---\n\n---\n\nb\n")).toHaveLength(2);
		});

		it("drops the empty group a trailing break makes", () => {
			expect(splitSlideSections("a\n\n---\n\nb\n\n---\n")).toHaveLength(2);
		});

		it("counts `***` and `___` as breaks too", () => {
			expect(splitSlideSections("a\n\n***\n\nb\n")).toHaveLength(2);
			expect(splitSlideSections("a\n\n___\n\nb\n")).toHaveLength(2);
			expect(splitSlideSections("a\n\n- - -\n\nb\n")).toHaveLength(2);
		});

		it("never breaks on a `---` inside a fenced code block", () => {
			const fenced = "# one\n\n```yaml\n---\nkey: value\n---\n```\n\n---\n\n# two\n";
			const sections = splitSlideSections(fenced);
			expect(sections).toHaveLength(2);
			expect(sections[0]).toContain("key: value");
			// A tilde fence guards the same way.
			expect(splitSlideSections("a\n\n~~~\n---\n~~~\n")).toHaveLength(1);
		});

		it("reads a `---` directly under a paragraph as a setext underline", () => {
			// `one\n---` is an h2 named "one", not a break: one slide, not two.
			expect(splitSlideSections("one\n---\ntwo\n---\nthree\n")).toHaveLength(1);
			// A blank line above it and it is a break again.
			expect(splitSlideSections("one\n\n---\n\ntwo\n")).toHaveLength(2);
			// `- - -` is never a setext underline, so it breaks even there.
			expect(splitSlideSections("one\n- - -\ntwo\n")).toHaveLength(2);
			// Nor is a heading a paragraph: `# one` then `---` is a break.
			expect(splitSlideSections("# one\n---\n# two\n")).toHaveLength(2);
		});

		// The presenter splits with legacy remark-parse under
		// `{breaks: true, commonmark: true}`. Under those options setext does
		// NOT interrupt a paragraph, and the tokenizer takes exactly one
		// content line followed by a line of nothing but `=` or `-`, with no
		// leading and no trailing whitespace. These four pin that shape. Each
		// asserts the section TEXT as well as the count, because a trailing
		// break leaves an empty group that is dropped: the count alone cannot
		// tell a break at the end of a note from a heading.
		it("a single line of text over `---` is a heading: ONE section", () => {
			expect(splitSlideSections("text\n---")).toEqual(["text\n---"]);
			// A line after it stays in the same slide - proof no break was cut.
			expect(splitSlideSections("text\n---\nmore")).toHaveLength(1);
		});

		it("two lines of text over `---` is a break: TWO sections", () => {
			// Setext cannot interrupt a paragraph already under way, so this
			// `---` is a thematic break and the `---` line itself is consumed.
			expect(splitSlideSections("line one\nline two\n---")).toEqual(["line one\nline two"]);
			expect(splitSlideSections("line one\nline two\n---\nmore")).toHaveLength(2);
		});

		it("`--- ` with a trailing space is a break: TWO sections", () => {
			// The tokenizer's underline is dashes and nothing else.
			expect(splitSlideSections("text\n--- ")).toEqual(["text"]);
			expect(splitSlideSections("text\n--- \nmore")).toHaveLength(2);
		});

		it("a list item over `---` is a break: TWO sections", () => {
			// A list line never opens a paragraph, so there is no heading for
			// the `---` to underline.
			expect(splitSlideSections("- item\n---")).toEqual(["- item"]);
			expect(splitSlideSections("- item\n---\nmore")).toHaveLength(2);
		});

		it("hands sectionHashes the same count it hands splitSlideSections", () => {
			const deck = "---\ntitle: d\n---\n\n---\n\n# one\n\n---\n\n---\n\n# two\n\n---\n";
			expect(sectionHashes(deck)).toHaveLength(splitSlideSections(deck).length);
			expect(sectionHashes(deck)).toHaveLength(3);
		});
	});

	// Paladin's console, 2026-09-05: `note check failed: Slides probe test.md,
	// deck 4 sections vs note 3; ink kept in memory`, then every slide's ink
	// went memory-only. He had typed a bare `---` directly under the
	// properties block. The presenter renders the frontmatter into the FIRST
	// slide, so that slide exists on screen even though the note's own body
	// (after the frontmatter) starts blank there.
	describe("a bare `---` right under the frontmatter (Paladin, 2026-09-05)", () => {
		const rest = "\n\n# Slide one\n\nDraw here.\n\n---\n\n# Slide two\n\n---\n\n# Slide three\n";

		it("counts the frontmatter's own slide: 4 sections, the first blank", () => {
			const note = "---\nhandwriting-page-id: abc\n---\n---" + rest;
			const sections = splitSlideSections(note);
			expect(sections).toHaveLength(4);
			expect(sections[0]).toBe("");
		});

		it("without frontmatter the leading blank group is still dropped: 3 sections", () => {
			// A leading blank line, not a bare `---`, as line one: a document
			// literally starting with `---` and a later matching `---` would
			// itself be read as frontmatter, which is not this case.
			const note = "\n---" + rest;
			const sections = splitSlideSections(note);
			expect(sections).toHaveLength(3);
			expect(sections[0]).toContain("Slide one");
		});

		it("a blank line before the `---` makes no difference to the presenter: still 4", () => {
			const note = "---\nhandwriting-page-id: abc\n---\n\n---" + rest;
			expect(splitSlideSections(note)).toHaveLength(4);
		});

		it("text before the first break is unchanged: 4 sections, the first has words", () => {
			const note = "---\nhandwriting-page-id: abc\n---\nIntro line\n\n---" + rest;
			const sections = splitSlideSections(note);
			expect(sections).toHaveLength(4);
			expect(sections[0]).toContain("Intro line");
		});
	});

	// Alan's console, 2026-09-06: `note "relslideonedrawherewiththepenthenpressth"
	// vs deck "slideonedrawherewiththepenthenpresstheri"`, then every stroke of
	// the presentation went memory-only and sixteen test items were lost at
	// Escape. His note opened `%%rel%%# Slide one`. The presenter does not
	// render a comment; the note side used to keep it.
	describe("Obsidian comments (Alan, 2026-09-06)", () => {
		it("drops an inline `%%...%%` from the section text", () => {
			expect(splitSlideSections("%%rel%%# Slide one\n\nDraw here.\n")).toEqual([
				"# Slide one\n\nDraw here.\n",
			]);
		});

		it("drops a block comment spanning two lines without changing the count", () => {
			const note = "# one\n\n%%a note\nover two lines%%\n\nbody\n\n---\n\n# two\n";
			const sections = splitSlideSections(note);
			expect(sections).toHaveLength(2);
			expect(sections[0]).not.toContain("over two lines");
			expect(sections[0]).toContain("body");
		});

		it("leaves `%%` inside a fenced code block alone", () => {
			const note = "# one\n\n```\n%% not a comment %%\n```\n\nbody\n";
			const sections = splitSlideSections(note);
			expect(sections).toHaveLength(1);
			expect(sections[0]).toContain("%% not a comment %%");
			expect(sections[0]).toContain("body");
		});

		it("drops an HTML comment before the first heading", () => {
			expect(splitSlideSections("<!-- draft -->\n# Slide one\n")).toEqual(["\n# Slide one\n"]);
		});

		// Measured against Obsidian 1.13.7's actual presenter parser: the whole
		// block comment is one node; a rule inside it cannot divide the deck.
		it("keeps a rule inside a block comment out of the slide count", () => {
			const note = "# one\n\n%%hidden\n\n---\n\nstill hidden%%\n\n# two\n";
			expect(splitSlideSections(note)).toHaveLength(1);
		});
	});

	it("hashes the trimmed text, so re-indenting the end does not detach ink", () => {
		expect(sectionHash("# one")).toBe(sectionHash("  # one\n\n"));
		expect(sectionHash("# one")).not.toBe(sectionHash("# two"));
		expect(sectionHash("# one")).toMatch(/^[0-9a-f]{8}$/);
	});

	it("keeps every slide in place when nothing changed", () => {
		const hashes = sectionHashes(note);
		const stored = hashes.map((hash, index) => ({ index, hash }));
		expect(remapSlides(stored, hashes).size).toBe(0);
	});

	it("follows a slide inserted ABOVE it - the case an index alone gets wrong", () => {
		const before = sectionHashes(note);
		const stored = before.map((hash, index) => ({ index, hash }));
		const after = sectionHashes(`---\ntitle: deck\n---\n# zero\n\n---\n\n# one\n\nbody one\n\n---\n\n# two\n\n---\n\n# three\n`);
		const moved = remapSlides(stored, after);
		expect(moved.get(0)).toBe(1);
		expect(moved.get(1)).toBe(2);
		expect(moved.get(2)).toBe(3);
	});

	it("remaps ink onto index 1 when a bare `---` under the frontmatter inserts a blank slide 0", () => {
		// Paladin's exact edit: a `---` typed directly under the properties
		// block, above everything that was already there. The stored ink was
		// on the old index 0 ("# one"); it must follow "# one" to its new
		// index rather than staying pinned to 0, which is now the blank
		// frontmatter slide.
		const before = sectionHashes(note);
		const stored = [{ index: 0, hash: before[0]! }];
		const afterNote = note.replace("---\ntitle: deck\n---\n", "---\ntitle: deck\n---\n---\n");
		const after = sectionHashes(afterNote);
		expect(after).toHaveLength(4);
		const moved = remapSlides(stored, after);
		expect(moved.get(0)).toBe(1);
		const strokes = [{ page: pageOfSlide(0) } as InkStroke];
		expect(remapStrokes(strokes, moved)).toBe(1);
		expect(strokes[0]!.page).toBe(pageOfSlide(1));
	});

	it("leaves a slide alone when the edit was BELOW it", () => {
		const before = sectionHashes(note);
		const stored = before.map((hash, index) => ({ index, hash }));
		const after = sectionHashes(note.replace("# three", "# three edited"));
		const moved = remapSlides(stored, after);
		// Slides 0 and 1 still hash to their own index; slide 2's text is gone
		// and matches nothing, so it KEEPS its index rather than being deleted.
		expect(moved.size).toBe(0);
	});

	it("refuses to guess when two sections are identical", () => {
		const dup = "# same\n\n---\n\n# same\n";
		const hashes = sectionHashes(dup);
		expect(hashes[0]).toBe(hashes[1]);
		// Stored as a one-slide deck whose text now appears twice: ambiguous,
		// so the index stands.
		const moved = remapSlides([{ index: 5, hash: hashes[0]! }], hashes);
		expect(moved.size).toBe(0);
	});

	it("counts the kept slides, and which of them land on a slide the deck shows", () => {
		// Two different unplaceable slides, and the difference is what the
		// reader sees. Index 5 is past the end of this two-section deck, so its
		// ink is invisible. Index 1 IS a section the deck shows - the ink was
		// drawn on other content and now renders over that section instead,
		// which is the case with no Notice and, before this, no log either.
		const dup = sectionHashes("# same\n\n---\n\n# same\n");
		const stored = [
			{ index: 5, hash: dup[0]! }, // ambiguous AND out of range
			{ index: 1, hash: "deadbeef" }, // no match at all, but in range
		];
		const moved = remapSlides(stored, dup);
		expect(moved.size).toBe(0);
		expect(keptSlides(stored, dup, moved)).toEqual({ kept: 2, visible: 1 });
	});

	it("does not count a slide that is where it belongs, or one it could place", () => {
		const hashes = sectionHashes(note);
		const stored = hashes.map((hash, index) => ({ index, hash }));
		// Nothing changed: every slide matches its own index.
		expect(keptSlides(stored, hashes, remapSlides(stored, hashes))).toEqual({
			kept: 0,
			visible: 0,
		});
		// A slide inserted above slide one moves all three, and a moved slide
		// is placed, not kept.
		const after = sectionHashes(`---\ntitle: deck\n---\n# zero\n\n---\n\n# one\n\nbody one\n\n---\n\n# two\n\n---\n\n# three\n`);
		expect(keptSlides(stored, after, remapSlides(stored, after))).toEqual({
			kept: 0,
			visible: 0,
		});
	});

	it("never deletes ink for a slide that was removed", () => {
		const before = sectionHashes(note);
		const stored = before.map((hash, index) => ({ index, hash }));
		const after = sectionHashes(`# one\n\nbody one\n\n---\n\n# three\n`);
		const moved = remapSlides(stored, after);
		// "# two" is gone: unmatched, so it keeps index 1 and waits.
		expect(moved.has(1)).toBe(false);
		// "# three" moved from 2 to 1, and that IS resolvable.
		expect(moved.get(2)).toBe(1);
	});

	it("moves the strokes with the slides, on 1-based page numbers", () => {
		const strokes = [
			{ page: pageOfSlide(0) } as InkStroke,
			{ page: pageOfSlide(2) } as InkStroke,
			{ page: undefined } as unknown as InkStroke,
		];
		const n = remapStrokes(strokes, new Map([[0, 1], [2, 3]]));
		expect(n).toBe(3);
		expect(strokes[0]!.page).toBe(pageOfSlide(1));
		expect(strokes[1]!.page).toBe(pageOfSlide(3));
		// An unnumbered stroke reads as slide 0, which is the only answer that
		// puts it somewhere the reader can find it.
		expect(strokes[2]!.page).toBe(pageOfSlide(1));
	});

	it("round-trips a slide index through the 1-based page field", () => {
		for (const i of [0, 1, 7]) expect(slideOfPage(pageOfSlide(i))).toBe(i);
		// PageData drops a page below 1, so 0 is never written; reading one
		// back as slide 0 is the tolerant answer.
		expect(slideOfPage(0)).toBe(0);
		expect(slideOfPage(undefined)).toBe(0);
	});
});

describe("the sidecar is not a note page (§3.1)", () => {
	it("uses an id of its own that a path can be built from", () => {
		const pageId = "11111111-2222-3333-4444-555555555555";
		expect(slidesSidecarId(pageId)).toBe(`${pageId}${SLIDES_SIDECAR_SUFFIX}`);
		expect(isSafePageId(slidesSidecarId(pageId))).toBe(true);
		expect(slidesSidecarId(pageId)).not.toBe(pageId);
	});

	it("never puts the suffixed id in a note's frontmatter", () => {
		const pageId = "11111111-2222-3333-4444-555555555555";
		const claimed = claimMarkdown("# a note\n", pageId);
		expect(claimed.content).toContain(`handwriting-page-id: ${pageId}`);
		expect(claimed.content).not.toContain(SLIDES_SIDECAR_SUFFIX);
		// So every reader that resolves a page from frontmatter - the note
		// surface, the canvas, and every older build - asks for the BARE id and
		// can never be handed slides ink.
		expect(claimed.pageId).toBe(pageId);
	});

	it("claims the bare page id and suffixes only for the sidecar", () => {
		const persist = slice("private persist(): void {", "\n\t}\n");
		expect(persist).toContain(".claimId(path, proposed)");
		expect(persist).not.toContain("claimId(path, slidesSidecarId");
		expect(persist).toContain("slidesSidecarId(result.pageId)");
		// The suffix is applied in exactly one function, so there is one place
		// to look when asking which ids this surface can ever write.
		const src = surfaceSrc.replace(/\r\n/g, "\n");
		const applications = src.split("`${pageId}${SLIDES_SIDECAR_SUFFIX}`").length - 1;
		expect(applications).toBe(1);
	});

	it("declares the surface and coordinate space on every page it writes", () => {
		const snapshot = slice("private snapshot(): PageData | null {", "\n\t}\n");
		expect(snapshot).toContain('surface: "slides"');
		expect(snapshot).toContain('coordSpace: "slide-logical"');
		expect(snapshot).toContain("pageId: sidecarId");
	});
});

describe("the stroke session (a cancel is not a lift)", () => {
	const down = (t = 0, captured = true): StrokeSession =>
		strokeSessionReducer(IDLE_SESSION, { kind: "down", pointerId: 1, t, captured }).state;

	it("begins on the first contact and commits on the lift", () => {
		const step = strokeSessionReducer(IDLE_SESSION, {
			kind: "down",
			pointerId: 1,
			t: 0,
			captured: true,
		});
		expect(step.begin).toBe(true);
		expect(step.state.phase).toBe("drawing");
		const up = strokeSessionReducer(step.state, { kind: "up", pointerId: 1, t: 50 });
		expect(up.end).toBe("up");
		expect(up.state).toEqual(IDLE_SESSION);
	});

	it("holds the stroke open through a cancel and carries on with the next move", () => {
		const cancelled = strokeSessionReducer(down(), { kind: "cancel", pointerId: 1, t: 10 });
		expect(cancelled.end).toBeNull();
		expect(cancelled.state.holdSince).toBe(10);
		const move = strokeSessionReducer(cancelled.state, { kind: "move", pointerId: 1, t: 20 });
		expect(move.sample).toBe(true);
		expect(move.recapture).toBe(true);
		expect(move.state.holdSince).toBeNull();
	});

	it("commits with the reason once the hold window runs out", () => {
		const cancelled = strokeSessionReducer(down(), { kind: "cancel", pointerId: 1, t: 10 });
		expect(strokeSessionReducer(cancelled.state, { kind: "tick", t: 10 + STROKE_HOLD_MS - 1 }).end).toBeNull();
		expect(strokeSessionReducer(cancelled.state, { kind: "tick", t: 10 + STROKE_HOLD_MS }).end).toBe("cancel");
	});

	it("ignores events addressed to another pointer", () => {
		const state = down();
		expect(strokeSessionReducer(state, { kind: "up", pointerId: 2, t: 5 }).end).toBeNull();
		expect(strokeSessionReducer(state, { kind: "down", pointerId: 2, t: 5, captured: true }).begin).toBe(
			false
		);
	});

	it("never re-acquires a capture that was deliberately never taken (A3)", () => {
		// A contact that may still be a tap runs uncaptured. Its first move
		// must NOT be read as a stolen capture and handed one, or the arrow
		// loses its click all over again.
		const tap = down(0, false);
		expect(tap.captured).toBe(false);
		const move = strokeSessionReducer(tap, { kind: "move", pointerId: 1, t: 10 });
		expect(move.recapture).toBe(false);
		expect(move.state.captured).toBe(false);
	});

	it("still re-acquires after a real theft on an uncaptured contact", () => {
		// The theft opens a hold, and that is what tells the two apart.
		const stolen = strokeSessionReducer(down(0, false), {
			kind: "lost-capture",
			pointerId: 1,
			t: 10,
		});
		expect(stolen.state.holdSince).toBe(10);
		const move = strokeSessionReducer(stolen.state, { kind: "move", pointerId: 1, t: 20 });
		expect(move.recapture).toBe(true);
		expect(move.state.captured).toBe(true);
	});
});

// ---- a live deck, with no DOM ----------------------------------------------

/**
 * The suite runs with no jsdom (vitest.config.ts sets no environment), so the
 * deck-level rules - the load race, the geometry cache, the erase frame, the
 * guard tail, teardown - are exercised against fakes that answer only what
 * `SlidesDeck` actually asks for. A fake that silently answered everything
 * would let a regression through; these throw instead.
 */

type AnyEvent = Record<string, unknown> & { type: string };

/**
 * `[slides]` log lines, captured for the tests that assert on one and to keep
 * the suite's output readable. File-level, so it covers every deck built below.
 */
const deckLogs: string[] = [];

beforeEach(() => {
	setDiagnosticsEnabled(false);
	deckLogs.length = 0;
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		deckLogs.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	setDiagnosticsEnabled(false);
	vi.restoreAllMocks();
	// The deck theme override is module-wide state in InkTheme, set at mount.
	// A rig that was never disposed would otherwise hand its deck's reading to
	// the next test in the file.
	setInkThemeOverride(null);
});

class FakeEl {
	createEl(tag: string): FakeEl {
		const child = this.ownerDocument.createElement(tag);
		this.appendChild(child);
		return child;
	}
	readonly style: Record<string, string> = { position: "", touchAction: "" };
	readonly children: FakeEl[] = [];
	className = "";
	id = "";
	textContent = "";
	rect: ScreenRect = { left: 0, top: 0, width: 0, height: 0 };
	clientWidth = 0;
	clientHeight = 0;
	/** Every `getBoundingClientRect` on this element, for the hot-path count. */
	rectCalls = 0;
	/** Every write to `width`/`height` once this element is a canvas (see `FakeDoc.createElement`). */
	backingWrites = 0;
	readonly classes = new Set<string>();
	readonly listeners: Array<{ type: string; fn: (ev: unknown) => void }> = [];
	readonly captured: number[] = [];
	/**
	 * Every `setPointerCapture` call, in order and never removed - `captured`
	 * is the live set, so it cannot answer "how many times, and when".
	 */
	readonly captureCalls: number[] = [];
	readonly classList = {
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
		contains: (c: string) => this.classes.has(c),
	};
	/** A CodeMirror `.cm-content` would set this; a plain `<div>` never does. */
	isContentEditable = false;
	/** Content attributes, `tabindex` included - a real element's, not the IDL default. */
	readonly attributes = new Map<string, string>();
	private _tabIndex = -1;

	/**
	 * Reflects the `tabindex` content attribute, the way a real element does:
	 * reading it never implies focusability (a bare `<div>` answers -1 too),
	 * but WRITING it is what a real `.focus()` call needs to have happened
	 * first - the exact silent no-op the source's mount-time patch exists to
	 * close.
	 */
	get tabIndex(): number {
		return this._tabIndex;
	}

	set tabIndex(v: number) {
		this._tabIndex = v;
		this.attributes.set("tabindex", String(v));
	}

	constructor(
		readonly tagName: string,
		readonly ownerDocument: FakeDoc
	) {}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}

	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.push({ type, fn });
	}

	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
		if (i >= 0) this.listeners.splice(i, 1);
	}

	getBoundingClientRect(): ScreenRect {
		this.rectCalls++;
		return this.rect;
	}

	appendChild(child: FakeEl): void {
		if (child.parentElement) child.remove();
		this.children.push(child);
		child.parentElement = this;
	}

	/**
	 * Real parentage, because the surface now decides whether to re-mount by
	 * comparing `canvas.parentElement` to `.reveal`. A fake that left this
	 * undefined would answer "detached" for canvases it had just mounted.
	 */
	parentElement: FakeEl | null = null;

	remove(): void {
		const p = this.parentElement;
		if (p) {
			const i = p.children.indexOf(this);
			if (i >= 0) p.children.splice(i, 1);
		}
		this.parentElement = null;
	}

	contains(other: unknown): boolean {
		return other === this;
	}

	/**
	 * Every `focus()` call's options argument, in order (F11). A real deck
	 * focus is `focus({ preventScroll: true })`, and a bare `focus()` scrolls
	 * the presentation - so the ARGUMENT is the protection and a fake that
	 * dropped it could not tell the two apart.
	 */
	readonly focusCalls: unknown[] = [];

	focus(options?: unknown): void {
		this.focusCalls.push(options);
		// A real `<div>` only takes DOM focus once a `tabindex` attribute has
		// made it focusable - without one, `.focus()` is a silent no-op and
		// `document.activeElement` does not move. Mirroring that here is what
		// makes the mount-time and stroke-end tests prove the patch, not just
		// the absence of a thrown error.
		if (this.attributes.has("tabindex")) this.ownerDocument.activeElement = this;
	}

	blur(): void {
		if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
	}

	setPointerCapture(id: number): void {
		this.captured.push(id);
		this.captureCalls.push(id);
	}

	releasePointerCapture(id: number): void {
		const i = this.captured.indexOf(id);
		if (i >= 0) this.captured.splice(i, 1);
	}

	/** Deliver an event to every listener for its type, in registration order. */
	dispatch(ev: AnyEvent): void {
		for (const l of this.listeners.slice()) if (l.type === ev.type) l.fn(ev);
	}
}

/**
 * A no-op 2d context that counts the calls the assertions care about.
 *
 * `granted` is a function rather than a constant (F4): what the browser GRANTS
 * for `desynchronized` is independent of what was requested - that difference
 * is the whole reason the mount line prints both - so the fake has to be able
 * to say "you asked for false and got true" rather than echoing the request.
 */
function fakeCtx(counts: ClearCounts, granted: () => boolean, el: FakeEl): CanvasRenderingContext2D {
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "clearRect")
					return (x: number, y: number, w: number, h: number) => {
						counts.clears++;
						counts.rects.push({ el, x, y, w, h });
					};
				if (prop === "getContextAttributes") return () => ({ desynchronized: granted() });
				return () => undefined;
			},
			set: () => true,
		}
	) as unknown as CanvasRenderingContext2D;
}

/**
 * Every `clearRect` any of this document's canvases took, in order, WITH the
 * canvas it landed on and the box it damaged.
 *
 * `clears` alone answers "how many"; two of this file's rules are about which
 * canvas and how big - the e-ink pen-up clears the stroke's own box rather
 * than the whole viewport (GAP 8), and the transient layers are cleared before
 * the committed flatten and not after (GAP 11) - and neither is visible in a
 * counter.
 */
interface ClearCounts {
	clears: number;
	rects: Array<{ el: FakeEl; x: number; y: number; w: number; h: number }>;
}

class FakeDoc {
	activeElement: unknown = null;
	readonly clearCounts: ClearCounts = { clears: 0, rects: [] };
	/** What `getContextAttributes().desynchronized` answers on this document's canvases (F4). */
	grantedDesynchronized = false;
	defaultView!: FakeWin;
	/**
	 * The presenter's stylesheet link, when a test hangs one here. Absent by
	 * default: a fake that always answered would hide which fallback ran.
	 */
	head: { querySelector: (selectors: string) => unknown } | undefined;

	createElement(tag: string): FakeEl {
		const el = new FakeEl(tag, this);
		const counts = this.clearCounts;
		const doc = this;
		const canvas = el as unknown as {
			getContext: () => CanvasRenderingContext2D;
			width: number;
			height: number;
		};
		canvas.getContext = () => fakeCtx(counts, () => doc.grantedDesynchronized, el);
		// Accessors rather than plain fields, so that "was the backing store
		// REALLOCATED" is answerable (F2/item 2). A plain assignment of the
		// same number is invisible to a reader that only sees the value, and
		// reallocation - not the value - is what throws the pixels away.
		let w = 0;
		let h = 0;
		Object.defineProperty(el, "width", {
			configurable: true,
			get: () => w,
			set: (v: number) => {
				w = v;
				el.backingWrites++;
			},
		});
		Object.defineProperty(el, "height", {
			configurable: true,
			get: () => h,
			set: (v: number) => {
				h = v;
				el.backingWrites++;
			},
		});
		canvas.width = 0;
		canvas.height = 0;
		el.backingWrites = 0;
		return el;
	}
}

class FakeWin {
	devicePixelRatio = 1;
	computedPosition = "static";
	/**
	 * What `palmRadiusTrustworthy` is asked about. Absent by default, which is
	 * the "cannot say what platform this is" case the shape rule fails CLOSED
	 * on - so every test written before the palm shield existed keeps running
	 * with no shield attached and asserting exactly what it always did.
	 */
	navigator: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined =
		undefined;
	/**
	 * What `getComputedStyle(.reveal).backgroundColor` answers. `undefined` by
	 * default, which is what a host with no real CSS engine would give and is
	 * exactly the "cannot be measured" case the fallbacks exist for.
	 */
	computedBackground: unknown = undefined;
	readonly timers = new Map<number, { fn: () => void; delay: number }>();
	readonly frames = new Map<number, () => void>();
	private nextTimer = 1;
	private nextFrame = 1;

	setTimeout(fn: () => void, delay = 0): number {
		const id = this.nextTimer++;
		this.timers.set(id, { fn, delay });
		return id;
	}

	clearTimeout(id: number): void {
		this.timers.delete(id);
	}

	requestAnimationFrame(fn: () => void): number {
		const id = this.nextFrame++;
		this.frames.set(id, fn);
		return id;
	}

	cancelAnimationFrame(id: number): void {
		this.frames.delete(id);
	}

	getComputedStyle(): { position: string; backgroundColor: unknown } {
		return { position: this.computedPosition, backgroundColor: this.computedBackground };
	}

	/**
	 * Every `(resolution: Ndppx)` query the surface has ever armed, in order,
	 * each with its own live listener list. The suite runs on node with no
	 * jsdom, so there is no real `matchMedia`; a counter alone would not do,
	 * because the whole rule is that the watcher RE-ARMS on the new ratio and
	 * lets the old query go.
	 */
	readonly mediaQueries: Array<{ query: string; listeners: Array<() => void> }> = [];

	matchMedia(query: string): MediaQueryList {
		const entry = { query, listeners: [] as Array<() => void> };
		this.mediaQueries.push(entry);
		return {
			media: query,
			matches: true,
			addEventListener: (_type: string, fn: () => void) => void entry.listeners.push(fn),
			removeEventListener: (_type: string, fn: () => void) => {
				const i = entry.listeners.indexOf(fn);
				if (i >= 0) entry.listeners.splice(i, 1);
			},
		} as unknown as MediaQueryList;
	}

	/** Listeners still attached anywhere. Teardown has to take these to zero. */
	resolutionListenerCount(): number {
		return this.mediaQueries.reduce((n, q) => n + q.listeners.length, 0);
	}

	/**
	 * The display changed under the window: the ratio moves and every query
	 * live at this instant flips. Both lists are snapshotted first - the
	 * handler re-arms, which pushes a new query and removes its own listener,
	 * and iterating the live arrays would fire the replacement forever.
	 */
	changeResolution(dpr: number): void {
		this.devicePixelRatio = dpr;
		for (const q of [...this.mediaQueries]) for (const fn of [...q.listeners]) fn();
	}

	addEventListener(): void {
		/* the window resize listener is never fired here */
	}

	removeEventListener(): void {
		/* ditto */
	}

	readonly MutationObserver = class {
		observe(): void {
			/* the class observer is driven through the deck's own paths */
		}
		disconnect(): void {
			/* nothing to disconnect */
		}
	};

	/**
	 * Run the pending timers due within `maxDelay`, once, in id order.
	 *
	 * The delay is honoured rather than ignored because the guard's whole rule
	 * is a difference between a 0 ms release and a 300 ms tail, and a fake that
	 * fired both together could not tell the fix from the bug.
	 */
	runTimers(maxDelay = Number.POSITIVE_INFINITY): void {
		for (const [id, t] of [...this.timers].sort((a, b) => a[0] - b[0])) {
			if (t.delay > maxDelay) continue;
			this.timers.delete(id);
			t.fn();
		}
	}

	/** Run every pending animation frame once, in id order. */
	runFrames(): void {
		for (const [id, fn] of [...this.frames].sort((a, b) => a[0] - b[0])) {
			this.frames.delete(id);
			fn();
		}
	}
}

interface Rig {
	deck: SlidesDeck;
	reveal: FakeEl;
	slides: FakeEl;
	win: FakeWin;
	doc: FakeDoc;
	scheduled: Array<{ id: string; page: PageData }>;
	savedNow: Array<{ id: string; page: PageData }>;
	/** Every `claimId` call: a Markdown write on the note, the one to watch. */
	claims: string[];
	/** Every `loadSidecar` call, by id and in order - the adopt-merge's own witness (F1). */
	loads: string[];
	/** Every Notice the surface raised, in order. */
	notices: string[];
	logs: string[];
	/** How many times the surface asked the host for the eraser's whole/partial setting. */
	wholeReads(): number;
	down(over?: Partial<AnyEvent>): void;
	move(x: number, y: number, over?: Partial<AnyEvent>): void;
	/**
	 * One `pointermove` carrying N coalesced samples (F3), the way Chromium
	 * delivers a pen faster than the frame rate. The rig's ordinary `move`
	 * never carries them, so a surface that read only the last one looked
	 * identical to one that read them all.
	 */
	moveCoalesced(points: Array<{ x: number; y: number }>, over?: Partial<AnyEvent>): void;
	end(type: string, over?: Partial<AnyEvent>): void;
	click(): { stopped: boolean };
}

interface RigOptions {
	sections?: number;
	source?: string | null;
	pageId?: string | null;
	/**
	 * The host's `loadSidecar`. Takes the id now (F1): the claim-identity rule
	 * turns on WHICH sidecar is read, and a loader that could not see the id
	 * could not tell the adopted one from the proposed one.
	 */
	load?: (sidecarId: string) => Promise<ParseResult | null>;
	/** `devicePixelRatio` on the DECK's window, set before the deck is built (F2). */
	devicePixelRatio?: number;
	/** What the canvases' `getContextAttributes()` GRANTS for `desynchronized` (F4). */
	grantedDesynchronized?: boolean;
	/** The host's `claimId`, when a test needs to hold the claim open. */
	claim?: (path: string, proposed: string) => Promise<{ pageId: string; futureVersion?: number }>;
	/** The host's immediate writer, when a test needs a real rejection. */
	saveNow?: (sidecarId: string, page: PageData) => Promise<void>;
	sectionText?: (i: number) => string;
	/** The inline `position` already on `.reveal` before the surface mounts. */
	revealPosition?: string;
	/** A `tabindex` already on `.reveal` before the surface mounts, if any. */
	revealTabIndex?: number;
	/**
	 * The note surface's eraser setting, as the host reports it. Defaults to
	 * whole-stroke, which is the plugin's own default (`eraserMode ===
	 * "stroke"`), so every test written before partial erase existed keeps
	 * asserting exactly what it always did.
	 */
	eraseWhole?: boolean;
	/** `getComputedStyle(.reveal).backgroundColor` for the deck-theme measurement. */
	deckBackground?: unknown;
	/** Which presenter stylesheet is linked in `document.head`, if any. */
	deckStylesheet?: "black" | "white";
	/** Whether the workspace body carries `theme-dark`, for the last fallback. */
	bodyDark?: boolean;
	/** The platform the palm shield's radius gate is asked about, if any. */
	navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number };
}

function makeRig(opts: RigOptions = {}): Rig {
	const doc = new FakeDoc();
	const win = new FakeWin();
	doc.defaultView = win;
	// Set before the deck is built: the surface measures the deck's theme once,
	// inside the constructor's first mount, and arms the palm shield there too.
	win.computedBackground = opts.deckBackground;
	win.navigator = opts.navigator;
	if (opts.devicePixelRatio !== undefined) win.devicePixelRatio = opts.devicePixelRatio;
	if (opts.grantedDesynchronized !== undefined) doc.grantedDesynchronized = opts.grantedDesynchronized;
	if (opts.deckStylesheet !== undefined) {
		const href = `app://obsidian.md/lib/reveal/${opts.deckStylesheet}.css`;
		doc.head = {
			querySelector: (sel: string) => {
				// Only the two selectors the surface actually asks for, matched
				// the way `[href*=...]` matches: a fake that answered any
				// selector with a hit could not tell black from white.
				const m = /^link\[href\*="([^"]+)"\]$/.exec(sel);
				return m && href.includes(m[1]!) ? { href } : null;
			},
		};
	}
	if (opts.bodyDark !== undefined) {
		const dark = opts.bodyDark;
		(doc as unknown as { body: unknown }).body = {
			classList: { contains: (c: string) => dark && c === "theme-dark" },
		};
	}
	const container = new FakeEl("div", doc);
	const reveal = new FakeEl("div", doc);
	const slides = new FakeEl("div", doc);
	if (opts.revealPosition !== undefined) reveal.style.position = opts.revealPosition;
	if (opts.revealTabIndex !== undefined) reveal.tabIndex = opts.revealTabIndex;
	reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
	reveal.clientWidth = 1000;
	reveal.clientHeight = 800;
	// A 960x700 deck drawn at half scale: k = 0.5.
	slides.rect = { left: 20, top: 25, width: 480, height: 350 };
	slides.clientWidth = 960;
	slides.clientHeight = 700;
	const n = opts.sections ?? 2;
	for (let i = 0; i < n; i++) {
		const s = new FakeEl("section", doc);
		s.textContent = opts.sectionText ? opts.sectionText(i) : `slide ${i}`;
		if (i === 0) s.classes.add("present");
		slides.children.push(s);
	}
	const scheduled: Array<{ id: string; page: PageData }> = [];
	const savedNow: Array<{ id: string; page: PageData }> = [];
	const claims: string[] = [];
	const loads: string[] = [];
	const notices: string[] = [];
	/** Every `eraseWholeStrokes()` call: proof the host member is read at all. */
	let wholeReads = 0;
	// Blank lines around the breaks, the way a real deck is written: a bare
	// `slide 0\n---` is a setext heading, not a slide break (CommonMark, and
	// what Obsidian's presenter counts).
	const source =
		opts.source === undefined
			? Array.from({ length: n }, (_, i) => `slide ${i}`).join("\n\n---\n\n")
			: opts.source;
	const host: SlidesInkHost = {
		activeFilePath: () => "Deck.md",
		readSource: async () => source,
		readPageId: () => (opts.pageId === undefined ? "note-1" : opts.pageId),
		claimId: async (path, proposed) => {
			claims.push(path);
			if (opts.claim) return opts.claim(path, proposed);
			return { pageId: proposed };
		},
		newPageId: () => "note-1",
		loadSidecar: async (sidecarId) => {
			loads.push(sidecarId);
			return opts.load ? opts.load(sidecarId) : null;
		},
		scheduleSidecar: (id, page) => void scheduled.push({ id, page }),
		saveSidecarNow: async (id, page) => {
			savedNow.push({ id, page });
			await opts.saveNow?.(id, page);
		},
		nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
		eraserRadiusPx: () => 12,
		eraseWholeStrokes: () => {
			wholeReads++;
			return opts.eraseWhole ?? true;
		},
		notify: (message) => void notices.push(message),
		buildId: TEST_BUILD_ID,
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	let t = 0;
	const ev = (type: string, over: Partial<AnyEvent> = {}): AnyEvent => ({
		type,
		pointerId: 1,
		pointerType: "pen",
		isPrimary: true,
		buttons: 1,
		button: 0,
		clientX: 200,
		clientY: 200,
		pressure: 0.5,
		timeStamp: (t += 20),
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
		...over,
	});
	return {
		deck,
		reveal,
		slides,
		win,
		doc,
		scheduled,
		savedNow,
		claims,
		loads,
		notices,
		logs: deckLogs,
		wholeReads: () => wholeReads,
		down: (over) => reveal.dispatch(ev("pointerdown", over)),
		move: (x, y, over) => reveal.dispatch(ev("pointermove", { clientX: x, clientY: y, ...over })),
		moveCoalesced: (points, over) => {
			const last = points[points.length - 1]!;
			const base = ev("pointermove", { clientX: last.x, clientY: last.y, ...over });
			// Each coalesced sample carries its own timestamp, the way a real
			// one does: the builder rejects points that share an instant, so a
			// list of three identical stamps would drop two and the test would
			// pass with the source reading only the last.
			const list = points.map((p, i) => ({
				...base,
				clientX: p.x,
				clientY: p.y,
				timeStamp: (base.timeStamp as number) - (points.length - 1 - i) * 4,
			}));
			base.getCoalescedEvents = () => list;
			reveal.dispatch(base);
		},
		end: (type, over) => reveal.dispatch(ev(type, over)),
		click: () => {
			const seen = { stopped: false };
			reveal.dispatch(ev("click", { stopPropagation: () => void (seen.stopped = true) }));
			return seen;
		},
	};
}

/** A stored sidecar holding one stroke on slide 0 (1-based page 1). */
function storedPage(id: string, strokeId: string): ParseResult {
	return {
		data: {
			...emptyPage(id),
			surface: "slides",
			coordSpace: "slide-logical",
			slides: [
				{ index: 0, hash: sectionHash("slide 0") },
				{ index: 1, hash: sectionHash("slide 1") },
			],
			strokes: [
				{
					id: strokeId,
					tool: "pen",
					color: "#000",
					width: 2,
					page: 1,
					points: [{ x: 1, y: 1, pressure: 0.5, t: 0 }],
					bbox: { x: 1, y: 1, width: 0, height: 0 },
					createdAt: 0,
				},
			],
		},
		recovered: false,
	};
}

/** Draw one whole stroke: down, two moves past the slop, lift. */
function drawStrokeOn(rig: Rig): void {
	rig.down();
	rig.move(260, 260);
	rig.move(300, 300);
	rig.end("pointerup");
}

describe("routine diagnostics", () => {
	it("preserves mount and stroke behavior while routine logging work stays off", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		const totalStrokes = vi.spyOn(
			rig.deck as unknown as { totalStrokes(): number },
			"totalStrokes"
		);
		drawStrokeOn(rig);

		expect(rig.scheduled).toHaveLength(1);
		expect(rig.scheduled[0]!.page.strokes).toHaveLength(1);
		expect(rig.logs.join("\n")).not.toContain("deck found:");
		expect(rig.logs.join("\n")).not.toContain("mount: three canvases");
		expect(rig.logs.join("\n")).not.toContain("deck took focus");
		expect(rig.logs.join("\n")).not.toContain("focus at stroke end:");
		expect(rig.logs.join("\n")).not.toContain("stroke end on slide 0:");
		expect(totalStrokes).not.toHaveBeenCalled();

		totalStrokes.mockRestore();
		rig.deck.dispose();
	});

	it("emits the paired mount, focus, stroke and save lines when recording is on", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		const totalStrokes = vi.spyOn(
			rig.deck as unknown as { totalStrokes(): number },
			"totalStrokes"
		);
		drawStrokeOn(rig);

		const lines = rig.logs.join("\n");
		expect(lines).toContain("deck found: container div, reveal div, slides div, 2 section(s)");
		expect(lines).toContain("mount: three canvases on div, starting on slide 0");
		expect(lines).toContain("deck took focus from none");
		expect(lines).toContain("focus at stroke end: active=div, insideDeck=true");
		expect(lines).toContain("stroke end on slide 0: reason=up, samples=3, +1");
		expect(lines).toContain("save scheduled: note-1.slides, 1 stroke(s)");
		expect(totalStrokes).toHaveBeenCalledTimes(1);

		totalStrokes.mockRestore();
		rig.deck.dispose();
	});

	it("retains load and save failures, notices and persistence outcomes while off", async () => {
		const readFailure = makeRig({
			load: async () => {
				throw new Error("read exploded");
			},
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(readFailure.logs.join("\n")).toContain(
			"sidecar load failed for note-1.slides: Error: read exploded"
		);
		expect(readFailure.notices).toEqual([]);
		drawStrokeOn(readFailure);
		expect(readFailure.scheduled).toHaveLength(1);
		readFailure.deck.dispose();

		let writes = 0;
		const writeFailure = makeRig({
			pageId: null,
			saveNow: async () => {
				if (++writes === 1) throw new Error("write exploded");
			},
		});
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(writeFailure);
		for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
		expect(writeFailure.logs.join("\n")).toContain(
			"save failed: note-1.slides: Error: write exploded"
		);
		expect(writeFailure.notices).toEqual([
			"Handwriting: this presentation's ink could not be saved.",
		]);
		expect(writeFailure.savedNow).toHaveLength(1);
		expect(writeFailure.scheduled).toEqual([]);
		writeFailure.deck.dispose();
	});
});

describe("the load window (a stroke drawn before the sidecar lands)", () => {
	it("merges the early stroke into the stored ink instead of overwriting it", async () => {
		let release!: (r: ParseResult) => void;
		const pending = new Promise<ParseResult>((res) => {
			release = res;
		});
		const rig = makeRig({ load: () => pending });
		await new Promise((r) => setTimeout(r, 0));
		// The store has not answered yet. Draw a whole stroke anyway.
		drawStrokeOn(rig);
		// Nothing may be written on the strength of an id that is still loading:
		// `snapshot()` would fall back to `emptyPage` and the write would be one
		// stroke over the reader's whole sidecar.
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		release(storedPage("note-1.slides", "stored-1"));
		await new Promise((r) => setTimeout(r, 0));
		const writes = [...rig.scheduled, ...rig.savedNow];
		expect(writes.length).toBeGreaterThan(0);
		const page = writes[writes.length - 1]!.page;
		expect(page.pageId).toBe("note-1.slides");
		const ids = page.strokes.map((s) => s.id);
		expect(ids).toContain("stored-1");
		expect(ids).toHaveLength(2);
		rig.deck.dispose();
	});

	it("refuses the write outright when the load came back damaged", async () => {
		const rig = makeRig({
			load: async () => ({ ...storedPage("note-1.slides", "stored-1"), damaged: true }),
		});
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		rig.deck.dispose();
	});
});

describe("the deck-side gather (§3.5: the frontmatter is not slide text)", () => {
	/** A section whose first child is the rendered frontmatter block. */
	function sectionWith(frontmatterClass: string): FakeEl {
		const doc = new FakeDoc();
		const section = new FakeEl("section", doc);
		const fm = new FakeEl("div", doc);
		fm.classes.add(frontmatterClass);
		fm.textContent = "handwriting-page-id: 07b2c6dd-5179-4628-a396-ae034c7c5711";
		const h1 = new FakeEl("h1", doc);
		h1.textContent = "Slide one";
		const p = new FakeEl("p", doc);
		p.textContent = "Draw here with the pen, then press the right arrow.";
		section.children.push(fm, h1, p);
		// A real element's textContent is every descendant's, run together,
		// and Obsidian renders the frontmatter first.
		section.textContent = `${fm.textContent}${h1.textContent}${p.textContent}`;
		return section;
	}

	const body = "Slide oneDraw here with the pen, then press the right arrow.";

	it("leaves out a child carrying class `frontmatter`", () => {
		expect(deckSectionText(sectionWith("frontmatter"))).toBe(body);
	});

	it("leaves out a child carrying class `metadata-container`", () => {
		expect(deckSectionText(sectionWith("metadata-container"))).toBe(body);
	});

	it("finds a frontmatter block that is not a direct child", () => {
		const doc = new FakeDoc();
		const section = new FakeEl("section", doc);
		const wrapper = new FakeEl("div", doc);
		const fm = new FakeEl("div", doc);
		fm.classes.add("frontmatter");
		fm.textContent = "handwriting-page-id: 07b2c6dd";
		wrapper.children.push(fm);
		const p = new FakeEl("p", doc);
		p.textContent = "Slide one";
		wrapper.textContent = fm.textContent;
		section.children.push(wrapper, p);
		section.textContent = `${fm.textContent}${p.textContent}`;
		expect(deckSectionText(section)).toBe("Slide one");
	});

	it("hands back a plain section's text unchanged", () => {
		const doc = new FakeDoc();
		const section = new FakeEl("section", doc);
		const h1 = new FakeEl("h1", doc);
		h1.textContent = "Slide one";
		section.children.push(h1);
		section.textContent = "Slide one";
		expect(deckSectionText(section)).toBe("Slide one");
	});
});

describe("the note check (§3.5: is this the note on the screen?)", () => {
	it("accepts the note the deck was built from, markdown syntax and all", () => {
		// Source on the left, what Obsidian rendered into the section on the
		// right. `#`, `**` and a link target are syntax, not content.
		expect(
			noteMatchesDeck(
				["# Quarterly review\n\nSee **[the plan](notes/plan.md)**", "## Numbers"],
				["Quarterly review\nSee the plan", "Numbers"]
			)
		).toBe(true);
	});

	it("accepts a rendered section with no whitespace between its blocks", () => {
		// `<h1>Slide one</h1><p>Draw here...` has textContent "Slide oneDraw
		// here" - no space where the block boundary was. A fingerprint that
		// collapses separators to a space compared "slide one draw here"
		// against "slide onedraw here" and failed every real deck, which is
		// why no sidecar was ever written. Separators are dropped instead.
		expect(
			noteMatchesDeck(
				["# Slide one\n\nDraw here with the pen."],
				["Slide oneDraw here with the pen."]
			)
		).toBe(true);
	});

	it("still refuses a genuinely different note once separators are gone", () => {
		expect(noteMatchesDeck(["# Slide one\n\nDraw here."], ["Shopping listMilk"])).toBe(false);
	});

	it("refuses a note with a different number of sections", () => {
		expect(noteMatchesDeck(["a", "b", "c"], ["a", "b"])).toBe(false);
		expect(noteMatchesDeck(["a"], ["a", "b"])).toBe(false);
	});

	it("refuses a note whose first slide is somebody else's", () => {
		expect(noteMatchesDeck(["# Shopping list"], ["Quarterly review"])).toBe(false);
	});

	it("lets a first slide with no words through on the count alone", () => {
		// A title slide that is only an image says nothing either way, and
		// reading a blank string as a mismatch would cost that deck its ink.
		expect(noteMatchesDeck(["![[cover.png]]"], [""])).toBe(true);
		expect(noteMatchesDeck(["", "b"], ["anything", "b"])).toBe(true);
	});

	it("matches when both sides' first section is blank (the frontmatter-only slide)", () => {
		// A bare `---` under the properties block gives the note side an
		// empty first section (splitSlideSections keeps it on purpose); the
		// gather strips the rendered frontmatter to "" on the deck side too.
		// Neither side saying anything proves nothing either way, so the
		// count is what decides, and it agrees here.
		expect(noteMatchesDeck(["", "# Slide one"], ["", "Slide one"])).toBe(true);
	});

	it("compares only the first NOTE_CHECK_CHARS of the note, so a long slide still matches", () => {
		const long = "word ".repeat(200);
		expect(noteMatchesDeck([long + "tail"], [long + "different tail"])).toBe(true);
	});

	it("accepts the deck from Alan's log, whose first slide renders the frontmatter", () => {
		// Verbatim from the console line that found this: the counts agreed,
		// the words agreed, and the check still refused, because the deck's
		// first section began with the note's own `handwriting-page-id`
		// property and the note's began with the body. This is the pair.
		expect(
			noteMatchesDeck(
				["# Slide one\n\nDraw here with the pen, then press the right arrow."],
				[
					"handwriting-page-id: 07b2c6dd-5179-4628-a396-ae034c7c5711" +
						"Slide oneDraw here with the pen, then press the right arrow.",
				]
			)
		).toBe(true);
	});

	it("accepts a deck whose frontmatter is longer than NOTE_CHECK_CHARS", () => {
		// The deck side is not cut at all. Were it cut at NOTE_CHECK_CHARS, a
		// long properties block would fill the window on its own and the
		// slide's actual words would never be compared.
		const properties = "property-name: value ".repeat(40);
		expect(properties.replace(/[^a-z0-9]/g, "").length).toBeGreaterThan(NOTE_CHECK_CHARS);
		expect(noteMatchesDeck(["# Slide one\n\nDraw here."], [properties + "Slide oneDraw here."])).toBe(
			true
		);
	});

	it("still refuses a genuinely different note now the relation is `contains`", () => {
		// `contains` is weaker than a prefix, so this is the one that has to
		// hold: a deck that renders somebody else's slide is still refused,
		// frontmatter and all.
		expect(
			noteMatchesDeck(
				["# Slide one\n\nDraw here with the pen, then press the right arrow."],
				[
					"handwriting-page-id: 07b2c6dd-5179-4628-a396-ae034c7c5711" +
						"Shopping listMilk, eggs, and a bag of flour for the weekend.",
				]
			)
		).toBe(false);
		// And the needle is only the first NOTE_CHECK_NEEDLE_CHARS, so a note
		// that agrees for a while and then diverges INSIDE the needle fails.
		const nearlyAll = "a".repeat(NOTE_CHECK_NEEDLE_CHARS - 10);
		expect(noteMatchesDeck([nearlyAll + "note tail"], [nearlyAll + "deck tail"])).toBe(false);
	});

	it("ignores what the two sides say past the needle", () => {
		// The other side of the same boundary: agree for the whole needle and
		// the rest is not compared, which is what lets a rendered slide run on.
		const wholeNeedle = "a".repeat(NOTE_CHECK_NEEDLE_CHARS);
		expect(noteMatchesDeck([wholeNeedle + "note tail"], [wholeNeedle + "deck tail"])).toBe(true);
	});

	it("treats two empty decks as a match", () => {
		expect(noteMatchesDeck([], [])).toBe(true);
	});

	it("accepts the deck from Alan's second log, whose note opens with a comment", () => {
		// Verbatim from the console line that found this: the counts agreed,
		// the words agreed, and the check still refused, because the note's
		// needle began "rel" - the body of a `%%rel%%` comment the presenter
		// never renders. The pair goes through splitSlideSections, which is
		// where the stripping lives and where the real caller gets its text.
		expect(
			noteMatchesDeck(
				splitSlideSections("%%rel%%# Slide one\n\nDraw here with the pen, then press the right arrow."),
				["Slide oneDraw here with the pen, then press the right arrow."]
			)
		).toBe(true);
	});
});

describe("a deck whose note is not the note on screen", () => {
	it("keeps the ink in memory, claims nothing, and says so once", async () => {
		// The workspace's active file is a three-section note; the deck on
		// screen has two. A second pane, or a popout.
		// Blank lines around the breaks: `one\n---` on its own is a setext
		// heading, which is exactly what splitSlideSections now says.
		const rig = makeRig({ sections: 2, source: "one\n\n---\n\ntwo\n\n---\n\nthree" });
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.logs.join("\n")).toContain(
			"note check failed: Deck.md, deck 2 sections vs note 3; ink kept in memory"
		);
		// And it says WHY: BOTH fingerprints, not just the counts. This line is
		// what found the frontmatter bug, so it is pinned to both prefixes.
		expect(rig.logs.join("\n")).toContain('note "one" vs deck "slide0"');
		drawStrokeOn(rig);
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.claims).toEqual([]);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
	});

	it("tells the reader once that the ink is not being saved", async () => {
		// The console line was the ONLY signal, and Alan lost sixteen drawn
		// items to it (2026-09-06). One Notice per deck now, `noticeReadOnly`'s
		// discipline: several strokes and a remount must not stack it.
		const rig = makeRig({ sections: 2, source: "one\n\n---\n\ntwo\n\n---\n\nthree" });
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		drawStrokeOn(rig);
		rig.reveal.dispatch({ type: "slidechanged" });
		drawStrokeOn(rig);
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.notices).toHaveLength(1);
		expect(rig.notices[0]).toContain("not being saved");
		expect(rig.notices[0]).toContain("the note does not match the deck");
		rig.deck.dispose();
	});

	it("says nothing at all when the note does match", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.notices).toEqual([]);
		rig.deck.dispose();
	});
});

describe("the geometry cache (§3.2: nothing measured per sample)", () => {
	it("takes zero getBoundingClientRect across 100 pointermoves", () => {
		const rig = makeRig();
		rig.down();
		// The pen-down measures once, deliberately. From here to the lift the
		// move path must not force layout at all.
		rig.slides.rectCalls = 0;
		rig.reveal.rectCalls = 0;
		for (let i = 0; i < 100; i++) rig.move(200 + i, 200 + (i % 7));
		expect(rig.slides.rectCalls).toBe(0);
		expect(rig.reveal.rectCalls).toBe(0);
		rig.end("pointerup");
		rig.deck.dispose();
	});

	it("takes zero getBoundingClientRect across 100 erase moves either", () => {
		const rig = makeRig();
		rig.down({ buttons: 32 });
		rig.slides.rectCalls = 0;
		rig.reveal.rectCalls = 0;
		for (let i = 0; i < 100; i++) rig.move(200 + i, 200 + (i % 7));
		expect(rig.slides.rectCalls).toBe(0);
		expect(rig.reveal.rectCalls).toBe(0);
		rig.end("pointerup");
		rig.deck.dispose();
	});

	it("re-measures when the deck moves under it, so the ink still lands right", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		// The window resized between strokes: same screen points, new k.
		rig.slides.rect = { left: 0, top: 0, width: 960, height: 700 };
		rig.reveal.dispatch({ type: "resize" });
		drawStrokeOn(rig);
		rig.deck.dispose();
		const strokes = rig.savedNow[rig.savedNow.length - 1]!.page.strokes;
		expect(strokes).toHaveLength(2);
		// k was 0.5 for the first stroke and 1 for the second, so the same
		// screen point is a different deck-logical point. A cache that never
		// re-measured would put them on top of each other.
		expect(strokes[0]!.points[0]!.x).not.toBeCloseTo(strokes[1]!.points[0]!.x);
	});

	it("reuses one point object without smearing every sample onto the last", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		rig.deck.dispose();
		const stroke = rig.savedNow[rig.savedNow.length - 1]!.page.strokes[0]!;
		const xs = new Set(stroke.points.map((p) => p.x));
		expect(xs.size).toBeGreaterThan(1);
	});
});

describe("teardown with the pen still down", () => {
	it("commits the stroke in progress instead of dropping it", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// No pointerup: the reader closed the presentation mid-stroke.
		rig.deck.dispose();
		const page = rig.savedNow[rig.savedNow.length - 1]!.page;
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]!.page).toBe(1);
	});

	it("flushes an erase gesture that never lifted", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		// The stored stroke sits at deck-logical (1,1); screen (20.5, 25.5) at
		// k=0.5 maps to (1,1), well inside the eraser circle. The move past the
		// slop is what promotes the contact (B1: an eraser waits on the same
		// slop/clock test as ink now), and promotion retroactively hit-tests
		// the point the contact started at, so the down point is still taken.
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		rig.move(30, 26, { buttons: 32 });
		rig.deck.dispose();
		const page = rig.savedNow[rig.savedNow.length - 1]!.page;
		expect(page.strokes).toEqual([]);
	});

	it("is still idempotent: a second dispose writes nothing more", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		rig.deck.dispose();
		const writes = rig.savedNow.length;
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(writes);
	});
});

/**
 * A sidecar holding `n` strokes strung out along one line of slide 0, far
 * enough apart (100 deck-logical units, against a 24-unit eraser circle) that
 * one erase position touches exactly one of them.
 */
function storedRow(id: string, n: number): ParseResult {
	return {
		data: {
			...emptyPage(id),
			surface: "slides",
			coordSpace: "slide-logical",
			slides: [
				{ index: 0, hash: sectionHash("slide 0") },
				{ index: 1, hash: sectionHash("slide 1") },
			],
			strokes: Array.from({ length: n }, (_, i) => ({
				id: `s${i}`,
				tool: "pen" as const,
				color: "#000",
				width: 2,
				page: 1,
				points: [{ x: 100 + i * 100, y: 100, pressure: 0.5, t: 0 }],
				bbox: { x: 100 + i * 100, y: 100, width: 0, height: 0 },
				createdAt: 0,
			})),
		},
		recovered: false,
	};
}

describe("the erase frame (§3.2: once per rAF, not once per move)", () => {
	/** Screen x for deck-logical x, at the rig's k=0.5 and left=20. */
	const sx = (logicalX: number): number => logicalX * 0.5 + 20;
	const sy = 100 * 0.5 + 25;

	it("repaints once for a whole burst of erase moves, on the frame", async () => {
		const rig = makeRig({ load: async () => storedRow("note-1.slides", 12) });
		await new Promise((r) => setTimeout(r, 0));
		// Drain the two nested frames the constructor queues for its remount.
		rig.win.runFrames();
		rig.win.runFrames();
		rig.down({ buttons: 32, clientX: sx(100), clientY: sy });
		const before = rig.doc.clearCounts.clears;
		for (let i = 1; i < 11; i++) {
			rig.move(sx(100 + i * 100), sy, { buttons: 32 });
		}
		// Ten moves, ten strokes gone, and not one repaint yet: the frame owes
		// the reader exactly one.
		expect(rig.doc.clearCounts.clears).toBe(before);
		rig.win.runFrames();
		expect(rig.doc.clearCounts.clears).toBe(before + 1);
		// ...and it is genuinely one frame, not one queued per move.
		expect(rig.win.frames.size).toBe(0);
		rig.deck.dispose();
	});

	it("persists at the lift, never on an erase move", async () => {
		const rig = makeRig({ load: async () => storedRow("note-1.slides", 12) });
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		const writesBefore = rig.scheduled.length + rig.savedNow.length;
		rig.down({ buttons: 32, clientX: sx(100), clientY: sy });
		for (let i = 1; i < 6; i++) rig.move(sx(100 + i * 100), sy, { buttons: 32 });
		expect(rig.scheduled.length + rig.savedNow.length).toBe(writesBefore);
		rig.end("pointerup", { buttons: 0 });
		expect(rig.scheduled.length + rig.savedNow.length).toBe(writesBefore + 1);
		const page = rig.scheduled[rig.scheduled.length - 1]!.page;
		expect(page.strokes).toHaveLength(6);
		rig.deck.dispose();
	});

	it("paints the last hit at the lift rather than leaving it to a frame", async () => {
		const rig = makeRig({ load: async () => storedRow("note-1.slides", 12) });
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		rig.down({ buttons: 32, clientX: sx(100), clientY: sy });
		const before = rig.doc.clearCounts.clears;
		rig.end("pointerup", { buttons: 0 });
		expect(rig.doc.clearCounts.clears).toBeGreaterThan(before);
		expect(rig.win.frames.size).toBe(0);
		rig.deck.dispose();
	});
});

describe("the navigation guard's tail (a commit is not a lift)", () => {
	it("keeps the guard up after a leave commits the stroke, until the real lift", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// The pen is still on the glass; the browser took the contact away.
		rig.end("pointercancel");
		// The hold window runs out and the stroke commits.
		rig.win.runTimers();
		// Nothing that releases on the next tick may fire: the pen has NOT
		// lifted, so the click Reveal would navigate on must still be
		// swallowed. This is the assertion the old code failed - it dropped the
		// guard in `commitStroke`, on a 0 ms timer.
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(true);
		// The real lift arrives. Its own click rides just behind it, so the
		// guard drops a tick later, not synchronously.
		rig.end("pointerup", { buttons: 0 });
		expect(rig.click().stopped).toBe(true);
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("drops the guard on its own if the lift never comes", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		rig.end("pointercancel");
		rig.win.runTimers();
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(true);
		// PEN_GUARD_TAIL_MS of silence: the contact really was over.
		rig.win.runTimers(PEN_GUARD_TAIL_MS);
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("still lets a tap's click through, guard tail and all", () => {
		const rig = makeRig();
		rig.down();
		rig.end("pointerup", { buttons: 0 });
		rig.win.runTimers(0);
		// A tap never became a stroke, so nothing was ever swallowed: the pen
		// taps the next-slide arrow exactly as a mouse click does (§3.3).
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});
});

describe("the silent lift (S5 extended: a lift is not always an event)", () => {
	/** The last page handed to the store, whichever door it went out of. */
	function lastPage(rig: Rig): PageData {
		const all = [...rig.scheduled, ...rig.savedNow];
		expect(all.length, "nothing was written").toBeGreaterThan(0);
		return all[all.length - 1]!.page;
	}

	/**
	 * DERIVED FROM THE ROUTER, NOT RESTATED FROM IT.
	 *
	 * `SlidesInkSurface.ts` re-declares `silentLift` on purpose and says why:
	 * importing `PointerRouter` would drag telemetry, the palm gate and the
	 * camera into a bundle that must depend on nothing but `src/ink` and
	 * `src/model`. That reasoning is sound and this test does not change it -
	 * the production file still imports nothing. A TEST file can take an import
	 * the production file cannot, and that asymmetry is the whole mechanism
	 * here.
	 *
	 * WHAT WAS WRONG WITH THE CASE THIS REPLACES. It asserted a hardcoded truth
	 * table against the slides copy ALONE, under the title "reads the hover
	 * signature the way PointerRouter does". It therefore proved what the code
	 * SAYS rather than what the router does: change the router's predicate - a
	 * third contact bit, a different eraser mask - and it stayed green while the
	 * two silently disagreed. The production file names that exact risk
	 * ("PointerRouter.ts IS the source of truth for this predicate and a drift
	 * here is a bug here") and nothing enforced it.
	 *
	 * slicer 2 put the shape better than I did, and it is theirs: on the remnant
	 * guard "the rule moved and my copy did not; here the rule could move and
	 * the copy would not, with nothing to say so". And the sharper half, also
	 * theirs: a duplication carrying a comment that ACKNOWLEDGES the duplication
	 * reads as a managed one - the comment is what stops the next reader
	 * looking.
	 *
	 * The signatures differ (the router takes a sample object, this surface two
	 * numbers) so the adapter below is doing real work; what it must never do is
	 * restate the ANSWER.
	 */
	it("agrees with PointerRouter's predicate on every contact-bit combination", () => {
		const router = (pressure: number, buttons: number): boolean =>
			routerSilentLift({ pressure, buttons });

		// The rows worth naming, kept for what they document - but each one now
		// asks the ROUTER for the answer instead of carrying a literal.
		const named: ReadonlyArray<readonly [number, number, string]> = [
			[0, 0, "the hover signature: pressure and BOTH contact bits at zero"],
			[0, 1, "a mid-stroke pressure dip still carries the tip bit (1)"],
			[0, 32, "the eraser end on the glass (32)"],
			[0.4, 0, "a buttons glitch still carries pressure"],
			[0, 2, "the side button is HELD THROUGH a lift, so bit 2 is ignored"],
		];
		for (const [pressure, buttons, why] of named) {
			expect(silentLift(pressure, buttons), why).toBe(router(pressure, buttons));
		}

		// AND EXHAUSTIVELY, which is what makes this an enforcement rather than a
		// sample: every combination of the six low button bits, at pressures on
		// both sides of zero. A predicate that starts reading a bit neither copy
		// read before is caught here, in whichever copy changed first.
		for (const pressure of [0, 0.0001, 0.4, 1]) {
			for (let buttons = 0; buttons < 64; buttons++) {
				expect(
					silentLift(pressure, buttons),
					`pressure ${pressure}, buttons ${buttons}`
				).toBe(router(pressure, buttons));
			}
		}
	});

	it("ends the stroke on a hover sample, with the samples drawn so far", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// The nib leaves the glass and no pointerup ever arrives: the stream
		// resumes hovering under the same pointerId.
		rig.move(400, 400, { buttons: 0, pressure: 0 });
		const page = lastPage(rig);
		expect(page.strokes).toHaveLength(1);
		// Down plus the two real moves, and NOT the hover sample: screen
		// (400,400) is deck-logical (760,750) at the rig's k=0.5.
		expect(page.strokes[0]!.points).toHaveLength(3);
		expect(page.strokes[0]!.points.some((p) => p.x === 760 && p.y === 750)).toBe(false);
		expect(
			rig.logs.some((l) => l.includes("stroke end on slide 0: reason=silent-lift"))
		).toBe(true);
		rig.deck.dispose();
	});

	it("ends the stroke after SILENT_LIFT_QUIET_MS of complete silence", async () => {
		setDiagnosticsEnabled(true);
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// The nib left the digitizer's range in the same motion, so there is
		// no hover sample either - only the clock knows.
		expect(rig.scheduled.length + rig.savedNow.length).toBe(0);
		clock.mockReturnValue(1000 + SILENT_LIFT_QUIET_MS + 1);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		const page = lastPage(rig);
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]!.points).toHaveLength(3);
		expect(
			rig.logs.some((l) => l.includes("stroke end on slide 0: reason=silent-lift"))
		).toBe(true);
		clock.mockRestore();
		rig.deck.dispose();
	});

	/**
	 * The negative control for the test above, and the reason it is worth
	 * anything: `runTimers` fires every pending timer whatever its delay, so a
	 * deadline that did not consult the clock would pass that test with the
	 * interval set to an hour. Here the deadline fires on a contact that was
	 * heard from 1 ms ago and must decline, re-arm, and leave the stroke live.
	 */
	it("does not end a stroke whose contact was heard from inside the window", async () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		clock.mockReturnValue(1000 + SILENT_LIFT_QUIET_MS - 1);
		rig.win.runTimers(SILENT_LIFT_QUIET_MS);
		expect(rig.scheduled.length + rig.savedNow.length).toBe(0);
		// Still the SAME stroke: one more move joins it rather than being
		// dropped by a session that had gone idle underneath.
		rig.move(340, 340);
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		const page = lastPage(rig);
		expect(page.strokes).toHaveLength(1);
		expect(page.strokes[0]!.points).toHaveLength(4);
		expect(rig.logs.some((l) => l.includes("reason=silent-lift"))).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("leaves a stroke that got its pointerup alone (no second commit)", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		const writes = rig.scheduled.length + rig.savedNow.length;
		expect(writes).toBe(1);
		// The pen goes on hovering over the deck afterwards, and the silence
		// deadline it armed at contact is gone rather than pending.
		rig.move(400, 400, { buttons: 0, pressure: 0 });
		rig.win.runTimers();
		expect(rig.scheduled.length + rig.savedNow.length).toBe(writes);
		expect(lastPage(rig).strokes).toHaveLength(1);
		rig.deck.dispose();
	});

	it("frees the surface: the next contact is a new stroke and a tap still navigates", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		rig.move(400, 400, { buttons: 0, pressure: 0 });
		// A commit is not a lift, so the guard takes its tail (the pen is off
		// the glass but the reader's hand is still over the deck).
		expect(rig.click().stopped).toBe(true);
		rig.win.runTimers(PEN_GUARD_TAIL_MS);
		expect(rig.click().stopped).toBe(false);
		// The reader writes again. This is what the stale session used to eat:
		// `onPointerDown` returns early while one is drawing, so the samples
		// joined the old stroke under the old nib.
		rig.down();
		rig.move(500, 500);
		rig.move(540, 540);
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		expect(lastPage(rig).strokes).toHaveLength(2);
		// And a tap after all that still reaches Reveal's arrow (A1/§3.3).
		rig.down();
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("ends an erase gesture the same way", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		// The stored stroke sits at deck-logical (1,1); screen (21,26) is
		// inside the eraser circle once the contact is promoted by a move.
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		rig.move(30, 26, { buttons: 32 });
		// The tail end leaves the glass with no pointerup.
		rig.move(40, 26, { buttons: 0, pressure: 0 });
		expect(lastPage(rig).strokes).toEqual([]);
		expect(
			rig.logs.some((l) => l.includes("erase end on slide 0: reason=silent-lift"))
		).toBe(true);
		rig.deck.dispose();
	});
});

describe("a slide change under a live stroke (the note surface's abandon rule)", () => {
	function lastPage(rig: Rig): PageData {
		const all = [...rig.scheduled, ...rig.savedNow];
		expect(all.length, "nothing was written").toBeGreaterThan(0);
		return all[all.length - 1]!.page;
	}

	/**
	 * The mounted layers, through the deck's private field: whether the WET
	 * canvas and the tail were cleared is the whole of half this rule, and
	 * there is no public reader for either.
	 */
	function layersOf(rig: Rig): {
		wet: { clear(w: number, h: number): void };
		tail: { clearAll(w: number, h: number): void };
		index: number;
	} {
		const l = (
			rig.deck as unknown as {
				layers: {
					wet: { clear(w: number, h: number): void };
					tail: { clearAll(w: number, h: number): void };
					index: number;
				} | null;
			}
		).layers;
		expect(l, "the deck never mounted").not.toBeNull();
		return l!;
	}

	/** The clicker, or the arrow key beside it: no pointer event at all. */
	function advance(rig: Rig, to: number): void {
		for (const s of rig.slides.children) s.classes.delete("present");
		rig.slides.children[to]!.classes.add("present");
		rig.reveal.dispatch({ type: "slidechanged" });
	}

	it("commits to the OLD slide, clears the live layers, and repaints the new one", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		const l = layersOf(rig);
		const wetClear = vi.spyOn(l.wet, "clear");
		const tailClear = vi.spyOn(l.tail, "clearAll");
		advance(rig, 1);
		const page = lastPage(rig);
		expect(page.strokes).toHaveLength(1);
		// `pageOfSlide(0)` - the slide it was drawn on, not the one now shown.
		expect(page.strokes[0]!.page).toBe(1);
		expect(page.strokes[0]!.points).toHaveLength(3);
		// Nothing half-drawn is left painted over the new slide.
		expect(wetClear).toHaveBeenCalled();
		expect(tailClear).toHaveBeenCalled();
		expect(l.index).toBe(1);
		expect(
			rig.logs.some((line) => line.includes("stroke end on slide 0: reason=slide-change"))
		).toBe(true);
		rig.deck.dispose();
	});

	it("adds nothing more from the contact that is still down, and starts nothing on the lift", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		advance(rig, 1);
		const writes = rig.scheduled.length + rig.savedNow.length;
		// The pen never left the glass; the reader is mid-letter.
		rig.move(340, 340);
		rig.move(380, 380);
		expect(rig.scheduled.length + rig.savedNow.length).toBe(writes);
		expect(lastPage(rig).strokes).toHaveLength(1);
		// The guard is still up, so the lift's own click cannot turn the page
		// a SECOND time - one slide past where the clicker asked to be.
		expect(rig.click().stopped).toBe(true);
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		expect(rig.click().stopped).toBe(true);
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(false);
		// And the lift committed nothing of its own.
		expect(lastPage(rig).strokes).toHaveLength(1);
		expect(lastPage(rig).strokes[0]!.page).toBe(1);
		rig.deck.dispose();
	});

	it("lets the next contact draw on the new slide, under the new index", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		advance(rig, 1);
		rig.end("pointerup", { buttons: 0, pressure: 0 });
		rig.win.runTimers(0);
		drawStrokeOn(rig);
		const pages = lastPage(rig).strokes.map((s) => s.page);
		// One on each, and the first one did NOT follow the index across.
		expect(pages).toEqual([1, 2]);
		rig.deck.dispose();
	});

	it("ends a live ERASE gesture the same way", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		rig.move(30, 26, { buttons: 32 });
		advance(rig, 1);
		expect(lastPage(rig).strokes).toEqual([]);
		expect(
			rig.logs.some((line) => line.includes("erase end on slide 0: reason=slide-change"))
		).toBe(true);
		// The scrub cannot follow the deck onto the next slide either.
		rig.move(40, 26, { buttons: 32 });
		expect(
			rig.logs.some((line) => line.includes("erase end on slide 1"))
		).toBe(false);
		rig.deck.dispose();
	});

	it("changes slide exactly as before when no stroke is live", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		const writes = rig.scheduled.length + rig.savedNow.length;
		advance(rig, 1);
		expect(rig.scheduled.length + rig.savedNow.length).toBe(writes);
		expect(rig.logs.some((line) => line.includes("reason=slide-change"))).toBe(false);
		expect(rig.logs.some((line) => line.includes("slide 1 now present"))).toBe(true);
		expect(layersOf(rig).index).toBe(1);
		rig.deck.dispose();
	});

	it("parks behind a claim in flight rather than writing past it", async () => {
		let release!: (r: { pageId: string }) => void;
		const claim = new Promise<{ pageId: string }>((res) => {
			release = res;
		});
		// A never-inked note: the first stroke claims the id, and the slide
		// change is what ends that first stroke.
		const rig = makeRig({ pageId: null, claim: () => claim });
		await new Promise((r) => setTimeout(r, 0));
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		advance(rig, 1);
		expect(rig.claims).toEqual(["Deck.md"]);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		release({ pageId: "note-1" });
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.id).toBe("note-1.slides");
		expect(rig.savedNow[0]!.page.strokes).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes[0]!.page).toBe(1);
		rig.deck.dispose();
	});
});

describe("the palm guard on the capture path (a palm cannot swipe mid-stroke)", () => {
	/**
	 * Dispatch one event at `.reveal` and report whether the guard swallowed
	 * it. `rig.move`/`rig.end` cannot answer this: they hand the surface's own
	 * pointer handlers a no-op `stopPropagation`, and what is under test here
	 * is the capture-phase guard listener, which is a different listener on the
	 * same element.
	 */
	function fire(rig: Rig, type: string, over: Partial<AnyEvent> = {}): boolean {
		const seen = { stopped: false };
		rig.reveal.dispatch({
			type,
			pointerId: 9,
			pointerType: "touch",
			isPrimary: false,
			buttons: 1,
			button: 0,
			clientX: 400,
			clientY: 400,
			pressure: 0.5,
			timeStamp: 1000,
			preventDefault: () => undefined,
			...over,
			stopPropagation: () => void (seen.stopped = true),
		});
		return seen.stopped;
	}

	it("swallows a touch pointermove while the pen is down", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		expect(fire(rig, "pointermove")).toBe(true);
		rig.deck.dispose();
	});

	it("swallows a touch pointerdown while the pen is down", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		expect(fire(rig, "pointerdown")).toBe(true);
		rig.deck.dispose();
	});

	it("lets a touch pointermove through with no pen down: a finger still swipes", () => {
		const rig = makeRig();
		expect(fire(rig, "pointermove")).toBe(false);
		expect(fire(rig, "pointerdown")).toBe(false);
		rig.deck.dispose();
	});

	it("swallows a touch pointermove for a contact that is still only a TAP", () => {
		const rig = makeRig();
		// Down and nothing else: unpromoted, `penStroke` false, and this is the
		// window the stroke-only guard had no answer for.
		rig.down();
		expect(fire(rig, "pointermove")).toBe(true);
		// And the tap is still a tap: its own click reaches the arrow.
		rig.end("pointerup", { buttons: 0 });
		rig.win.runTimers(0);
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("lets a MOUSE pointermove through while the pen is down", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		expect(fire(rig, "pointermove", { pointerType: "mouse" })).toBe(false);
		rig.deck.dispose();
	});

	it("never swallows a pen pointerdown, stroke live or not (S4)", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// The stroke is live; a second pen pointerdown must still bubble, or
		// Reveal's focus plugin never gets the deck focused again.
		expect(fire(rig, "pointerdown", { pointerType: "pen", isPrimary: true })).toBe(false);
		rig.deck.dispose();
	});

	/**
	 * RENAMED 2026-09-05, from "lets touch flow again once the pen has lifted
	 * and the guard's hold expired".
	 *
	 * The old name and the old body claimed touch flows again on the tick after
	 * the lift, and that claim was too wide: it was written about the
	 * NAVIGATION guard's 0 ms release (the `click` rule, which does drop on the
	 * next tick so a pen tap can still reach the arrow) and it silently pinned
	 * the PALM rule to the same instant. PalmGate holds new touches for
	 * RELEASE_TAIL_MS = 250 because the palm usually lingers - the nib leaves
	 * the glass first and the heel of the hand follows, and its moves on the
	 * way up are the ones that reach Reveal's swipe. So the tick-after
	 * assertion stays for the click and is replaced by the tail for touch.
	 */
	it("holds touch off for the release tail after a lift, then lets it flow again", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(1000);
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		expect(fire(rig, "pointermove")).toBe(true);
		rig.end("pointerup", { buttons: 0 });
		rig.win.runTimers(0);
		// The navigation guard is down - a pen tap's click reaches the arrow.
		expect(rig.click().stopped).toBe(false);
		// The palm rule is NOT: the hand is still coming off the glass.
		clock.mockReturnValue(1000 + PEN_RELEASE_TAIL_MS - 1);
		expect(fire(rig, "pointermove")).toBe(true);
		expect(fire(rig, "touchmove", { pointerType: undefined })).toBe(true);
		clock.mockReturnValue(1000 + PEN_RELEASE_TAIL_MS + 1);
		expect(fire(rig, "pointermove")).toBe(false);
		expect(fire(rig, "touchmove", { pointerType: undefined })).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("swallows the touch* three while the pen is down, pointerType or not", () => {
		const rig = makeRig();
		rig.down();
		for (const type of ["touchstart", "touchmove", "touchend"]) {
			expect(fire(rig, type, { pointerType: undefined })).toBe(true);
		}
		rig.deck.dispose();
	});

	// ---- the hover key ("palm placed before pen") --------------------------
	//
	// A hovering nib is never the active contact, so `onPointerMove` drops it
	// at `this.session.pointerId !== ev.pointerId`. The key is therefore fed
	// from the capture-phase guard listener, which sees the raw stream because
	// `pointermove` is in PEN_CONTACT_GUARDED_EVENTS.

	/** One hovering-pen sample at `.reveal`: pen pointermove, no buttons. */
	function hover(rig: Rig): void {
		fire(rig, "pointermove", { pointerType: "pen", isPrimary: true, buttons: 0, pointerId: 3 });
	}

	it("swallows a touch pointerdown while the pen merely HOVERS", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(5000);
		const rig = makeRig();
		// No contact of any kind yet - `penContact` is false throughout.
		expect(fire(rig, "pointerdown")).toBe(false);
		hover(rig);
		expect(fire(rig, "pointerdown")).toBe(true);
		expect(fire(rig, "pointermove")).toBe(true);
		expect(fire(rig, "touchstart", { pointerType: undefined })).toBe(true);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("never swallows a pen pointerdown while the pen hovers (S4)", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(5000);
		const rig = makeRig();
		hover(rig);
		// The hover key widened the PALM rule, not the pen/mouse promise: the
		// deck still gets the pointerdown that keeps its keyboard alive.
		expect(fire(rig, "pointerdown", { pointerType: "pen", isPrimary: true })).toBe(false);
		expect(fire(rig, "pointerdown", { pointerType: "mouse" })).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("expires the hover key after PEN_NEAR_TAIL_MS: a finger alone still swipes", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(5000);
		const rig = makeRig();
		hover(rig);
		clock.mockReturnValue(5000 + PEN_NEAR_TAIL_MS - 1);
		expect(fire(rig, "pointerdown")).toBe(true);
		clock.mockReturnValue(5000 + PEN_NEAR_TAIL_MS + 1);
		expect(fire(rig, "pointerdown")).toBe(false);
		expect(fire(rig, "pointermove")).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("does not take a pen pointermove WITH buttons down as a hover sample", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(5000);
		const rig = makeRig();
		// The nib is on the glass and owned by some other contact entirely;
		// that is the pen-down rule's business, not the hover key's.
		fire(rig, "pointermove", { pointerType: "pen", isPrimary: true, buttons: 1, pointerId: 3 });
		clock.mockReturnValue(5000 + PEN_NEAR_TAIL_MS + 1);
		expect(fire(rig, "pointerdown")).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});
});

describe("the palm shield on the deck (a hand on the glass with no pen in the room)", () => {
	/** Windows: `palmRadiusTrustworthy` is true, which is where this runs. */
	const WINDOWS = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32" };
	const IPAD = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", platform: "MacIntel", maxTouchPoints: 5 };

	function fireShape(
		rig: Rig,
		type: string,
		over: Partial<AnyEvent> & { width?: number; height?: number } = {}
	): boolean {
		const seen = { stopped: false };
		rig.reveal.dispatch({
			type,
			pointerId: 9,
			pointerType: "touch",
			isPrimary: false,
			buttons: 1,
			button: 0,
			clientX: 400,
			clientY: 400,
			pressure: 0.5,
			timeStamp: 1000,
			preventDefault: () => undefined,
			...over,
			stopPropagation: () => void (seen.stopped = true),
		} as AnyEvent);
		return seen.stopped;
	}

	it("swallows a palm-SHAPED touch pointerdown with no pen anywhere near", () => {
		const rig = makeRig({ navigator: WINDOWS });
		expect(fireShape(rig, "pointerdown", { width: PALM_CONTACT_SWALLOW_PX + 8, height: 20 })).toBe(
			true
		);
		expect(fireShape(rig, "pointermove", { width: 20, height: PALM_CONTACT_SWALLOW_PX })).toBe(true);
		rig.deck.dispose();
	});

	it("lets a FINGER-shaped touch through: Reveal's swipe is touch's own", () => {
		const rig = makeRig({ navigator: WINDOWS });
		expect(fireShape(rig, "pointerdown", { width: 8, height: 8 })).toBe(false);
		// No size information at all (the spec default) is judged by nothing.
		expect(fireShape(rig, "pointerdown", { width: 1, height: 1 })).toBe(false);
		expect(fireShape(rig, "pointerdown")).toBe(false);
		rig.deck.dispose();
	});

	it("never swallows a palm-sized PEN or MOUSE contact by shape (S4)", () => {
		const rig = makeRig({ navigator: WINDOWS });
		const big = { width: PALM_CONTACT_SWALLOW_PX + 8, height: PALM_CONTACT_SWALLOW_PX + 8 };
		expect(fireShape(rig, "pointerdown", { ...big, pointerType: "pen", isPrimary: true })).toBe(
			false
		);
		expect(fireShape(rig, "pointerdown", { ...big, pointerType: "mouse" })).toBe(false);
		rig.deck.dispose();
	});

	it("stays off where the radii are not calibrated (iPad) and where there is no navigator", () => {
		// The contact guard registers a touchstart listener of its own, but
		// only on a device that has seen a pen. Reset so the count below is
		// about the shield and not about whichever earlier test held one.
		resetPenToolsForTest();
		const big = { width: PALM_CONTACT_SWALLOW_PX + 8, height: PALM_CONTACT_SWALLOW_PX + 8 };
		const ipad = makeRig({ navigator: IPAD });
		expect(fireShape(ipad, "pointerdown", big)).toBe(false);
		expect(ipad.reveal.listeners.filter((l) => l.type === "touchstart")).toHaveLength(1);
		ipad.deck.dispose();
		// No navigator: the platform cannot be identified, so the shield is
		// inert rather than trigger-happy.
		const blind = makeRig();
		expect(fireShape(blind, "pointerdown", big)).toBe(false);
		blind.deck.dispose();
	});

	it("attaches PalmShield itself to `.reveal` for the touch* half", () => {
		// No pen seen, so the contact guard adds nothing here and this stays a
		// statement about the shield.
		resetPenToolsForTest();
		const rig = makeRig({ navigator: WINDOWS });
		// The surface's own guard registers one touchstart listener; the
		// shield is the second, and it is the one that can preventDefault the
		// `touchstart` Reveal's Controls bind on `.navigate-*`.
		expect(rig.reveal.listeners.filter((l) => l.type === "touchstart")).toHaveLength(2);
		let prevented = false;
		rig.reveal.dispatch({
			type: "touchstart",
			changedTouches: [{ identifier: 1, radiusX: 30, radiusY: 30 }],
			preventDefault: () => void (prevented = true),
			stopPropagation: () => undefined,
			stopImmediatePropagation: () => undefined,
		} as unknown as AnyEvent);
		expect(prevented).toBe(true);
		rig.deck.dispose();
		expect(rig.reveal.listeners.filter((l) => l.type === "touchstart")).toHaveLength(0);
	});
});

describe("native menus over a live deck (contextmenu)", () => {
	function fireMenu(rig: Rig, over: Partial<AnyEvent> = {}): { prevented: boolean; stopped: boolean } {
		const seen = { prevented: false, stopped: false };
		rig.reveal.dispatch({
			type: "contextmenu",
			pointerId: 9,
			pointerType: "mouse",
			isPrimary: true,
			buttons: 2,
			button: 2,
			clientX: 400,
			clientY: 400,
			pressure: 0,
			timeStamp: 1000,
			...over,
			preventDefault: () => void (seen.prevented = true),
			stopPropagation: () => void (seen.stopped = true),
		} as AnyEvent);
		return seen;
	}

	/** One hovering-pen sample at `.reveal`, which is what arms `penNear`. */
	function hover(rig: Rig): void {
		rig.reveal.dispatch({
			type: "pointermove",
			pointerId: 3,
			pointerType: "pen",
			isPrimary: true,
			buttons: 0,
			button: -1,
			clientX: 400,
			clientY: 400,
			pressure: 0,
			timeStamp: 1000,
			preventDefault: () => undefined,
			stopPropagation: () => undefined,
		} as AnyEvent);
	}

	it("suppresses a contextmenu raised during a live pen stroke", () => {
		const rig = makeRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		const seen = fireMenu(rig);
		// Both halves: preventDefault for the BROWSER's menu (a default action
		// stopPropagation cannot touch), stopPropagation for a menu some
		// listener below `.reveal` would raise.
		expect(seen.prevented).toBe(true);
		expect(seen.stopped).toBe(true);
		rig.deck.dispose();
	});

	it("suppresses the barrel-button menu Windows fires AFTER the pointerup", () => {
		const rig = makeRig();
		// A side-button contact inks on this surface, so this is the gesture
		// that stacked menus on the note surface's hardware report.
		rig.down({ buttons: 3 });
		rig.move(260, 260);
		rig.move(300, 300);
		rig.end("pointerup", { buttons: 0 });
		rig.win.runTimers(0);
		// Chromium >=115 delivers it as a pen-sourced PointerEvent.
		expect(fireMenu(rig, { pointerType: "pen" }).prevented).toBe(true);
		rig.deck.dispose();
	});

	it("suppresses a menu raised while the pen merely hovers, and stops when it leaves", () => {
		const clock = vi.spyOn(performance, "now");
		clock.mockReturnValue(7000);
		const rig = makeRig();
		hover(rig);
		// A finger planted to steady the writing hand long-presses into a
		// right-click; Chromium stamps that one pointerType "touch".
		expect(fireMenu(rig, { pointerType: "touch" }).prevented).toBe(true);
		clock.mockReturnValue(7000 + PEN_NEAR_TAIL_MS + 1);
		expect(fireMenu(rig, { pointerType: "touch" }).prevented).toBe(false);
		clock.mockRestore();
		rig.deck.dispose();
	});

	it("lets a MOUSE right-click through when no pen has been near", () => {
		const rig = makeRig();
		const seen = fireMenu(rig);
		expect(seen.prevented).toBe(false);
		expect(seen.stopped).toBe(false);
		rig.deck.dispose();
	});

	it("lets a plain touch long-press keep its menu with no pen in the session", () => {
		const rig = makeRig();
		expect(fireMenu(rig, { pointerType: "touch" }).prevented).toBe(false);
		rig.deck.dispose();
	});

	it("unbinds the listener on dispose", () => {
		const rig = makeRig();
		expect(rig.reveal.listeners.filter((l) => l.type === "contextmenu")).toHaveLength(1);
		rig.deck.dispose();
		expect(rig.reveal.listeners.filter((l) => l.type === "contextmenu")).toHaveLength(0);
	});
});

describe("A3: capture is taken at promotion, not at contact", () => {
	// Alan, mouse, 2026-09-05: "click on arrow does NOT turn page". A1 let the
	// click through, but `setPointerCapture` at pointerdown retargets the
	// pointerup to `.reveal`, so the browser builds the click from the common
	// ancestor of `.navigate-right` and `.reveal` - the deck, not the button -
	// and Reveal's Controls never see it.
	it("never captures a contact that lifts under both the slop and the clock", () => {
		const rig = makeRig();
		rig.down();
		expect(rig.reveal.captureCalls).toEqual([]);
		// Two pixels of jitter, well under TAP_SLOP_PX, well under TAP_MS.
		rig.move(202, 201);
		expect(rig.reveal.captureCalls).toEqual([]);
		rig.end("pointerup", { buttons: 0 });
		rig.win.runTimers(0);
		expect(rig.reveal.captureCalls).toEqual([]);
		// And the click it carries is still not swallowed.
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("captures exactly once, on the move that crosses the slop", () => {
		const rig = makeRig();
		rig.down();
		expect(rig.reveal.captureCalls).toEqual([]);
		// Still under the slop.
		rig.move(203, 202);
		expect(rig.reveal.captureCalls).toEqual([]);
		// Past it: this is the move that earns the capture.
		rig.move(260, 260);
		expect(rig.reveal.captureCalls).toEqual([1]);
		// Every later sample rides the same capture.
		rig.move(300, 300);
		rig.move(340, 340);
		expect(rig.reveal.captureCalls).toEqual([1]);
		rig.end("pointerup", { buttons: 0 });
		// Released at the commit, so the deck holds nothing after the lift.
		expect(rig.reveal.captured).toEqual([]);
		rig.deck.dispose();
	});

	it("captures a motionless contact held past TAP_MS - the deliberate dot", () => {
		const rig = makeRig();
		rig.down();
		expect(rig.reveal.captureCalls).toEqual([]);
		// Never moved; the clock alone promotes it, at the end of the contact.
		rig.end("pointerup", { buttons: 0, timeStamp: 10_000 });
		expect(rig.reveal.captureCalls).toEqual([1]);
		// It became ink, so the click riding behind the lift is swallowed
		// rather than turning the page. (The guard drops a tick later, which
		// is the tail the neighbouring describe pins.)
		expect(rig.click().stopped).toBe(true);
		rig.deck.dispose();
	});

	// Alan, Orion, pen, 2026-09-05: "wont let me exit presentation by clicking
	// the exit button with eraser on: nothing touched" - the eraser used to
	// capture and hit-test at pointerdown, which swallowed the close button's
	// click under a tap exactly the way the arrows used to eat a pen tap
	// before A1. It now takes the SAME promotion ink does (B1).
	it("(a) an eraser tap - down and up within TAP_MS, no move - touches nothing and its click passes through", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		// Same point as the stored stroke (deck-logical (1,1), k=0.5): if the
		// tap touched anything, this is exactly where it would.
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		expect(rig.reveal.captureCalls).toEqual([]);
		rig.end("pointerup", { buttons: 0, clientX: 21, clientY: 26 });
		expect(rig.reveal.captureCalls).toEqual([]);
		expect(rig.click().stopped).toBe(false);
		expect(
			rig.logs.some((l) =>
				l.includes("erase end on slide 0: reason=tap, samples=1, nothing touched (click passed through)")
			)
		).toBe(true);
		rig.deck.dispose();
		// Nothing was ever dirty, so teardown writes nothing at all.
		expect(rig.savedNow).toEqual([]);
	});

	it("(b) an eraser drag past the slop is promoted, captured, and erases what its path crosses", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		// Down well clear of the stored stroke; the drag crosses over it.
		rig.down({ buttons: 32, clientX: 5, clientY: 5 });
		expect(rig.reveal.captureCalls).toEqual([]);
		rig.move(21, 26, { buttons: 32 }); // past TAP_SLOP_PX, onto deck-logical (1,1)
		expect(rig.reveal.captureCalls).toEqual([1]);
		rig.end("pointerup", { buttons: 0 });
		// Captured, so the click riding behind the lift is swallowed too.
		expect(rig.click().stopped).toBe(true);
		rig.deck.dispose();
		expect(rig.savedNow[rig.savedNow.length - 1]!.page.strokes).toEqual([]);
	});

	it("(c) an eraser held past TAP_MS without moving is promoted at the clock and erases what is under it", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		expect(rig.reveal.captureCalls).toEqual([]);
		// Never moved; the clock alone promotes it, at the end of the contact -
		// same rule A3 already pins for a motionless ink dot, above.
		rig.end("pointerup", { buttons: 0, clientX: 21, clientY: 26, timeStamp: 999_999 });
		expect(rig.reveal.captureCalls).toEqual([1]);
		rig.deck.dispose();
		expect(rig.savedNow[rig.savedNow.length - 1]!.page.strokes).toEqual([]);
	});

	it("(d, unchanged) a pen-tip tap still passes its click through - the eraser fix does not touch this path", () => {
		const rig = makeRig();
		rig.down();
		rig.end("pointerup", { buttons: 0 });
		expect(rig.reveal.captureCalls).toEqual([]);
		expect(rig.click().stopped).toBe(false);
		rig.deck.dispose();
	});

	it("keeps S4 intact: pointerdown is preventDefaulted and never stopped", () => {
		const rig = makeRig();
		const seen = { prevented: false, stopped: false };
		rig.reveal.dispatch({
			type: "pointerdown",
			pointerId: 1,
			pointerType: "pen",
			isPrimary: true,
			buttons: 1,
			button: 0,
			clientX: 200,
			clientY: 200,
			pressure: 0.5,
			timeStamp: 1,
			preventDefault: () => void (seen.prevented = true),
			stopPropagation: () => void (seen.stopped = true),
		});
		expect(seen.prevented).toBe(true);
		// Reveal's focus plugin focuses the deck from this event; stopping it
		// costs the deck its keyboard (S4).
		expect(seen.stopped).toBe(false);
		rig.end("pointerup", { buttons: 0 });
		rig.deck.dispose();
	});
});

describe("two stored slides that share a hash (§3.6 never merges)", () => {
	const A = sectionHash("A");
	const B = sectionHash("B");

	it("moves only the nearest claimant onto the surviving section", () => {
		// Two identical slides were stored at 0 and 4; the deck now has one of
		// them, at index 3. Both used to be remapped onto 3 and their ink was
		// merged there.
		const stored = [
			{ index: 0, hash: A },
			{ index: 4, hash: A },
		];
		const current = [B, B, B, A];
		const moved = remapSlides(stored, current);
		expect(moved.get(4)).toBe(3);
		expect(moved.has(0)).toBe(false);
		// The one that did not move is KEPT, not lost - and its old index is
		// past the end of this deck, so it is invisible rather than misplaced.
		expect(keptSlides(stored, current, moved)).toEqual({ kept: 1, visible: 1 });
	});

	it("leaves a section that still holds its own stored slide alone", () => {
		// The slide at 1 matches where it is. Its twin at 0 must not be moved
		// on top of it.
		const stored = [
			{ index: 0, hash: A },
			{ index: 1, hash: A },
		];
		const current = [B, A];
		const moved = remapSlides(stored, current);
		expect(moved.size).toBe(0);
		expect(keptSlides(stored, current, moved)).toEqual({ kept: 1, visible: 1 });
	});

	it("breaks a tie at equal distance on the lower index, deterministically", () => {
		const stored = [
			{ index: 0, hash: A },
			{ index: 4, hash: A },
		];
		const current = [B, B, A];
		const moved = remapSlides(stored, current);
		expect(moved.get(0)).toBe(2);
		expect(moved.has(4)).toBe(false);
	});

	it("still moves a lone slide the whole way, which is the case that matters", () => {
		// One `---` added above the first slide: everything shifts by one.
		const stored = [{ index: 0, hash: A }];
		expect(remapSlides(stored, [B, A]).get(0)).toBe(1);
	});

	it("keeps the strokes of the unplaced twin on their old page number", () => {
		const stored = [
			{ index: 0, hash: A },
			{ index: 4, hash: A },
		];
		const current = [B, B, B, A];
		const strokes: InkStroke[] = [
			{
				id: "a",
				tool: "pen",
				color: "#000",
				width: 2,
				page: 1,
				points: [],
				bbox: { x: 0, y: 0, width: 0, height: 0 },
				createdAt: 0,
			},
			{
				id: "b",
				tool: "pen",
				color: "#000",
				width: 2,
				page: 5,
				points: [],
				bbox: { x: 0, y: 0, width: 0, height: 0 },
				createdAt: 0,
			},
		];
		expect(remapStrokes(strokes, remapSlides(stored, current))).toBe(1);
		expect(strokes[0]!.page).toBe(1);
		expect(strokes[1]!.page).toBe(4);
	});
});

describe("the surface leaves no trace on reveal's own element", () => {
	/**
	 * THE DECK NEVER TAKES `touch-action` NOW. Alan, 2026-09-08: "it must work
	 * seamlessly" - so the surface leaves the deck's gestures alone and
	 * decides per contact instead. What it still restores is the position
	 * patch, which is unrelated to the guard.
	 */
	it("never touches touch-action or the guard class, and restores position on dispose", () => {
		resetPenToolsForTest();
		const rig = makeRig();
		// The rig's getComputedStyle answers "static", so the defensive patch
		// fires and there is something to restore.
		expect(rig.reveal.style.position).toBe("relative");
		// The deck keeps every native gesture: nothing is armed, ever.
		expect(rig.reveal.style.touchAction).toBe("");
		expect(rig.reveal.classes.has(GUARD_SUBTREE_CLASS)).toBe(false);
		rig.deck.dispose();
		expect(rig.reveal.style.position).toBe("");
	});

	/**
	 * A device that has never seen a pen must not pay the blocking listener at
	 * all - that is the whole named cost of this route, and this is where it
	 * is held to zero rather than merely made cheap.
	 */
	it("registers no touchstart listener of its own until a pen has been seen", () => {
		resetPenToolsForTest();
		const rig = makeRig();
		const before = rig.reveal.listeners.filter((l) => l.type === "touchstart").length;

		rig.down({ pointerType: "pen", isPrimary: true });

		const after = rig.reveal.listeners.filter((l) => l.type === "touchstart").length;
		expect(after).toBe(before + 1);
		rig.deck.dispose();
		// And it comes off again: the surface leaves no trace.
		expect(rig.reveal.listeners.filter((l) => l.type === "touchstart")).toHaveLength(0);
	});

	/**
	 * THE DECISION ITSELF. `pointerdown` fires before the same contact's
	 * `touchstart`, so the handler already knows what landed.
	 */
	it("prevents a pen's touchstart and leaves a finger's alone", () => {
		resetPenToolsForTest();
		const rig = makeRig();
		rig.down({ pointerType: "pen", isPrimary: true });

		const fire = (): boolean => {
			let prevented = false;
			rig.reveal.dispatch({
				type: "touchstart",
				changedTouches: [{ identifier: 1, radiusX: 2, radiusY: 2 }],
				preventDefault: () => void (prevented = true),
				stopPropagation: () => undefined,
				stopImmediatePropagation: () => undefined,
			} as unknown as AnyEvent);
			return prevented;
		};

		// The pen's pointerdown above is still the most recent one.
		expect(fire()).toBe(true);

		// A finger lands: its own pointerdown re-answers the question.
		rig.down({ pointerType: "touch", isPrimary: true });
		expect(fire()).toBe(false);

		rig.deck.dispose();
	});

	it("puts back whatever position was already there, not a blank", () => {
		const rig = makeRig({ revealPosition: "absolute" });
		expect(rig.reveal.style.position).toBe("relative");
		rig.deck.dispose();
		expect(rig.reveal.style.position).toBe("absolute");
	});
});

/**
 * The wet layer's `desynchronized` request regressed once already (a bare
 * `true`, copied from before InkOverlay's own A/B ruled it out on this class
 * of machine - see `SLIDES_DESYNCHRONIZED`'s doc comment). One test pins the
 * source so a future edit cannot reintroduce the bare literal even if it
 * leaves the constant's value alone; the other pins the constructed renderer
 * and the mount log that reports what Chromium actually granted.
 */
describe("the wet layer asks for a plain (non-desynchronized) canvas", () => {
	it("is built from SLIDES_DESYNCHRONIZED, never a bare `true`", () => {
		expect(SLIDES_DESYNCHRONIZED).toBe(false);
		const src = surfaceSrc.replace(/\r\n/g, "\n");
		expect(src).toMatch(/new WetInkRenderer\(wetCanvas, SLIDES_DESYNCHRONIZED\)/);
		expect(src).not.toMatch(/new WetInkRenderer\(wetCanvas,\s*true\s*\)/);
	});

	it("mounts with the requested state and reports it on the mount log line", () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		const l = (
			rig.deck as unknown as {
				layers: { wet: { requested: boolean; actualDesynchronized: boolean | undefined } } | null;
			}
		).layers;
		if (!l) throw new Error("no layers mounted; the assertion below would be vacuous");
		expect(l.wet.requested).toBe(false);
		const mountLine = rig.logs.find((line) => line.includes("mount: three canvases"));
		expect(mountLine).toBeDefined();
		expect(mountLine).toContain(`wet desynchronized: requested ${l.wet.requested}`);
		expect(mountLine).toContain(`actual ${l.wet.actualDesynchronized}`);
	});
});

/**
 * Alan, mouse-only, twice, no console: the caret blinking in the note ate the
 * RIGHT ARROW before a first stroke was ever drawn. Obsidian's presenter sets
 * Reveal's own `focused` flag with a synthetic `pointerdown`, but never moves
 * DOM focus off the editor, and `.reveal` carries no tabindex of its own -
 * so the existing pointerdown-time `ensureDeckFocused()` call was a silent
 * no-op the whole time. These cover the mount-time and stroke-end recovery
 * added to close that gap, and the tabindex patch both of them depend on.
 */
describe("the deck takes the keyboard even when a note's caret never let go (Alan, mouse-only)", () => {
	/** A CodeMirror-shaped element: what is actually focused in the note. */
	function makeEditor(rig: Rig): FakeEl {
		const editor = new FakeEl("div", rig.doc);
		editor.className = "cm-content";
		editor.isContentEditable = true;
		return editor;
	}

	/** `ensureDeckFocused` is private; called directly to isolate it from pointerdown. */
	function callEnsureDeckFocused(rig: Rig): void {
		(rig.deck as unknown as { ensureDeckFocused: () => void }).ensureDeckFocused();
	}

	it("(a) grabs focus from a contentEditable left focused when the deck mounts", () => {
		const rig = makeRig();
		const editor = makeEditor(rig);
		rig.doc.activeElement = editor;
		// The mount-time grab is scheduled at 0ms from the end of the constructor.
		rig.win.runTimers();
		expect(rig.doc.activeElement).toBe(rig.reveal);
		expect(rig.reveal.tabIndex).toBe(-1);
	});

	it("(b) leaves an existing tabindex on .reveal alone", () => {
		const rig = makeRig({ revealTabIndex: 0 });
		expect(rig.reveal.tabIndex).toBe(0);
		expect(rig.reveal.getAttribute("tabindex")).toBe("0");
	});

	it("(c) does nothing when focus is already inside .reveal", () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		rig.doc.activeElement = rig.reveal;
		callEnsureDeckFocused(rig);
		expect(rig.doc.activeElement).toBe(rig.reveal);
		expect(rig.logs.some((l) => l.includes("deck took focus"))).toBe(false);
	});

	it("(d) still blurs a stuck contentEditable when .reveal cannot take focus itself", () => {
		const rig = makeRig();
		// An unfocusable element, the case the tabindex patch exists to close:
		// `.focus()` runs and does nothing.
		rig.reveal.focus = () => undefined;
		const editor = makeEditor(rig);
		rig.doc.activeElement = editor;
		callEnsureDeckFocused(rig);
		expect(rig.doc.activeElement).toBeNull();
	});

	it("(e) logs the tabindex patch once", () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		const hits = rig.logs.filter((l) => l.includes("reveal element had no tabindex; patched to -1"));
		expect(hits).toHaveLength(1);
	});

	it("(f) a full stroke still ends with focus on .reveal, caret in the note before the down", () => {
		const rig = makeRig();
		const editor = makeEditor(rig);
		rig.doc.activeElement = editor;
		drawStrokeOn(rig);
		rig.win.runTimers();
		expect(rig.doc.activeElement).toBe(rig.reveal);
	});

	it("(g) logs active/insideDeck/revealFocused at stroke end", () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		drawStrokeOn(rig);
		const line = rig.logs.find((l) => l.includes("focus at stroke end:"));
		expect(line).toBeDefined();
		expect(line).toContain("active=");
		expect(line).toContain("insideDeck=");
		expect(line).toContain("revealFocused=");
	});
});

/**
 * The deck's theme, which is NOT the workspace's (auditor, 2026-09-05).
 *
 * Obsidian picks the presenter's stylesheet from the Appearance config value -
 * white.css only when it is literally "moonstone" - so "adapt to system" on a
 * light-mode OS presents a black deck with no `theme-dark` on the body. Ink
 * follows the body class, so it resolved as light-theme ink and painted black
 * on black. Every rig here therefore leaves the body light, which is the
 * combination that was broken.
 */
describe("the deck's theme is measured, not inherited from the workspace", () => {
	beforeEach(() => setDiagnosticsEnabled(true));

	/** How many times the surface announced a deck theme. */
	const themeLines = (rig: Rig): string[] => rig.logs.filter((l) => l.includes("deck theme:"));

	it("reads a black deck off its own paint, with the body still light", () => {
		const rig = makeRig({ deckBackground: "rgb(25, 25, 25)" });
		expect(inkThemeOverride()).toBe(true);
		expect(themeLines(rig)).toEqual(["[slides] deck theme: dark (measured)"]);
		rig.deck.dispose();
		expect(inkThemeOverride()).toBeNull();
	});

	it("reads a white deck the same way, and does not override it dark", () => {
		const rig = makeRig({ deckBackground: "rgb(255, 255, 255)" });
		expect(inkThemeOverride()).toBe(false);
		expect(themeLines(rig)).toEqual(["[slides] deck theme: light (measured)"]);
		rig.deck.dispose();
		expect(inkThemeOverride()).toBeNull();
	});

	it("falls back to the presenter's stylesheet when the paint cannot be read", () => {
		// `.reveal` with no background of its own: Reveal 4 paints the viewport
		// around it, and `transparent` computes to a black nobody can see.
		const rig = makeRig({ deckBackground: "rgba(0, 0, 0, 0)", deckStylesheet: "black" });
		expect(inkThemeOverride()).toBe(true);
		expect(themeLines(rig)).toEqual(["[slides] deck theme: dark (link)"]);
		rig.deck.dispose();
		expect(inkThemeOverride()).toBeNull();
	});

	it("does not read transparent as black: white.css over an unreadable paint is light", () => {
		const rig = makeRig({ deckBackground: "rgba(0, 0, 0, 0)", deckStylesheet: "white" });
		expect(inkThemeOverride()).toBe(false);
		expect(themeLines(rig)).toEqual(["[slides] deck theme: light (link)"]);
		rig.deck.dispose();
	});

	it("falls back again to the body when there is neither a paint nor a link", () => {
		const dark = makeRig({ bodyDark: true });
		expect(inkThemeOverride()).toBe(true);
		expect(themeLines(dark)).toEqual(["[slides] deck theme: dark (body)"]);
		dark.deck.dispose();

		// The log is file-level, so the second deck starts from a clean sheet.
		dark.logs.length = 0;
		const light = makeRig({ bodyDark: false });
		expect(inkThemeOverride()).toBe(false);
		expect(themeLines(light)).toEqual(["[slides] deck theme: light (body)"]);
		light.deck.dispose();
		expect(inkThemeOverride()).toBeNull();
	});

	it("measures once per deck, not once per repaint or slide", async () => {
		const rig = makeRig({ deckBackground: "rgb(25, 25, 25)" });
		await new Promise((r) => setTimeout(r, 0));
		// The two rAF remounts, a slide change and a whole stroke: every path
		// that repaints, and none of them may measure again.
		rig.win.runFrames();
		rig.win.runFrames();
		rig.slides.children[0]!.classes.delete("present");
		rig.slides.children[1]!.classes.add("present");
		rig.reveal.dispatch({ type: "slidechanged" });
		drawStrokeOn(rig);
		expect(themeLines(rig)).toHaveLength(1);
		rig.deck.dispose();
	});

	it("says nothing, and overrides nothing, for a deck reveal has not marked yet", () => {
		// No `present` section, so no canvases and no measurement. A surface
		// that guessed here would theme the workspace behind a deck that is not
		// on the screen yet.
		const rig = makeRig({ sections: 0, deckBackground: "rgb(25, 25, 25)" });
		expect(themeLines(rig)).toEqual([]);
		expect(inkThemeOverride()).toBeNull();
		rig.deck.dispose();
		expect(inkThemeOverride()).toBeNull();
	});
});

/**
 * The mounted wet layer, reached through the deck's private `layers` because
 * the shaping flag is the whole point of the assertion and there is no public
 * reader for it. A deck that never mounted throws rather than answering a
 * default, which would let the assertion pass on a surface that drew nothing.
 */
function wetLayerOf(rig: Rig): { shape: boolean } {
	const l = (rig.deck as unknown as { layers: { wet: { shape: boolean } } | null }).layers;
	if (!l) throw new Error("no layers mounted; the shaping assertion would be vacuous");
	return l.wet;
}

describe("live shaping follows the device, per stroke (mouse ink draws flat)", () => {
	afterEach(() => setMouseInk(false));

	it("leaves the wet layer unshaped for a MOUSE stroke, the way it will commit", () => {
		// The committed renderer already draws a `device: "mouse"` stroke flat
		// (StrokeRenderer.drawStroke), and the slides builder writes that tag,
		// so a shaped wet layer meant the live stroke thinned with velocity
		// and tapered at the start and then snapped flat at pen-up.
		setMouseInk(true);
		const rig = makeRig();
		expect(wetLayerOf(rig).shape).toBe(true); // mount's default, before any contact
		rig.down({ pointerType: "mouse" });
		expect(wetLayerOf(rig).shape).toBe(false);
	});

	it("keeps the shaped width law for a PEN stroke, even after a mouse one", () => {
		// Per stroke, not once at mount: a pen contact after a mouse contact
		// has to shape again, which is the half a mount-time flag cannot do.
		setMouseInk(true);
		const rig = makeRig();
		rig.down({ pointerType: "mouse" });
		expect(wetLayerOf(rig).shape).toBe(false);
		rig.end("pointerup", { pointerType: "mouse" });
		rig.down({ pointerType: "pen" });
		expect(wetLayerOf(rig).shape).toBe(true);
	});

	it("shapes a plain pen stroke on a deck that never saw a mouse", () => {
		const rig = makeRig();
		rig.down({ pointerType: "pen" });
		expect(wetLayerOf(rig).shape).toBe(true);
	});

	it("sets the flag BEFORE beginStroke, which is where the renderer latches it", () => {
		// `WetInkRenderer.beginStroke` reads `this.shape` into
		// `shapingThisStroke` and never looks at it again for that stroke, so
		// an assignment after the call would be a whole stroke too late.
		const down = slice("const fromMouse = ev.pointerType === \"mouse\";", "\n\t}\n");
		expect(down).toContain("l.wet.shape = !fromMouse;");
		expect(down.indexOf("l.wet.shape = !fromMouse;")).toBeLessThan(
			down.indexOf("l.wet.beginStroke(")
		);
	});
});

/** The strokes the deck currently holds for one slide, in order. */
function strokesOn(rig: Rig, index: number): InkStroke[] {
	const map = (rig.deck as unknown as { strokes: Map<number, InkStroke[]> }).strokes;
	return map.get(index) ?? [];
}

describe("partial erase follows the note surface's eraser setting (item 3b)", () => {
	/** Fresh, predictable ids, so "the survivors are new strokes" is checkable. */
	function ids(): () => string {
		let n = 0;
		return () => `cut-${n++}`;
	}

	function line(id: string, page: number): InkStroke {
		const points = [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 50, y: 0, pressure: 0.5, t: 10 },
			{ x: 100, y: 0, pressure: 0.5, t: 20 },
		];
		return {
			id,
			tool: "pen",
			color: "#000",
			width: 2,
			page,
			points,
			bbox: { x: -4, y: -4, width: 108, height: 8 },
			createdAt: 0,
		};
	}

	it("cuts a crossed stroke into fresh-id survivors that keep the slide", () => {
		const s = line("orig", 3);
		const out = partialEraseInSlide([s], ["orig"], { x: 50, y: 0, r: 10 }, ids());
		expect(out.touched).toBe(1);
		expect(out.strokes.length).toBeGreaterThan(1);
		// The original is gone, and no piece reuses its id.
		expect(out.strokes.some((p) => p.id === "orig")).toBe(false);
		expect(new Set(out.strokes.map((p) => p.id)).size).toBe(out.strokes.length);
		// Its slide travels with every piece - a survivor on the wrong page
		// would reappear on somebody else's slide at the next load.
		for (const p of out.strokes) expect(p.page).toBe(3);
	});

	it("puts the survivors back AT THE SAME INDEX, which is what holds z-order", () => {
		const before = line("before", 1);
		const cut = line("cut", 1);
		const after = line("after", 1);
		const out = partialEraseInSlide([before, cut, after], ["cut"], { x: 50, y: 0, r: 10 }, ids());
		expect(out.strokes[0]).toBe(before);
		expect(out.strokes[out.strokes.length - 1]).toBe(after);
		// Everything between the two untouched strokes is the replacement.
		expect(out.strokes.slice(1, -1).every((p) => p.id.startsWith("cut-"))).toBe(true);
	});

	it("puts back the SAME OBJECT when the bbox was hit but the line never was", () => {
		// `strokesHitByCircle` is a coarse gate. A stroke it reports that the
		// ring did not actually cross must come back untouched and uncounted,
		// or an eraser pass NEAR ink would repaint and persist a save for ink
		// nobody altered.
		const s = line("orig", 2);
		const out = partialEraseInSlide([s], ["orig"], { x: 50, y: 40, r: 10 }, ids());
		expect(out.touched).toBe(0);
		expect(out.strokes).toHaveLength(1);
		expect(out.strokes[0]).toBe(s);
	});

	it("takes the whole stroke when the circle swallows it, leaving nothing", () => {
		const s = line("orig", 1);
		const out = partialEraseInSlide([s], ["orig"], { x: 50, y: 0, r: 500 }, ids());
		expect(out.touched).toBe(1);
		expect(out.strokes).toEqual([]);
	});

	it("cuts with the SAME ring the hit test used, radius scaled by k", () => {
		// The deck rect the rig uses: k = 0.5, so a 12px eraser is 24 logical
		// units, and the centre is the tip's own mapping.
		const c = slideEraseCircle(260, 260, { left: 20, top: 25, width: 480, height: 350 }, 960, 12);
		expect(c).toEqual({ x: 480, y: 470, r: 24 });
	});

	it("on the deck, a partial setting cuts the stroke instead of removing it", () => {
		const rig = makeRig({ eraseWhole: false });
		drawStrokeOn(rig);
		const drawn = strokesOn(rig, 0);
		expect(drawn).toHaveLength(1);
		const original = drawn[0]!;
		// The eraser tail, over the middle sample of that stroke, held past
		// TAP_MS without moving: B1's promotion by the clock (§3.3), same
		// point at both ends of the contact so the hit test lands mid-line.
		rig.down({ buttons: 32, clientX: 260, clientY: 260 });
		rig.end("pointerup", { buttons: 0, clientX: 260, clientY: 260, timeStamp: 999_999 });
		const after = strokesOn(rig, 0);
		expect(after.length).toBeGreaterThan(1);
		expect(after.some((s) => s.id === original.id)).toBe(false);
		expect(after.every((s) => s.page === original.page)).toBe(true);
		rig.deck.dispose();
	});

	it("on the deck, the whole-stroke setting still removes the stroke outright", () => {
		const rig = makeRig(); // the plugin's default: whole strokes
		drawStrokeOn(rig);
		expect(strokesOn(rig, 0)).toHaveLength(1);
		rig.down({ buttons: 32, clientX: 260, clientY: 260 });
		rig.end("pointerup", { buttons: 0 });
		expect(strokesOn(rig, 0)).toHaveLength(0);
		rig.deck.dispose();
	});

	it("actually READS the host member rather than assuming a default", () => {
		// A surface that hard-coded whole-stroke would pass the test above and
		// fail every reader who set the eraser to partial.
		const rig = makeRig({ eraseWhole: false });
		drawStrokeOn(rig);
		expect(rig.wholeReads()).toBe(0); // nothing asked before a promoted erase
		rig.down({ buttons: 32, clientX: 260, clientY: 260 });
		// Still nothing asked: B1 defers the hit test to promotion, same as
		// the tip defers ink to it.
		expect(rig.wholeReads()).toBe(0);
		rig.end("pointerup", { buttons: 0, clientX: 260, clientY: 260, timeStamp: 999_999 });
		expect(rig.wholeReads()).toBeGreaterThan(0);
		rig.deck.dispose();
	});
});

/**
 * The mounted layers, reached through the deck's private field: the tail is a
 * rendering layer with no public reader, and a deck that never mounted throws
 * rather than answering a default, which would let these assertions pass on a
 * surface that drew nothing.
 */
function layersOf(rig: Rig): {
	committed: FakeEl;
	wetCanvas: FakeEl;
	tailCanvas: FakeEl;
	tail: TailRenderer;
} {
	const l = (
		rig.deck as unknown as {
			layers: {
				committed: FakeEl;
				wetCanvas: FakeEl;
				tailCanvas: FakeEl;
				tail: TailRenderer;
			} | null;
		}
	).layers;
	if (!l) throw new Error("no layers mounted; the head assertions would be vacuous");
	return l;
}

/** Deck-logical coordinates for a screen point, at the rig's k=0.5 deck. */
function logical(rig: Rig, x: number, y: number): { x: number; y: number } {
	return mapScreenToSlide(x, y, rig.slides.rect, rig.slides.clientWidth);
}

describe("the live head (Alan, mouse: the commit sprayed backwards out of the pen)", () => {
	// The wet layer paints nothing until a segment settles, and `flattenSegment`
	// excludes a segment's start, so the first thing on the wet canvas is a disc
	// at mid(p0, p1) - while the committed ribbon starts at p0 with a round cap.
	// The difference is |p1 - p0| / 2: sub-pixel for a pen, a whole frame of
	// hand travel for a mouse. `WetInkRenderer`'s header says the caller draws
	// the head; the note surface and the page view do, and this one did not.

	it("mounts a third canvas for the head, above the wet layer and below reveal's controls", () => {
		const rig = makeRig();
		const l = layersOf(rig);
		expect(l.tailCanvas.className).toBe("handwriting-slides-tail");
		expect(l.tailCanvas.style.zIndex).toBe("22");
		expect(Number(l.tailCanvas.style.zIndex)).toBeGreaterThan(
			Number(l.wetCanvas.style.zIndex)
		);
		// Routing, not an optimisation: input is claimed on `.reveal`, never on
		// a canvas (the rule the other two canvases are mounted under).
		expect(l.tailCanvas.style.pointerEvents).toBe("none");
		expect(rig.reveal.children).toContain(l.tailCanvas);
		rig.deck.dispose();
	});

	it("sizes and scales the head canvas exactly like the wet one", () => {
		const rig = makeRig();
		const l = layersOf(rig);
		const wet = l.wetCanvas as unknown as { width: number; height: number };
		const tail = l.tailCanvas as unknown as { width: number; height: number };
		// A head canvas left at 0x0, or at the wrong backing scale, draws the
		// stub in the wrong place or not at all.
		expect(tail.width).toBe(wet.width);
		expect(tail.height).toBe(wet.height);
		expect(tail.width).toBeGreaterThan(0);
		expect(l.tailCanvas.style.width).toBe(l.wetCanvas.style.width);
		expect(l.tailCanvas.style.height).toBe(l.wetCanvas.style.height);
		rig.deck.dispose();
	});

	it("puts the contact point on screen at pointerdown, from == to == p0", () => {
		const rig = makeRig();
		const spy = vi.spyOn(TailRenderer.prototype, "drawHead");
		rig.down({ clientX: 200, clientY: 200 });
		expect(spy).toHaveBeenCalledTimes(1);
		const [, , from, to] = spy.mock.calls[0]!;
		const p0 = logical(rig, 200, 200);
		expect(from).toEqual(p0);
		expect(to).toEqual(p0);
		rig.deck.dispose();
	});

	it("redraws the head out to the newest sample on every move", () => {
		const rig = makeRig();
		const spy = vi.spyOn(TailRenderer.prototype, "drawHead");
		rig.down({ clientX: 200, clientY: 200 });
		spy.mockClear();
		rig.move(260, 260);
		expect(spy).toHaveBeenCalledTimes(1);
		const to = spy.mock.calls[0]![3];
		// The whole point of the head: the drawn geometry reaches the newest
		// sample, not the settled midpoint half a sample behind it.
		expect(to).toEqual(logical(rig, 260, 260));
		rig.deck.dispose();
	});

	it("clears the head at lift, and draws none after it", () => {
		const rig = makeRig();
		const clear = vi.spyOn(TailRenderer.prototype, "clearAll");
		const spy = vi.spyOn(TailRenderer.prototype, "drawHead");
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		rig.end("pointerup");
		expect(clear).toHaveBeenCalled();
		const drawn = spy.mock.calls.length;
		// A head that outlived its stroke would sit on the deck until the next
		// one happened to paint over it.
		rig.end("pointerup");
		expect(spy.mock.calls).toHaveLength(drawn);
		rig.deck.dispose();
	});

	it("clears the head at lift for a MOUSE stroke too", () => {
		setMouseInk(true);
		const rig = makeRig();
		const clear = vi.spyOn(TailRenderer.prototype, "clearAll");
		rig.down({ pointerType: "mouse" });
		expect(wetLayerOf(rig).shape).toBe(false); // flat, as it will commit
		rig.move(260, 260, { pointerType: "mouse" });
		rig.end("pointerup", { pointerType: "mouse" });
		expect(clear).toHaveBeenCalled();
		rig.deck.dispose();
		setMouseInk(false);
	});

	it("takes the head canvas down with the other two", () => {
		const rig = makeRig();
		const l = layersOf(rig);
		const removed = vi.spyOn(l.tailCanvas, "remove");
		const wetRemoved = vi.spyOn(l.wetCanvas, "remove");
		rig.deck.dispose();
		expect(removed).toHaveBeenCalled();
		expect(wetRemoved).toHaveBeenCalled();
	});
});

describe("teardown skips the write when nothing changed", () => {
	it("writes nothing for a presented note with a page id but no sidecar, when nothing was drawn", async () => {
		// Default rig: readPageId returns "note-1" (the note carries an id),
		// loadSidecar resolves to null (no sidecar file exists yet). Exactly
		// the "presented, never inked this session" case that used to leave a
		// phantom `.slides.json` behind on a bare Escape.
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
		expect(rig.logs.join("\n")).toContain(
			"teardown: 0 slide(s) inked, 0 stroke(s), nothing changed, no write"
		);
	});

	it("writes nothing when a loaded sidecar is never touched", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
	});

	it("flushes exactly once, with the stroke, when ink was actually drawn", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes).toHaveLength(1);
	});

	it("keeps an erasure: a stroke erased to nothing still writes the empty page", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		// Same contact point as the "flushes an erase gesture that never
		// lifted" test above: screen (21, 26) sits on the stored stroke at
		// deck-logical (1,1), k=0.5. This time the gesture lifts cleanly
		// before teardown, so the persisted-at-lift path (not the forced
		// mid-gesture commit in `dispose`) is what marks the deck dirty. The
		// move past the slop promotes the contact (B1) and its retroactive
		// hit test at the down point is what takes the stored stroke.
		rig.down({ buttons: 32, clientX: 21, clientY: 26 });
		rig.move(30, 26, { buttons: 32 });
		rig.end("pointerup", { buttons: 0 });
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes).toEqual([]);
	});

	it("flushes once when a stroke landed inside the load window and the load then finished", async () => {
		let release!: (r: ParseResult) => void;
		const pending = new Promise<ParseResult>((res) => {
			release = res;
		});
		const rig = makeRig({ load: () => pending });
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		release(storedPage("note-1.slides", "stored-1"));
		await new Promise((r) => setTimeout(r, 0));
		// The deferred write from the load window went to `scheduled`, not
		// `saveSidecarNow` (a normal debounced save, not the claim's first
		// write) - it is teardown's own flush that should call it, once.
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(1);
		const page = rig.savedNow[0]!.page;
		expect(page.strokes.map((s) => s.id)).toContain("stored-1");
		expect(page.strokes).toHaveLength(2);
	});
});

describe("the remap's own result is what the next load must see (§3.6, stale hashes)", () => {
	it("persists once when a slide was inserted above: strokes remapped, hashes refreshed, dispose flushes them", async () => {
		// Stored against a 2-slide deck that has since had a slide inserted at
		// the top: what was slide 0 and 1 are now slide 1 and 2.
		const load = async (): Promise<ParseResult> => ({
			data: {
				...emptyPage("note-1.slides"),
				surface: "slides",
				coordSpace: "slide-logical",
				slides: [
					{ index: 0, hash: sectionHash("slide 1") },
					{ index: 1, hash: sectionHash("slide 2") },
				],
				strokes: [
					{
						id: "stored-1",
						tool: "pen",
						color: "#000",
						width: 2,
						page: 1,
						points: [{ x: 1, y: 1, pressure: 0.5, t: 0 }],
						bbox: { x: 1, y: 1, width: 0, height: 0 },
						createdAt: 0,
					},
				],
			},
			recovered: false,
		});
		const rig = makeRig({ sections: 3, load });
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.scheduled).toHaveLength(1);
		const page = rig.scheduled[0]!.page;
		expect(page.strokes.map((s) => s.page)).toEqual([2]);
		expect(page.slides).toEqual([
			{ index: 0, hash: sectionHash("slide 0") },
			{ index: 1, hash: sectionHash("slide 1") },
			{ index: 2, hash: sectionHash("slide 2") },
		]);
		expect(rig.logs.join("\n")).toContain("remap persisted: 1 stroke(s) moved, 3 hash(es) changed");
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(1);
	});

	it("schedules nothing when the stored hashes still match and nothing moved", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.scheduled).toEqual([]);
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
	});

	it("persists once when a hash changed but no stroke moved - the hash list is still the remap's next input", async () => {
		const load = async (): Promise<ParseResult> => ({
			data: {
				...emptyPage("note-1.slides"),
				surface: "slides",
				coordSpace: "slide-logical",
				slides: [
					{ index: 0, hash: sectionHash("slide 0") },
					{ index: 1, hash: sectionHash("old slide 1") },
				],
				strokes: [],
			},
			recovered: false,
		});
		const rig = makeRig({ load });
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.scheduled).toHaveLength(1);
		expect(rig.logs.join("\n")).toContain("remap persisted: 0 stroke(s) moved, 1 hash(es) changed");
		rig.deck.dispose();
		expect(rig.savedNow).toHaveLength(1);
	});
});

/** A stored sidecar holding one stroke per id, all on slide 0 (1-based page 1). */
function storedPageWith(id: string, strokeIds: string[]): ParseResult {
	const one = storedPage(id, "x");
	return {
		...one,
		data: {
			...one.data,
			strokes: strokeIds.map((strokeId, i) => ({
				...one.data.strokes[0]!,
				id: strokeId,
				points: [{ x: 1 + i, y: 1, pressure: 0.5, t: 0 }],
			})),
		},
	};
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("a sidecar from a newer build: read-only, not invisible (InlineInkStore's rule)", () => {
	it("renders the stored ink and schedules no write at all", async () => {
		const rig = makeRig({
			load: async () => ({ ...storedPage("note-1.slides", "stored-1"), futureVersion: 99 }),
		});
		await tick();
		// Adopted: the deck knows about the newer build's stroke. The teardown
		// line is the only window onto `this.strokes` the fake DOM gives.
		drawStrokeOn(rig);
		rig.deck.dispose();
		expect(rig.logs.join("\n")).toContain("sidecar loaded: READ-ONLY (schema v99)");
		expect(rig.logs.join("\n")).toContain("teardown: 1 slide(s) inked, 2 stroke(s)");
		// And fails closed in the write direction, at BOTH gates: nothing
		// debounced, nothing flushed at teardown.
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
	});

	it("says so once per presentation, not once per stroke", async () => {
		const rig = makeRig({
			load: async () => ({ ...storedPage("note-1.slides", "stored-1"), futureVersion: 99 }),
		});
		await tick();
		drawStrokeOn(rig);
		drawStrokeOn(rig);
		drawStrokeOn(rig);
		expect(rig.notices).toHaveLength(1);
		expect(rig.notices[0]).toContain("written by a newer Handwriting");
		// The message names the state the reader is actually in: the ink IS on
		// screen, and only saving is off.
		expect(rig.notices[0]).toContain("shown here");
	});

	it("still refuses to render a DAMAGED payload - that one really is a placeholder", async () => {
		const rig = makeRig({
			load: async () => ({ ...storedPage("note-1.slides", "stored-1"), damaged: true }),
		});
		await tick();
		rig.deck.dispose();
		expect(rig.logs.join("\n")).toContain("sidecar loaded: REFUSED (damaged)");
		expect(rig.logs.join("\n")).toContain("teardown: 0 slide(s) inked, 0 stroke(s)");
		expect(rig.notices).toEqual([
			"Handwriting: this presentation's ink file could not be read, so new ink is not being saved.",
		]);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
	});
});

describe("a claim in flight at teardown (the settle window)", () => {
	it("keeps the first stroke on a never-inked note when the deck closes mid-claim", async () => {
		let release!: (r: { pageId: string }) => void;
		const claim = new Promise<{ pageId: string }>((res) => {
			release = res;
		});
		// `pageId: null` is the note nobody has drawn on yet: the first stroke
		// claims, and the claim is what the write waits behind.
		const rig = makeRig({ pageId: null, claim: () => claim });
		await tick();
		drawStrokeOn(rig);
		expect(rig.claims).toEqual(["Deck.md"]);
		// Escape, inside the ~100-300 ms the frontmatter claim takes.
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
		release({ pageId: "note-1" });
		expect(await settleSlidesInk()).toBe(true);
		// The stroke reached disk, once, under the id the claim came back with.
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.id).toBe("note-1.slides");
		expect(rig.savedNow[0]!.page.strokes).toHaveLength(1);
		expect(rig.logs.join("\n")).toContain("teardown: parked write flushed to note-1.slides");
	});

	it("reports a parked write dropped by a future note without saving it", async () => {
		let release!: (r: { pageId: string; futureVersion: number }) => void;
		const claim = new Promise<{ pageId: string; futureVersion: number }>((res) => {
			release = res;
		});
		const rig = makeRig({ pageId: null, claim: () => claim });
		await tick();
		drawStrokeOn(rig);
		rig.deck.dispose();
		release({ pageId: "note-1", futureVersion: 99 });
		expect(await settleSlidesInk()).toBe(true);
		expect(rig.logs.join("\n")).toContain(
			"teardown: parked write dropped - no page id was claimed"
		);
		expect(rig.notices).toEqual([
			"Handwriting: this note declares a newer Handwriting format. Ink drawn on it is not saved.",
		]);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
	});

	it("merges the sidecar the note turned out to already have before that write", async () => {
		let release!: (r: { pageId: string }) => void;
		const claim = new Promise<{ pageId: string }>((res) => {
			release = res;
		});
		const rig = makeRig({
			pageId: null,
			claim: () => claim,
			load: async () => storedPage("other-1.slides", "other-device-1"),
		});
		await tick();
		drawStrokeOn(rig);
		rig.deck.dispose();
		// The note carried an id this session never saw - another device's.
		release({ pageId: "other-1" });
		expect(await settleSlidesInk()).toBe(true);
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes.map((s) => s.id)).toContain("other-device-1");
		expect(rig.savedNow[0]!.page.strokes).toHaveLength(2);
	});

	it("keeps a stroke parked behind the LOAD window when the deck closes mid-load", async () => {
		let release!: (r: ParseResult) => void;
		const pending = new Promise<ParseResult>((res) => {
			release = res;
		});
		const rig = makeRig({ load: () => pending });
		await tick();
		drawStrokeOn(rig);
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
		release(storedPage("note-1.slides", "stored-1"));
		expect(await settleSlidesInk()).toBe(true);
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes).toHaveLength(2);
	});

	it("still writes nothing at all when there is no claim and nothing changed", async () => {
		const rig = makeRig();
		await tick();
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
		expect(rig.scheduled).toEqual([]);
		// No drain either: the dirty gate is not routed around by the new leg.
		expect(await settleSlidesInk()).toBe(true);
		expect(rig.logs.join("\n")).toContain("nothing changed, no write");
	});
});

describe("live reload: another device wrote the .slides sidecar while the deck is up", () => {
	it("offers the sidecar as a reload candidate only when the deck is quiet", async () => {
		const rig = makeRig({ load: async () => storedPage("note-1.slides", "stored-1") });
		await tick();
		expect(rig.deck.reloadCandidateSidecarId()).toBe("note-1.slides");
		// A pen on the glass: swapping the committed lists mid-stroke is the
		// one thing a reload can do that the reader would see.
		rig.down();
		rig.move(260, 260);
		expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
		rig.end("pointerup");
		expect(rig.deck.reloadCandidateSidecarId()).toBe("note-1.slides");
	});

	it("adopts the other device's new stroke without dropping unsaved session ink", async () => {
		let disk = storedPageWith("note-1.slides", ["stored-1"]);
		const rig = makeRig({ load: async () => disk });
		await tick();
		// Drawn here and NOT yet written (the debounce holds it in `scheduled`).
		drawStrokeOn(rig);
		const mine = rig.scheduled.at(-1)!.page.strokes.find((s) => s.id !== "stored-1")!.id;
		// The other device adds one and sync lands the file.
		disk = storedPageWith("note-1.slides", ["stored-1", "stored-2"]);
		expect(await rig.deck.reloadExternal("note-1.slides")).toBe(true);
		rig.deck.dispose();
		const ids = rig.savedNow[0]!.page.strokes.map((s) => s.id);
		expect(ids).toContain("stored-2");
		expect(ids).toContain(mine);
		// stored-1 exactly once: the adopt appends, so a reload that did not
		// drop what it adopted last time would double every stored stroke.
		expect(ids.filter((id) => id === "stored-1")).toHaveLength(1);
		expect(ids).toHaveLength(3);
	});

	it("reports no change when the file is byte-identical, so the poll can back off", async () => {
		const rig = makeRig({ load: async () => storedPageWith("note-1.slides", ["stored-1"]) });
		await tick();
		expect(await rig.deck.reloadExternal("note-1.slides")).toBe(false);
		rig.deck.dispose();
		// And nothing was lost putting it back.
		expect(rig.logs.join("\n")).toContain("teardown: 1 slide(s) inked, 1 stroke(s)");
	});

	it("puts the session back when the re-read gives nothing (a half-synced file)", async () => {
		let disk: ParseResult | null = storedPageWith("note-1.slides", ["stored-1"]);
		const rig = makeRig({ load: async () => disk });
		await tick();
		drawStrokeOn(rig);
		disk = null; // caught mid-write by the sync client
		expect(await rig.deck.reloadExternal("note-1.slides")).toBe(false);
		rig.deck.dispose();
		const ids = rig.savedNow[0]!.page.strokes.map((s) => s.id);
		expect(ids).toContain("stored-1");
		expect(ids).toHaveLength(2);
	});

	it("refuses to reload a future-locked deck: re-reading would drop the lock", async () => {
		const rig = makeRig({
			load: async () => ({ ...storedPage("note-1.slides", "stored-1"), futureVersion: 99 }),
		});
		await tick();
		expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
		expect(await rig.deck.reloadExternal("note-1.slides")).toBe(false);
	});

	it("refuses while the note is mismatched: that sidecar is some other deck's ink", async () => {
		const rig = makeRig({ sections: 2, source: "only one slide here" });
		await tick();
		expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
	});
});

describe("scanForSlides: a pop-out window must not kill the live deck (S1)", () => {
	/**
	 * A container/reveal/slides trio wired the way `findDeck` walks it, built
	 * from the same `FakeEl` the rest of this suite mounts decks on - a deck
	 * built through `scanForSlides` behaves exactly like `makeRig`'s.
	 */
	function makeDeckElements(doc: FakeDoc): { container: FakeEl; reveal: FakeEl; slides: FakeEl } {
		const container = new FakeEl("div", doc);
		const reveal = new FakeEl("div", doc);
		const slides = new FakeEl("div", doc);
		reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
		reveal.clientWidth = 1000;
		reveal.clientHeight = 800;
		slides.rect = { left: 20, top: 25, width: 480, height: 350 };
		slides.clientWidth = 960;
		slides.clientHeight = 700;
		const section = new FakeEl("section", doc);
		section.textContent = "slide 0";
		section.classes.add("present");
		slides.children.push(section);
		(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".reveal" ? reveal : null;
		(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".slides" ? slides : null;
		// A freshly mounted container is attached, exactly like a real one.
		(container as unknown as { isConnected: boolean }).isConnected = true;
		return { container, reveal, slides };
	}

	/** A fake `Document`: a body whose only child a `.slides-container` scan can find. */
	function makeScanDoc(): { doc: FakeDoc; setDeck: (el: FakeEl | null) => void } {
		const doc = new FakeDoc();
		doc.defaultView = new FakeWin();
		let current: FakeEl | null = null;
		(doc as unknown as { body: { querySelector: (sel: string) => FakeEl | null } }).body = {
			querySelector: (sel: string) => (sel === ":scope > .slides-container" ? current : null),
		};
		return { doc, setDeck: (el: FakeEl | null) => void (current = el) };
	}

	function makeHost(): SlidesInkHost {
		return {
			activeFilePath: () => "Deck.md",
			readSource: async () => "slide 0",
			readPageId: () => "note-1",
			claimId: async (_path, proposedId) => ({ pageId: proposedId }),
			newPageId: () => "note-1",
			loadSidecar: async () => null,
			scheduleSidecar: () => undefined,
			saveSidecarNow: async () => undefined,
			nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
			eraserRadiusPx: () => 12,
			eraseWholeStrokes: () => true,
			notify: () => undefined,
			buildId: TEST_BUILD_ID,
		};
	}

	let evClock = 0;
	function ev(type: string, over: Partial<AnyEvent> = {}): AnyEvent {
		return {
			type,
			pointerId: 1,
			pointerType: "pen",
			isPrimary: true,
			buttons: 1,
			button: 0,
			clientX: 200,
			clientY: 200,
			pressure: 0.5,
			timeStamp: (evClock += 20),
			preventDefault: () => undefined,
			stopPropagation: () => undefined,
			...over,
		};
	}

	/** Draw one whole stroke on a `reveal` fake: down, two moves past the slop, lift. */
	function drawOn(reveal: FakeEl): void {
		reveal.dispatch(ev("pointerdown"));
		reveal.dispatch(ev("pointermove", { clientX: 260, clientY: 260 }));
		reveal.dispatch(ev("pointermove", { clientX: 300, clientY: 300 }));
		reveal.dispatch(ev("pointerup"));
	}

	beforeEach(() => {
		// `setSlidesInk(true, ...)` installs a body observer; scanForSlides
		// itself never constructs one, but the module-level "on" path does.
		(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
			observe(): void {
				/* the fake body has nothing to observe */
			}
			disconnect(): void {
				/* nothing to disconnect */
			}
		};
	});

	afterEach(() => {
		// Off is genuinely off (see setSlidesInk): this both tears down
		// whatever deck a test left live and resets the module's `enabled`
		// flag for the next test.
		setSlidesInk(false);
		delete (globalThis as { activeDocument?: unknown }).activeDocument;
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	});

	it("keeps a live deck when a scan lands on a pop-out that has focus - it is still the same, drawable deck", () => {
		const main = makeScanDoc();
		const popout = makeScanDoc();
		const mainDeck = makeDeckElements(main.doc);
		main.setDeck(mainDeck.container);
		(globalThis as { document?: unknown }).document = main.doc;
		setSlidesInk(true, makeHost());

		// The pop-out (with notes, and nothing that looks like a deck) takes
		// focus, and the next body mutation over there fires the observer.
		(globalThis as { activeDocument?: unknown }).activeDocument = popout.doc;
		deckLogs.length = 0;
		scanForSlides();

		// No teardown happened...
		expect(deckLogs.some((l) => l.includes("teardown:"))).toBe(false);
		// ...and the ORIGINAL deck is still live: a stroke on its reveal
		// still commits.
		drawOn(mainDeck.reveal);
		setSlidesInk(false);
		expect(deckLogs.some((l) => l.includes("teardown: 1 slide(s) inked, 1 stroke(s)"))).toBe(true);
	});

	it("still disposes a deck once its own container is actually gone (existing teardown behaviour, preserved)", () => {
		const main = makeScanDoc();
		const mainDeck = makeDeckElements(main.doc);
		main.setDeck(mainDeck.container);
		(globalThis as { document?: unknown }).document = main.doc;
		setSlidesInk(true, makeHost());
		deckLogs.length = 0;

		// The container is actually removed from the document.
		(mainDeck.container as unknown as { isConnected: boolean }).isConnected = false;
		main.setDeck(null);
		scanForSlides();

		expect(deckLogs.some((l) => l.includes("teardown:"))).toBe(true);
	});

	it("finds and mounts a NEW deck that appears in the pop-out while it is the active document", () => {
		const main = makeScanDoc();
		const popout = makeScanDoc();
		(globalThis as { document?: unknown }).document = main.doc;
		setSlidesInk(true, makeHost()); // nothing in either document yet
		deckLogs.length = 0;

		const popoutDeck = makeDeckElements(popout.doc);
		popout.setDeck(popoutDeck.container);
		(globalThis as { activeDocument?: unknown }).activeDocument = popout.doc;
		scanForSlides();

		// Mounted in the POP-OUT's reveal specifically, not the main one.
		drawOn(popoutDeck.reveal);
		setSlidesInk(false);
		expect(deckLogs.some((l) => l.includes("teardown: 1 slide(s) inked, 1 stroke(s)"))).toBe(true);
	});
});

/**
 * The canvases as an allocation and as a DOM attachment, rather than as a
 * coordinate space. Four separate ways three full-viewport canvases can be
 * right in memory and wrong on the glass: too big to allocate, sized at a
 * ratio the compositor has to resample, sized for a display the window has
 * already left, and not in the document at all.
 */
describe("the backing stores (a full-viewport canvas, three times over)", () => {
	it("leaves an ordinary display at its full ratio and only reduces past the budget", () => {
		// A Surface Pro's own panel: 1440x960 css at dpr 2 is 5.5M device px,
		// well inside. The floor the note surface's `backingScale` needed is
		// not needed here, because nothing multiplies the ratio in the first
		// place - k rides in the camera (A3).
		expect(slidesBackingScale(1440, 960, 2)).toBe(2);
		// The viewport this file's own header measured, which was allocating
		// 14.25M per canvas: 1.43x the budget and 89% of the 16M WebKit
		// refuses silently.
		const capped = slidesBackingScale(2560, 1392, 2);
		expect(capped).toBeLessThan(2);
		expect(2560 * capped * 1392 * capped).toBeCloseTo(MAX_BACKING_AREA, 0);
		// A garbage ratio is 1, never NaN: NaN would size the store to zero,
		// which is the blank canvas this whole function exists to prevent.
		expect(slidesBackingScale(1000, 800, Number.NaN)).toBe(1);
		expect(slidesBackingScale(1000, 800, 0)).toBe(1);
		// An unmeasured box cannot cap anything; it must not return 0 either.
		expect(slidesBackingScale(0, 0, 2)).toBe(2);
	});

	it("caps the store on a display big enough to blow the budget, and moves no ink doing it", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		// A 5K panel, full screen, at dpr 2. Uncapped this asks for
		// 10240x5760 (59M device px) on each of the three canvases, which is
		// past the point WebKit stops allocating and starts saying nothing.
		rig.reveal.rect = { left: 0, top: 0, width: 5120, height: 2880 };
		rig.reveal.clientWidth = 5120;
		rig.reveal.clientHeight = 2880;
		rig.slides.rect = { left: 100, top: 40, width: 1920, height: 1400 };
		rig.win.devicePixelRatio = 2;
		rig.reveal.dispatch({ type: "resize" });
		const l = layersOf(rig);
		for (const c of [l.committed, l.wetCanvas, l.tailCanvas]) {
			const canvas = c as unknown as { width: number; height: number };
			expect(canvas.width).toBeLessThan(5120 * 2);
			// Rounding the two axes independently can land a few hundred px
			// past the budget; what must never happen is the 59M above.
			expect(canvas.width * canvas.height).toBeLessThan(MAX_BACKING_AREA * 1.01);
		}
		// ...and the camera is untouched by the reduction (A3). The deck is
		// drawn at k = 1920/960 = 2, and a screen point still maps through k
		// alone: a ratio that leaked into the coordinates would put every
		// stroke somewhere else on a big display, which is worse than a soft
		// one.
		const expected = logical(rig, 200, 200);
		drawStrokeOn(rig);
		rig.deck.dispose();
		const p = rig.savedNow[rig.savedNow.length - 1]!.page.strokes[0]!.points[0]!;
		expect(p.x).toBeCloseTo(expected.x, 6);
		expect(p.y).toBeCloseTo(expected.y, 6);
	});

	it("derives the css box back from the rounded store, so the ratio is exactly the transform's", () => {
		const rig = makeRig();
		// 150% Windows scaling on an odd viewport: 1707 * 1.5 = 2560.5, which
		// rounds to 2561. Left at "1707px" - the obvious version - the
		// compositor sees 2561/1707 = 1.500293 and resamples the whole
		// full-viewport canvas every frame, which is what "ink is only blurry
		// in slides / only on my Surface" is.
		rig.reveal.clientWidth = 1707;
		rig.reveal.clientHeight = 1067;
		rig.win.devicePixelRatio = 1.5;
		rig.reveal.dispatch({ type: "resize" });
		const l = layersOf(rig);
		for (const c of [l.committed, l.wetCanvas, l.tailCanvas]) {
			const canvas = c as unknown as { width: number; height: number };
			expect(canvas.width).toBe(2561);
			expect(canvas.height).toBe(1601);
			const cssW = Number.parseFloat(c.style.width ?? "");
			const cssH = Number.parseFloat(c.style.height ?? "");
			// The point of the whole exercise: exactly dpr, not nearly dpr.
			expect(canvas.width / cssW).toBe(1.5);
			expect(canvas.height / cssH).toBe(1.5);
			// And it is genuinely derived, not the measured box by luck.
			expect(cssW).not.toBe(1707);
			expect(cssH).not.toBe(1067);
		}
		rig.deck.dispose();
	});

	it("re-sizes all three canvases when the resolution changes under a box that did not move", () => {
		const rig = makeRig();
		const l = layersOf(rig);
		expect((l.committed as unknown as { width: number }).width).toBe(1000);
		expect(rig.win.mediaQueries.at(-1)!.query).toBe("(resolution: 1dppx)");
		expect(rig.win.resolutionListenerCount()).toBe(1);
		// Plugged into a projector, or moved onto the Surface's own 2x panel.
		// `.reveal` is the same 1000x800 css px it always was, so `resize`
		// never fires and the ResizeObserver never beats.
		rig.win.changeResolution(2);
		for (const c of [l.committed, l.wetCanvas, l.tailCanvas]) {
			const canvas = c as unknown as { width: number; height: number };
			expect(canvas.width).toBe(2000);
			expect(canvas.height).toBe(1600);
		}
		// Re-armed on the NEW ratio - the old query can never match again, so
		// a watcher that did not re-arm would fire exactly once in a session -
		// and the old listener is gone rather than accumulating.
		expect(rig.win.mediaQueries.at(-1)!.query).toBe("(resolution: 2dppx)");
		expect(rig.win.resolutionListenerCount()).toBe(1);
		// Once more, the other way: unplugging mid-deck.
		rig.win.changeResolution(1);
		expect((l.committed as unknown as { width: number }).width).toBe(1000);
		expect(rig.win.resolutionListenerCount()).toBe(1);
		rig.deck.dispose();
	});

	it("takes the resolution watcher with it on teardown", () => {
		const rig = makeRig();
		expect(rig.win.resolutionListenerCount()).toBe(1);
		rig.deck.dispose();
		expect(rig.win.resolutionListenerCount()).toBe(0);
		// And a display change afterwards reaches nothing: a watcher that
		// outlived its deck would call `refresh` on a disposed surface.
		rig.win.changeResolution(3);
		expect(rig.win.resolutionListenerCount()).toBe(0);
	});

	it("notices the canvases are no longer under .reveal and re-mounts them", () => {
		const rig = makeRig();
		const l = layersOf(rig);
		// The host rebuilt its own subtree and took the canvases with it while
		// `.reveal` survived. Every listener still fires - capture, the palm
		// guard, the tap rule all live on `.reveal` - so the pen keeps working
		// and nothing is painted: the reader draws invisibly.
		l.committed.remove();
		l.wetCanvas.remove();
		l.tailCanvas.remove();
		expect(rig.reveal.children).toHaveLength(0);
		// The path that already runs on every geometry sync and every repaint.
		rig.reveal.dispatch({ type: "slidechanged" });
		const after = layersOf(rig);
		expect(after.committed).not.toBe(l.committed);
		expect(rig.reveal.children).toContain(after.committed);
		expect(rig.reveal.children).toContain(after.wetCanvas);
		expect(rig.reveal.children).toContain(after.tailCanvas);
		// Sized, not left at 0x0: canvases are created with no dimensions, so
		// a re-mount that never reached `syncGeometry` would paint into
		// nothing and look exactly like the bug it repairs.
		expect((after.committed as unknown as { width: number }).width).toBe(1000);
		expect((after.tailCanvas as unknown as { height: number }).height).toBe(800);
		expect(rig.logs.some((line) => line.includes("no longer under"))).toBe(true);
		rig.deck.dispose();
	});

	it("re-mounts from a repaint too, so a stroke is the longest anyone draws blind", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		const l = layersOf(rig);
		l.committed.remove();
		l.wetCanvas.remove();
		l.tailCanvas.remove();
		// No slide change, no resize: just the reader drawing. `commitStroke`
		// ends in `repaint`, which is where the check has to be for the damage
		// to be bounded by one stroke rather than by the next slide.
		drawStrokeOn(rig);
		const after = layersOf(rig);
		expect(rig.reveal.children).toContain(after.committed);
		expect((after.committed as unknown as { width: number }).width).toBe(1000);
		rig.deck.dispose();
	});
});

describe("onSlidesCssChange (GAP 16): re-arm the deck-theme measurement on css-change", () => {
	/** A minimal deck, mounted through `setSlidesInk`/`scanForSlides` exactly the way main.ts's `css-change` handler will find it - not through `makeRig`, because this exercises the MODULE-LEVEL `deck`, which `onSlidesCssChange` reads and `makeRig`'s `SlidesDeck` never touches. */
	function installDeck(background: unknown): { win: FakeWin; doc: FakeDoc } {
		const doc = new FakeDoc();
		const win = new FakeWin();
		win.computedBackground = background;
		doc.defaultView = win;
		const container = new FakeEl("div", doc);
		const reveal = new FakeEl("div", doc);
		const slides = new FakeEl("div", doc);
		reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
		reveal.clientWidth = 1000;
		reveal.clientHeight = 800;
		slides.rect = { left: 20, top: 25, width: 480, height: 350 };
		slides.clientWidth = 960;
		slides.clientHeight = 700;
		const section = new FakeEl("section", doc);
		section.textContent = "slide 0";
		section.classes.add("present");
		slides.children.push(section);
		(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".reveal" ? reveal : null;
		(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".slides" ? slides : null;
		(container as unknown as { isConnected: boolean }).isConnected = true;
		(doc as unknown as { body: { querySelector: (sel: string) => FakeEl | null } }).body = {
			querySelector: (sel: string) => (sel === ":scope > .slides-container" ? container : null),
		};
		(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
			observe(): void {
				/* the fake body has nothing to observe */
			}
			disconnect(): void {
				/* nothing to disconnect */
			}
		};
		(globalThis as { document?: unknown }).document = doc;
		const host: SlidesInkHost = {
			activeFilePath: () => "Deck.md",
			readSource: async () => "slide 0",
			readPageId: () => "note-1",
			claimId: async (_path, proposed) => ({ pageId: proposed }),
			newPageId: () => "note-1",
			loadSidecar: async () => null,
			scheduleSidecar: () => undefined,
			saveSidecarNow: async () => undefined,
			nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
			eraserRadiusPx: () => 12,
			eraseWholeStrokes: () => true,
			notify: () => undefined,
			buildId: TEST_BUILD_ID,
		};
		setSlidesInk(true, host);
		return { win, doc };
	}

	afterEach(() => {
		// Off is genuinely off (see setSlidesInk): tears down whatever deck
		// this test left live and resets the module's `enabled` flag.
		setSlidesInk(false);
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	});

	it("(a) with a live deck whose paint flips dark to light, flips inkThemeOverride() and repaints exactly once", () => {
		const { win, doc } = installDeck("rgb(25, 25, 25)");
		expect(inkThemeOverride()).toBe(true);
		const before = doc.clearCounts.clears;
		win.computedBackground = "rgb(255, 255, 255)";
		onSlidesCssChange();
		expect(inkThemeOverride()).toBe(false);
		expect(doc.clearCounts.clears).toBe(before + 1);
	});

	it("(b) is a no-op with no deck live: no throw, no override change", () => {
		setSlidesInk(false);
		expect(inkThemeOverride()).toBeNull();
		expect(() => onSlidesCssChange()).not.toThrow();
		expect(inkThemeOverride()).toBeNull();
	});

	it("does nothing when the deck's paint has not actually changed - the control for (a)", () => {
		const { doc } = installDeck("rgb(25, 25, 25)");
		expect(inkThemeOverride()).toBe(true);
		const before = doc.clearCounts.clears;
		onSlidesCssChange();
		// Still dark: a css-change unrelated to the deck's own paint (a font,
		// an unrelated plugin's CSS) must not flip anything, and must not
		// repaint either.
		expect(inkThemeOverride()).toBe(true);
		expect(doc.clearCounts.clears).toBe(before);
	});
});

describe("main.ts registers onSlidesCssChange in its css-change handler (GAP 16)", () => {
	const mainCode = codeOnly(mainSrc);

	/**
	 * Windowed rather than whole-file, but BOTH ends of the slice are their
	 * own assertion first (per the file's raw-source-assertion rule): a
	 * `indexOf` that silently returns -1 on either anchor must fail loudly,
	 * not slice `mainCode.slice(-1, ...)` and quietly pass on the wrong text.
	 */
	function cssChangeHandler(): string {
		const startNeedle = 'workspace.on("css-change", () => {';
		const start = mainCode.indexOf(startNeedle);
		expect(start).toBeGreaterThan(-1);
		const rest = mainCode.slice(start);
		const endNeedle = "refreshAllStrips();";
		const endRel = rest.indexOf(endNeedle);
		expect(endRel).toBeGreaterThan(-1);
		const closeRel = rest.indexOf("})", endRel);
		expect(closeRel).toBeGreaterThan(endRel);
		return rest.slice(0, closeRel);
	}

	it("calls onSlidesCssChange() beside the other fan-out, inside the same handler", () => {
		// codeOnly strips comments first, so a comment naming the call could
		// not satisfy this - only a real call site does.
		expect(cssChangeHandler()).toContain("onSlidesCssChange();");
	});
});

/* ------------------------------------------------------------------------ *
 * Pinning the protections a negative-control pass could remove in silence.
 *
 * Each block below names the protection and the mutation that used to leave
 * the whole suite green. They assert nothing new about the design - every
 * rule here is already stated in the header - they only make sure the next
 * reader who deletes one of these lines is told.
 * ------------------------------------------------------------------------ */

/**
 * A `claimId` the test holds open (F1). The frontmatter claim is a real await
 * in the source, and "the sidecar write happens AFTER it" is an ORDER, which a
 * claim that resolves immediately cannot express.
 */
function deferredClaim(pageId: string): {
	claim: (path: string, proposed: string) => Promise<{ pageId: string; futureVersion?: number }>;
	release: () => void;
} {
	let resolve: (v: { pageId: string }) => void = () => undefined;
	const gate = new Promise<{ pageId: string }>((r) => {
		resolve = r;
	});
	return { claim: () => gate, release: () => resolve({ pageId }) };
}

/**
 * `main.ts`'s slides host object as CODE (F5), comments blanked, both ends of
 * the window asserted first. The wiring inside it - which object the writes
 * go through, and whether they carry the page writer - cannot be reached from
 * a test: `startSlidesInk` is private, needs a live App, a vault and a store.
 */
function slidesHostSource(): string {
	const code = codeOnly(mainSrc).replace(/\r\n/g, "\n");
	const startNeedle = "private startSlidesInk(): void {";
	const start = code.indexOf(startNeedle);
	expect(start, "anchor not found: startSlidesInk").toBeGreaterThan(-1);
	const rest = code.slice(start);
	const endNeedle = "setSlidesInk(true, host);";
	const end = rest.indexOf(endNeedle);
	expect(end, "closing anchor not found: setSlidesInk(true, host)").toBeGreaterThan(-1);
	return rest.slice(0, end);
}

describe("the claim identity rule (item 1: a note may already own an id we never saw)", () => {
	it("merges the ADOPTED id's stored ink, and writes only after the claim has resolved", async () => {
		// No id in the frontmatter, so the deck must claim one; the claim comes
		// back with a DIFFERENT id, which is the case the merge exists for (a
		// second pane, another device, a cold metadata cache).
		const gate = deferredClaim("note-9");
		const rig = makeRig({
			pageId: null,
			claim: gate.claim,
			load: async (id) => (id === slidesSidecarId("note-9") ? storedPage(id, "was-there") : null),
		});
		await new Promise((r) => setTimeout(r, 0));
		drawStrokeOn(rig);
		// The claim is still in flight: nothing may be written yet. A write
		// here is the overwrite - this session's one stroke over the other
		// device's whole sidecar, with the store's conflict guard disarmed.
		expect(rig.scheduled).toHaveLength(0);
		expect(rig.savedNow).toHaveLength(0);
		gate.release();
		for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
		// The adopted id's sidecar was read...
		expect(rig.loads).toContain(slidesSidecarId("note-9"));
		// ...and BOTH strokes are in the first write: the stored one and ours.
		const writes = [...rig.scheduled, ...rig.savedNow];
		expect(writes.length).toBeGreaterThan(0);
		const ids = writes[0]!.page.strokes.map((s) => s.id);
		expect(ids).toContain("was-there");
		expect(ids).toHaveLength(2);
		rig.deck.dispose();
	});
});

describe("syncGeometry's two protections (item 2)", () => {
	async function mountedRig(): Promise<Rig> {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		return rig;
	}

	it("does not reallocate a backing store whose size has not changed", async () => {
		const rig = await mountedRig();
		const l = layersOf(rig);
		const total = (): number =>
			l.committed.backingWrites + l.wetCanvas.backingWrites + l.tailCanvas.backingWrites;
		const before = total();
		// Same viewport, same ratio: three syncs that change nothing.
		rig.reveal.dispatch({ type: "resize" });
		rig.reveal.dispatch({ type: "resize" });
		rig.reveal.dispatch({ type: "resize" });
		// Writing `canvas.width` at all clears the canvas, even with the same
		// number - so an unguarded sync throws the committed ink away on every
		// resize event the deck receives.
		expect(total()).toBe(before);
		rig.deck.dispose();
	});

	it("re-measures the deck on a resize, with no stroke to force it", async () => {
		const rig = await mountedRig();
		const before = rig.slides.rectCalls;
		rig.reveal.dispatch({ type: "resize" });
		// `measureGeometry` is the only reader of `.slides`'s rect, and the
		// cache is never invalidated by anything else: without it the camera
		// stays on the pre-resize layout until the reader's next pen-down, so
		// a stroke drawn after a window resize lands somewhere else.
		expect(rig.slides.rectCalls).toBeGreaterThan(before);
		rig.deck.dispose();
	});
});

describe("coalesced samples are all consumed (item 3)", () => {
	it("appends every sample a single move carried, not just the last", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		rig.down();
		// One move, three samples: at 240 Hz on a 60 Hz deck this is the normal
		// case, and dropping two of three is a visibly cornered line.
		rig.moveCoalesced([
			{ x: 260, y: 260 },
			{ x: 300, y: 300 },
			{ x: 340, y: 340 },
		]);
		rig.end("pointerup", { buttons: 0 });
		const committed = strokesOn(rig, 0);
		expect(committed).toHaveLength(1);
		// The pen-down point plus the three coalesced ones.
		expect(committed[0]!.points).toHaveLength(4);
		rig.deck.dispose();
	});
});

describe("main.ts's slides host writes through the store, with the page writer (item 4)", () => {
	it("routes load, schedule and save through this.store and passes a newPageWriter", () => {
		const src = slidesHostSource();
		expect(src).toContain('const writer = newPageWriter("slides");');
		expect(src).toContain("loadSidecar: (sidecarId) => this.store.load(sidecarId),");
		// Both writers, and both carrying the writer: the store is what holds
		// the debounce, the conflict guard and the atomic replace, and a direct
		// adapter write from here would have none of them.
		expect(src).toContain("this.store.schedule(sidecarId, page, writer)");
		expect(src).toContain("this.store.saveNow(sidecarId, page, writer)");
		// The stamp a vault restamp rewrites (item: build id) - naming anything
		// else would print a build label that never changes with the vault copy
		// actually loaded.
		expect(src).toContain("buildId: this.manifest.version,");
	});
});

describe("the deck's OWN window owns devicePixelRatio (item 5)", () => {
	it("sizes the backing stores from the deck window's ratio, not the global one", async () => {
		// A presentation on a second, hidpi screen: the deck's document is not
		// the one `globalThis` describes, and reading the global one there
		// gives a soft deck on the display that has the pixels.
		const rig = makeRig({ devicePixelRatio: 2 });
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		const l = layersOf(rig);
		const committed = l.committed as unknown as { width: number; height: number };
		expect(committed.width).toBe(2000);
		expect(committed.height).toBe(1600);
		rig.deck.dispose();
	});
});

describe("focus is retaken at pen-down, at the stroke end and once more 0 ms later (item 7)", () => {
	function caret(rig: Rig): FakeEl {
		const el = new FakeEl("div", rig.doc);
		el.isContentEditable = true;
		el.tabIndex = 0;
		return el;
	}

	async function mountedRig(): Promise<Rig> {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		// The mount's OWN 0 ms focus timer, drained here rather than left
		// pending. Left armed it fires on the first `runTimers(0)` any test
		// below makes and re-takes focus for a reason that has nothing to do
		// with the stroke - which is exactly how the 0 ms RETRY test passed
		// with the retry deleted.
		rig.win.runTimers(0);
		return rig;
	}

	it("takes focus back at pen-down when a caret took it after the mount", async () => {
		const rig = await mountedRig();
		const ce = caret(rig);
		rig.doc.activeElement = ce;
		rig.down();
		expect(rig.doc.activeElement).toBe(rig.reveal);
		rig.deck.dispose();
	});

	it("takes focus back at the stroke end when something stole it mid-stroke", async () => {
		const rig = await mountedRig();
		rig.down();
		rig.move(260, 260);
		const ce = caret(rig);
		rig.doc.activeElement = ce;
		rig.end("pointerup", { buttons: 0 });
		expect(rig.doc.activeElement).toBe(rig.reveal);
		rig.deck.dispose();
	});

	it("takes it back again 0 ms later, for whatever the click's default did after us", async () => {
		const rig = await mountedRig();
		rig.down();
		rig.move(260, 260);
		rig.end("pointerup", { buttons: 0 });
		// The pointerup's default action, or a click handler it triggered, runs
		// AFTER the handler above and moves focus again.
		const ce = caret(rig);
		rig.doc.activeElement = ce;
		rig.win.runTimers(0);
		expect(rig.doc.activeElement).toBe(rig.reveal);
		rig.deck.dispose();
	});
});

describe("the module off-gate (item 8)", () => {
	afterEach(() => {
		setSlidesInk(false);
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	});

	it("builds no deck for a container that appears while slides ink is OFF", () => {
		setDiagnosticsEnabled(true);
		const doc = new FakeDoc();
		const win = new FakeWin();
		doc.defaultView = win;
		const container = new FakeEl("div", doc);
		const reveal = new FakeEl("div", doc);
		const slides = new FakeEl("div", doc);
		reveal.clientWidth = 1000;
		reveal.clientHeight = 800;
		slides.clientWidth = 960;
		slides.clientHeight = 700;
		const section = new FakeEl("section", doc);
		section.textContent = "slide 0";
		section.classes.add("present");
		slides.children.push(section);
		(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (
			sel
		) => (sel === ".reveal" ? reveal : null);
		(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".slides" ? slides : null;
		(container as unknown as { isConnected: boolean }).isConnected = true;
		// The container is NOT there yet: `setSlidesInk(true, host)` installs
		// the host and finds nothing, and the switch is then turned off.
		let present: FakeEl | null = null;
		(doc as unknown as { body: { querySelector: (sel: string) => FakeEl | null } }).body = {
			querySelector: (sel: string) => (sel === ":scope > .slides-container" ? present : null),
		};
		(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
			observe(): void {
				/* nothing to observe */
			}
			disconnect(): void {
				/* nothing to disconnect */
			}
		};
		(globalThis as { document?: unknown }).document = doc;
		const host: SlidesInkHost = {
			activeFilePath: () => "Deck.md",
			readSource: async () => "slide 0",
			readPageId: () => "note-1",
			claimId: async (_path, proposed) => ({ pageId: proposed }),
			newPageId: () => "note-1",
			loadSidecar: async () => null,
			scheduleSidecar: () => undefined,
			saveSidecarNow: async () => undefined,
			nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
			eraserRadiusPx: () => 12,
			eraseWholeStrokes: () => true,
			notify: () => undefined,
			buildId: TEST_BUILD_ID,
		};
		setSlidesInk(true, host);
		setSlidesInk(false);
		// Now the reader presents. The host is still installed - it is only
		// ever set, never cleared - so `enabled` is the whole gate, and a scan
		// that consults the host alone builds a deck the user turned off.
		present = container;
		deckLogs.length = 0;
		scanForSlides();
		expect(deckLogs.filter((l) => l.includes("mount:"))).toHaveLength(0);
	});
});

describe("the mount line reports the GRANTED desynchronized flag (item 9)", () => {
	it("says actual true when the browser grants what was not requested", async () => {
		setDiagnosticsEnabled(true);
		// `SLIDES_DESYNCHRONIZED` is the A/B's answer; what the browser then
		// GRANTS is its own business, and the diagnosis of a tearing deck is
		// the difference between the two. Logging the request twice would read
		// identically on every machine that behaved.
		expect(SLIDES_DESYNCHRONIZED).toBe(false);
		const rig = makeRig({ grantedDesynchronized: true });
		await new Promise((r) => setTimeout(r, 0));
		const mount = rig.logs.find((l) => l.includes("mount: three canvases"));
		expect(mount).toBeDefined();
		expect(mount).toContain("wet desynchronized: requested false actual true");
		rig.deck.dispose();
	});
});

describe("the mount line names the running build (stale-plugin visibility)", () => {
	it("appends the host's buildId to the mount line", async () => {
		setDiagnosticsEnabled(true);
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		const mount = rig.logs.find((l) => l.includes("mount: three canvases"));
		expect(mount).toBeDefined();
		expect(mount).toContain(`build ${TEST_BUILD_ID}`);
		rig.deck.dispose();
	});
});

describe("the committed repaint opts INTO the ribbon cache (item 10)", () => {
	it("passes the cache flag at the slides call site", () => {
		// A full-slide repaint runs on every slide change, load, erase and
		// resize, over every stroke on the slide; flattening each ribbon again
		// each time is the cost this argument exists to avoid.
		const body = slice("private repaint(): void {", "\n\t}");
		expect(body).toContain("drawStroke(l.ctx, cam, s, undefined, true);");
	});
});

describe("the deck focus does not scroll the presentation (item 11)", () => {
	it("focuses .reveal with preventScroll", async () => {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.reveal.focusCalls.length = 0;
		rig.doc.activeElement = null;
		rig.down();
		expect(rig.reveal.focusCalls.length).toBeGreaterThan(0);
		// A bare `focus()` scrolls the focused element into view, and `.reveal`
		// is the whole viewport: on a deck mid-transition that is a visible
		// jump on the projector.
		expect(rig.reveal.focusCalls[0]).toEqual({ preventScroll: true });
		rig.deck.dispose();
	});
});

describe("the hold watchdog and the synchronous refresh (item 12)", () => {
	async function mountedRig(): Promise<Rig> {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		return rig;
	}

	it("commits a stroke that was cancelled and then went quiet for STROKE_HOLD_MS", async () => {
		const rig = await mountedRig();
		rig.down();
		rig.move(260, 260);
		rig.move(300, 300);
		// S5: a cancel is not a lift, so the stroke is held open. But nothing
		// more arrives - Chromium took the contact away for good - and the
		// reducer's `holdSince` is only a NUMBER until a real timer asks it.
		rig.end("pointercancel");
		expect(rig.scheduled).toHaveLength(0);
		rig.win.runTimers(STROKE_HOLD_MS);
		// This is the commit, not the guard tail: the ink reached the store.
		// Not the silent-lift deadline either: that one asks `lastPointerAt`,
		// finds this contact was heard from a moment ago, and re-arms.
		expect(rig.scheduled).toHaveLength(1);
		expect(rig.scheduled[0]!.page.strokes).toHaveLength(1);
		rig.deck.dispose();
	});

	it("repaints inside refresh(), not on a later frame", async () => {
		const rig = await mountedRig();
		const before = rig.doc.clearCounts.clears;
		rig.reveal.dispatch({ type: "resize" });
		// Deferring this to a rAF is invisible on a resize and wrong on a
		// teardown-adjacent path: the frame belongs to a deck that may be gone
		// by the time it runs, and the reader watches a stale slide until then.
		expect(rig.doc.clearCounts.clears).toBeGreaterThan(before);
		expect(rig.win.frames.size).toBe(0);
		rig.deck.dispose();
	});
});

/**
 * The teardown re-checks (item 6 of the test slice).
 *
 * Three lines in `dispose()` and in the erase frame it cancels, each of which
 * a negative-control pass would delete without turning a single existing test
 * red. Two of the three are SECOND lines of defence and cannot be reached
 * behaviourally today - the reason is recorded on each pin below, because a
 * source assertion with no explanation is the kind of test nobody dares
 * delete and nobody believes either. The behavioural test comes first and
 * asserts the end state all three exist to produce: after teardown, nothing
 * is armed, nothing repaints, nothing is still recording.
 */
describe("the teardown re-checks (item 6: nothing survives dispose)", () => {
	async function mountedRig(): Promise<Rig> {
		const rig = makeRig({ load: async () => storedRow("note-1.slides", 12) });
		await new Promise((r) => setTimeout(r, 0));
		// The two nested frames the constructor queues for its remount, and
		// the 0 ms focus timer the mount arms. Drained here because this test
		// did not arm them: left pending, they would answer the assertions
		// below in place of the protection under test.
		rig.win.runFrames();
		rig.win.runFrames();
		rig.win.runTimers(0);
		return rig;
	}

	/** Screen x/y for the deck-logical row `storedRow` lays down, at k=0.5. */
	const sx = (logicalX: number): number => logicalX * 0.5 + 20;
	const sy = 100 * 0.5 + 25;

	function traceOf(rig: Rig): { active: boolean } {
		return (rig.deck as unknown as { moveTrace: { active: boolean } }).moveTrace;
	}

	it("leaves no erase frame, no repaint and no live trace behind it", async () => {
		setDiagnosticsEnabled(true);
		try {
			const rig = await mountedRig();
			// An erase gesture in the reader's hand: promoted (so the move
			// trace has begun and its frame loop is pumping), with a hit the
			// erase frame has not painted yet.
			rig.down({ buttons: 32, clientX: sx(100), clientY: sy });
			rig.move(sx(200), sy, { buttons: 32 });
			expect(traceOf(rig).active).toBe(true);
			expect(rig.win.frames.size).toBeGreaterThan(0);
			// The presentation closes with the pen still on the glass.
			rig.deck.dispose();
			const after = rig.doc.clearCounts.clears;
			expect(traceOf(rig).active).toBe(false);
			expect(rig.win.frames.size).toBe(0);
			// And a frame that somehow still ran would paint nothing.
			rig.win.runFrames();
			expect(rig.doc.clearCounts.clears).toBe(after);
		} finally {
			setDiagnosticsEnabled(false);
		}
	});

	/**
	 * PIN 1 - the `disposed` re-check inside the erase frame.
	 *
	 * NOT reachable behaviourally, and the reason is worth stating: the only
	 * arming site is `markErased`, the frame it arms lives exactly as long as
	 * a live erase gesture, and every ending of a live erase gesture -
	 * `dispose()`'s own `flushErase()` included - CANCELS it. So no erase
	 * frame can outlive the deck to observe the flag. It is the second line
	 * of defence for PIN 2, and PIN 2 is the second line of defence for it;
	 * deleting either alone is invisible, deleting both is a repaint on a
	 * disposed deck. Pinned against the source, both ends anchored, with
	 * comments stripped so a comment cannot satisfy it.
	 */
	it("keeps the disposed re-check inside the erase frame", () => {
		const frame = codeOnly(
			slice("this.eraseFrame = win.requestAnimationFrame(() => {", "this.repaint();")
		);
		expect(frame).toContain("this.eraseFrame = null;");
		expect(frame).toContain("|| this.disposed) return;");
	});

	/**
	 * PIN 2 - `flushErase()` in `dispose()`.
	 *
	 * Also not reachable today, for the mirror-image reason: `dispose()`
	 * commits the gesture in the reader's hand first, and `commitStroke`'s
	 * erase branch flushes every promoted erase itself. An UNpromoted erase
	 * contact has never run a hit test (`markErased` is called at three sites
	 * and all three are behind `penStroke`), so it has nothing pending, and
	 * `onPointerDown` returns early while a session is live, so no second
	 * contact can strand the first one's dirt. What is left is the state no
	 * path produces today and the next erase path might: dirt with no live
	 * gesture to carry it. Pinned against the source rather than pretended.
	 */
	it("keeps the flush in dispose()", () => {
		const teardown = codeOnly(slice("\tdispose(): void {", "this.disposed = true;"));
		expect(teardown).toContain("this.commitStroke(");
		expect(teardown).toContain("this.flushErase();");
		// Order matters as much as presence: the commit is what has a builder
		// to spend, and the flush is what catches what it did not.
		expect(teardown.indexOf("this.commitStroke(")).toBeLessThan(
			teardown.indexOf("this.flushErase();")
		);
	});

	/**
	 * PIN 3 - `this.moveTrace.dispose()` in `dispose()`.
	 *
	 * Same shape again: `commitStroke` ends an active trace, and `dispose()`
	 * runs `commitStroke` first, so the trace is already stopped by the time
	 * this line is reached on every path that exists today. It is what stops
	 * the pump for a trace that began without a commit to end it - and the
	 * pump re-arms itself every frame, so getting this wrong costs a frame
	 * loop for the life of the window, not one stale callback.
	 */
	it("keeps the move trace's own teardown in dispose()", () => {
		const teardown = codeOnly(
			slice("setInkThemeOverride(null);", "for (const d of this.disposers.splice(0)) d();")
		);
		expect(teardown).toContain("this.moveTrace.dispose();");
	});
});

/**
 * The pen-up clear: which canvas, how big, and in what order (GAP 8, GAP 11).
 */
describe("the pen-up clear (GAP 8: the e-ink branch, GAP 11: the handoff order)", () => {
	async function mountedRig(): Promise<Rig> {
		const rig = makeRig();
		await new Promise((r) => setTimeout(r, 0));
		rig.win.runFrames();
		rig.win.runFrames();
		rig.win.runTimers(0);
		return rig;
	}

	/** The clears that landed on one canvas since `from`, in order. */
	function clearsOn(
		rig: Rig,
		el: FakeEl,
		from: number
	): Array<{ x: number; y: number; w: number; h: number }> {
		return rig.doc.clearCounts.rects
			.slice(from)
			.filter((r) => r.el === el)
			.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
	}

	it("clears the whole viewport at the lift off e-ink, as it always did", async () => {
		const rig = await mountedRig();
		const l = layersOf(rig);
		const from = rig.doc.clearCounts.rects.length;
		drawStrokeOn(rig);
		// The wet layer: one clear, the whole 1000x800 viewport.
		expect(clearsOn(rig, l.wetCanvas, from)).toEqual([{ x: 0, y: 0, w: 1000, h: 800 }]);
		// The tail: a whole-canvas clear at the end, whatever the per-event
		// dirty-rect clears did before it.
		expect(clearsOn(rig, l.tailCanvas, from)).toContainEqual({ x: 0, y: 0, w: 1000, h: 800 });
		rig.deck.dispose();
	});

	it("clears the stroke's own box in Boox mode, not the full-viewport canvas", async () => {
		setPredictionEink(true);
		try {
			const rig = await mountedRig();
			const l = layersOf(rig);
			const from = rig.doc.clearCounts.rects.length;
			drawStrokeOn(rig);
			// E-ink refreshes the region a frame damaged, and this canvas is
			// the whole viewport: the box has to be the ink's, not the deck's.
			const wet = clearsOn(rig, l.wetCanvas, from);
			expect(wet).toHaveLength(1);
			expect(wet[0]!.w).toBeLessThan(1000);
			expect(wet[0]!.h).toBeLessThan(800);
			// And the tail goes with it: no whole-canvas clear anywhere in the
			// gesture, which is what `clearAll` would have left behind.
			expect(clearsOn(rig, l.tailCanvas, from)).not.toContainEqual({
				x: 0,
				y: 0,
				w: 1000,
				h: 800,
			});
			rig.deck.dispose();
		} finally {
			setPredictionEink(false);
		}
	});

	it("clears the transient layers BEFORE the committed flatten, not after", async () => {
		const rig = await mountedRig();
		const l = layersOf(rig);
		const from = rig.doc.clearCounts.rects.length;
		drawStrokeOn(rig);
		const seen = rig.doc.clearCounts.rects.slice(from);
		const wetAt = seen.findIndex((r) => r.el === l.wetCanvas);
		const committedAt = seen.findIndex((r) => r.el === l.committed);
		// `repaint()` opens with a clearRect on the committed layer, so its
		// index IS the moment the committed stroke starts being painted.
		// This surface's order is the opposite of `handoffFinishedStroke`'s
		// and the comment on the clear in `commitStroke` says why it is safe:
		// both layers are plain canvases and everything between the two is one
		// synchronous task. Flip the order and this goes red - which is the
		// point, because nothing else in the file would notice.
		expect(wetAt).toBeGreaterThanOrEqual(0);
		expect(committedAt).toBeGreaterThanOrEqual(0);
		expect(wetAt).toBeLessThan(committedAt);
		rig.deck.dispose();
	});
});

describe("live reload while sidecar I/O is pending", () => {
	it.each([false, true])("keeps an erased session stroke out of a saved remote copy after a read (failed first: %s)", async (missing) => {
		let next: Promise<ParseResult | null> = Promise.resolve(storedPage("note-1.slides", "stored-1"));
		const rig = makeRig({ load: () => next });
		await Promise.all(rig.deck.inFlightWork());
		drawStrokeOn(rig);
		const disk = { data: rig.scheduled[0]!.page, recovered: false };
		const mine = disk.data.strokes.find((s) => s.id !== "stored-1")!.id;
		let release!: (page: ParseResult | null) => void;
		next = new Promise((resolve) => { release = resolve; });
		const reload = rig.deck.reloadExternal("note-1.slides");
		rig.down({ buttons: 32, clientX: 260, clientY: 260 });
		rig.end("pointerup", { buttons: 0, clientX: 260, clientY: 260, timeStamp: 999_999 });
		const erased = !strokesOn(rig, 0).some((s) => s.id === mine);
		release(missing ? null : disk);
		await reload;
		next = Promise.resolve(disk);
		await rig.deck.reloadExternal("note-1.slides");
		expect(erased).toBe(true);
		expect(strokesOn(rig, 0).map((s) => s.id)).toEqual(["stored-1"]);
		expect(rig.scheduled.at(-1)!.page.strokes.map((s) => s.id)).toEqual(["stored-1"]);
		rig.deck.dispose();
	});

	it("waits at teardown when the deck was dirty before its reload began", async () => {
		const { rig, release } = await pendingReloadRig();
		drawStrokeOn(rig);
		const mine = strokesOn(rig, 0).find((s) => s.id !== "stored-1")!.id;
		const reload = rig.deck.reloadExternal("note-1.slides");
		rig.deck.dispose();
		const earlyFlush = [...rig.savedNow];
		release(storedPageWith("note-1.slides", ["stored-1", "stored-2"]));
		await reload;
		expect(await settleSlidesInk()).toBe(true);
		expect(earlyFlush).toEqual([]);
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes.map((s) => s.id).sort()).toEqual([mine, "stored-1", "stored-2"].sort());
	});
	async function pendingReloadRig(): Promise<{
		rig: Rig;
		release: (page: ParseResult | null) => void;
		reject: (error: Error) => void;
	}> {
		let release!: (page: ParseResult | null) => void;
		let reject!: (error: Error) => void;
		const pending = new Promise<ParseResult | null>((resolve, fail) => {
			release = resolve;
			reject = fail;
		});
		let cold = true;
		const rig = makeRig({ load: () => cold
			? Promise.resolve(storedPageWith("note-1.slides", ["stored-1"]))
			: pending });
		await Promise.all(rig.deck.inFlightWork());
		cold = false;
		expect(strokesOn(rig, 0).map((s) => s.id)).toEqual(["stored-1"]);
		expect(rig.scheduled).toEqual([]);
		return { rig, release, reject };
	}

	it("holds saves until remote ink and a stroke drawn during the read are merged", async () => {
		const { rig, release } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		drawStrokeOn(rig);
		const mine = strokesOn(rig, 0).find((s) => s.id !== "stored-1")!.id;
		const earlyWrites = [...rig.scheduled, ...rig.savedNow];
		const remote = storedPageWith("note-1.slides", ["stored-1", "stored-2"]);
		remote.data.deck = { width: 1200, height: 900 };
		release(remote);
		expect(await reload).toBe(true);
		expect(earlyWrites).toEqual([]);
		expect(rig.scheduled).toHaveLength(1);
		expect(rig.scheduled[0]!.page.strokes.map((s) => s.id).sort()).toEqual([mine, "stored-1", "stored-2"].sort());
		expect(rig.scheduled[0]!.page.deck).toEqual(remote.data.deck);
		rig.deck.dispose();
	});

	it.each(["missing", "rejected", "damaged"] as const)("retains old ink and a read-window stroke after a %s read", async (outcome) => {
		const { rig, release, reject } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		drawStrokeOn(rig);
		const mine = strokesOn(rig, 0).find((s) => s.id !== "stored-1")!.id;
		const earlyWrites = [...rig.scheduled, ...rig.savedNow];
		if (outcome === "rejected") reject(new Error("held read failed"));
		else release(outcome === "missing" ? null : { ...storedPage("note-1.slides", "ignored"), damaged: true });
		expect(await reload).toBe(false);
		expect(earlyWrites).toEqual([]);
		expect(strokesOn(rig, 0).map((s) => s.id).sort()).toEqual([mine, "stored-1"].sort());
		if (outcome === "damaged") {
			expect(rig.scheduled).toEqual([]);
			expect(rig.deck.reloadCandidateSidecarId()).toBeNull();
		} else {
			expect(rig.scheduled).toHaveLength(1);
			expect(rig.scheduled[0]!.page.strokes).toHaveLength(2);
		}
		rig.deck.dispose();
		if (outcome === "damaged") expect(rig.savedNow).toEqual([]);
	});

	it("refuses a second reload while the first read is pending", async () => {
		const { rig, release } = await pendingReloadRig();
		const first = rig.deck.reloadExternal("note-1.slides");
		const candidate = rig.deck.reloadCandidateSidecarId();
		const second = rig.deck.reloadExternal("note-1.slides");
		const reads = rig.loads.length;
		release(storedPageWith("note-1.slides", ["stored-1", "stored-2"]));
		const answers = await Promise.all([first, second]);
		expect(candidate).toBeNull();
		expect(reads).toBe(2);
		expect(answers).toEqual([true, false]);
		expect(strokesOn(rig, 0).map((s) => s.id).sort()).toEqual(["stored-1", "stored-2"]);
		rig.deck.dispose();
	});

	it("drains a pending reload before teardown saves its last local stroke", async () => {
		const { rig, release } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		drawStrokeOn(rig);
		const mine = strokesOn(rig, 0).find((s) => s.id !== "stored-1")!.id;
		rig.deck.dispose();
		const earlyWrites = [...rig.scheduled, ...rig.savedNow];
		release(storedPageWith("note-1.slides", ["stored-1", "stored-2"]));
		await reload;
		expect(await settleSlidesInk()).toBe(true);
		expect(earlyWrites).toEqual([]);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toHaveLength(1);
		expect(rig.savedNow[0]!.page.strokes.map((s) => s.id).sort()).toEqual([mine, "stored-1", "stored-2"].sort());
	});

	it("does not restore a closed clean deck when its pending reload finishes", async () => {
		const { rig, release } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		rig.deck.dispose();
		release(storedPageWith("note-1.slides", ["stored-1", "stored-2"]));
		expect(await reload).toBe(false);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		expect(strokesOn(rig, 0)).toEqual([]);
	});

	it("applies the future-version lock before any read-window stroke can be saved", async () => {
		const { rig, release } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		drawStrokeOn(rig);
		const mine = strokesOn(rig, 0).find((s) => s.id !== "stored-1")!.id;
		release({ ...storedPageWith("note-1.slides", ["stored-1", "stored-2"]), futureVersion: 99 });
		expect(await reload).toBe(true);
		expect(strokesOn(rig, 0).map((s) => s.id).sort()).toEqual([mine, "stored-1", "stored-2"].sort());
		expect(rig.scheduled).toEqual([]);
		rig.deck.dispose();
		expect(rig.savedNow).toEqual([]);
	});

	it.each([false, true])("keeps an erase made during a pending read (failed read: %s)", async (missing) => {
		const { rig, release } = await pendingReloadRig();
		const reload = rig.deck.reloadExternal("note-1.slides");
		rig.down({ buttons: 32, clientX: 20.5, clientY: 25.5 });
		rig.end("pointerup", { buttons: 0, clientX: 20.5, clientY: 25.5, timeStamp: 999_999 });
		const erased = strokesOn(rig, 0).every((s) => s.id !== "stored-1");
		release(missing ? null : storedPageWith("note-1.slides", ["stored-1", "stored-2"]));
		await reload;
		expect(erased).toBe(true);
		expect(strokesOn(rig, 0).some((s) => s.id === "stored-1")).toBe(false);
		expect(rig.scheduled).toHaveLength(1);
		expect(rig.scheduled[0]!.page.strokes.map((s) => s.id)).toEqual(missing ? [] : ["stored-2"]);
		if (!missing) {
			expect(await rig.deck.reloadExternal("note-1.slides")).toBe(false);
			expect(strokesOn(rig, 0).map((s) => s.id)).toEqual(["stored-2"]);
		}
		rig.deck.dispose();
	});
});
// Counts captured from the installed Obsidian 1.13.7 presenter parser, with
// its own %% tokenizers (app.js SHA256 8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898).
// These fixtures require no Obsidian internals at runtime or in the test gate.
describe("the measured presenter comment grammar", () => {
	it("keeps literal comments inside code across a paragraph's soft breaks", () => {
		const code = "`code\n%%literal%%\nend`";
		expect(splitSlideSections(code + "\n\n---\n\nnext")[0]).toContain(code);
	});

	it("strips a valid HTML comment across soft breaks without crossing a paragraph boundary", () => {
		const sections = splitSlideSections("visible <!-- hidden\nend -->\n\n---\n\nnext");
		expect(sections).toHaveLength(2);
		expect(sections[0]).not.toContain("hidden");
		expect(noteMatchesDeck(sections, ["visible", "next"])).toBe(true);
		const broken = splitSlideSections("visible <!-- hidden\n\n---\n\nend -->\n\nnext");
		expect(broken).toHaveLength(2);
		expect(broken[0]).toContain("hidden");
	});
	const corpus = [
  {
    "name": "obsidianBlock",
    "source": "# one\n\n%%\n---\n%%\n\n# two\n\n---\n\n# three",
    "count": 2
  },
  {
    "name": "htmlBlock",
    "source": "# one\n\n<!--\n---\n-->\n\n# two\n\n---\n\n# three",
    "count": 2
  },
  {
    "name": "commentOnly",
    "source": "%%\nhidden\n%%\n\n---\n\n# shown",
    "count": 2
  },
  {
    "name": "inlineComment",
    "source": "%%rel%%# Slide one\n\n---\n\n# two",
    "count": 2
  },
  {
    "name": "inlineCode",
    "source": "`%%literal%%`\n\n---\n\n# two",
    "count": 2
  },
  {
    "name": "normal",
    "source": "# one\n\n---\n\n# two",
    "count": 2
  },
  {
    "name": "existingDecision",
    "source": "# one\n\n%%hidden\n\n---\n\nstill hidden%%\n\n# two\n",
    "count": 1
  },
  {
    "name": "commentTitle",
    "source": "%%hidden%%\n---\n# shown",
    "count": 1
  },
  {
    "name": "inlineMultiline",
    "source": "# one\n\nvisible %%hidden\n---\nend%%\n\n# two",
    "count": 1
  },
  {
    "name": "unclosedInline",
    "source": "# one %%unfinished\n\n---\n\n# two",
    "count": 2
  },
  {
    "name": "unclosedBlock",
    "source": "# one\n\n%%unfinished\n\n---\n\n# two",
    "count": 1
  },
  {
    "name": "htmlNormalBlock",
    "source": "# one\n\n<!-- hidden\n\n---\n\nstill hidden -->\n\n# two",
    "count": 1
  }
];
	it.each(corpus)("matches the presenter slide count for $name", ({ source, count }) => {
		expect(splitSlideSections(source)).toHaveLength(count);
		expect(sectionHashes(source)).toHaveLength(count);
	});

	it.each([
		"`%%literal%%`",
		"``code ` %%literal%%``",
		"\\%%literal%%",
		"    %%literal%%",
		"# one %%unfinished",
		"%%one%two",
	])("preserves code, escapes, and literal percent text: %s", (line) => {
		expect(splitSlideSections(line + "\n\n---\n\n# next")[0]).toContain(line);
	});

	it("does not turn a hidden inline prefix into a structural rule", () => {
		expect(splitSlideSections("%%hidden%%---\n\nnext")).toHaveLength(1);
	});

	it.each([
		{ source: "# one\n\n%%hidden\n\n---\n\nend%%\n\n# two", deck: ["one two"] },
		{ source: "%%\nhidden\n%%\n\n---\n\n# shown", deck: ["", "shown"] },
		{ source: "# one %%unfinished\n\n---\n\n# two", deck: ["one %%unfinished", "two"] },
	])("saves a matched presentation for $source", async ({ source, deck }) => {
		expect(noteMatchesDeck(splitSlideSections(source), deck)).toBe(true);
		const rig = makeRig({ source, sections: deck.length, sectionText: (i) => deck[i]! });
		await Promise.all(rig.deck.inFlightWork());
		drawStrokeOn(rig);
		expect(rig.scheduled).toHaveLength(1);
		expect(rig.scheduled[0]!.page.strokes).toHaveLength(1);
		expect(rig.notices).toEqual([]);
		rig.deck.dispose();
	});

	it("still refuses a different note after comment normalization", async () => {
		const rig = makeRig({ source: "# one\n\n%%hidden\n---\nend%%", sections: 1, sectionText: () => "a different note" });
		await Promise.all(rig.deck.inFlightWork());
		drawStrokeOn(rig);
		expect(rig.scheduled).toEqual([]);
		expect(rig.savedNow).toEqual([]);
		expect(rig.notices).toHaveLength(1);
		rig.deck.dispose();
	});
});
/**
 * `reloadSlidesExternal` is the module-level WRAPPER, and it is a different
 * thing from the `reloadExternal` the block above drives ten times over.
 *
 * The delegate is thoroughly pinned. The wrapper is four lines and, until
 * these cases, nothing anywhere named it or reached it: every live-reload test
 * builds its deck with `makeRig`, and `makeRig`'s `SlidesDeck` NEVER touches
 * the module-level `deck` binding - the file already says so at
 * `onSlidesCssChange`'s helper, for the same reason. So the two lines that are
 * only the wrapper's - the no-deck guard, and reading the singleton at all -
 * had no coverage while the thing underneath had plenty.
 *
 * Mounted through `setSlidesInk`/`scanForSlides` because that is the only way
 * to put a deck where this function looks for one.
 */
describe("reloadSlidesExternal: the wrapper, not the delegate", () => {
	function mountDeck(disk: () => Promise<ParseResult | null>): void {
		const doc = new FakeDoc();
		const win = new FakeWin();
		doc.defaultView = win;
		const container = new FakeEl("div", doc);
		const reveal = new FakeEl("div", doc);
		const slides = new FakeEl("div", doc);
		reveal.rect = { left: 0, top: 0, width: 1000, height: 800 };
		reveal.clientWidth = 1000;
		reveal.clientHeight = 800;
		slides.rect = { left: 20, top: 25, width: 480, height: 350 };
		slides.clientWidth = 960;
		slides.clientHeight = 700;
		const section = new FakeEl("section", doc);
		section.textContent = "slide 0";
		section.classes.add("present");
		slides.children.push(section);
		(container as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".reveal" ? reveal : null;
		(reveal as unknown as { querySelector: (sel: string) => FakeEl | null }).querySelector = (sel) =>
			sel === ".slides" ? slides : null;
		(container as unknown as { isConnected: boolean }).isConnected = true;
		(doc as unknown as { body: { querySelector: (sel: string) => FakeEl | null } }).body = {
			querySelector: (sel: string) => (sel === ":scope > .slides-container" ? container : null),
		};
		(globalThis as { MutationObserver?: unknown }).MutationObserver = class {
			observe(): void {
				/* nothing to observe on the fake body */
			}
			disconnect(): void {
				/* nothing to disconnect */
			}
		};
		(globalThis as { document?: unknown }).document = doc;
		const host: SlidesInkHost = {
			activeFilePath: () => "Deck.md",
			readSource: async () => "slide 0",
			readPageId: () => "note-1",
			claimId: async (_path, proposed) => ({ pageId: proposed }),
			newPageId: () => "note-1",
			loadSidecar: disk,
			scheduleSidecar: () => undefined,
			saveSidecarNow: async () => undefined,
			nib: () => ({ tool: "pen", color: "#123456", width: 2 }),
			eraserRadiusPx: () => 12,
			eraseWholeStrokes: () => true,
			notify: () => undefined,
			buildId: TEST_BUILD_ID,
		};
		setSlidesInk(true, host);
	}

	afterEach(() => {
		setSlidesInk(false);
		delete (globalThis as { document?: unknown }).document;
		delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
	});

	it("answers false, and does not throw, when no deck is live", async () => {
		// The poll runs on a timer and the deck goes away when the
		// presentation closes, so this is the ordinary case at the end of
		// every talk, not a defensive nicety.
		expect(await reloadSlidesExternal("note-1.slides")).toBe(false);
	});

	it("reaches the deck the MODULE holds", async () => {
		let disk = storedPageWith("note-1.slides", ["stored-1"]);
		mountDeck(async () => disk);
		await tick();
		disk = storedPageWith("note-1.slides", ["stored-1", "stored-2"]);
		expect(await reloadSlidesExternal("note-1.slides")).toBe(true);
	});

	it("re-reads the singleton per call instead of capturing one deck", async () => {
		// The failure this excludes is the one that bit the PDF controller
		// today: a binding taken once and then held past the thing it named.
		// Here the first deck is torn down and a second mounted underneath the
		// same wrapper, and the wrapper must answer for the SECOND.
		let disk = storedPageWith("note-1.slides", ["stored-1"]);
		mountDeck(async () => disk);
		await tick();
		expect(await reloadSlidesExternal("note-1.slides")).toBe(false);

		setSlidesInk(false);
		expect(await reloadSlidesExternal("note-1.slides")).toBe(false);

		disk = storedPageWith("note-1.slides", ["stored-1"]);
		mountDeck(async () => disk);
		await tick();
		disk = storedPageWith("note-1.slides", ["stored-1", "stored-2"]);
		expect(
			await reloadSlidesExternal("note-1.slides"),
			"a wrapper holding the disposed deck would answer for it, or throw"
		).toBe(true);
	});
});

/**
 * CHARACTERISATION, AND THIS ONE IS WRONG-BUT-CURRENT.
 *
 * A stroke drawn on THIS device is never added to `adoptedIds`. Not when it is
 * drawn, and - the part that makes it permanent - not when it is later read
 * back from the sidecar either: `adoptSidecar` skips ids already on screen
 * ("Ids already on screen are SKIPPED, not appended"), so a stroke that has
 * synced out and come back is still, as far as this surface is concerned,
 * local ink.
 *
 * `replaceAdopted` then keeps exactly the strokes that are NOT adopted. So a
 * remote DELETE of a stroke this device drew cannot remove it, this device
 * writes it back on the next save, and the other device's delete is undone.
 * Resurrection, for the life of the deck.
 *
 * That is the opposite defect from the one notes and PDFs have, where adopt
 * REPLACES and ink is lost. Slides unions, so it loses nothing and forgets
 * nothing.
 *
 * THE ASSERTION BELOW IS THE BUG, PINNED AS IT BEHAVES TODAY. A fix will turn
 * it red, and that is the fix working - not a regression. Whoever fixes it
 * should delete this case and write the opposite one. It is NOT `it.fails`,
 * because it does not throw: it passes, describing something we do not want.
 */
describe("a remote delete of locally-drawn ink (characterisation: today's behaviour is wrong)", () => {
	it("does not remove it, even after that stroke has been round-tripped through the sidecar", async () => {
		let disk: ParseResult | null = storedPageWith("note-1.slides", ["stored-1"]);
		const rig = makeRig({ load: async () => disk });
		await tick();

		drawStrokeOn(rig);
		const mine = rig.scheduled.at(-1)!.page.strokes.find((s) => s.id !== "stored-1")!.id;

		// It syncs out, and this device reads its own stroke back. This is the
		// step that separates the case from "unsaved session ink survives",
		// which is desirable and is already pinned above: after this reload
		// the stroke is on disk AND on screen, and the surface still does not
		// consider it adopted.
		disk = storedPageWith("note-1.slides", ["stored-1", mine]);
		await rig.deck.reloadExternal("note-1.slides");

		// The other device deletes it.
		disk = storedPageWith("note-1.slides", ["stored-1"]);
		await rig.deck.reloadExternal("note-1.slides");

		rig.deck.dispose();
		const ids = rig.savedNow[0]!.page.strokes.map((s) => s.id);
		expect(
			ids,
			"WRONG-BUT-CURRENT: the remote delete is undone because local ink is never adopted"
		).toContain(mine);
		expect(ids).toContain("stored-1");
	});
});
