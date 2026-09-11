import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import css from "../../styles.css?raw";
import mainSrc from "../main.ts?raw";
import stripSrc from "./MobileTools.ts?raw";
import deviceSrc from "./DeviceInput.ts?raw";
import { codeOnly } from "../CodeOnly";
import {
	DEFAULT_FOLD_ORDER,
	MobileTools,
	nibIsLit,
	normalizeFoldOrder,
	type MobileToolsHost,
} from "./MobileTools";
import { type InkPreset } from "../ink/InkPresets";
// The two base widths the px sliders are built from. Imported rather than
// copied so the expected multipliers below are the ones the constructor
// really divides by, not two numbers that were true when this was written.
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { deviceHasTouch, setHasTouchForTest } from "./DeviceInput";
// markPenHardwareSeen, not markPenSeen: these tests want "a pen exists", and
// markPenSeen only means "show the strip" - it is set by every tool command,
// which is exactly the confusion that left the nib light stuck on for three
// releases. See PenToolsMode.ts's `penHardware`.
import {
	clearPenHardwareSeen,
	// The pen-less half of the router's mouse grant; the regression pin at the
	// foot of this file composes the router's own expression rather than
	// restating it (see `InlinePenRouter.mouseActsAsPen`).
	deviceHasNeverSeenAPen,
	markPenHardwareSeen,
	markPenSeen,
	penHardwareEverSeen,
	penHardwareSeen,
	penSeenThisSession,
	releaseMouseInkQuietly,
	resetPenToolsForTest,
	setPenToolsMode,
	restorePenHardwareEverSeen,
} from "./PenToolsMode";
import {
	armMouseInkQuietly,
	clearToolPicked,
	consumeMousePutDown,
	disarmMouseInkQuietly,
	markToolPicked,
	mouseActsAsPen,
	mouseInkEnabled,
	setMouseInk,
	toolIsLit,
	toolPickedHere,
} from "./MouseInk";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "./PenInk";
import { penOnOff } from "./PenCommand";
import { PdfInkController } from "../pdf/PdfInkController";

/**
 * Obsidian's real `setIcon` APPENDS an svg to the parent; it does not clear
 * what is already there. The suite-wide stub (test/obsidian-stub.ts) is a
 * no-op, which is the same assumption that let the pill stack icons up in the
 * first place, so this file mocks the honest behaviour instead: every call
 * adds one more <svg>. `appends` false is the other real case - an icon name
 * Obsidian does not know renders nothing - which is what the glyph fallback
 * downstream of every setIcon call is there for.
 */
const icons = vi.hoisted(() => ({ appends: true }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		setIcon: (parent: unknown): void => {
			if (icons.appends) (parent as { createEl(tag: string): unknown }).createEl("svg");
		},
	};
});

/**
 * EVERY TEST IN THIS FILE STARTS AT LAUNCH, with no tool picked.
 *
 * `toolPicked` (MouseInk.ts) is module state exactly as the three pen flags
 * in PenToolsMode.ts are, and this file both READS it - through `nibIsLit`
 * and the strip's three mouse branches - and WRITES it, every time a click
 * runs an exec that reaches `setInlineTool`/`setTipMode` or hits the strip's
 * own "give the mouse this tool" branch. Left to leak, one describe's click
 * would hand the next one a device where a tool is already lit, and on a
 * pen-less device (which `resetPenToolsForTest()` makes every describe here)
 * that is the difference between the strip's arm branch and its put-down
 * branch: the SAME click does the opposite thing. Three tests in this file
 * failed that way before this hook existed.
 *
 * File-level rather than repeated per describe, so a describe added later
 * cannot forget it; the ones that WANT a lit tool say `markToolPicked()`
 * inside the test, where it reads as setup rather than as inheritance.
 */
beforeEach(() => clearToolPicked());

describe("toolbar visibility while writing", () => {
	beforeEach(() => resetPenToolsForTest());

	it("updates existing strip and collapsed pill between Auto and On without input commands", () => {
		const pane = new FakeEl("div", new FakeDoc());
		const exec = vi.fn();
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost({ exec }));
		const toolbar = pane.querySelector(".handwriting-mobile-tools")!;
		const pill = pane.querySelector(".handwriting-pen-pill")!;
		strip.setInking(true);
		for (const el of [toolbar, pill]) expect(el.classes.has("is-inking")).toBe(true);
		setPenToolsMode("show");
		for (const el of [toolbar, pill]) expect(el.classes.has("is-inking")).toBe(false);
		strip.setInking(true);
		for (const el of [toolbar, pill]) expect(el.classes.has("is-inking")).toBe(false);
		setPenToolsMode("auto");
		for (const el of [toolbar, pill]) expect(el.classes.has("is-inking")).toBe(true);
		strip.setInking(false);
		for (const el of [toolbar, pill]) expect(el.classes.has("is-inking")).toBe(false);
		expect(exec).not.toHaveBeenCalled();
		strip.destroy();
		const afterDestroy = vi.spyOn(strip, "setInking");
		setPenToolsMode("show");
		expect(afterDestroy).not.toHaveBeenCalled();
	});
});

/**
 * nibIsLit is the pure seam that fell out of splitting the light's predicate
 * from the click chain's (design doc 1.4.6 §6a, "the pen button unhilights
 * when the mouse hands the tool back"): pin it directly with a fake host.
 *
 * The strip class itself is constructed further down, against the fake
 * element tree in this file. The header here used to say it could not be -
 * that was true when nibIsLit was extracted and is not any more.
 */
const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	// Drag to anchor: a no-op by default, so every strip a test builds still
	// behaves exactly as it did. The drag tests at the foot of this file pass
	// a spy and read what it was handed.
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	// Quick pens: no starred pens by default, so every strip a test builds
	// still has the row it had before this feature - one star chip and
	// nothing else.
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	// What BOTH real surfaces answer (InkOverlay.ts and PdfInkController.ts):
	// the flag is the honest read wherever the router gates on it. Tests that
	// want a host disagreeing with the global pass their own.
	penInksHere: () => penInkEnabled(),
	// A MOUSE-ONLY device by default, so the strip a test gets is the full
	// one and every existing assertion about button order still describes the
	// strip it was written against. Tests about the phone's strip pass true.
	hasTouch: () => false,
	...over,
});

describe("nibIsLit", () => {
	beforeEach(() => resetPenToolsForTest());

	it("is lit for a pen that has been seen this session, mouse ink off", () => {
		markPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(true);
	});

	/**
	 * CHANGED, 2026-09-05: "button should become the truth" and its addendum
	 * reverse this exact case. BEFORE this assertion asserted `false` -
	 * "a mouse user with mouse ink off and no pen seen is dark". Alan's own
	 * symptom that started this whole ruling was the INVERSE of that
	 * (button lit, mouse not drawing), and the fix `InlinePenRouter
	 * .mouseActsAsPen` already ships is: on exactly this device (pen-less,
	 * pen input on, a tool nominally selected), the mouse NOW draws with
	 * whichever tool is lit, with no arm step - so a dark button here would
	 * be lying the OTHER way. NOW asserts `true`.
	 *
	 * FALSIFIABILITY (would this still turn red if `nibIsLit` reverted to
	 * reading `penSeenThisSession()`?): NO, and it structurally cannot -
	 * this is a call about the FRESH-SESSION state that was reset just
	 * above, where `penSeenThisSession()` and `penHardwareSeen()` are BOTH
	 * false, so a reverted first disjunct would read no differently here
	 * than the correct one does. That divergence only exists once hardware
	 * has been marked and then cleared while session-seen stays latched -
	 * exactly the paired tests below, which is where that regression check
	 * still lives, isolated from this new rule via `penInksHere: () =>
	 * false`. This test is not, and was never, a regression guard for the
	 * classic 1.4.6-1.4.8 bug; it pins the addendum's own new baseline.
	 */
	/**
	 * CHANGED AGAIN, 2026-09-05, and the setup is the whole of the change:
	 * `markToolPicked()` is new here. The assertion still says `true` and
	 * the rule it pins is still the addendum's, but the case it describes
	 * was, as written, a device STRAIGHT FROM LAUNCH with nothing picked -
	 * and it asserted the button was lit there, which is exactly the
	 * `mouse-lit-truth` defect stated as a test. `nibIsLit` read "a tool is
	 * lit" from `penInksHere()` alone, whose default is TRUE, so this passed
	 * for the wrong reason and pinned the wrong behaviour: on that device a
	 * plain left-drag inked instead of selecting text, and this test said
	 * the light was right to say so. The pick is what "a tool is lit" always
	 * meant; it just had nothing to read it from until now.
	 */
	it("is lit for a mouse user with mouse ink off and no pen seen, ONCE A TOOL IS PICKED", () => {
		markToolPicked();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(
			true
		);
	});

	/**
	 * THE OTHER HALF OF THE SAME PAIR, and the one the case above was
	 * silently standing in for: same device, same switches, nothing picked.
	 * ADDED for `mouse-lit-truth` - the launch state had no test at all,
	 * which is how a light that lied about it shipped.
	 */
	it("is DARK at launch for that same mouse user - nothing picked, nothing lit", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(
			false
		);
	});

	it("uses the explicit picked grant for an iPhone finger without claiming pen hardware", () => {
		const phone = fakeHost({
			activeTool: () => "pen",
			fingerInkAvailable: () => true,
		});
		expect(nibIsLit(phone, "pen")).toBe(false);
		markToolPicked();
		expect(nibIsLit(phone, "pen")).toBe(true);
		expect(penHardwareSeen()).toBe(false);
		setPenInk(false);
		expect(nibIsLit(phone, "pen")).toBe(false);
		resetPenInkForTest();
	});

	/**
	 * A SECOND CASE of the same new rule, for symmetry with the pen: ADDED,
	 * not a rewrite of an existing assertion. The `markToolPicked()` is the
	 * same correction the pen case above carries.
	 */
	it("is lit for a mouse user on the highlighter too, pen-less, no arm, once picked", () => {
		markToolPicked();
		expect(
			nibIsLit(
				fakeHost({ activeTool: () => "highlighter", mouseInkOn: () => false }),
				"highlighter"
			)
		).toBe(true);
	});

	// ALAN'S RULE, 2026-09-03: the light is dark "until you touch with your
	// pen", and turning mouse ink off puts it out "at any point". Before this
	// the hardware flag latched for the whole session, so once he had used his
	// pen the button stayed lit however often mouse ink was switched off - by
	// hand it read as stuck, and no amount of toggling could make it go dark.
	//
	// UNCHANGED IN OUTCOME, 2026-09-06 - and the setup LOST a field it had
	// only briefly. It carried `penInksHere: () => false` (keyboard mode) as
	// isolation against the pen-less grant `mouseDrawsFromLitTool`, which at
	// the time read the present-tense `penHardwareSeen()` and so flipped true
	// the instant `clearPenHardwareSeen()` ran, masking the first disjunct.
	// TWO things have since removed the need and one of them forbids it:
	// `deviceHasNeverSeenAPen()` was repointed onto the never-cleared session
	// LATCH (see the CLOSED test below), which `markPenHardwareSeen()` here
	// sets for good, so the grant cannot fire in this test at all; and since
	// `nibIsLit`'s first disjunct is `penDrawsHere` - hardware AND
	// `h.penInksHere()` - keyboard mode would now zero the very disjunct this
	// test exists to isolate, and the test would pass on nothing. Pen input
	// reads ON here, which is also the honest setting for "a pen user
	// switching mouse ink off".
	//
	// FALSIFIABILITY (would this still turn red if `nibIsLit` reverted to
	// reading `penSeenThisSession()`?): YES, unchanged. `markPenHardwareSeen()`
	// sets BOTH flags; `clearPenHardwareSeen()` clears only the hardware one,
	// deliberately leaving `penSeenThisSession()` latched true (the toolbar
	// must not disappear). So a reverted first disjunct would read
	// `penSeenThisSession()` = true here and this test would see `true`
	// where the correct code (and this assertion) says `false` - exactly
	// the three-release regression this test exists to catch, still caught.
	// Nothing else can carry the last assertion: mouse ink is off and the
	// pen-less grant is latched out, so the first disjunct is the whole answer.
	it("goes dark when mouse ink is turned off, even after a pen has been seen", () => {
		markPenHardwareSeen();
		const off = fakeHost({ activeTool: () => "pen", mouseInkOn: () => false });
		expect(nibIsLit(off, "pen")).toBe(true);
		clearPenHardwareSeen();
		expect(nibIsLit(off, "pen")).toBe(false);
	});

	// UNCHANGED IN OUTCOME, and it drops the same stale `penInksHere: () =>
	// false` for the same two reasons as the test above - this one adds the
	// RECOVERY half (a real pen contact relights it). Falsifiability: YES,
	// same argument - the middle assertion (`false`) is where a reverted
	// first disjunct would read `penSeenThisSession()` = true and go red.
	it("comes back on the next pen contact - the whole of 'until you touch with your pen'", () => {
		markPenHardwareSeen();
		clearPenHardwareSeen();
		const off = fakeHost({ activeTool: () => "pen", mouseInkOn: () => false });
		expect(nibIsLit(off, "pen")).toBe(false);
		// Both surfaces call this on every real pen contact.
		markPenHardwareSeen();
		expect(nibIsLit(off, "pen")).toBe(true);
	});

	/**
	 * CHANGED, once this branch rebased onto the tip carrying the persisted
	 * latch (`penHardwareEverSeen()`): this test used to be named
	 * "LIMIT: relights via the pen-less grant right after mouse-ink-off" and
	 * asserted `true` at the end - `deviceHasNeverSeenAPen()` read the
	 * present-tense `penHardwareSeen()`, which `clearPenHardwareSeen` (every
	 * mouse-ink-off) puts back to false, so the addendum's own grant
	 * incorrectly re-fired and relit the button. Repointing
	 * `deviceHasNeverSeenAPen()` onto the session latch - never cleared by
	 * `clearPenHardwareSeen()` - closes that hole: the realistic,
	 * undisguised case (no forced `penInksHere`, pen input reads ON, the
	 * honest common case) now goes dark exactly as Alan's original "off at
	 * any point" ruling (2026-09-03) asked, with no conflict between the two
	 * rulings left. NOW asserts `false`, and is named for what it now
	 * proves.
	 */
	it("CLOSED: stays dark after mouse-ink-off, for a device that has held a pen this session", () => {
		// A TOOL IS PICKED, and this line is what keeps the test honest. What
		// it pins is that `deviceHasNeverSeenAPen()` reads the session LATCH,
		// so the pen-less grant cannot re-fire after `clearPenHardwareSeen()`.
		// With nothing picked the file-level `clearToolPicked()` makes
		// `toolIsLit` false, the grant is false whatever the latch says, and
		// the last assertion holds for the wrong reason - it would stay green
		// with the latch fix reverted. Picking a tool puts the latch back in
		// charge of the answer.
		markToolPicked();
		markPenHardwareSeen();
		const off = fakeHost({ activeTool: () => "pen", mouseInkOn: () => false });
		expect(nibIsLit(off, "pen")).toBe(true);
		clearPenHardwareSeen();
		expect(nibIsLit(off, "pen")).toBe(false);
	});

	it("leaves the TOOLBAR alone - clearing the light must not take the strip away", () => {
		// The half he was explicit about twice, and the reason the clear is
		// narrow: "make turning ink turns off the pen light, but NOT the
		// toolbar off", then "why the fuck would the toolbar disappear".
		// `penSeen` decides the strip exists; only `penHardware` may be
		// cleared here. Clearing both would delete the toolbar out from under
		// him, which is the opposite of the request.
		markPenHardwareSeen();
		expect(penSeenThisSession()).toBe(true);
		clearPenHardwareSeen();
		expect(penSeenThisSession()).toBe(true);
	});

	it("still lights for an armed mouse with no pen, which the clear must not break", () => {
		// A mouse user's light does not ride the hardware flag at all - it
		// rides `mouseInkOn()`. Pinned because the obvious wrong fix for the
		// rule above is to drop the `|| h.mouseInkOn()` disjunct, and that
		// would leave a mouse user staring at a dark button while their mouse
		// was drawing.
		clearPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => true }), "pen")).toBe(
			true
		);
	});

	it("is lit for a mouse user with mouse ink armed, no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => true }), "pen")).toBe(true);
	});

	it("is dark when the tip is claimed by another mode, even if mouse ink is on", () => {
		expect(
			nibIsLit(
				fakeHost({ activeTool: () => "pen", mouseInkOn: () => true, eraserOn: () => true }),
				"pen"
			)
		).toBe(false);
	});

	it("is dark when the nominal tool is not this nib", () => {
		markPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "highlighter" }), "pen")).toBe(false);
	});

	it("checks the highlighter independently of the pen", () => {
		expect(
			nibIsLit(fakeHost({ activeTool: () => "highlighter", mouseInkOn: () => true }), "highlighter")
		).toBe(true);
	});
});

/**
 * A fake element tree, enough of one for the strip to build itself in.
 *
 * The suite runs on node with no DOM and no jsdom dependency, and the strip
 * needs Obsidian's HTMLElement extensions (createEl/createDiv/createSpan,
 * setText, setCssStyles, toggleClass) as much as it needs the standard ones.
 * Both are implemented here rather than shimmed onto a real prototype: the
 * strip only ever touches the handful of calls below, and a fake that
 * records classes is exactly what an assertion about `is-disabled` wants to
 * read. Measurement (getBoundingClientRect, offsetWidth) IS reached, by the
 * reader these tests get as far as: `hangUnder` returns before measuring
 * while a pop is shut - the state the C16 tests below run in - and goes on
 * to measure the strip and the button when one opens, to centre the pop
 * under it. It used to be true that no test here opened one at all. Three
 * groups at the foot of this file now do: the eraser's pop off the mode's
 * own OFF-to-ON edge, all three pops under the held-slider tests, and the
 * eraser's again off the tap that reopens it. So the rects answer zeros
 * rather than not answering at all. Nothing asserts on the placement they
 * produce - only on whether a pop is showing, and on what its slider holds.
 */
interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

describe("MobileTools: iPhone finger entry", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
	});
	afterEach(() => {
		resetPenInkForTest();
		resetPenToolsForTest();
		clearToolPicked();
	});

	function buildPhone() {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		let active = "pen";
		const execed: string[] = [];
		const focused: boolean[] = [];
		const host = fakeHost({
			activeTool: () => active,
			fingerInkAvailable: () => true,
			exec: (id) => {
				execed.push(id);
				if (id === "handwriting:inline-tool-pen") active = "pen";
				if (id === "handwriting:inline-tool-highlighter") active = "highlighter";
				if (id === "handwriting:inline-tool-pen" || id === "handwriting:inline-tool-highlighter") {
					markToolPicked();
				}
				if (id === "handwriting:pen-ink-toggle") setPenInk(!penInkEnabled());
			},
			setEditorFocus: (on) => void focused.push(on),
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		return { doc, pane, strip, execed, focused, host };
	}

	it("builds Keyboard before any pen has ever been seen", () => {
		const { pane } = buildPhone();
		expect(penHardwareEverSeen()).toBe(false);
		expect(pane.findByTipLabel("Keyboard mode (pen input off)")).not.toBeNull();
	});

	it("the apparent default Pen tap picks and arms instead of opening its slider", () => {
		const { doc, pane, strip, execed, focused, host } = buildPhone();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		expect(nibIsLit(host, "pen")).toBe(false);

		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(execed).toEqual(["handwriting:inline-tool-pen"]);
		expect(toolPickedHere()).toBe(true);
		expect(penInkEnabled()).toBe(true);
		expect(focused).toEqual([false]);
		expect(strip.openNibSlider).toBeNull();
		expect(nibIsLit(host, "pen")).toBe(true);
	});

	it("Keyboard exit can re-enter through Pen or Highlighter", () => {
		const { doc, pane, execed, focused, host } = buildPhone();
		const keyboard = pane.findByTipLabel("Keyboard mode (pen input off)");
		const pen = pane.findByTipLabel("Pen");
		const highlighter = pane.findByTipLabel("Highlighter");
		if (!keyboard || !pen || !highlighter) throw new Error("missing phone tool");

		keyboard.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(false);
		expect(toolPickedHere()).toBe(false);
		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(true);
		expect(nibIsLit(host, "pen")).toBe(true);

		keyboard.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		highlighter.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(true);
		expect(nibIsLit(host, "highlighter")).toBe(true);
		expect(execed).toEqual([
			"handwriting:pen-ink-toggle",
			"handwriting:inline-tool-pen",
			"handwriting:pen-ink-toggle",
			"handwriting:pen-ink-toggle",
			"handwriting:inline-tool-highlighter",
			"handwriting:pen-ink-toggle",
		]);
		expect(focused).toEqual([true, false, true, false]);
	});
});

class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	readonly defaultView = {
		requestAnimationFrame: (cb: () => void): number => {
			this.frames.push(cb);
			return this.frames.length;
		},
	};
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire a DOCUMENT-level handler: the strip releases a held slider here,
	 * because a drag very often ends with the pointer off the input. `type`
	 * is on the event because the drag's document-level end reads it to tell
	 * a lift from a cancel. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, preventDefault: (): void => {}, pointerType: "mouse", ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** Run every frame callback `refresh()` queued, including any queued by one. */
	flushFrames(): void {
		for (let i = 0; i < 20 && this.frames.length > 0; i++) {
			const due = this.frames.splice(0, this.frames.length);
			for (const cb of due) cb();
		}
	}
}

class FakeEl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	textContent = "";
	value = "";
	/** Mocks the DOM `hidden` property - not a class, so it needs its own
	 * field rather than riding `classes`. Nothing in `MobileTools.ts` writes
	 * it today: Delete selection, Lasso: copy selection and Lasso: paste dim
	 * instead of hiding (the owner's ruling after trying the hide on vault
	 * test 2, 2026-09-05 - see "the selection group dims rather than hides"
	 * below). Kept for whichever button first needs it. */
	hidden = false;
	readonly offsetWidth = 0;
	readonly offsetLeft = 0;
	readonly classList = {
		add: (c: string): void => void this.classes.add(c),
		remove: (c: string): void => void this.classes.delete(c),
		contains: (c: string): boolean => this.classes.has(c),
		toggle: (c: string, on?: boolean): boolean => {
			const want = on ?? !this.classes.has(c);
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};

	constructor(
		readonly tag: string,
		readonly ownerDocument: FakeDoc,
		opts: ElOpts = {}
	) {
		for (const c of (opts.cls ?? "").split(" ").filter(Boolean)) this.classes.add(c);
		for (const [k, v] of Object.entries(opts.attr ?? {})) this.attrs.set(k, v);
		if (opts.text !== undefined) this.textContent = opts.text;
	}

	createEl(tag: string, opts: ElOpts = {}): FakeEl {
		const el = new FakeEl(tag, this.ownerDocument, opts);
		this.children.push(el);
		return el;
	}
	createDiv(opts: ElOpts = {}): FakeEl {
		return this.createEl("div", opts);
	}
	createSpan(opts: ElOpts = {}): FakeEl {
		return this.createEl("span", opts);
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
	insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
		// DETACH FIRST, which the DOM does and this fake used to not:
		// `insertBefore` MOVES a node that is already a child rather than
		// adding a second copy of it. `MobileTools` builds the eraser's mode
		// chips with `createDiv` (which appends) and then insertBefore's them
		// to the front, so the eraser's pop read as chips, slider, chips here
		// and as chips, slider in a browser. Nothing asserted the pop's whole
		// shape before, so the extra child sat unnoticed.
		const had = this.children.indexOf(node);
		if (had >= 0) this.children.splice(had, 1);
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(node);
		else this.children.splice(at, 0, node);
		return node;
	}
	empty(): void {
		this.children.length = 0;
		this.textContent = "";
	}
	remove(): void {}
	setText(t: string): void {
		this.children.length = 0;
		this.textContent = t;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	/**
	 * Zeros by default: nothing here asserts on where an open pop is placed.
	 * SETTABLE since drag-to-anchor, because the drop rule is answered from
	 * boxes and a strip whose every edge is zero cannot express a drag at
	 * all - a test that wants a real pane, a real strip and a real actions
	 * row writes them here.
	 */
	rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
		return this.rect;
	}
	/**
	 * Pointer capture, recorded rather than performed. The strip takes it on
	 * the handle so the gesture keeps arriving once the finger leaves the
	 * 24px of grip it started on; there is no retargeting to model here, so
	 * what a test can read is that it was asked for and given back.
	 */
	captured: number | null = null;
	setPointerCapture(id: number): void {
		this.captured = id;
	}
	releasePointerCapture(id: number): void {
		if (this.captured === id) this.captured = null;
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	toggleClass(c: string, on: boolean): void {
		this.classList.toggle(c, on);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	/** Tag ("svg") or one class (".handwriting-sr-only"); nothing else is used. */
	querySelector(sel: string): FakeEl | null {
		for (const kid of this.children) {
			const hit = sel.startsWith(".") ? kid.classes.has(sel.slice(1)) : kid.tag === sel;
			if (hit) return kid;
			const deep = kid.querySelector(sel);
			if (deep) return deep;
		}
		return null;
	}
	contains(node: unknown): boolean {
		if (node === this) return true;
		return this.children.some((kid) => kid.contains(node));
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire the handlers the strip registered, the way a real click would. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			type,
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			target: this,
			...ev,
		};
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** The control carrying this label - ownName moves aria-label to dataset. */
	findByTipLabel(label: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.dataset.tipLabel === label) return kid;
			const deep = kid.findByTipLabel(label);
			if (deep) return deep;
		}
		return null;
	}
}

/**
 * C16, design doc 5i: Redo can sit lit and dead.
 *
 * The strip reads enablement two ways that disagree. Live, at click time:
 * `isEnabled` runs the host predicate fresh. Cached, as a class: `is-disabled`
 * is written by `refresh()` and stays until the next one - and nothing on the
 * note surface refreshes the strip when the document changes. Undo, so Redo
 * lights; type, and CodeMirror drops the redo stack; the button still looks
 * available and every press does nothing, forever.
 */
describe("MobileTools: a dimmed button's refused click corrects the stale class", () => {
	beforeEach(() => resetPenToolsForTest());

	/**
	 * Builds the strip on a fake pane and hands back the pieces a test drives.
	 * `canRedo` reads a live box, so a test can flip the predicate WITHOUT
	 * telling the strip - which is the defect itself, not a shortcut around it.
	 */
	const buildStrip = (
		redo: { value: boolean }
	): { doc: FakeDoc; execed: string[]; redoBtn: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const execed: string[] = [];
		const host = fakeHost({
			canRedo: () => redo.value,
			exec: (id: string) => void execed.push(id),
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const redoBtn = pane.findByTipLabel("Redo");
		if (!redoBtn) throw new Error("no Redo button was built");
		return { doc, execed, redoBtn };
	};

	it("dims Redo on the wasted press, once the redo stack went away underneath it", () => {
		// Redo is live when the strip is built, so it paints as available.
		const redo = { value: true };
		const { doc, execed, redoBtn } = buildStrip(redo);
		expect(redoBtn.classes.has("is-disabled")).toBe(false);

		// The document changes and CodeMirror drops the redo stack. Nothing
		// here refreshes the strip, so the LIVE predicate is now false while
		// the CACHED class still says available. That divergence is what the
		// user is looking at, and flipping the predicate alone is exactly how
		// typing produces it.
		redo.value = false;
		doc.flushFrames();
		expect(redoBtn.classes.has("is-disabled")).toBe(false);

		// Press it. The click guard refuses the command - correctly, there is
		// nothing to redo - and that refusal is the button's one chance to
		// stop lying about itself. No toast: the user asked for nothing (the
		// eraser/Backspace ruling, 2026-09-02). It just goes dim.
		redoBtn.fire("click");
		doc.flushFrames();

		expect(execed).not.toContain("editor:redo");
		expect(redoBtn.classes.has("is-disabled")).toBe(true);
		expect(redoBtn.getAttribute("aria-disabled")).toBe("true");
	});

	it("still runs Redo, and leaves it undimmed, while the redo stack is really there", () => {
		// The other half: a genuinely available button must not be dimmed by
		// the correction above. Without this, a "fix" that dimmed everything
		// on click would satisfy the test before it.
		const redo = { value: true };
		const { doc, execed, redoBtn } = buildStrip(redo);

		redoBtn.fire("click");
		doc.flushFrames();

		expect(execed).toContain("editor:redo");
		expect(redoBtn.classes.has("is-disabled")).toBe(false);
		expect(redoBtn.getAttribute("aria-disabled")).toBe("false");
	});
});

/**
 * The collapsed pill wore every tool it had ever been rather than the one in
 * hand: a pen and a highlighter overlapping inside the one circle, reported
 * with screenshots twice (alan, and samuelbits - "though it works properly",
 * which is the whole of it, the pill is cosmetic).
 *
 * `setIcon` appends, so the swap path needed the same `empty()` the chevron
 * in `setCorner` has had since the chevrons stacked the same way (glass,
 * 2026-08-31). Present since the pill started wearing the tool in hand, 1.4.5
 * included; not a 1.4.6 regression.
 */
describe("MobileTools: the collapsed pill wears one tool, not all of them", () => {
	beforeEach(() => resetPenToolsForTest());
	afterEach(() => {
		icons.appends = true;
	});

	/** Direct children only - setIcon puts its svg straight on the pill. */
	const svgCount = (el: FakeEl): number => el.children.filter((k) => k.tag === "svg").length;

	const buildPill = (over: Partial<MobileToolsHost>): { strip: MobileTools; pill: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost(over));
		const pill = pane.querySelector(".handwriting-pen-pill");
		if (!pill) throw new Error("no pen pill was built");
		return { strip, pill };
	};

	it("swaps the pill's icon on a tool change instead of stacking a second one", () => {
		markPenHardwareSeen();
		const tool = { value: "pen" };
		const lasso = { value: false };
		const { strip, pill } = buildPill({
			activeTool: () => tool.value,
			lassoOn: () => lasso.value,
		});

		// Preconditions. The pill has to be wearing something to begin with,
		// or "exactly one svg" below could pass on a pill that never drew an
		// icon at all.
		expect(pill.dataset.icon).toBe("pen");
		expect(svgCount(pill)).toBe(1);

		// Change one: pen -> highlighter, which is the report verbatim.
		tool.value = "highlighter";
		strip.refreshNow();
		expect(pill.dataset.icon).toBe("highlighter");

		// Change two: the lasso claims the tip, the nibs go dark, and the
		// pill follows to a third icon. dataset.icon is asserted at each step
		// because the swap block is guarded on it - a change that did not
		// change anything would leave this test passing for no reason.
		lasso.value = true;
		strip.refreshNow();
		expect(pill.dataset.icon).toBe("lasso");

		// The defect, as the screenshots show it.
		expect(svgCount(pill)).toBe(1);

		// Clearing the pill takes the screen reader's name with it, so it has
		// to go back in the same move, carrying the NEW label.
		expect(pill.querySelector(".handwriting-sr-only")?.textContent).toBe("Lasso tools");
		expect(pill.dataset.tipLabel).toBe("Lasso tools");
	});

	it("still falls back to the glyph when the icon renders nothing", () => {
		// Not the defect - a guard on the fix. `setText` on a pill that was
		// just emptied has to leave the same glyph behind it left on one full
		// of stale svgs, and the sr-only name still has to survive it.
		icons.appends = false;
		markPenHardwareSeen();
		const tool = { value: "pen" };
		const { strip, pill } = buildPill({ activeTool: () => tool.value });
		expect(svgCount(pill)).toBe(0);
		expect(pill.textContent).toBe("P");

		tool.value = "highlighter";
		strip.refreshNow();

		expect(pill.dataset.icon).toBe("highlighter");
		expect(svgCount(pill)).toBe(0);
		expect(pill.textContent).toBe("H");
		expect(pill.querySelector(".handwriting-sr-only")?.textContent).toBe("Highlighter tools");
	});
});

/**
 * A newly mounted strip does not open the eraser pop by itself.
 *
 * `wasEraserOn` is per-strip; the tip mode it watches is global. So a strip
 * built while the eraser was already on ran its constructor's `refreshNow`
 * with `wasEraserOn` still false, read that as the OFF-to-ON edge, and hung
 * the eraser's size pop open with no user action behind it - on every new
 * pane, every split and every popout, and again on each one after that.
 *
 * The edge itself is load-bearing and must survive the fix: it is a touch
 * user's only route back to the pop once pen contact has closed it, and it
 * is the route the palette command and a hotkey both take, neither of which
 * passes through this file's own click handler.
 */
describe("MobileTools: the eraser pop opens on a deliberate switch, not on mount", () => {
	beforeEach(() => resetPenToolsForTest());

	/** The eraser's pop is the first `dropSlider` the strip builds. */
	const eraserPop = (pane: FakeEl): FakeEl => {
		const pop = pane.querySelector(".handwriting-slider-pop");
		if (!pop) throw new Error("no slider pop was built");
		// Named rather than assumed: three pops share the class, and the pen
		// and highlighter ones are built after this. If that order ever
		// changes, this fails loudly instead of asserting about the wrong pop.
		const label = pop.querySelector("input")?.getAttribute("aria-label");
		if (label !== "Eraser size") throw new Error(`first pop is ${label}, not the eraser's`);
		return pop;
	};

	const buildStrip = (over: Partial<MobileToolsHost>): { strip: MobileTools; pop: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost(over));
		return { strip, pop: eraserPop(pane) };
	};

	it("stays shut on a strip mounted while the eraser is already on", () => {
		const { strip, pop } = buildStrip({ eraserOn: () => true });

		expect(pop.classes.has("is-showing")).toBe(false);

		// And it does not arrive one refresh late: a pane that opened the pop
		// on its second frame would be the same defect, deferred.
		strip.refreshNow();
		expect(pop.classes.has("is-showing")).toBe(false);
	});

	it("still opens when the eraser is switched on while the strip is up", () => {
		// The real edge, and the only way back to the pop for a touch user
		// once pen contact has closed it. A fix that suppressed this has
		// traded one defect for a worse one.
		const on = { value: false };
		const { strip, pop } = buildStrip({ eraserOn: () => on.value });

		expect(pop.classes.has("is-showing")).toBe(false);

		on.value = true;
		strip.refreshNow();

		expect(pop.classes.has("is-showing")).toBe(true);
	});
});

/**
 * "Weird distortion on the pen slider as i slide it up and down, like the
 * slider is just vibrating" (alan, on hardware, 2026-09-02; 1.4.7 from the
 * store, and the same code is in 1.4.6).
 *
 * `hangUnder` writes `slider.input.value` on EVERY `refreshNow` while a pop
 * is showing, with nothing asking whether that input is under a finger.
 * Refreshes land while a slider is open from several directions - a hover
 * preview on the next button along, the 300ms close timer, any command that
 * goes through refreshAllStrips - and each one shoves the control the user
 * is holding.
 *
 * Whatever an engine does with a value assigned mid-drag (the thumb may hold
 * still, it may jump, the drag may be dropped entirely - this is the part
 * nobody has demonstrated yet), writing into a control the user is holding
 * is wrong on all of them. The guard is that rule and nothing more, so it is
 * correct regardless of how the mechanism turns out.
 *
 * All three sliders, table-driven. The eraser has no lossy arithmetic to fix
 * - it is native px, no conversion at either edge - but it is dragged by the
 * same finger through the same `hangUnder`, and a fourth slider gets a row
 * here whether or not anyone remembers why.
 */
describe("MobileTools: a refresh does not write into the slider under a finger", () => {
	beforeEach(() => resetPenToolsForTest());

	/** aria-label stays on the inputs; only buttons get it moved by ownName. */
	const findByAria = (el: FakeEl, aria: string): FakeEl | null => {
		if (el.getAttribute("aria-label") === aria) return el;
		for (const kid of el.children) {
			const hit = findByAria(kid, aria);
			if (hit) return hit;
		}
		return null;
	};
	/** The pop holding the named slider: pop > slot > input, and the pops
	 * hang off the strip inside the pane rather than off the pane itself. */
	const popFor = (el: FakeEl, aria: string): FakeEl => {
		for (const kid of el.children) {
			if (kid.classes.has("handwriting-slider-pop") && findByAria(kid, aria)) return kid;
			try {
				return popFor(kid, aria);
			} catch {
				// Not down this branch; keep looking.
			}
		}
		throw new Error(`no pop was built for ${aria}`);
	};

	interface Row {
		/** The slider's aria-label, which is how the pop is found. */
		aria: string;
		/** A px value this slider can actually hold; asserted against its own step. */
		dragTo: string;
		/** Moved under the drag by something that is not the finger. */
		away: number;
		/** What `hangUnder` writes for `away` once the finger has lifted. */
		awayShown: string;
	}
	/**
	 * The readout's format, RESTATED here rather than imported from the
	 * component: one decimal where the control's step is fractional, none
	 * where it is whole, and the px unit. A test that asked the component
	 * how it formats and then checked it formatted that way would pass on
	 * any format at all.
	 */
	const DECIMALS: Record<string, number> = {
		"Eraser size": 0,
		"Pen size": 1,
		"Highlighter size": 0,
	};
	const shown = (aria: string, v: string): string =>
		`${Number(v).toFixed(DECIMALS[aria] ?? 0)}px`;

	const ROWS: Row[] = [
		// (20 - 3) / 1 = 17 steps up from the eraser's own min.
		{ aria: "Eraser size", dragTo: "20", away: 40, awayShown: "40" },
		// (3.36 - 0.66) / 0.1 = 27 steps up from the pen's min.
		{ aria: "Pen size", dragTo: "3.36", away: 1, awayShown: "2.2" },
		// (9 - 4) / 1 = 5 steps up from the highlighter's min.
		{ aria: "Highlighter size", dragTo: "9", away: 1, awayShown: "16" },
	];

	interface Rig {
		doc: FakeDoc;
		strip: MobileTools;
		pop: FakeEl;
		input: FakeEl;
		stored: () => number;
		moveUnderTheDrag: (to: number) => void;
		refreshes: () => number;
		/**
		 * How many times the host's own size setter has been called.
		 *
		 * The readout is painted from the same event that reports the value,
		 * so the count is what says the paint was ADDED to that path rather
		 * than wired into it twice - a second call per input event would
		 * double every preview the page draws under the pop.
		 */
		sets: () => number;
	}

	/** A strip with the named slider's pop open and a live store behind it. */
	const rigFor = (aria: string): Rig => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const nib = aria === "Highlighter size" ? "highlighter" : "pen";
		const sizes: Record<string, number> = { pen: 1, highlighter: 1 };
		const eraser = { on: false, radius: 10 };
		let refreshes = 0;
		let sets = 0;
		const host = fakeHost({
			// refreshNow reads this first, so it counts the refreshes that
			// actually ran - a test that asserted "unchanged" after nothing
			// happened would be asserting nothing at all.
			recordingOn: () => {
				refreshes++;
				return false;
			},
			activeTool: () => nib,
			eraserOn: () => eraser.on,
			eraserRadiusPx: () => eraser.radius,
			setEraserRadiusPx: (px: number) => {
				sets++;
				eraser.radius = px;
			},
			inkSizeMult: (tool: string) => sizes[tool] ?? 1,
			setInkSizeMult: (tool: string, mult: number) => {
				sets++;
				sizes[tool] = mult;
			},
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		const pop = popFor(pane, aria);
		const input = findByAria(pop, aria);
		if (!input) throw new Error(`no input for ${aria}`);
		if (aria === "Eraser size") {
			// The eraser pop rides the MODE, and opens on the off-to-on edge.
			eraser.on = true;
			strip.refreshNow();
		} else {
			// A nib pop opens from its button. The TOUCH tap is the route
			// used here: hover would open it just as well, but hover also
			// arms the tooltip, and that reaches for a real `window`, which
			// this suite deliberately does not have.
			const label = nib === "pen" ? "Pen" : "Highlighter";
			const btn = pane.findByTipLabel(label);
			if (!btn) throw new Error(`no ${label} button was built`);
			btn.fire("click", { pointerType: "touch" });
			doc.flushFrames();
		}
		const stored = (): number => (aria === "Eraser size" ? eraser.radius : sizes[nib]!);
		const moveUnderTheDrag = (to: number): void => {
			if (aria === "Eraser size") eraser.radius = to;
			else sizes[nib] = to;
		};
		return {
			doc,
			strip,
			pop,
			input,
			stored,
			moveUnderTheDrag,
			refreshes: () => refreshes,
			sets: () => sets,
		};
	};

	/**
	 * THE FLAT POP (1.4.12): what the pop is MADE OF, and in what order.
	 *
	 * The pop used to lead with a `.handwriting-slider-slot` - a 28x104 div
	 * holding the range input turned a quarter turn - and carry a live
	 * `.handwriting-slider-val` readout under it. Between them they were
	 * taller than every other row in the pop put together, in a control whose
	 * whole point is to stay out of the way. The SLOT is gone for good: the
	 * slider is one flat row across the pop's own width.
	 *
	 * THE NUMBER IS BACK, and it is a different element (the owner,
	 * 2026-09-06: "as well"). `.handwriting-slider-num`, on its own row
	 * directly under the track, in a box of its own with a fixed width - not
	 * `.handwriting-slider-val`, which had no box and set the pop's width
	 * between them. So the assertions that the OLD class is nowhere in the
	 * pop still hold, and still say something: they say the readout that
	 * juddered did not come back with the readout that did. The pen's pop
	 * reads slider, value, saved pens, palette; the eraser's, chips, slider,
	 * value.
	 *
	 * STRUCTURE, not geometry: this suite has no layout, so the sizes are
	 * measured in a real engine by `test/render/PopGeometry.test.ts` - which
	 * is also where "the digits cannot move the track" is settled, because
	 * that is a claim about widths and this file has none. What is checkable
	 * here is that the parts exist, are in the right order, are direct
	 * children of the pop rather than nested in a slot, and that the slider
	 * keeps its own range, step and name.
	 */
	describe("the pop is flat: no rotated slot, and the value on its own row", () => {
		/** The classes of a pop's children, in order, sliders named. */
		const shapeOf = (pop: FakeEl): string[] =>
			pop.children.map((k) => {
				if (k.tag === "input") return `input[${k.getAttribute("type")}]`;
				return [...k.classes].join(".");
			});

		for (const row of ROWS) {
			it(`builds ${row.aria} as a flat row, not a rotated slot`, () => {
				const rig = rigFor(row.aria);
				const shape = shapeOf(rig.pop);
				// The two removed parts, by the exact class names the
				// stylesheet used to reach them by.
				expect(shape.join(" ")).not.toContain("handwriting-slider-slot");
				expect(shape.join(" ")).not.toContain("handwriting-slider-val");
				// And nowhere DEEPER either: a slot moved one level down is
				// still a slot, and the shape above only reads direct
				// children.
				expect(rig.pop.querySelector(".handwriting-slider-slot")).toBeNull();
				expect(rig.pop.querySelector(".handwriting-slider-val")).toBeNull();
				// The input is the pop's own child now, which is what lets a
				// stylesheet give it the pop's full width.
				expect(rig.pop.children.some((k) => k.tag === "input")).toBe(true);
			});
		}

		it("reads slider, value, rule, saved pens, rule, palette", () => {
			const rig = rigFor("Pen size");
			expect(shapeOf(rig.pop)).toEqual([
				"input[range]",
				"handwriting-slider-num",
				"handwriting-pop-rule",
				"handwriting-pop-presets",
				"handwriting-pop-rule",
				"handwriting-pop-colors",
			]);
		});

		/**
		 * The eraser's pop shares the container and carries mode chips where a
		 * nib carries colours. It gets no rules, because it has no sections to
		 * divide: chips, then the slider.
		 */
		it("gives the eraser its chips and its slider, and no hairlines", () => {
			const rig = rigFor("Eraser size");
			expect(shapeOf(rig.pop)).toEqual([
				"handwriting-mode-chips",
				"input[range]",
				"handwriting-slider-num",
			]);
		});

		/**
		 * The rotated slot is gone; the RANGE it held is not. A redesign that
		 * quietly clipped a slider's travel would be invisible in a shape
		 * assertion, and these are the numbers the pen and highlighter
		 * multiplier bounds are converted into.
		 */
		for (const row of ROWS) {
			it(`keeps ${row.aria}'s own range and step`, () => {
				const rig = rigFor(row.aria);
				const min = Number(rig.input.getAttribute("min"));
				const max = Number(rig.input.getAttribute("max"));
				const step = Number(rig.input.getAttribute("step"));
				expect(max).toBeGreaterThan(min);
				expect(step).toBeGreaterThan(0);
				// The name a screen reader says. The readout under the track
				// is a value, not a name: it says "20" and never "Eraser
				// size", so this attribute is still the whole of the label.
				expect(rig.input.getAttribute("aria-label")).toBe(row.aria);
			});
		}
	});

	/**
	 * THE NUMBER UNDER THE TRACK.
	 *
	 * "If the number is there then it is easier to set on ones liking" and "it
	 * will be difficult to remember one like" (a second user, 2026-09-06),
	 * ruled in by the owner the same day. On glass there is no hover, so a
	 * slider with no readout tells the user what it holds only by where the
	 * thumb happens to be.
	 *
	 * What this file can check is the WIRING: that the readout exists, that it
	 * says the input's own value rather than a number recomputed beside it,
	 * that it follows both routes the input's value changes by - the finger,
	 * and the refresh that writes the control once the finger lifts - and that
	 * adding it changed nothing about what the host is told. What it cannot
	 * check is the widths, which is the whole of why the previous readout was
	 * deleted; those are measured in a real engine by
	 * `test/render/PopGeometry.test.ts`.
	 */
	describe("the slider shows its own value", () => {
		/**
		 * The base width each slider's px value is divided by to get the
		 * multiplier the host stores; null where the value IS the stored
		 * number (the eraser's slider is identity px).
		 */
		const BASE: Record<string, number | null> = {
			"Eraser size": null,
			"Pen size": DEFAULT_PEN.baseWidth,
			"Highlighter size": HIGHLIGHTER_PEN.baseWidth,
		};

		/** The readout, and the assertion that there is one to read. */
		const numOf = (rig: Rig, aria: string): FakeEl => {
			const num = rig.pop.querySelector(".handwriting-slider-num");
			expect(num, `the ${aria} pop has no readout`).not.toBeNull();
			return num!;
		};

		for (const row of ROWS) {
			it(`shows ${row.aria}'s value at both ends of its range and while dragged`, () => {
				const rig = rigFor(row.aria);
				const num = numOf(rig, row.aria);
				// The ends off the input's OWN attributes: a readout tested
				// only in the middle of a range says nothing about the two
				// values a user actually reaches for.
				const min = rig.input.getAttribute("min");
				const max = rig.input.getAttribute("max");
				expect(min, `${row.aria} has no min`).not.toBeNull();
				expect(max, `${row.aria} has no max`).not.toBeNull();
				for (const v of [min!, max!, row.dragTo]) {
					rig.input.fire("pointerdown");
					rig.input.value = v;
					rig.input.fire("input");
					// PIXELS, ROUNDED TO THE STEP. This asserted the raw string
					// the control holds until the owner ruled otherwise; the pen
					// is the row that proves the rounding does something, since
					// its 3.36 shows as "3.4px".
					expect(num.textContent).toBe(shown(row.aria, v));
				}
			});
		}

		for (const row of ROWS) {
			it(`follows the refresh that writes ${row.aria} once the finger lifts`, () => {
				const rig = rigFor(row.aria);
				const num = numOf(rig, row.aria);

				// MID-DRAG the control belongs to the finger, so a refresh
				// writes nothing - and the readout says what the control
				// holds, which is the dragged value and not the stored one.
				rig.input.fire("pointerdown");
				rig.input.value = row.dragTo;
				rig.input.fire("input");
				rig.moveUnderTheDrag(row.away);
				rig.strip.refreshNow();
				expect(rig.input.value).toBe(row.dragTo);
				expect(num.textContent).toBe(shown(row.aria, rig.input.value));

				// The finger lifts, the guard releases, and the next refresh
				// writes the control from the store. The readout has to come
				// with it: this is the one route that changes the value
				// without an `input` event ever firing.
				rig.doc.fire("pointerup");
				rig.moveUnderTheDrag(row.away);
				rig.strip.refreshNow();
				expect(rig.input.value).toBe(row.awayShown);
				expect(num.textContent).toBe(shown(row.aria, row.awayShown));
			});
		}

		/**
		 * THE NEGATIVE CONTROL. The readout is painted from the input event
		 * that already reports the value, so the thing to prove is that it
		 * was added to that path and not wired into it a second time: the
		 * host hears the same number it heard before, exactly once.
		 */
		for (const row of ROWS) {
			it(`reports ${row.aria} to the host once, unchanged, with the readout present`, () => {
				const rig = rigFor(row.aria);
				const num = numOf(rig, row.aria);

				const before = rig.sets();
				rig.input.fire("pointerdown");
				rig.input.value = row.dragTo;
				rig.input.fire("input");
				expect(rig.sets() - before, "one input event, one setter call").toBe(1);
				expect(num.textContent).toBe(shown(row.aria, row.dragTo));

				// And the VALUE is the one `dropSlider` was converting at
				// 58f4345: the eraser's slider is identity px, and the two
				// nibs' is `pxToMult` - px over the nib's base width, rounded
				// to 3dp so the float noise in a non-integer base cannot leak
				// into the stored multiplier.
				const base = BASE[row.aria];
				expect(base, `${row.aria} has no base recorded here`).not.toBeUndefined();
				const want =
					base === null
						? Number(row.dragTo)
						: Math.round((Number(row.dragTo) / base!) * 1000) / 1000;
				expect(rig.stored()).toBe(want);
			});
		}

		/**
		 * NO LAYOUT READ ON THE DRAG PATH. This runs on every input event of
		 * a drag, and a measurement here would flush style under the finger -
		 * which is the shape of the stall the pop's `touch-action` was set to
		 * fix. Read off the source through `codeOnly`, so a mention of one of
		 * these in a comment cannot satisfy or break it.
		 */
		const src = codeOnly(stripSrc).replace(/\r\n/g, "\n");

		it("paints the readout with one textContent write and no measurement", () => {
			const at = src.indexOf("const paintValue = (");
			expect(at, "paintValue is gone from MobileTools.ts").toBeGreaterThan(-1);
			const end = src.indexOf("};", at);
			expect(end, "paintValue's body has no end").toBeGreaterThan(at);
			const body = src.slice(at, end);
			expect(body).toContain("textContent");
			expect(body).not.toMatch(
				/offsetWidth|getBoundingClientRect|getComputedStyle|ResizeObserver|requestAnimationFrame/
			);
		});

		it("paints it from the input event that already reports the value", () => {
			const at = src.indexOf('input.addEventListener("input"');
			expect(at, "the slider's input listener is gone").toBeGreaterThan(-1);
			const end = src.indexOf("});", at);
			expect(end, "the input listener has no end").toBeGreaterThan(at);
			const body = src.slice(at, end);
			expect(body).toContain("paintValue(parts)");
			// Byte for byte what the listener reported before the readout
			// existed: the paint is an addition to this path, not a change
			// to it.
			expect(body).toContain("onValue(Number(input.value), false)");
		});
	});

	for (const row of ROWS) {
		it(`leaves the ${row.aria} slider alone while it is held`, () => {
			const rig = rigFor(row.aria);

			// Preconditions. The pop has to be OPEN, or `hangUnder` returns
			// before it writes anything and every assertion below passes for
			// the wrong reason.
			expect(rig.pop.classes.has("is-showing")).toBe(true);
			// And the value being dragged to has to be one the slider can
			// actually hold - `min + k * step` off the input's own
			// attributes, not off a number copied into this file.
			const min = Number(rig.input.getAttribute("min"));
			const step = Number(rig.input.getAttribute("step"));
			const steps = (Number(row.dragTo) - min) / step;
			expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);

			// The finger takes hold and drags.
			const before = rig.stored();
			rig.input.fire("pointerdown");
			rig.input.value = row.dragTo;
			rig.input.fire("input");
			expect(rig.stored()).not.toBe(before);

			// The stored value moves under the drag. Any of the refresh
			// routes can do this, and the lossy px<->mult round trip does it
			// on the two nibs without anyone's help; this states it outright
			// so the test says what it means and holds for the eraser too.
			rig.moveUnderTheDrag(row.away);
			const ran = rig.refreshes();
			rig.strip.refreshNow();

			// A refresh really did run...
			expect(rig.refreshes()).toBeGreaterThan(ran);
			// ...and it did not touch the control under the finger.
			expect(rig.input.value).toBe(row.dragTo);

			// The other half: the guard releases. A slider that stayed held
			// would go deaf to every later refresh, which is a worse defect
			// than the one being fixed - so prove the pointer coming up puts
			// the write-back back.
			rig.doc.fire("pointerup");
			rig.strip.refreshNow();
			expect(rig.input.value).toBe(row.awayShown);
		});
	}
});

/**
 * The eraser's tap, both halves at once.
 *
 * §5p gave the eraser button a branch of its own so that a re-tap reopens
 * the size pop: pen contact closes every pop (`closeInkSliders`, driven by
 * StripPenChrome), and once it had, the only route back was to switch the
 * tool off and on again - two taps through the OFF-to-ON edge `refreshNow`
 * watches. The branch was written for pen and touch alike (`ptr !== "mouse"`)
 * and so it also swallowed the tap that used to put the eraser DOWN, on
 * every device that is not a mouse. Shipped in 1.4.6.
 *
 * Either half is satisfiable alone by a fix that loses the other - deleting
 * the branch restores the toggle and reinstates the two-tap trap - so both
 * are pinned here, and the state the pop is IN is what tells them apart.
 */
describe("MobileTools: tapping the eraser while it is already active", () => {
	beforeEach(() => resetPenToolsForTest());

	const descendants = (el: FakeEl): FakeEl[] =>
		el.children.flatMap((kid) => [kid, ...descendants(kid)]);

	/** The eraser's own pop, found by the slider it carries rather than by
	 * the order the strip happens to build its three pops in. */
	const eraserPop = (pane: FakeEl): FakeEl => {
		const hit = descendants(pane).find(
			(el) =>
				el.classes.has("handwriting-slider-pop") &&
				descendants(el).some((kid) => kid.getAttribute("aria-label") === "Eraser size")
		);
		if (!hit) throw new Error("no eraser pop was built");
		return hit;
	};

	/**
	 * `eraser` is a live box the host reads, and `exec` flips it the way the
	 * command does: `main.ts`'s eraser command is a plain toggle,
	 * `on = !getInlineEraserMode()`. So a test can tell "the branch ran" from
	 * "the command ran" by reading the box rather than by trusting the strip.
	 *
	 * The strip is built with the eraser OFF and `pickUp()` switches it on.
	 * That is now the only route to an open pop: a strip stopped reading its
	 * own mount as an OFF-to-ON edge (the describe above), so building one
	 * with the eraser already on leaves every pop shut. It is also the
	 * honest sequence - the pop is showing because the user just picked the
	 * eraser up, which is the moment before the tap under test.
	 */
	const buildStrip = (
		eraser: { value: boolean }
	): {
		doc: FakeDoc;
		execed: string[];
		tools: MobileTools;
		btn: FakeEl;
		pop: FakeEl;
		pickUp: () => void;
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const execed: string[] = [];
		const host = fakeHost({
			eraserOn: () => eraser.value,
			exec: (id: string) => {
				execed.push(id);
				if (id === "handwriting:inline-tool-eraser") eraser.value = !eraser.value;
			},
		});
		const tools = new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Eraser");
		if (!btn) throw new Error("no Eraser button was built");
		const pickUp = (): void => {
			eraser.value = true;
			tools.refreshNow();
		};
		return { doc, execed, tools, btn, pop: eraserPop(pane), pickUp };
	};

	for (const ptr of ["touch", "pen"]) {
		it(`switches the eraser off on a ${ptr} tap while the pop is showing`, () => {
			// The eraser is picked up, which fires the OFF-to-ON edge and
			// hangs the pop out - the state a user is in the moment after
			// taking the tool, and the state they tap in to put it down.
			const eraser = { value: false };
			const { doc, execed, btn, pop, pickUp } = buildStrip(eraser);
			pickUp();
			expect(pop.classes.has("is-showing")).toBe(true);

			btn.fire("click", { pointerType: ptr });
			doc.flushFrames();

			expect(execed).toContain("handwriting:inline-tool-eraser");
			expect(eraser.value).toBe(false);
			expect(pop.classes.has("is-showing")).toBe(false);
		});
	}

	it("reopens the pop instead, in one tap, once pen contact has closed it", () => {
		const eraser = { value: false };
		const { doc, execed, tools, btn, pop, pickUp } = buildStrip(eraser);
		pickUp();
		expect(pop.classes.has("is-showing")).toBe(true);

		// Pen contact takes every pop down without touching the mode.
		tools.closeInkSliders();
		doc.flushFrames();
		expect(pop.classes.has("is-showing")).toBe(false);
		expect(eraser.value).toBe(true);

		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();

		// One tap, and the tool is still in hand: this is the half the §5p
		// branch exists for, and the half a bare deletion would lose.
		expect(execed).not.toContain("handwriting:inline-tool-eraser");
		expect(eraser.value).toBe(true);
		expect(pop.classes.has("is-showing")).toBe(true);
	});

	/**
	 * "mouse sould disable" (alan, 2026-09-02): a mouse only draws because
	 * its owner has no pen, so the eraser button IS the mode for them and
	 * the pop never gets in the way of putting it down.
	 *
	 * Both pop states are run, and the hidden one carries the weight: that
	 * is the exact state in which the pen tap above reopens the pop instead
	 * of switching the tool off, so it is the row that would catch a fix
	 * that reached the mouse. Neither row goes red when the fix is taken out
	 * - the mouse path is not what changed - which is the point of them.
	 */
	for (const showing of [true, false]) {
		it(`still switches the eraser off on a mouse click, pop ${
			showing ? "showing" : "hidden"
		}`, () => {
			const eraser = { value: false };
			const { doc, execed, tools, btn, pop, pickUp } = buildStrip(eraser);
			pickUp();
			if (!showing) {
				// Pen contact, the same way the reopen test gets there.
				tools.closeInkSliders();
				doc.flushFrames();
			}
			// Asserted, not assumed: a row that had silently lost its own
			// state would be the other row over again.
			expect(pop.classes.has("is-showing")).toBe(showing);
			expect(eraser.value).toBe(true);

			btn.fire("click", { pointerType: "mouse" });
			doc.flushFrames();

			expect(execed).toContain("handwriting:inline-tool-eraser");
			expect(eraser.value).toBe(false);
		});
	}
});

/**
 * The nib light follows mouse ink going OFF.
 *
 * alan, 2026-09-02: "left clicking with mouse on pen and highlighter gives
 * the toast that mouse ink is now enabled, but doesnt unhighlight the boxes,
 * they are still lit". His own earlier request - "can we make sure that the
 * pen button unhilights when we click it with mouse and moes ink turns off?"
 * - shipped in 1.4.6 and did not work in 1.4.6, 1.4.7 or 1.4.8, because
 * `nibIsLit` read `penSeenThisSession()`, which every tool command sets.
 *
 * The rig wires the fake host to what the real code actually does, which is
 * the only reason this test can see the defect at all:
 *   - `inline-tool-pen` calls markPenSeen() unconditionally (main.ts)
 *   - `mouse-ink-toggle` calls markPenSeen() whenever it turns ink ON,
 *     inside its own `if (on)` (main.ts)
 *   - a mouse click on the ACTIVE nib no longer execs that command at all
 *     (1.4.10): it takes the quiet arm/release wrappers and says the loud
 *     command's own words through `host.toast`. The rig models both halves
 *     of what those wrappers do to the light - markPenSeen on the way in,
 *     clearPenHardwareSeen on the way out - which is the whole reason this
 *     test can still see the defect it was written for.
 */
describe("MobileTools: the nib light follows mouse ink going off", () => {
	beforeEach(() => resetPenToolsForTest());

	const rig = (): {
		doc: FakeDoc;
		btn: FakeEl;
		mouseInk: { value: boolean };
		toasts: string[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const mouseInk = { value: false };
		const toasts: string[] = [];
		const exec = (id: string): void => {
			if (id === "handwriting:inline-tool-pen") {
				markPenSeen();
				toasts.push("Handwriting: pen");
			}
			if (id === "handwriting:mouse-ink-toggle") {
				const on = !mouseInk.value;
				mouseInk.value = on;
				if (on) markPenSeen();
				toasts.push(on ? "Handwriting: pen" : "Handwriting: cursor");
			}
		};
		const host = fakeHost({
			exec,
			activeTool: () => "pen",
			mouseInkOn: () => mouseInk.value,
			// The two wrappers the surfaces wire (InkOverlay.ts): the arm half
			// marks the pen seen and repaints every strip, the release half
			// clears the hardware light with the mode. Modelled here rather
			// than spied, because this test is about what the LIGHT does.
			armMouseInkQuietly: () => {
				mouseInk.value = true;
				markPenSeen();
			},
			// ISOLATION, MOVED 2026-09-06 out of `penInksHere` and into the
			// wrapper that always owed it. This describe block tests whether
			// the CLICK-driven arm/disarm cycle drives the light through
			// `mouseInkOn()`; `clearPenHardwareSeen()` here flips
			// `deviceHasNeverSeenAPen()` back true on this pen-less rig, so
			// without something putting the tool down the pen-less grant
			// (`mouseDrawsFromLitTool`) relights the button on its own and
			// masks what the test is exercising. That used to be neutralised
			// with `penInksHere: () => false` (keyboard mode) on the host -
			// which now zeroes the FIRST disjunct too (`penDrawsHere`), so
			// the second test below could no longer see a real pen light
			// anything and went red on the true statement it pins.
			//
			// `clearToolPicked()` is the honest fix and was always the more
			// faithful rig: the real wrapper both surfaces wire here is
			// `releaseMouseInkQuietly` (PenToolsMode.ts), which calls
			// `disarmMouseInkQuietly` AND `clearToolPicked` - putting a tool
			// down with a mouse unpicks it. Modelling only half of it was the
			// reason the grant re-fired at all. Pen input now reads ON, as it
			// does for the user this describe is about.
			disarmMouseInkQuietly: () => {
				mouseInk.value = false;
				clearPenHardwareSeen();
				clearToolPicked();
			},
			toast: (message: string) => {
				toasts.push(message);
			},
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		return { doc, btn, mouseInk, toasts };
	};

	it("goes dark when a mouse click hands the tip back to text", () => {
		const { doc, btn, mouseInk, toasts } = rig();

		// Cold: no pen has ever been seen and mouse ink is off. Pen is the
		// nominal tool, so isActive is true - but nothing inks with it, so
		// the button is dark. Asserted rather than assumed: if this were
		// already lit the last assertion could pass for the wrong reason.
		expect(btn.classes.has("is-active")).toBe(false);

		// Click one: the mouse claims the pen, mouse ink comes on, the
		// button lights. This half worked before the fix and must keep
		// working after it.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(mouseInk.value).toBe(true);
		expect(btn.classes.has("is-active")).toBe(true);

		// Click two: Alan's click. The mouse goes back to text.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		// The BEHAVIOUR was never broken - mouse ink really did go off, and
		// the toast really did say so. Pinned so a later fix to the light
		// cannot quietly change what the button does.
		expect(mouseInk.value).toBe(false);
		expect(toasts.at(-1)).toBe("Handwriting: cursor");

		// The LIGHT is the defect: "doesnt unhighlight the boxes".
		expect(btn.classes.has("is-active")).toBe(false);
	});

	/**
	 * The other half of the same rule, and the one a careless fix breaks: a
	 * real pen lights the nib with mouse ink off and keeps it lit. Deleting
	 * the `penHardwareSeen()` disjunct outright would pass the test above and
	 * fail this one, leaving every pen user with a permanently dark strip.
	 */
	it("stays lit for a real pen with mouse ink off", () => {
		markPenHardwareSeen();
		const { btn, mouseInk } = rig();
		expect(mouseInk.value).toBe(false);
		expect(btn.classes.has("is-active")).toBe(true);
	});
});

/**
 * The size slider previews what the tip can DO, not what it is nominally set to.
 *
 * alan, 2026-09-03: "plain mouse without mouse ink armed should not open the
 * slider popout, correct?" He is right, and it was broken. The hover branch
 * read `spec.isActive`, which means "the nominal tool" and deliberately
 * ignores mouse ink (see ButtonSpec.isLit for why the two predicates are split
 * at all), so a plain mouse with ink off hovered the Pen button and was handed
 * a size slider for a tool that could not lay down a stroke. The BUTTON was
 * already dark beside it - the light read `isLit` and the preview did not,
 * which is two controls on one button disagreeing about the same question.
 *
 * The hover gate now uses the render path's own resolution,
 * `spec.isLit ?? spec.isActive`, so buttons without their own `isLit` - all of
 * them but the two nibs - are untouched, and the eraser's separate §5p preview
 * branch keeps its own ruling.
 *
 * WHAT IS DELIBERATELY NOT CHANGED: the click path. Clicking an unlit nib is
 * the only way a mouse user arms mouse ink at all (the final else's
 * `armMouseInkQuietly`), and gating that would strand them with no way in. The
 * last test here is the one that goes red if anyone tidies the two into
 * agreement.
 *
 * The window shim is why this describe stands apart: the hover path arms the
 * tooltip through `window.setTimeout`, which the rest of this suite avoids by
 * opening pops with a touch tap instead. Here hover IS the subject, so the
 * timers are supplied and made flushable.
 */
describe("MobileTools: hover previews a nib that can ink, and no other", () => {
	let timers: Array<{ id: number; fn: () => void }> = [];
	let priorWindow: unknown;

	beforeEach(() => {
		resetPenToolsForTest();
		timers = [];
		let next = 1;
		priorWindow = (globalThis as Record<string, unknown>).window;
		(globalThis as Record<string, unknown>).window = {
			setTimeout: (fn: () => void): number => {
				const id = next++;
				timers.push({ id, fn });
				return id;
			},
			clearTimeout: (id: number): void => {
				const at = timers.findIndex((t) => t.id === id);
				if (at >= 0) timers.splice(at, 1);
			},
		};
	});

	afterEach(() => {
		(globalThis as Record<string, unknown>).window = priorWindow;
	});

	/** Run every pending timer, the tooltip's included - harmless on fakes. */
	const flushTimers = (): void => {
		const due = timers.splice(0, timers.length);
		for (const t of due) t.fn();
	};

	const rig = (
		over: Partial<MobileToolsHost> = {}
	): {
		doc: FakeDoc;
		strip: MobileTools;
		btn: FakeEl;
		mouseInk: { value: boolean };
		armed: string[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const mouseInk = { value: false };
		const armed: string[] = [];
		const host = fakeHost({
			activeTool: () => "pen",
			mouseInkOn: () => mouseInk.value,
			armMouseInkQuietly: () => {
				armed.push("quiet");
				mouseInk.value = true;
			},
			...over,
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		return { doc, strip, btn, mouseInk, armed };
	};

	/**
	 * CHANGED, 2026-09-05: "button should become the truth" and its addendum.
	 * BEFORE, both assertions here were the OTHER way - dark, and hover
	 * offered nothing - documented in this test's own comment as "Alan's
	 * case exactly", meaning the ORIGINAL bug this whole ruling reverses: a
	 * plain mouse, pen-less, no explicit arm. `InlinePenRouter
	 * .mouseActsAsPen` now genuinely lets this mouse ink with the nominal
	 * tool, so a dark button offering no preview would be exactly the stale
	 * reading the ruling exists to fix - the preview must follow the same
	 * truth the light does, or hovering a nib that genuinely inks would
	 * offer nothing while the identical, explicitly-armed case two tests
	 * below gets its slider. NOW asserts the mirror of that case: lit, and
	 * the hover opens the size slider exactly as an armed mouse's does.
	 *
	 * FALSIFIABILITY: this test was never a hardware-vs-session regression
	 * guard (it never marks or clears hardware seen) and still is not -
	 * that guard lives in the `nibIsLit` unit tests (MobileTools.test.ts's
	 * own `describe("nibIsLit", ...)`), not here. This one now pins the
	 * addendum's positive, end-to-end (DOM + hover) case; see the test
	 * below for the negative one it used to be, isolated to where it still
	 * genuinely applies (keyboard mode).
	 */
	/**
	 * CHANGED AGAIN, 2026-09-05 (`mouse-lit-truth`), and again the SETUP is
	 * the change: `markToolPicked()` is new, the two assertions are not.
	 * As written this described a device at LAUNCH with nothing picked, and
	 * asserted it was lit and previewing - which is the defect itself, since
	 * that same state also inked a plain left-drag that should have selected
	 * text. "A tool is lit" is pen ink enabled AND a tool picked; picking one
	 * here is what makes the sentence this test's name asserts actually true.
	 * The launch state it used to cover is now pinned, dark, in the test
	 * below it.
	 */
	it("a plain mouse with ink off is offered the preview once a tool is picked", () => {
		markToolPicked();
		const { doc, strip, btn } = rig();
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(true);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	/**
	 * ADDED for `mouse-lit-truth`: the same plain mouse STRAIGHT FROM LAUNCH.
	 * Nothing picked, so nothing inks, so the button is dark and the hover
	 * offers nothing - and the router, reading the same predicate, leaves the
	 * drag to the editor. The pair above and here is the whole rule in the
	 * DOM: the preview follows the light follows the draw.
	 */
	it("a plain mouse at launch is offered nothing - no tool has been picked yet", () => {
		const { doc, strip, btn } = rig();
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(false);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe(null);
	});

	/**
	 * ADDED: the genuine negative case the test above used to stand in for.
	 * `penInksHere: () => false` is keyboard mode - the tip does nothing at
	 * all, pen or mouse - so neither `penHardwareSeen()`,
	 * `h.mouseInkOn()` nor the new pen-less grant can be true, and a mouse
	 * hovering a nib that genuinely cannot ink is still offered nothing.
	 */
	it("a plain mouse in keyboard mode is offered nothing - nothing inks there, pen-less grant included", () => {
		const { doc, strip, btn } = rig({ penInksHere: () => false });
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(false);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe(null);
	});

	/**
	 * ADDED 2026-09-06 with "unlit while the keyboard mode is on", because the
	 * light going out MOVES this gate too and an unpinned consequence is how
	 * a rule gets tidied back apart later. The hover branch reads the render
	 * path's own `spec.isLit ?? spec.isActive`, so darkening the nib in
	 * keyboard mode also stops the size slider previewing there - and that is
	 * the same ruling arriving at the same answer by the road it already
	 * takes, not a side effect: the pop previews what the tip can DO, and in
	 * keyboard mode a pen does nothing. The mouse's version of this case is
	 * the test above; this is the PEN device, the only one that has the
	 * Keyboard button at all, and the only one where the old code left the
	 * button lit and the slider dropping for a pen that could not draw.
	 */
	it("a PEN in keyboard mode is offered nothing either - the pop previews what the tip can do", () => {
		markPenHardwareSeen();
		const { doc, strip, btn } = rig({ penInksHere: () => false });
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(false);
		// A pen reaches this branch: only touch is turned away above it.
		btn.fire("pointerenter", { pointerType: "pen" });
		doc.flushFrames();
		expect(strip.openNibSlider, "keyboard mode dropped a size slider").toBe(null);
	});

	it("a mouse with ink armed still gets its preview", () => {
		const { doc, strip, btn, mouseInk } = rig();
		mouseInk.value = true;
		strip.refreshNow();
		expect(btn.classes.has("is-active")).toBe(true);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("a real pen gets its preview with mouse ink off", () => {
		// The interaction with the pdf fix, and why it matters: once a surface
		// sets the hardware flag its pen user is lit and gets the preview. A
		// PDF-only pen user was dark before that fix, so tightening this gate
		// on its own would have taken their slider away too.
		markPenHardwareSeen();
		const { doc, strip, btn, mouseInk } = rig();
		expect(mouseInk.value).toBe(false);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("a pen hovering the glass gets it too", () => {
		markPenHardwareSeen();
		const { doc, strip, btn } = rig();
		btn.fire("pointerenter", { pointerType: "pen" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("leaving a previewed nib still closes the pop on the timer", () => {
		// The close half. `scheduleSliderClose` only closes what hover opened,
		// so a gate that stops hover opening must not leave a pop behind that
		// nothing will now take away.
		markPenHardwareSeen();
		const { doc, strip, btn } = rig();
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		btn.fire("pointerleave", { pointerType: "mouse" });
		flushTimers();
		doc.flushFrames();
		expect(strip.openNibSlider).toBe(null);
	});

	it("a tap-opened pop survives a hover that can no longer open one", () => {
		// The other side of the same worry. A touch tap opens the pop as a
		// DECISION (sliderFromHover false). A mouse then crosses the button
		// with ink off: the new gate skips the branch, so no
		// `cancelSliderClose` runs - and the leave timer still declines to
		// close a pop that hover did not open. Nothing leaks, and nothing the
		// user asked for is taken away.
		const { doc, strip, btn } = rig();
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		btn.fire("pointerenter", { pointerType: "mouse" });
		btn.fire("pointerleave", { pointerType: "mouse" });
		flushTimers();
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("clicking an unlit nib still arms mouse ink", () => {
		// HOVER ONLY. This is the way in for a mouse user with no pen and it
		// runs through the click chain's `isActive` branches, which are
		// untouched. If a later change points the click path at `isLit` too,
		// this goes red and says why.
		const { doc, strip, btn, mouseInk, armed } = rig({
			// The tip is not the pen right now, so the click is a PICK rather
			// than a toggle - the final else, which is the branch that arms.
			activeTool: () => "highlighter",
		});
		expect(mouseInk.value).toBe(false);
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(armed).toEqual(["quiet"]);
		expect(mouseInk.value).toBe(true);
		expect(strip.openNibSlider).toBe("pen");
	});
});

/**
 * Putting a tool DOWN with a mouse hands the pointer back to text.
 *
 * ALAN, 2026-09-03. The two nibs already did this - clicking the nib you are
 * drawing with calls `setMouseInk(false)` - but the other four tip tools only
 * toggled back to the last nib. For a MOUSE that is not putting anything down:
 * the pointer is still claimed and still cannot select text, so the only way
 * back to the cursor from the eraser was to click a button you were not using.
 * His words: "much more consistent for them all to be dropped and revert back
 * to mouse cursor", and the extra click that costs is "correct behavior.
 * sometimes you need the mouse cursor back".
 *
 * PEN AND TOUCH ARE DELIBERATELY UNCHANGED and are pinned here as such. A
 * pen's resting state IS the nib, so returning there is already its put-down;
 * there is no cursor for it to get back. He asked for the two to stay as they
 * are while he thinks the flow through, so a change reaching them is a
 * regression against a live instruction, not a bonus.
 *
 * A second regression rode in on this feature (alan, hardware finding
 * 2026-09-03: "toast is incorrect ... it says highlighter after doing it"):
 * `exec(spec.commandId)` is what actually reverts the mode, and that
 * command's own Notice is written for a pen or touch tap really picking the
 * nib the tip fell back to - true for THEM, false for a mouse put-down, which
 * picked nothing. `markMousePutDown` (MouseInk.ts) is how the strip tells
 * that command its toast is about to be wrong; `putDownFlagAtExec` below
 * reads `consumeMousePutDown()` from INSIDE the exec mock, at the exact point
 * the real command callback would read it, so these tests pin both that the
 * flag is set and that it is set in time - not merely that it is set
 * eventually.
 */
describe("MobileTools: a mouse putting a tip tool down gets its cursor back", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		// Drain any flag a previous test's exec never consumed, so no test
		// here can pass because an EARLIER test left it set.
		consumeMousePutDown();
	});

	const TOOLS = [
		{ label: "Eraser", id: "handwriting:inline-tool-eraser", key: "eraserOn" },
		{ label: "Lasso", id: "handwriting:inline-tool-lasso", key: "lassoOn" },
		{ label: "Insert space", id: "handwriting:inline-tool-space", key: "spaceOn" },
		{ label: "Pan", id: "handwriting:inline-tool-pan", key: "panOn" },
	] as const;

	const rig = (
		tool: (typeof TOOLS)[number],
		opts: { active: boolean; inkOn: boolean }
	): {
		btn: FakeEl;
		doc: FakeDoc;
		disarmed: number;
		armed: number;
		execed: string[];
		putDownFlagAtExec: boolean | null;
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const state = { active: opts.active, ink: opts.inkOn };
		const counts = { disarmed: 0, armed: 0 };
		const execed: string[] = [];
		let putDownFlagAtExec: boolean | null = null;
		const host = fakeHost({
			[tool.key]: () => state.active,
			mouseInkOn: () => state.ink,
			exec: (id: string) => {
				execed.push(id);
				if (id === tool.id) {
					// Read-and-clear, exactly as the real command's
					// `tipModeOffNotice` (main.ts) would while building its
					// own Notice - this IS that read, moved into the test.
					putDownFlagAtExec = consumeMousePutDown();
					state.active = !state.active;
				}
			},
			armMouseInkQuietly: () => {
				counts.armed++;
				state.ink = true;
			},
			disarmMouseInkQuietly: () => {
				counts.disarmed++;
				state.ink = false;
			},
		} as Partial<MobileToolsHost>);
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel(tool.label);
		if (!btn) throw new Error(`no ${tool.label} button was built`);
		return {
			btn,
			doc,
			get disarmed() {
				return counts.disarmed;
			},
			get armed() {
				return counts.armed;
			},
			execed,
			get putDownFlagAtExec() {
				return putDownFlagAtExec;
			},
		};
	};

	for (const tool of TOOLS) {
		it(`${tool.label}: a mouse click while active hands the cursor back`, () => {
			const r = rig(tool, { active: true, inkOn: true });
			r.btn.fire("click", { pointerType: "mouse" });
			// The tool still comes off through its own command - the put-down
			// is the tool AND the pointer, not one instead of the other.
			expect(r.execed).toContain(tool.id);
			expect(r.disarmed).toBe(1);
		});

		it(`${tool.label}: a mouse put-down tells the command its toast is wrong, before the command runs`, () => {
			const r = rig(tool, { active: true, inkOn: true });
			r.btn.fire("click", { pointerType: "mouse" });
			// If this is null, exec never ran (a different bug); if it is
			// false, the flag was not set before exec, which is exactly the
			// state that leaves the OFF toast naming a nib nobody picked.
			expect(r.putDownFlagAtExec).toBe(true);
		});

		it(`${tool.label}: a mouse click while INACTIVE still arms, unchanged`, () => {
			const r = rig(tool, { active: false, inkOn: false });
			r.btn.fire("click", { pointerType: "mouse" });
			expect(r.armed).toBe(1);
			expect(r.disarmed).toBe(0);
			// Picking UP is not putting down: the exec's own toast IS right
			// for this edge (it names what was picked), so the flag must
			// stay clear.
			expect(r.putDownFlagAtExec).toBe(false);
		});

		for (const ptr of ["pen", "touch"] as const) {
			it(`${tool.label}: a ${ptr} click while active does NOT touch mouse ink`, () => {
				const r = rig(tool, { active: true, inkOn: true });
				r.btn.fire("click", { pointerType: ptr });
				expect(r.disarmed).toBe(0);
				expect(r.armed).toBe(0);
				// A pen or touch tap really did just pick the nib the tip
				// fell back to - the exec's toast is correct for them, so
				// the flag that overrides it must never be seen true here
				// (some tools' pen/touch tap does not even reach exec - the
				// eraser's own pop-reopen branch is one - so `null`, meaning
				// exec never ran on this id at all, is an equally clean pass).
				expect(r.putDownFlagAtExec).not.toBe(true);
				// And whether or not exec ran, nothing may be left armed for
				// the NEXT off-toggle to pick up by mistake.
				expect(consumeMousePutDown()).toBe(false);
			});
		}
	}
});

/**
 * A `saved` object the click chain can actually REACH, for the two describes
 * below.
 *
 * The point of `saved` is that a regression which starts writing data.json
 * again makes an assertion fail. A bare `const saved = { mouseInk: false }`
 * does not do that: no production code can see it, so `expect(saved.mouseInk)
 * .toBe(false)` is a claim about a literal and would pass against the very
 * code these tests forbid (adversarial review, 2026-09-04).
 *
 * The regression has one shape - going back through the LOUD toggle command,
 * where `settings.mouseInk = on` and `persistSettings()` live (main.ts) and
 * which is how `host.setMouseInk` reached them before 1.4.10. So the fake
 * host's `exec` MODELS that command, persist included: any click that routes
 * to `handwriting:mouse-ink-toggle` writes `saved.mouseInk` here and the
 * assertions catch it. `execs` records the ids for the same reason from the
 * other side - a click that quietly stopped doing anything at all would pass
 * a "nothing was written" assertion by doing nothing.
 */
interface LoudModel {
	saved: { mouseInk: boolean };
	toasts: string[];
	execs: string[];
	/** The loud command, persist and Notice included. True if it ran. */
	loud(id: string): boolean;
}
const loudModel = (savedMouseInk: boolean): LoudModel => {
	const m: LoudModel = {
		saved: { mouseInk: savedMouseInk },
		toasts: [],
		execs: [],
		loud: (id: string): boolean => {
			if (id !== "handwriting:mouse-ink-toggle") return false;
			const on = !mouseInkEnabled();
			setMouseInk(on);
			// The two lines that make this the LOUD path (main.ts).
			m.saved.mouseInk = on;
			if (on) markPenSeen();
			m.toasts.push(on ? "Handwriting: pen" : "Handwriting: cursor");
			return true;
		},
	};
	return m;
};

/**
 * The strip's own quiet edges, end to end through the real MouseInk module
 * instead of a counter.
 *
 * The rigs above wire `armMouseInkQuietly`/`disarmMouseInkQuietly` to spies,
 * which pins that the click chain CALLS them and says nothing about what they
 * then do. Since alan's ruling (2026-09-04, "dont persist a quiet arm") what
 * they do is the interesting half: arm this session and write nothing.
 * QuietMouseInkFanout.test.ts pins that the module has no route to disk left;
 * these two pin that the button a mouse user actually presses is wired to
 * those functions and not to some second arming path of its own.
 *
 * The eraser is the tool under test because a mouse click on it is the case
 * that falls all the way through to the generic exec branch - its own
 * pop-reopen branch is `ptr !== "mouse"` - so this drives the same code path
 * as lasso, insert space and pan.
 */
describe("MobileTools: the strip's quiet arm and put-down are for this session", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
		consumeMousePutDown();
	});
	// The flag is a module global shared by every test in this file, so a
	// describe that ends armed leaks an inking mouse into whatever runs next.
	afterEach(() => setMouseInk(false));

	const rig = (active: boolean, m: LoudModel): { btn: FakeEl; doc: FakeDoc } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const state = { active };
		const host = fakeHost({
			eraserOn: () => state.active,
			// The real flag, the way both surfaces wire it (InkOverlay.ts,
			// PdfInkController.ts): `mouseInkOn: () => mouseInkEnabled()`.
			mouseInkOn: () => mouseInkEnabled(),
			exec: (id: string) => {
				m.execs.push(id);
				if (m.loud(id)) return;
				if (id === "handwriting:inline-tool-eraser") {
					// The command's own read-and-clear, so a put-down cannot
					// leave the flag set for a later test.
					consumeMousePutDown();
					state.active = !state.active;
				}
			},
			armMouseInkQuietly: () => armMouseInkQuietly(),
			disarmMouseInkQuietly: () => disarmMouseInkQuietly(),
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Eraser");
		if (!btn) throw new Error("no Eraser button was built");
		return { btn, doc };
	};

	it("a mouse click on a tool it cannot use arms for the session and saves nothing", () => {
		const m = loudModel(false); // data.json - and the click CAN reach it
		setMouseInk(m.saved.mouseInk);
		const { btn, doc } = rig(false, m);

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		expect(mouseInkEnabled()).toBe(true);
		// Catches a re-routed arm: through the toggle command, `m.loud` runs
		// and writes this. No longer a claim about a literal.
		expect(m.saved.mouseInk).toBe(false);
		expect(m.execs).not.toContain("handwriting:mouse-ink-toggle");
		// main.ts onload, replayed: the arm is not there to be found.
		setMouseInk(m.saved.mouseInk);
		expect(mouseInkEnabled()).toBe(false);
	});

	it("a mouse click putting that tool down releases the session and saves nothing", () => {
		const m = loudModel(true); // turned on by name, by the command
		setMouseInk(m.saved.mouseInk);
		const { btn, doc } = rig(true, m);

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		expect(mouseInkEnabled()).toBe(false);
		expect(m.saved.mouseInk).toBe(true);
		expect(m.execs).not.toContain("handwriting:mouse-ink-toggle");
		setMouseInk(m.saved.mouseInk);
		expect(mouseInkEnabled()).toBe(true);
	});
});

/**
 * THE ACTIVE NIB'S OWN MOUSE CLICK IS THE FOURTH QUIET PATH, and until 1.4.10
 * it was the loudest thing on the strip.
 *
 * "Click the tool you are drawing with to hand the mouse back to text" (alan,
 * 2026-09-02), and click it again to draw with it: both halves called
 * `host.setMouseInk`, which both surfaces wired to `executeCommandById(
 * "handwriting:mouse-ink-toggle")` - the LOUD command, `settings.mouseInk =
 * on` and `persistSettings()` and all. So the ruling that took the persist
 * off the eraser's quiet arm (2026-09-04, "dont persist a quiet arm") left
 * the two buttons a mouse user presses most often writing data.json twice per
 * round trip, in both directions - the same "mouse ink keeps turning on by
 * itself" the ruling was about (adversarial review, 2026-09-04).
 *
 * Same rig shape as the describe above, on the nib rather than the eraser,
 * because the nib takes its OWN branch: `isActive && ptr === "mouse"` is
 * caught before the generic exec, so nothing about the eraser's path proves
 * anything about this one.
 */
describe("MobileTools: a mouse click on the ACTIVE nib is for this session", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});
	afterEach(() => setMouseInk(false));

	const rig = (m: LoudModel): { btn: FakeEl; doc: FakeDoc } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const host = fakeHost({
			activeTool: () => "pen",
			mouseInkOn: () => mouseInkEnabled(),
			exec: (id: string) => {
				m.execs.push(id);
				m.loud(id);
			},
			armMouseInkQuietly: () => armMouseInkQuietly(),
			disarmMouseInkQuietly: () => disarmMouseInkQuietly(),
			toast: (message: string) => m.toasts.push(message),
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		return { btn, doc };
	};

	it("putting the nib down is session-only and leaves the saved value alone", () => {
		const m = loudModel(true); // the mode was turned on BY NAME
		setMouseInk(m.saved.mouseInk); // main.ts onload

		const { btn, doc } = rig(m);
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		expect(mouseInkEnabled()).toBe(false);
		// The loud command's off wording, unchanged.
		expect(m.toasts).toEqual(["Handwriting: cursor"]);
		// The two that fail if the put-down goes back through the command:
		// `m.loud` would have written `false` here and pushed the id.
		expect(m.saved.mouseInk).toBe(true);
		expect(m.execs).toEqual([]);

		setMouseInk(m.saved.mouseInk); // the next launch, same one line
		expect(mouseInkEnabled()).toBe(true);
	});

	it("picking it back up arms for the session only", () => {
		const m = loudModel(false); // never turned on by name
		setMouseInk(m.saved.mouseInk);

		const { btn, doc } = rig(m);
		// Click one: a cold mouse on the active nib - "give the mouse this
		// tool", the only way in for someone with no pen.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		expect(mouseInkEnabled()).toBe(true);
		// The loud command's ON wording, which named the tip the mouse now
		// holds; `isActive` for a nib already means no tip mode is on, so
		// that expression could only ever have come out as the nib.
		expect(m.toasts).toEqual(["Handwriting: pen"]);
		expect(m.saved.mouseInk).toBe(false);
		expect(m.execs).toEqual([]);

		// Click two: back to text, and still nothing written.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(mouseInkEnabled()).toBe(false);
		expect(m.toasts).toEqual(["Handwriting: pen", "Handwriting: cursor"]);
		expect(m.saved.mouseInk).toBe(false);

		setMouseInk(m.saved.mouseInk); // the next launch
		expect(mouseInkEnabled()).toBe(false);
	});
});

/**
 * THE PUT-DOWN ON A DEVICE THAT HAS NEVER SEEN A PEN, with `mouseInkOn()`
 * FALSE THE WHOLE TIME - the second half of `mouse-lit-truth`.
 *
 * A palette or hotkey pick on such a device makes the mouse draw through the
 * DERIVED grant, which arms nothing: `mouseInkOn()` stays false. All three of
 * the strip's mouse branches asked exactly that flag, so the lit button could
 * not put itself down - clicking it fell through to the arm branch or to a
 * plain exec, and the only exit left was the pen-ink toggle, whose button is
 * hidden on precisely these devices (`shownOn`, MobileTools.ts). They ask
 * `mouseDrawsHere` now, which is either switch.
 *
 * `mouseInkOn: () => false` is hard-wired in the rig rather than modelled, so
 * a regression cannot pass by quietly arming the old flag instead.
 */
describe("MobileTools: the put-down works on a pen-less device with nothing armed", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		setMouseInk(false);
	});
	afterEach(() => {
		setMouseInk(false);
		clearToolPicked();
	});

	const rig = (over: Partial<MobileToolsHost> = {}) => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const toasts: string[] = [];
		const execs: string[] = [];
		const armed: string[] = [];
		/** What the exec'd command's own Notice would have said (main.ts's
		 * `tipModeOffNotice`): true means it read the put-down flag and
		 * substituted "Handwriting: cursor" for the nib's name. */
		const saidCursor: boolean[] = [];
		const host = fakeHost({
			activeTool: () => "pen",
			mouseInkOn: () => false,
			armMouseInkQuietly: () => armed.push("quiet"),
			// What InkOverlay.ts wires: the one place the mouse put-down is
			// written (`releaseMouseInkQuietlyEverywhere`).
			disarmMouseInkQuietly: () => releaseMouseInkQuietly(),
			exec: (id: string) => {
				execs.push(id);
				saidCursor.push(consumeMousePutDown());
			},
			toast: (message: string) => toasts.push(message),
			...over,
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		doc.flushFrames();
		return { doc, pane, toasts, execs, armed, saidCursor };
	};

	it("clicking the lit nib puts it down, with mouseInkOn() false throughout", () => {
		markToolPicked(); // what "Handwriting: Pen" from the palette leaves behind
		const { doc, pane, toasts, execs, armed } = rig();
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		expect(btn.classes.has("is-active")).toBe(true);

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		// The put-down branch, not the arm branch and not a plain exec.
		expect(armed).toEqual([]);
		expect(execs).toEqual([]);
		expect(toasts).toEqual(["Handwriting: cursor"]);
		// And the mouse is genuinely back to text: the router reads this
		// same flag through `toolIsLit`.
		expect(toolPickedHere()).toBe(false);
		expect(btn.classes.has("is-active")).toBe(false);
	});

	it("the eraser's put-down runs too, and the exec's toast is corrected to 'cursor'", () => {
		markToolPicked();
		const { doc, pane, execs, saidCursor, armed } = rig({ eraserOn: () => true });
		const btn = pane.findByTipLabel("Eraser");
		if (!btn) throw new Error("no Eraser button was built");

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		expect(execs).toEqual(["handwriting:inline-tool-eraser"]);
		// ONE toast, the command's, saying the right words - not two.
		expect(saidCursor).toEqual([true]);
		expect(armed).toEqual([]);
		expect(toolPickedHere()).toBe(false);
	});

	it("at launch the same click picks instead, and the NEXT one puts it down", () => {
		const { doc, pane, toasts, armed } = rig();
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		// Nothing picked yet, so nothing is lit and nothing is being put down.
		expect(btn.classes.has("is-active")).toBe(false);

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(armed).toEqual(["quiet"]);
		expect(toasts).toEqual(["Handwriting: pen"]);
		expect(toolPickedHere()).toBe(true);

		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(toasts).toEqual(["Handwriting: pen", "Handwriting: cursor"]);
		expect(toolPickedHere()).toBe(false);
	});
});

/**
 * The Keyboard button: the pen-off switch on the strip (design §5, PenInk.ts).
 *
 * Two e-ink reports behind it - "I couldn't see how to toggle it off or
 * activate the keyboard input when I needed it", and the pen fighting the
 * keyboard in live preview. Every other button on the strip picks what the
 * tip DOES; this one takes the tip away and gives the note back to the
 * keyboard, so the three things worth pinning are where it sits, when it
 * lights, and the focus call that only a click can make.
 */
describe("MobileTools: a paused tool click resumes that tool", () => {
	beforeEach(() => {
		resetPenInkForTest();
		resetPenToolsForTest();
		markPenHardwareSeen();
	});
	afterEach(() => resetPenInkForTest());
	const tools = [
		["pen", "Pen"], ["highlighter", "Highlighter"], ["eraser", "Eraser"],
		["lasso", "Lasso"], ["space", "Insert space"], ["pan", "Pan"],
	] as const;
	for (const [tool, label] of tools) {
		for (const [pointerType, mousePreference] of [
			["mouse", false], ["mouse", true], ["pen", false],
			["pen", true], ["touch", false], ["touch", true],
		] as const) {
			for (const alreadySelected of [false, true]) {
				it(`${pointerType} selects ${tool} from Keyboard, previously selected=${alreadySelected}, mouse preference=${mousePreference}`, () => {
					const pane = new FakeEl("div", new FakeDoc());
					let selected: string = alreadySelected ? tool : tool === "pen" ? "highlighter" : "pen";
					const rememberedNib = selected === "highlighter" ? "highlighter" : "pen";
					let nib = rememberedNib;
					const focused: boolean[] = [];
					const disarm = vi.fn();
					let mouseOn = mousePreference;
					const arm = vi.fn(() => { mouseOn = true; });
					const exec = (id: string) => {
						if (id === "handwriting:pen-ink-toggle") setPenInk(!penInkEnabled());
						else if (id === "handwriting:inline-tool-pen") penOnOff({
							tool: () => nib, tipMode: () => selected !== "pen" && selected !== "highlighter",
							pickPen: () => { selected = "pen"; nib = "pen"; markToolPicked(); }, afterFlip: () => {},
						});
						else if (id === "handwriting:inline-tool-highlighter") { selected = "highlighter"; nib = "highlighter"; markToolPicked(); }
						else if (id.startsWith("handwriting:inline-tool-")) {
							const target = id.slice("handwriting:inline-tool-".length);
							selected = selected === target ? nib : target;
							markToolPicked();
						}
					};
					// Exercise the actual PDF dispatch between the shared toolbar
					// listener and commands, without mounting a synthetic viewer.
					const pdf = new PdfInkController(
						pane as unknown as HTMLElement, pane.ownerDocument.defaultView as unknown as Window,
						() => [], () => null, () => [], () => {}, exec, () => {},
					);
					const dispatch = pdf as unknown as { stripExec(id: string): void };
					const host = fakeHost({
						exec: (id) => dispatch.stripExec(id), activeTool: () => nib,
						eraserOn: () => selected === "eraser", lassoOn: () => selected === "lasso",
						spaceOn: () => selected === "space", panOn: () => selected === "pan",
						mouseInkOn: () => mouseOn, armMouseInkQuietly: arm, disarmMouseInkQuietly: disarm,
						setEditorFocus: (on) => { focused.push(on); },
					});
					setPenInk(false);
					const strip = new MobileTools(pane as unknown as HTMLElement, host);
					pane.findByTipLabel(label)!.fire("click", { pointerType });
					expect(penInkEnabled(), "tool click left Keyboard pause enabled").toBe(true);
					expect(selected).toBe(tool);
					expect(focused).toEqual([false]);
					expect(disarm).not.toHaveBeenCalled();
						expect(arm).toHaveBeenCalledTimes(pointerType === "mouse" && !mousePreference ? 1 : 0);
						expect(host.mouseInkOn()).toBe(mousePreference || pointerType === "mouse");
					if (tool !== "pen" && tool !== "highlighter") expect(nib).toBe(rememberedNib);
					pane.findByTipLabel("Keyboard mode (pen input off)")!.fire("click", { pointerType });
					expect(penInkEnabled()).toBe(false);
					expect(selected).toBe(tool);
					strip.destroy();
				});
			}
		}
	}
	it("Undo does not leave Keyboard mode", () => {
		const pane = new FakeEl("div", new FakeDoc());
		const exec = vi.fn();
		setPenInk(false);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost({ canUndo: () => true, exec }));
		pane.findByTipLabel("Undo")!.fire("click", { pointerType: "mouse" });
		expect(penInkEnabled()).toBe(false);
		expect(exec).toHaveBeenCalledExactlyOnceWith("editor:undo");
		strip.destroy();
	});
});

describe("MobileTools: the Keyboard button hands the note to the keyboard", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		// A DEVICE THAT HAS HELD A PEN, since 1.4.12: the button is only built
		// once real pen hardware has been seen this session (alan: "yeah mouse
		// only users should never see it, i think"). Every test below is about
		// what the button DOES once it exists, so each one needs the device
		// that has it - the absence rule itself is pinned in its own block
		// further down. `markPenHardwareSeen`, not `markPenSeen`: only the
		// former sets the latch, which is the entire point of the latch.
		markPenHardwareSeen();
	});
	afterEach(() => resetPenInkForTest());

	const build = (
		over: Partial<MobileToolsHost> = {}
	): {
		doc: FakeDoc;
		pane: FakeEl;
		strip: MobileTools;
		execed: string[];
		focused: boolean[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const execed: string[] = [];
		const focused: boolean[] = [];
		const host = fakeHost({
			// Stands in for main.ts's `pen-ink-toggle` callback, whose only
			// part that matters here is the flip: the button reads the state
			// back AFTER exec to decide which way to move the keyboard, so a
			// fake that did not flip would test nothing.
			exec: (id: string) => {
				execed.push(id);
				if (id === "handwriting:pen-ink-toggle") setPenInk(!penInkEnabled());
			},
			setEditorFocus: (on: boolean) => void focused.push(on),
			// The overrides go LAST so a test can say which nib is in hand;
			// nothing below overrides `exec`, which is the road every one of
			// them needs.
			...over,
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		return { doc, pane, strip, execed, focused };
	};

	/** Labels and dividers of the strip's own row, in the order they were built. */
	const row = (pane: FakeEl): string[] => {
		const el = pane.querySelector(".handwriting-mobile-tools");
		if (!el) throw new Error("no strip was built");
		return el.children
			.filter(
				(k) =>
					k.classes.has("handwriting-mobile-tools-divider") ||
					k.dataset.tipLabel !== undefined
			)
			.map((k) =>
				k.classes.has("handwriting-mobile-tools-divider") ? "|" : k.dataset.tipLabel ?? ""
			);
	};

	it("closes the tip group: after Pan, before the selection divider", () => {
		const { pane } = build();
		const labels = row(pane);
		const at = labels.indexOf("Keyboard mode (pen input off)");
		expect(at, "the Keyboard button was not built").toBeGreaterThan(-1);
		// Its own group, not a new one: no divider between Pan and it, and
		// the next divider is the selection group's.
		expect(labels[at - 1]).toBe("Pan");
		expect(labels[at + 1]).toBe("|");
		expect(labels[at + 2]).toBe("Delete selection");
	});

	it("is dark while the pen inks and lit while the pen is off", () => {
		const { doc, pane, strip } = build();
		const btn = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!btn) throw new Error("no Keyboard button was built");
		// The light means "the keyboard has the note", so it is the one button
		// that is lit precisely when nothing else on its row can be.
		expect(btn.classes.has("is-active")).toBe(false);
		setPenInk(false);
		strip.refreshNow();
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(true);
	});

	it("reads penInksHere from the host, so a surface that keeps inking keeps its light out", () => {
		// The seam itself, still the button's only source of truth. Both real
		// surfaces answer `penInkEnabled()` today (the note overlay and, since
		// the owner's reversal, PdfInkController), so this drives it from the
		// host side rather than from the flag: a host that says the pen still
		// inks must leave the light out however the global reads, and a host
		// that says it does not must light it.
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const alwaysInks = fakeHost({ penInksHere: () => true });
		const strip = new MobileTools(pane as unknown as HTMLElement, alwaysInks);
		const btn = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!btn) throw new Error("no Keyboard button was built");

		setPenInk(false);
		strip.refreshNow();
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(false);

		const doc2 = new FakeDoc();
		const pane2 = new FakeEl("div", doc2);
		const neverInks = fakeHost({ penInksHere: () => false });
		const strip2 = new MobileTools(pane2 as unknown as HTMLElement, neverInks);
		const btn2 = pane2.findByTipLabel("Keyboard mode (pen input off)");
		if (!btn2) throw new Error("no Keyboard button was built");

		strip2.refreshNow();
		doc2.flushFrames();
		expect(btn2.classes.has("is-active")).toBe(true);
	});

	it("is built on every strip - the pdf's included - and lit there while the pen is off", () => {
		// The reversal of `penCanTurnOff`/`shownOn`, which for one commit kept
		// this button off the pdf strip entirely: "i think the dude was having
		// trouble with his keyboard coming up on pdf when he didnt want it to?
		// so why would you take keyboard mode away from pdf". Nothing asks a
		// host whether the button belongs any more, so the row is the same row
		// on every surface. Driven with the answer PdfInkController now gives
		// - `penInksHere: () => penInkEnabled()` - so the assertion is about
		// the pdf strip and not about a host shape no surface has.
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const pdfHost = fakeHost({ penInksHere: () => penInkEnabled() });
		const strip = new MobileTools(pane as unknown as HTMLElement, pdfHost);

		const labels = row(pane).filter((l) => l !== "|");
		expect(labels).toContain("Keyboard mode (pen input off)");
		const btn = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!btn) throw new Error("the pdf strip carries no Keyboard button");
		expect(btn.classes.has("is-active")).toBe(false);

		setPenInk(false);
		strip.refreshNow();
		doc.flushFrames();
		expect(btn.classes.has("is-active"), "the pdf strip's keyboard button stayed dark").toBe(
			true
		);
	});

	it("execs the toggle and takes the keyboard inside the same click", () => {
		const { doc, pane, execed, focused } = build();
		const btn = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!btn) throw new Error("no Keyboard button was built");

		// Off: the user asked to type, and the focus has to happen HERE - a
		// programmatic focus raises the soft keyboard on iOS and Android only
		// inside a user gesture, which the command reached from a hotkey or
		// the palette does not have.
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(execed).toEqual(["handwriting:pen-ink-toggle"]);
		expect(penInkEnabled()).toBe(false);
		expect(focused).toEqual([true]);
		expect(btn.classes.has("is-active")).toBe(true);

		// On again: the keyboard goes down and the glass goes back to the ink.
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(true);
		expect(focused).toEqual([true, false]);
		expect(btn.classes.has("is-active")).toBe(false);
	});

	/**
	 * THE RULING, 2026-09-06, in the owner's words: "unlit while the keyboard
	 * mode is on", under his standing rule for this strip - "button should
	 * become the truth".
	 *
	 * A pen device with a pen in hand, which is the only device that has this
	 * button at all. `nibIsLit` asked whether another TOOL held the tip and
	 * whether a pen existed, and never whether the pen could ink, so the Pen
	 * button stayed lit through keyboard mode while the pen placed carets -
	 * "lit and not drawing", the exact symptom the whole rule was written for,
	 * reached through the one door nothing had shut.
	 *
	 * DRIVEN THROUGH THE BUTTON, not through the flag: `build()`'s exec is the
	 * strip's real road to the switch (main.ts's retired-command action ->
	 * `togglePenInput`), so what this pins is what a user's finger does.
	 */
	it("puts the nib light out while the keyboard has the note, and gives it back on the same nib", () => {
		const { doc, pane } = build();
		const pen = pane.findByTipLabel("Pen");
		const kbd = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!pen || !kbd) throw new Error("the strip is missing Pen or Keyboard");

		// Precondition, asserted rather than assumed: a pen has been seen and
		// the pen is the nominal tool, so the button starts LIT. Without this
		// the last assertion could pass on a button that was never lit at all.
		doc.flushFrames();
		expect(pen.classes.has("is-active")).toBe(true);

		// Keyboard mode on. THE DEFECT: this was `true` before 2026-09-06.
		kbd.fire("click", { pointerType: "pen" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(false);
		expect(pen.classes.has("is-active"), "the pen button stayed lit in keyboard mode").toBe(
			false
		);

		// And back, on the same nib. NOT A PUT-DOWN: `setPenInk(false)`
		// unpicks the tool for the pen-less device's derived grant, but the
		// nominal tool - `h.activeTool()` - is untouched, and on a pen device
		// the light does not read the pick at all. The strip comes back
		// exactly as it was left.
		kbd.fire("click", { pointerType: "pen" });
		doc.flushFrames();
		expect(penInkEnabled()).toBe(true);
		expect(pen.classes.has("is-active"), "the pen button did not come back").toBe(true);
		expect(kbd.classes.has("is-active")).toBe(false);
	});

	/**
	 * THE SAME ROUND TRIP HOLDING THE OTHER NIB, and the one a fix that
	 * reached for the pen would break: a highlighter user coming back from
	 * typing is not asking to have the highlighter taken out of their hand
	 * (the reason `togglePenInput` is deliberately not `penOnOff` - see
	 * PenCommand.ts). Both nibs are asserted at every step, so a fix that
	 * relit the wrong one is red here rather than merely unmentioned.
	 */
	it("gives the HIGHLIGHTER back to a highlighter user, not the pen", () => {
		const { doc, pane } = build({ activeTool: () => "highlighter" });
		const pen = pane.findByTipLabel("Pen");
		const hi = pane.findByTipLabel("Highlighter");
		const kbd = pane.findByTipLabel("Keyboard mode (pen input off)");
		if (!pen || !hi || !kbd) throw new Error("the strip is missing a nib or Keyboard");

		doc.flushFrames();
		expect(hi.classes.has("is-active")).toBe(true);
		expect(pen.classes.has("is-active")).toBe(false);

		kbd.fire("click", { pointerType: "pen" });
		doc.flushFrames();
		expect(hi.classes.has("is-active"), "the highlighter stayed lit in keyboard mode").toBe(
			false
		);
		expect(pen.classes.has("is-active")).toBe(false);

		kbd.fire("click", { pointerType: "pen" });
		doc.flushFrames();
		expect(hi.classes.has("is-active"), "the highlighter did not come back").toBe(true);
		expect(pen.classes.has("is-active"), "the pen was lit for a highlighter user").toBe(false);
	});

	it("puts the keyboard on the collapsed pill, and the nib goes dark under it", () => {
		// The pill is what is on screen while the strip is folded, which is
		// exactly when someone wonders why their pen stopped drawing.
		//
		// THIS TEST'S COMMENT USED TO SAY "the pen nib stays LIT underneath -
		// `penHardwareSeen` is deliberately not cleared", and that was the
		// defect, written down as though it were the design. The pill's own
		// pen-off branch was the only thing keeping a pen icon off the folded
		// strip; the button behind it was lying. Since 2026-09-06 the nib goes
		// dark too, so the two agree instead of one covering for the other -
		// and the assertions on `pen` below are what say so, in the same test
		// as the pill, because "the pill matches the nib" is one fact.
		//
		// The branch still wins outright, and still has to: agreeing on DARK
		// is not the same as saying WHY, and only the pill can name the state.
		markPenHardwareSeen();
		const { doc, pane, strip } = build();
		const pill = pane.querySelector(".handwriting-pen-pill");
		const pen = pane.findByTipLabel("Pen");
		if (!pill || !pen) throw new Error("no pen pill or Pen button was built");
		expect(pill.dataset.icon).toBe("pen");
		expect(pen.classes.has("is-active")).toBe(true);

		setPenInk(false);
		strip.refreshNow();
		doc.flushFrames();
		expect(pill.dataset.icon).toBe("keyboard");
		expect(pill.dataset.tipLabel).toBe("Pen off");
		expect(pill.querySelector(".handwriting-sr-only")?.textContent).toBe("Pen off");
		expect(pen.classes.has("is-active"), "the pill said Pen off over a lit nib").toBe(false);

		setPenInk(true);
		strip.refreshNow();
		doc.flushFrames();
		expect(pill.dataset.icon).toBe("pen");
		expect(pill.dataset.tipLabel).toBe("Pen tools");
		expect(pen.classes.has("is-active")).toBe(true);
	});
});

/**
 * Keyboard mode is an overarching pause for mouse drawing too. A device that
 * has NEVER seen a pen must resume its derived mouse grant when the mode ends.
 *
 * On that device the mouse's grant is DERIVED from the lit tool
 * (`mouseDrawsFromLitTool`, MouseInk.ts - alan's addendum to "button should
 * become the truth": a pen-less machine has nothing else for the mouse to be),
 * and the strip's light and the router's grant reach it through one shared
 * function so they cannot disagree. The Keyboard pause gates the complete
 * mouse draw predicate while leaving the explicit preference untouched.
 *
 * FALSIFIABILITY, stated plainly because it is not the usual answer: these
 * assertions are GREEN on the code before the fix as well as after, by
 * design - "unchanged" is the whole claim. What they do go red on is the
 * wrong fix above, which is the failure actually worth catching here.
 *
 * `mouseActsAsPen(...)` is composed exactly as `InlinePenRouter.mouseActsAsPen`
 * composes it (InlinePenRouter.ts, its one call site), so this is the router's
 * real answer and not a restatement of it.
 */
describe("MobileTools: keyboard mode pauses and resumes a pen-less device's mouse ink", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		// NO `markPenHardwareSeen()`: this describe is the pen-less device,
		// so the latch stays false and `deviceHasNeverSeenAPen()` reads true.
	});
	afterEach(() => resetPenInkForTest());

	/** The router's own expression, at its own call site's shape. */
	const mouseDraws = (): boolean =>
		mouseActsAsPen("mouse", toolIsLit(penInkEnabled()), deviceHasNeverSeenAPen());

	it("keeps the derived grant riding the pick, exactly as it did before the light changed", () => {
		expect(deviceHasNeverSeenAPen()).toBe(true);

		// Launch: nothing picked, so nothing inks and a drag selects text.
		expect(mouseDraws()).toBe(false);

		// A tool picked from the palette IS the grant on this device.
		markToolPicked();
		expect(mouseDraws()).toBe(true);

		// Keyboard mode takes it, through `toolIsLit` and through
		// `setPenInk(false)`'s own unpick - both of which predate this fix and
		// neither of which the fix touches.
		setPenInk(false);
		expect(mouseDraws()).toBe(false);
		expect(toolPickedHere()).toBe(false);

		// And the way back is a PICK, not the switch: this is the behaviour
		// PenInk.ts chose on purpose ("coming up dark (right)"), and the fix
		// must not have quietly turned it into a restore.
		setPenInk(true);
		expect(mouseDraws()).toBe(false);
		markToolPicked();
		expect(mouseDraws()).toBe(true);
	});

	it("pauses the armed mouse nib in Keyboard mode while preserving its stored arm", () => {
		const host = fakeHost({ activeTool: () => "pen", mouseInkOn: () => true });
		expect(nibIsLit(host, "pen")).toBe(true);
		setPenInk(false);
		expect(nibIsLit(host, "pen"), "keyboard mode must pause an armed mouse's nib").toBe(false);
		expect(host.mouseInkOn()).toBe(true);
	});
});

/**
 * Delete selection, Lasso: copy selection and Lasso: paste DIM when they cannot
 * act, exactly like Undo and Redo - covered above in "a dimmed button's
 * refused click corrects the stale class" - present, hoverable, `is-disabled`
 * and `aria-disabled="true"`, never hidden.
 *
 * They briefly HID instead (owner's ruling, 2026-09-05: "too many icons" -
 * thirteen buttons at rest), but after trying that on vault test 2 the
 * owner ruled it back, verbatim: "on trying it out, i dont think they
 * should disappear." This pins that reversal: the three selection buttons
 * and the divider that opens their group stay in the dom and stay visible
 * no matter what `isEnabled` says.
 */
describe("MobileTools: the selection group dims rather than hides", () => {
	beforeEach(() => resetPenToolsForTest());

	const build = (over: Partial<MobileToolsHost>): { pane: FakeEl; strip: MobileTools } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost(over));
		return { pane, strip };
	};

	/** The divider drawn immediately before the named button, in the strip's
	 * own child order - `startsGroup` (MobileTools.ts) draws it right there.
	 * Used below to confirm it stays visible even when every button after it
	 * is dimmed. */
	const dividerBefore = (pane: FakeEl, label: string): FakeEl => {
		const el = pane.querySelector(".handwriting-mobile-tools");
		if (!el) throw new Error("no strip was built");
		const at = el.children.findIndex((k) => k.dataset.tipLabel === label);
		if (at < 1) throw new Error(`no ${label} button, or nothing before it`);
		const divider = el.children[at - 1];
		if (!divider || !divider.classes.has("handwriting-mobile-tools-divider")) {
			throw new Error(`element before ${label} is not the group's divider`);
		}
		return divider;
	};

	it("dims Delete, Copy and Paste with no selection and nothing to paste - present, not hidden, same as Undo", () => {
		const { pane } = build({ hasInkSelection: () => false, canPasteInk: () => false });
		const del = pane.findByTipLabel("Delete selection");
		const copy = pane.findByTipLabel("Lasso: copy selection");
		const paste = pane.findByTipLabel("Lasso: paste");
		const undo = pane.findByTipLabel("Undo");
		if (!del || !copy || !paste || !undo) {
			throw new Error("the selection group or Undo was not built");
		}
		for (const btn of [del, copy, paste]) {
			expect(btn.hidden).toBe(false);
			expect(btn.classes.has("is-disabled")).toBe(true);
			expect(btn.getAttribute("aria-disabled")).toBe("true");
		}
		expect(dividerBefore(pane, "Delete selection").hidden).toBe(false);

		// Undo's own long-standing behaviour, unchanged by any of this:
		// dimmed, never hidden. `canUndo` defaults false in `fakeHost`, so
		// this strip's Undo is disabled too - the case the two now share.
		expect(undo.hidden).toBe(false);
		expect(undo.classes.has("is-disabled")).toBe(true);
		expect(undo.getAttribute("aria-disabled")).toBe("true");
	});

	it("undims Delete and Copy once ink is selected - Paste stays dimmed, nothing hides", () => {
		const { pane } = build({ hasInkSelection: () => true, canPasteInk: () => false });
		const del = pane.findByTipLabel("Delete selection");
		const copy = pane.findByTipLabel("Lasso: copy selection");
		const paste = pane.findByTipLabel("Lasso: paste");
		if (!del || !copy || !paste) throw new Error("the selection group was not built");
		expect(del.hidden).toBe(false);
		expect(copy.hidden).toBe(false);
		expect(paste.hidden).toBe(false);
		expect(del.classes.has("is-disabled")).toBe(false);
		expect(copy.classes.has("is-disabled")).toBe(false);
		expect(paste.classes.has("is-disabled")).toBe(true);
		expect(dividerBefore(pane, "Delete selection").hidden).toBe(false);
	});

	it("undims Paste with a full ink clipboard alone - Delete and Copy stay dimmed, nothing hides", () => {
		const { pane } = build({ hasInkSelection: () => false, canPasteInk: () => true });
		const del = pane.findByTipLabel("Delete selection");
		const copy = pane.findByTipLabel("Lasso: copy selection");
		const paste = pane.findByTipLabel("Lasso: paste");
		if (!del || !copy || !paste) throw new Error("the selection group was not built");
		expect(del.hidden).toBe(false);
		expect(copy.hidden).toBe(false);
		expect(paste.hidden).toBe(false);
		expect(del.classes.has("is-disabled")).toBe(true);
		expect(copy.classes.has("is-disabled")).toBe(true);
		expect(paste.classes.has("is-disabled")).toBe(false);
		expect(dividerBefore(pane, "Delete selection").hidden).toBe(false);
	});
});

/**
 * Nothing sets `el.hidden` on these buttons today - Delete selection, Lasso:
 * copy selection and Lasso: paste dim instead of hiding (the owner tried
 * hiding them, then ruled it back after trying it on vault test 2, verbatim:
 * "i dont think they should disappear", 2026-09-05). The override below is
 * kept in styles.css anyway, for whichever button next needs `el.hidden`:
 * `.handwriting-mobile-tool` carries an author `display: flex`, and an
 * author rule beats the user-agent default `[hidden] { display: none }`
 * outright regardless of selector specificity or source order - so without
 * this override a hidden button would stay laid out and painted (dimmed,
 * hoverable, not-allowed cursor on hover) despite `hidden` being true. That
 * silent defeat is exactly what vault test 2 saw on 1.4.12-dev before this
 * override existed - a unit test over `FakeEl` cannot see a CSS cascade
 * defeat at all, in either direction.
 *
 * So this is matched against the CASCADE, not the file's text - the pattern
 * `GuardStyle.test.ts` established for the same reason: a stylesheet read
 * as text is a document, and a comment can quote a rule's selector and
 * declaration while explaining it, which reads identically to a live rule
 * under a plain substring match. `codeOnly` (`src/CodeOnly.ts`) blanks
 * comments before either regex below ever sees the text.
 */
/** The declaration body of `.handwriting-mobile-tool[hidden] { ... }` in the
 * cascade, or null if that selector is not a live rule there (commented out,
 * or only named inside a comment that explains it). */
function hiddenToolOverrideBody(sheet: string): string | null {
	const rule = /\.handwriting-mobile-tool\[hidden\]\s*\{([^}]*)\}/;
	return codeOnly(sheet).match(rule)?.[1] ?? null;
}

describe("styles.css - the [hidden] override, kept for any future el.hidden use", () => {
	it("`.handwriting-mobile-tool[hidden]` forces display:none, outranking the button's own display:flex", () => {
		const body = hiddenToolOverrideBody(css);
		expect(body, "[hidden] override present in the cascade, not merely in the file").not.toBeNull();
		// Normal specificity beats the owned display:flex rule; browser coverage
		// in ScorecardCssResidual.test.ts verifies the computed hidden state.
		expect(body!).toMatch(/display:\s*none\s*;/);
	});
});

/**
 * Fixtures for the extractor above, same shape as `GuardStyle.test.ts`'s:
 * attacked directly with sheet text instead of `styles.css`, so a green run
 * on the real sheet above is evidence rather than an artifact of a reader
 * that finds everything.
 */
describe("the hidden-override reader matches the cascade, not the document", () => {
	const RULE = ".handwriting-mobile-tool[hidden] {\n\tdisplay: none !important;\n}\n";

	it("finds the rule when it is really there", () => {
		// Anti-vacuity: a reader that matched nothing would also pass both
		// negative fixtures below while proving the opposite of what they claim.
		expect(hiddenToolOverrideBody(RULE)).toMatch(/display:\s*none\s*!important/);
	});

	it("does NOT accept a commented-out copy of the rule", () => {
		// The actual regression this guards: deleting the rule from the
		// cascade while a comment nearby still spells it out (or simply
		// forgetting to re-add it after wrapping the block in `/* */` during
		// a debugging pass) must not read as the fix still being in place.
		expect(hiddenToolOverrideBody(`/*\n${RULE}*/\n`)).toBeNull();
	});

	it("does NOT accept the rule spelled out inside prose that explains it", () => {
		const prose =
			"/*\n * The override reads\n * .handwriting-mobile-tool[hidden] { display: none !important; }\n" +
			" * so an author display rule never outranks a hidden button again.\n */\n";
		expect(hiddenToolOverrideBody(prose)).toBeNull();
	});
});


/**
 * ITEM 1: the colour moved INTO the nib pops, and the nibs wear it.
 *
 * The strip had an "Ink color" button that cycled the palette and opened a
 * pop of swatches of its own. Alan, 2026-09-05: "13 buttons is too much,
 * especially on phone", and, on where the colour should go instead, "color
 * into the pen pop fine but then pen should be colored to indicate color
 * without having to touch anything".
 *
 * So there are two separable claims here and both are pinned below: the
 * button is GONE and its swatches are a row inside each nib's own size pop
 * (its own palette, not the active tool's), and the two nib icons are
 * PAINTED with their own ink at all times - including the nib that is not
 * currently active, which is the case an `activeColor()` read could not have
 * answered and which is why the host read is parameterised by tool now.
 */
describe("MobileTools: colour lives in the nib pops and on the nib icons", () => {
	beforeEach(() => resetPenToolsForTest());

	const PENS = [
		{ name: "black", hex: "#101010" },
		{ name: "red", hex: "#dd2222" },
	];
	const HIGHLIGHTS = [
		{ name: "yellow", hex: "#ffee55" },
		{ name: "green", hex: "#66dd66" },
	];

	/** A strip whose two nibs hold different colours from different palettes. */
	const build = (
		over: Partial<MobileToolsHost> = {}
	): { doc: FakeDoc; pane: FakeEl; strip: MobileTools; picked: string[] } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const picked: string[] = [];
		const host = fakeHost({
			toolColor: (tool: string) => (tool === "highlighter" ? "#ffee55" : "#dd2222"),
			paletteFor: (tool: string) => (tool === "highlighter" ? HIGHLIGHTS : PENS),
			pickColor: (name: string, hex: string) => void picked.push(`${name} ${hex}`),
			...over,
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		return { doc, pane, strip, picked };
	};

	/** Every control on the strip that carries a name, in build order. */
	const labels = (pane: FakeEl): string[] => {
		const el = pane.querySelector(".handwriting-mobile-tools");
		if (!el) throw new Error("no strip was built");
		const out: string[] = [];
		const walk = (node: FakeEl): void => {
			for (const kid of node.children) {
				if (kid.dataset.tipLabel !== undefined) out.push(kid.dataset.tipLabel);
				walk(kid);
			}
		};
		walk(el);
		return out;
	};

	it("builds no Ink color button at all - not dimmed, absent", () => {
		const { pane } = build();
		// By the label it wore, and by the tint that used to identify it:
		// the tooltip is rewritten from the live colour on every refresh, so
		// a surviving palette button could be wearing a colour name instead.
		expect(labels(pane)).not.toContain("Ink color");
		expect(labels(pane).some((l) => l.startsWith("Ink color"))).toBe(false);
		// The two nibs are still there - this removed a button, not a nib.
		expect(pane.findByTipLabel("Pen: red")).not.toBeNull();
		expect(pane.findByTipLabel("Highlighter: yellow")).not.toBeNull();
	});

	// The heart of "without having to touch anything": BOTH nibs are painted,
	// on every refresh, whichever one the tip is actually holding. The old
	// single `activeColor()` read could answer for one of them at a time.
	it("paints each nib with its OWN ink, including the one that is not active", () => {
		const { pane } = build({ activeTool: () => "pen" });
		const pen = pane.findByTipLabel("Pen: red");
		const hl = pane.findByTipLabel("Highlighter: yellow");
		if (!pen || !hl) throw new Error("a nib button was not built");
		expect(pen.style.color).toBe("#dd2222");
		// Not the pen's colour, and not the active tool's: its own.
		expect(hl.style.color).toBe("#ffee55");
	});

	it("names the colour beside the tool in the tooltip, so a hover can say it", () => {
		const { pane } = build();
		const pen = pane.findByTipLabel("Pen: red");
		if (!pen) throw new Error("no Pen button was built");
		expect(pen.querySelector(".handwriting-sr-only")?.textContent).toBe("Pen: red");
		// A colour outside the palette has no name to give, so the button
		// keeps its plain one rather than inventing one or going blank.
		const other = build({ toolColor: () => "#123456" });
		expect(other.pane.findByTipLabel("Pen")).not.toBeNull();
	});

	/** The swatch row inside the named nib's pop, and the pop holding it. */
	const openPopColors = (
		nib: "pen" | "highlighter"
	): { row: FakeEl; pop: FakeEl; picked: string[] } => {
		const { doc, pane, picked } = build({ activeTool: () => nib });
		const label = nib === "pen" ? "Pen: red" : "Highlighter: yellow";
		const btn = pane.findByTipLabel(label);
		if (!btn) throw new Error(`no ${nib} button was built`);
		// Touch, not hover: hover also arms the tooltip, which reaches for a
		// real `window` this suite does not have (see the held-slider rig).
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		const strip = pane.querySelector(".handwriting-mobile-tools");
		if (!strip) throw new Error("no strip was built");
		const rows: FakeEl[] = [];
		const walk = (node: FakeEl): void => {
			for (const kid of node.children) {
				if (kid.classes.has("handwriting-pop-colors")) rows.push(kid);
				walk(kid);
			}
		};
		walk(strip);
		// One row per NIB pop, and none for the eraser's - two rows exist,
		// and the showing one is the only one that was filled.
		expect(rows.length).toBe(2);
		const filled = rows.filter((r) => r.children.length > 0);
		expect(filled.length, "exactly one nib's swatches are built at a time").toBe(1);
		const row = filled[0]!;
		// FakeEl carries no parentElement, so the pop is re-found as the one
		// `.handwriting-slider-pop` that contains this row.
		const pop = strip.children.find(
			(k) => k.classes.has("handwriting-slider-pop") && k.contains(row)
		);
		if (!pop) throw new Error("the swatch row was not built inside a pop");
		return { row, pop, picked };
	};

	it("gives the pen's pop the PEN's palette, current colour ringed", () => {
		const { row } = openPopColors("pen");
		expect(row.children.map((s) => s.getAttribute("aria-label"))).toEqual(["black", "red"]);
		expect(row.children.map((s) => s.style.backgroundColor)).toEqual(["#101010", "#dd2222"]);
		// `toolColor("pen")` is #dd2222, which is `red` - the second swatch.
		expect(row.children.map((s) => s.classes.has("is-current"))).toEqual([false, true]);
	});

	it("gives the highlighter's pop its OWN palette, not the pen's", () => {
		const { row } = openPopColors("highlighter");
		expect(row.children.map((s) => s.getAttribute("aria-label"))).toEqual(["yellow", "green"]);
		expect(row.children.map((s) => s.classes.has("is-current"))).toEqual([true, false]);
	});

	// The old colour pop closed itself on a pick, because picking was the
	// whole of what that pop was for. This row shares a pop with the size
	// slider, so closing on a pick would take the size control away from
	// under the finger that was about to use it.
	it("applies a tapped swatch and leaves the pop open with the size slider in it", () => {
		const { row, pop, picked } = openPopColors("pen");
		const black = row.children[0]!;
		black.fire("click", { pointerType: "touch" });
		expect(picked).toEqual(["black #101010"]);
		expect(pop.classes.has("is-showing")).toBe(true);
		// Still a size pop: the slider it shares the pop with is untouched.
		expect(pop.querySelector("input")).not.toBeNull();
	});
});

/**
 * The strip lost the button; the COMMAND is untouched, and the brief says so
 * in as many words ("`handwriting:ink-color-cycle` keeps working - it is in
 * the palette's always set"). Verified against main.ts's own source rather
 * than taken on trust: an unconditional `callback`, never a
 * `checkCallback`/`isChecking` gate, is what "always in the palette" means
 * mechanically, and it is the half a strip change could plausibly have
 * broken by tidying the command away with the button that used to exec it.
 */
describe("ink-color-cycle survives the strip button that used to exec it", () => {
	it("is still registered, and still unconditionally", () => {
		const src = codeOnly(mainSrc);
		const at = src.indexOf(`id: "ink-color-cycle"`);
		expect(at, "ink-color-cycle is no longer registered in main.ts").toBeGreaterThan(-1);
		const next = src.indexOf("this.addCommand({", at);
		const block = next === -1 ? src.slice(at) : src.slice(at, next);
		expect(block).toContain("callback:");
		expect(block).not.toContain("checkCallback");
	});

	it("is no longer a button on the strip", () => {
		// The other end of the same change, read off MobileTools.ts's own
		// source: the command id may appear in prose explaining where the
		// cycle went, and `codeOnly` blanks that before this counts it.
		expect(codeOnly(stripSrc)).not.toContain("handwriting:ink-color-cycle");
	});
});

/**
 * ITEM 2: Pan is for devices that have no other way to drag the page.
 *
 * `shownOn` is BACK on ButtonSpec after `6ad3730` removed it (that commit
 * removed `penCanTurnOff` with it, and rightly - its one predicate said the
 * pdf gets no keyboard button, which the owner reversed). What returns is a
 * different question: not "can this surface honour the button" but "does
 * this DEVICE have any use for it". Panning with the tip is a workaround for
 * having no finger, so a touchscreen makes the button redundant rather than
 * broken.
 */
describe("MobileTools: Pan is built on every device, touchscreen or not", () => {
	beforeEach(() => resetPenToolsForTest());

	const stripFor = (hasTouch: boolean): FakeEl => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		new MobileTools(pane as unknown as HTMLElement, fakeHost({ hasTouch: () => hasTouch }));
		return pane;
	};

	it("builds it on a mouse-only device", () => {
		expect(stripFor(false).findByTipLabel("Pan")).not.toBeNull();
	});

	// THE RULING THIS TEST EXISTS FOR (alan, 2026-09-05): "pan in the fold
	// list fine". Pan was absent on touch devices for a day, to buy a phone's
	// row some width; the width problem went to the fold list instead, so the
	// button is back everywhere and a narrow pane sends it under the chevron.
	// This assertion is the inverse of the one it replaces, deliberately.
	it("builds it on a touch device too - the fold, not the device, decides", () => {
		const pane = stripFor(true);
		expect(pane.findByTipLabel("Pan")).not.toBeNull();
		// The tools around it are untouched, and no divider was orphaned:
		// Pan sits inside the tip group rather than opening one.
		expect(pane.findByTipLabel("Insert space")).not.toBeNull();
		expect(pane.findByTipLabel("Eraser")).not.toBeNull();
	});

	// The host's touch answer is now read by nothing, and a strip must not
	// start caring about it again by accident: a host that flips it mid-life
	// changes no button on the strip.
	it("ignores the host's touch answer entirely, before and after a refresh", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const touch = { now: false };
		const strip = new MobileTools(
			pane as unknown as HTMLElement,
			fakeHost({ hasTouch: () => touch.now })
		);
		expect(pane.findByTipLabel("Pan")).not.toBeNull();
		touch.now = true;
		strip.refreshNow();
		doc.flushFrames();
		expect(pane.findByTipLabel("Pan")).not.toBeNull();
	});
});

/**
 * The device read itself, pinned apart from the strip that consumes it.
 *
 * `navigator.maxTouchPoints` and not `Platform.isMobile`: the two disagree on
 * exactly the machines this rule is about (a Surface running the desktop app
 * has glass; a desktop build in mobile emulation does not), so the choice is
 * asserted against the source rather than left to whoever reads it next.
 */
describe("deviceHasTouch reads the device, not the app", () => {
	afterEach(() => setHasTouchForTest(null));

	it("answers the seam when one is set, in both directions", () => {
		setHasTouchForTest(true);
		expect(deviceHasTouch()).toBe(true);
		setHasTouchForTest(false);
		expect(deviceHasTouch()).toBe(false);
	});

	it("falls back to asking the device when the seam is cleared", () => {
		setHasTouchForTest(true);
		setHasTouchForTest(null);
		// Node has no `navigator.maxTouchPoints` and no `ontouchstart`, so
		// the honest answer here is false - and, more to the point, it is an
		// ANSWER: a bare `navigator.maxTouchPoints` read would have thrown
		// inside a strip constructor on this very platform.
		expect(deviceHasTouch()).toBe(false);
	});

	it("is written against maxTouchPoints, never Platform.isMobile", () => {
		const src = codeOnly(deviceSrc);
		expect(src).toContain("maxTouchPoints");
		// The mistake this rules out by name: `Platform.isMobile` answers
		// "is this the mobile app", which is a different question.
		expect(src).not.toContain("Platform");
		expect(src).not.toContain("isMobile");
	});
});

/**
 * ITEM 3: the Keyboard button belongs to devices that have held a pen.
 *
 * Alan, 2026-09-05, ruling on it directly: "yeah mouse only users should
 * never see it, i think". The brief asked for this off `penSeen`, and that
 * flag cannot deliver it - every tool command sets it, so a mouse-only user
 * turns it true with their first press of the strip and the button appears
 * for exactly the people the ruling excludes. `penHardwareSeen()` is honest
 * but goes back to false on every mouse-ink-off, which would make the button
 * come and go. The latch is the flag that answers the question asked.
 */
describe("MobileTools: the Keyboard button waits for a pen to have been here", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
	});
	afterEach(() => resetPenInkForTest());

	// The tip string 1.4.12 reworded ("Keyboard" was unclear about what the
	// button does, 6440f87). Named once here so this block cannot be the place
	// the next rewording is missed - the four `toBeNull` assertions below pass
	// against ANY wrong string, so a stale literal would go unnoticed in half
	// of them.
	const KEYBOARD_TIP = "Keyboard mode (pen input off)";

	const stripOn = (pane: FakeEl, doc: FakeDoc): MobileTools =>
		new MobileTools(pane as unknown as HTMLElement, fakeHost());

	it("is absent on a machine that has never seen a pen", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		stripOn(pane, doc);
		expect(pane.findByTipLabel(KEYBOARD_TIP)).toBeNull();
		// Absent, not dimmed: there is no disabled Keyboard button hiding in
		// the strip either.
		const strip = pane.querySelector(".handwriting-mobile-tools");
		expect(strip?.findByTipLabel(KEYBOARD_TIP) ?? null).toBeNull();
	});

	// The flag the brief named. A mouse-only user reaches it by pressing ANY
	// tool button, because every tool command calls markPenSeen to raise the
	// strip - so a `penSeen` predicate would have shown them the button.
	it("stays absent after markPenSeen alone - the flag the brief asked for", () => {
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		stripOn(pane, doc);
		expect(pane.findByTipLabel(KEYBOARD_TIP)).toBeNull();
	});

	it("is built once real pen hardware has been seen", () => {
		markPenHardwareSeen();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		stripOn(pane, doc);
		expect(pane.findByTipLabel(KEYBOARD_TIP)).not.toBeNull();
	});

	/**
	 * 1.4.12, and the half of Alan's ruling the session-scoped latch could not
	 * deliver: "a pen device shows the Keyboard button FROM LAUNCH".
	 *
	 * This is a restart, told the way the code experiences one - the module
	 * reset, then `restorePenHardwareEverSeen()` from a settings file that
	 * says a pen has been here, then the FIRST strip of the session built with
	 * no pen anywhere near the glass. `stale()` and the rebuild it drives are
	 * the mechanism for the OTHER case (a pen arriving mid-session); on this
	 * path there is nothing stale to notice, because the very first build
	 * already had the right answer.
	 */
	it("is built on the first strip after a restore, with no pen contact at all", () => {
		restorePenHardwareEverSeen();
		expect(penHardwareEverSeen(), "the restore set the latch").toBe(true);
		// And set NOTHING else. A restored latch is a fact about the past; the
		// present-tense flags must still say no pen is in the room, or the nib
		// lights at launch and the desktop strip appears unasked.
		expect(penHardwareSeen(), "a restore is not a pen in the room").toBe(false);
		expect(penSeenThisSession(), "a restore does not raise the strip by itself").toBe(false);

		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = stripOn(pane, doc);
		expect(pane.findByTipLabel(KEYBOARD_TIP)).not.toBeNull();
		// Nothing to rebuild: the button was right the first time. A strip
		// that reported itself stale here would destroy and rebuild itself at
		// every launch on every pen device.
		expect(strip.stale(), "the first strip of the session is already correct").toBe(false);
	});

	// THE non-monotonicity that rules `penHardwareSeen()` out. Mouse ink
	// going off clears the present-tense flag deliberately (the nib light
	// must go dark "at any point"), and a button keyed off that would vanish
	// from the next strip built - the toolbar-disappearing complaint at one
	// button's scale.
	it("survives a mouse-ink-off that clears the present-tense flag", () => {
		markPenHardwareSeen();
		clearPenHardwareSeen();
		expect(penHardwareSeen(), "the present-tense flag really did go false").toBe(false);
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		stripOn(pane, doc);
		expect(pane.findByTipLabel(KEYBOARD_TIP)).not.toBeNull();
	});

	/**
	 * THE EDGE, and the reason `stale()` exists.
	 *
	 * `shownOn` runs once per strip. On a phone the strip is built at mount,
	 * before any pen has touched the glass, so the latch flips while the
	 * strip is already on screen - and a refresh cannot conjure a button that
	 * was never built. Without a rebuild the button would appear only when
	 * something else happened to recreate the strip, which on a phone is
	 * "when you reopen the note".
	 */
	it("reports itself stale on the first pen contact, so a surface can rebuild it", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = stripOn(pane, doc);
		expect(strip.stale(), "a fresh strip matches the device it was built for").toBe(false);
		markPenHardwareSeen();
		expect(strip.stale(), "the latch moved under a strip that cannot repaint it away").toBe(
			true
		);
		// A repaint is NOT the answer, which is the whole point: the button
		// still is not there until the surface rebuilds.
		strip.refreshNow();
		doc.flushFrames();
		expect(pane.findByTipLabel(KEYBOARD_TIP)).toBeNull();
		// What the surfaces do on a true answer - destroy, then build again.
		strip.destroy();
		const rebuilt = new FakeEl("div", doc);
		stripOn(rebuilt, doc);
		expect(rebuilt.findByTipLabel(KEYBOARD_TIP)).not.toBeNull();
	});

	it("stays put once the latch is set - a second contact rebuilds nothing", () => {
		markPenHardwareSeen();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = stripOn(pane, doc);
		expect(strip.stale()).toBe(false);
		markPenHardwareSeen();
		clearPenHardwareSeen();
		markPenHardwareSeen();
		// At most one rebuild per session per strip: the latch cannot go back
		// down, so nothing after the first contact asks for another.
		expect(strip.stale()).toBe(false);
	});

	// A touch device that HAS held a pen keeps its keyboard button. Pan was
	// the contrast here until 2026-09-05 - present on a mouse-only device,
	// absent on glass - and it lost that predicate when the owner put it back
	// on every device and gave the width problem to the fold list. So the
	// point stands with the assertion inverted: the pen latch is now the ONLY
	// thing that decides whether a button on this strip exists at all. This is
	// the Boox/Surface case - glass and a stylus.
	it("is independent of the touchscreen rule", () => {
		markPenHardwareSeen();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		new MobileTools(pane as unknown as HTMLElement, fakeHost({ hasTouch: () => true }));
		expect(pane.findByTipLabel(KEYBOARD_TIP)).not.toBeNull();
		expect(pane.findByTipLabel("Pan")).not.toBeNull();
	});
});

/**
 * The latch itself, apart from the strip that reads it. Three flags whose
 * names are one word apart live in PenToolsMode.ts, and the cost of
 * confusing two of them has been three releases once already.
 */
describe("penHardwareEverSeen: the third flag, and how it differs", () => {
	beforeEach(() => resetPenToolsForTest());

	it("starts false and is not set by markPenSeen", () => {
		expect(penHardwareEverSeen()).toBe(false);
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
		expect(penHardwareEverSeen()).toBe(false);
	});

	it("is set by real pen hardware, alongside the present-tense flag", () => {
		markPenHardwareSeen();
		expect(penHardwareSeen()).toBe(true);
		expect(penHardwareEverSeen()).toBe(true);
	});

	// The one behaviour that distinguishes it from its neighbour, and the
	// reason it exists at all.
	it("is NOT cleared by clearPenHardwareSeen, which its neighbour is", () => {
		markPenHardwareSeen();
		clearPenHardwareSeen();
		expect(penHardwareSeen()).toBe(false);
		expect(penHardwareEverSeen()).toBe(true);
	});

	it("is NOT cleared by a quiet mouse-ink release either", () => {
		markPenHardwareSeen();
		releaseMouseInkQuietly();
		expect(penHardwareSeen()).toBe(false);
		expect(penHardwareEverSeen()).toBe(true);
	});

	// NOT a restart any more. Since 1.4.12 the latch is written to settings
	// and restored at load, so a real restart of a device that has held a pen
	// answers TRUE - that behaviour is pinned in PenToolsMode.test.ts, where
	// the restore seam lives. What survives here is the seam's other job: it
	// is the only thing in the codebase that puts this flag back down, and a
	// suite whose first pen contact leaked into every later test would assert
	// nothing at all.
	it("is cleared by the test reset, which is the only thing that clears it", () => {
		markPenHardwareSeen();
		resetPenToolsForTest();
		expect(penHardwareEverSeen()).toBe(false);
	});
});

/**
 * ITEM 4, the strip's half: the chevron exists, toggles, and gets out of the
 * way. The DECISION about which buttons fold is `StripOverflow.test.ts`; this
 * is only about the control.
 *
 * Nothing here can make the row actually overflow - `FakeEl` answers 0 to
 * every dimension, so `layoutOverflow` bails on an unmeasurable width and
 * leaves the strip exactly as built. That bail is itself the reason every
 * other test in this file still describes a single unfolded row, so it is
 * asserted rather than assumed.
 */
describe("MobileTools: the More chevron", () => {
	beforeEach(() => resetPenToolsForTest());

	const build = (): { doc: FakeDoc; pane: FakeEl; strip: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		new MobileTools(pane as unknown as HTMLElement, fakeHost());
		const strip = pane.querySelector(".handwriting-mobile-tools");
		if (!strip) throw new Error("no strip was built");
		return { doc, pane, strip };
	};

	it("builds the chevron and the second row, both idle, on every strip", () => {
		const { pane, strip } = build();
		expect(pane.findByTipLabel("More tools")).not.toBeNull();
		expect(strip.querySelector(".handwriting-mobile-tools-more")).not.toBeNull();
		// Neither class is on: an unmeasurable width means "no fold", and
		// stylesheet-side that is a hidden chevron and a hidden row.
		expect(strip.classes.has("is-more-needed")).toBe(false);
		expect(strip.classes.has("is-more-open")).toBe(false);
	});

	it("sits AFTER every tool button, so nothing shifts under it", () => {
		const { strip } = build();
		const named = strip.children.filter((k) => k.dataset.tipLabel !== undefined);
		expect(named[named.length - 1]?.dataset.tipLabel).toBe("More tools");
	});

	it("opens and closes on a press, flipping the chevron with it", () => {
		const { pane, strip } = build();
		const more = pane.findByTipLabel("More tools");
		if (!more) throw new Error("no More button was built");
		more.fire("click", { pointerType: "touch" });
		expect(strip.classes.has("is-more-open")).toBe(true);
		more.fire("click", { pointerType: "touch" });
		expect(strip.classes.has("is-more-open")).toBe(false);
	});

	it("closes when a tool is picked - the row is a menu, not a drawer", () => {
		const { doc, pane, strip } = build();
		const more = pane.findByTipLabel("More tools");
		const eraser = pane.findByTipLabel("Eraser");
		if (!more || !eraser) throw new Error("the strip was not built");
		more.fire("click", { pointerType: "touch" });
		expect(strip.classes.has("is-more-open")).toBe(true);
		eraser.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.classes.has("is-more-open")).toBe(false);
	});

	it("closes on a tap outside the strip", () => {
		const { doc, pane, strip } = build();
		const more = pane.findByTipLabel("More tools");
		if (!more) throw new Error("no More button was built");
		more.fire("click", { pointerType: "touch" });
		expect(strip.classes.has("is-more-open")).toBe(true);
		// A document-level pointerdown whose target is not in this strip.
		doc.fire("pointerdown", { target: new FakeEl("div", doc) });
		expect(strip.classes.has("is-more-open")).toBe(false);
	});

	it("closes when the strip collapses to its pill", () => {
		const { doc, pane, strip } = build();
		const more = pane.findByTipLabel("More tools");
		const collapse = pane.findByTipLabel("Collapse pen tools");
		if (!more || !collapse) throw new Error("the strip was not built");
		more.fire("click", { pointerType: "touch" });
		collapse.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.classes.has("is-more-open")).toBe(false);
		// Put the session preference back for the tests after this one:
		// `collapsedSession` is module state and a collapsed strip would be
		// inherited by every strip built afterwards.
		const pill = pane.querySelector(".handwriting-pen-pill");
		pill?.fire("click", { pointerType: "touch" });
	});
});

/**
 * The stylesheet's half of item 4, matched against the CASCADE rather than
 * the file's text - the pattern `GuardStyle.test.ts` established, and the one
 * the `[hidden]` override below already uses: a comment can quote a selector
 * while explaining it, which reads identically to a live rule under a plain
 * substring match. `codeOnly` blanks comments before either regex sees them.
 */
describe("styles.css - the folded row is invisible until it is needed", () => {
	/**
	 * The declaration body of ONE live rule, found by its exact selector
	 * text. Substring-and-scan rather than a built regex: the selectors here
	 * are full of `.` and `-`, and a helper that escapes them for a regex is
	 * one more thing between the assertion and the sheet. `codeOnly` has
	 * already blanked every comment, so a selector quoted in prose - and
	 * these are, at length, right above the rules - cannot be found here.
	 */
	const body = (selector: string): string | null => {
		const sheet = codeOnly(css);
		let from = 0;
		for (;;) {
			const at = sheet.indexOf(selector, from);
			if (at === -1) return null;
			const rest = sheet.slice(at + selector.length);
			// The selector must be the WHOLE of what precedes the brace, or
			// `.handwriting-mobile-tools` would match inside
			// `.handwriting-mobile-tools-more` and read the wrong rule.
			const open = rest.match(/^\s*\{/);
			if (open) {
				const close = rest.indexOf("}");
				return close === -1 ? null : rest.slice(open[0].length, close);
			}
			from = at + 1;
		}
	};

	it("hides the chevron until a real measurement says the row overflowed", () => {
		expect(body(".handwriting-tools-more")).toMatch(/display:\s*none/);
		expect(
			body(".handwriting-mobile-tools.is-more-needed .handwriting-tools-more")
		).toMatch(/display:\s*flex/);
	});

	it("hides the second row until the chevron opens it, and makes it a ROW", () => {
		const shut = body(".handwriting-mobile-tools-more");
		expect(shut, "the second row's own rule is in the cascade").not.toBeNull();
		expect(shut!).toMatch(/display:\s*none/);
		// width:100% is what forces the wrap that MAKES it a second line -
		// without it the "row" would sit on the end of the first one.
		expect(shut!).toMatch(/width:\s*100%/);
		expect(
			body(".handwriting-mobile-tools.is-more-open .handwriting-mobile-tools-more")
		).toMatch(/display:\s*flex/);
	});

	// The failsafe underneath the whole fold. If a measurement is ever wrong,
	// a too-wide row must still wrap rather than clip its last buttons off
	// the glass - which is what the strip did before this slice and must go
	// on doing when the plan cannot help.
	it("keeps flex-wrap on the strip as the failsafe under the fold", () => {
		expect(body(".handwriting-mobile-tools")).toMatch(/flex-wrap:\s*wrap/);
	});

	// Anti-vacuity: a reader that found nothing would pass nothing above,
	// but a reader that found EVERYTHING would pass all of it wrongly.
	it("finds no rule for a selector that is not in the sheet", () => {
		expect(body(".handwriting-tools-more-that-does-not-exist")).toBeNull();
	});
});

/**
 * Quick pens (1.4.12 §4, §10): the chip row at the top of a nib's pop.
 *
 * The DOM half only. WHICH chips exist, which one is ringed and how big each
 * dot is are decided by `presetChips` and pinned in InkPresets.test.ts; what
 * is asserted here is that the row is built where the design put it, that it
 * is the ACTIVE nib's row, and that a chip's gestures reach the host rather
 * than being handled inside the strip.
 */
describe("MobileTools: the quick-pen row inside a nib's pop", () => {
	beforeEach(() => resetPenToolsForTest());

	const PENS = [
		{ name: "black", hex: "#101010" },
		{ name: "red", hex: "#dd2222" },
	];
	const HIGHLIGHTS = [{ name: "yellow", hex: "#ffee55" }];
	const penPreset = (hex: string, size: number): InkPreset => ({
		tool: "pen",
		hex,
		name: "starred",
		size,
	});

	/** Opens the named nib's pop and hands back its preset row. */
	const openPop = (
		nib: "pen" | "highlighter",
		over: Partial<MobileToolsHost> = {}
	): {
		doc: FakeDoc;
		row: FakeEl;
		pop: FakeEl;
		applied: number[];
		forgotten: number[];
		starred: string[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const applied: number[] = [];
		const forgotten: number[] = [];
		const starred: string[] = [];
		const host = fakeHost({
			activeTool: () => nib,
			toolColor: (tool: string) => (tool === "highlighter" ? "#ffee55" : "#dd2222"),
			paletteFor: (tool: string) => (tool === "highlighter" ? HIGHLIGHTS : PENS),
			applyPreset: (_tool: string, index: number) => void applied.push(index),
			forgetPreset: (_tool: string, index: number) => void forgotten.push(index),
			starPreset: (tool: string) => void starred.push(tool),
			...over,
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		const label = nib === "pen" ? "Pen: red" : "Highlighter: yellow";
		const btn = pane.findByTipLabel(label);
		if (!btn) throw new Error(`no ${nib} button was built`);
		// Touch, not hover: hover arms the tooltip, which reaches for a real
		// `window` this suite does not have.
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		const stripEl = pane.querySelector(".handwriting-mobile-tools");
		if (!stripEl) throw new Error("no strip was built");
		const pop = stripEl.children.find(
			(k) =>
				k.classes.has("handwriting-slider-pop") &&
				k.classes.has("is-showing") &&
				k.querySelector(".handwriting-pop-presets") !== null
		);
		if (!pop) throw new Error("no nib pop was showing");
		const row = pop.querySelector(".handwriting-pop-presets");
		if (!row) throw new Error("the pop has no preset row");
		return { doc, row, pop, applied, forgotten, starred };
	};

	const chips = (row: FakeEl): FakeEl[] =>
		row.children.filter((c) => c.classes.has("handwriting-preset-chip"));

	it("puts the row ABOVE the swatches inside the same pop", () => {
		// Design §10's one placement relation. §10 also calls the row the top
		// of the pop; the pop reads slider, saved pens, palette, so "above the
		// swatches" is what the code can honour and this is it.
		const { pop } = openPop("pen");
		const at = (cls: string): number => pop.children.findIndex((k) => k.classes.has(cls));
		expect(at("handwriting-pop-presets")).toBeGreaterThanOrEqual(0);
		expect(at("handwriting-pop-colors")).toBeGreaterThan(at("handwriting-pop-presets"));
		// And still under the slider, which nobody asked to move. The slider
		// is a direct child of the pop now rather than sitting in a rotated
		// slot, so it is found by TAG: `findIndex` on a class that no longer
		// exists returns -1, and every row in the pop is "greater than -1",
		// which is how this line went on passing after the slot was deleted.
		const slider = pop.children.findIndex((k) => k.tag === "input");
		expect(slider).toBeGreaterThanOrEqual(0);
		expect(at("handwriting-pop-presets")).toBeGreaterThan(slider);
	});

	it("shows a star and no chips for a tool nobody has starred", () => {
		const { row } = openPop("pen");
		expect(chips(row)).toHaveLength(0);
		expect(row.children.filter((c) => c.classes.has("handwriting-preset-star"))).toHaveLength(1);
	});

	it("draws one chip per preset, in the preset's colour, at its own width", () => {
		const { row } = openPop("pen", {
			presetsFor: () => [penPreset("#dd2222", 1.8), penPreset("#101010", 0.6)],
		});
		const dots = chips(row).map((c) => c.children[0]!);
		expect(dots.map((d) => d.style.backgroundColor)).toEqual(["#dd2222", "#101010"]);
		// Bold draws a bigger dot than fine - the numbers themselves are
		// `presetDotPx`'s to pin.
		expect(parseFloat(dots[0]!.style.width!)).toBeGreaterThan(parseFloat(dots[1]!.style.width!));
		// The pen in hand is red at 1x, so neither the bold nor the fine red
		// is the current one.
		expect(chips(row).map((c) => c.classes.has("is-current"))).toEqual([false, false]);
	});

	it("rings the chip the nib is actually wearing", () => {
		const { row } = openPop("pen", {
			inkSizeMult: () => 1.8,
			presetsFor: () => [penPreset("#dd2222", 1.8), penPreset("#101010", 1.8)],
		});
		expect(chips(row).map((c) => c.classes.has("is-current"))).toEqual([true, false]);
	});

	it("gives the highlighter's pop its OWN row, asked for by tool", () => {
		const asked: string[] = [];
		const { row } = openPop("highlighter", {
			presetsFor: (tool: string) => {
				asked.push(tool);
				return tool === "highlighter" ? [] : [penPreset("#dd2222", 1)];
			},
		});
		expect(asked).toContain("highlighter");
		expect(chips(row)).toHaveLength(0);
	});

	it("tapping a chip applies that slot and closes the pop", () => {
		const { doc, row, pop, applied } = openPop("pen", {
			presetsFor: () => [penPreset("#dd2222", 1.8), penPreset("#101010", 0.6)],
		});
		chips(row)[1]!.fire("click");
		// The strip's refresh is rAF-deferred, the same as every other close.
		doc.flushFrames();
		expect(applied).toEqual([1]);
		// Design §4: the pop closes behind a preset, where a swatch leaves it
		// open. The whole pen was chosen; there is nothing left to adjust.
		expect(pop.classes.has("is-showing")).toBe(false);
	});

	it("right-clicking a chip forgets that slot and never applies it", () => {
		const { row, forgotten, applied } = openPop("pen", {
			presetsFor: () => [penPreset("#dd2222", 1.8)],
		});
		chips(row)[0]!.fire("contextmenu");
		expect(forgotten).toEqual([0]);
		expect(applied).toEqual([]);
	});

	it("the star saves the pair in hand and leaves the pop open to show it", () => {
		const { doc, row, pop, starred } = openPop("pen");
		const star = row.children.find((c) => c.classes.has("handwriting-preset-star"));
		if (!star) throw new Error("no star chip was built");
		star.fire("click");
		doc.flushFrames();
		expect(starred).toEqual(["pen"]);
		expect(pop.classes.has("is-showing")).toBe(true);
	});

	it("says the star will replace when all four slots are full", () => {
		const full = Array.from({ length: 4 }, () => penPreset("#dd2222", 1));
		const { row } = openPop("pen", { presetsFor: () => full });
		const star = row.children.find((c) => c.classes.has("handwriting-preset-star"));
		expect(star?.dataset.tipLabel ?? star?.getAttribute("aria-label")).toContain("replacing");
	});
});

/**
 * The fold order is a SETTING now, which means the array this code works with
 * came off disk and can say anything. `normalizeFoldOrder` is the whole of
 * the defence, and each case below is a defect it prevents rather than a
 * tidiness: a lost button, a fold that stops early, or a button folding that
 * the row is meant to keep.
 */
describe("normalizeFoldOrder: a saved order made safe", () => {
	it("keeps a good order exactly as given", () => {
		const mine = [...DEFAULT_FOLD_ORDER].reverse();
		expect(normalizeFoldOrder(mine)).toEqual(mine);
	});

	it("drops an id this build does not know", () => {
		const got = normalizeFoldOrder(["handwriting:from-the-future", "editor:redo"]);
		expect(got).not.toContain("handwriting:from-the-future");
		expect(got[0]).toBe("editor:redo");
	});

	// A repeat would demote nothing the second time and silently shorten the
	// list by one, so a row one button too wide would stop folding early.
	it("drops a duplicate, keeping the first", () => {
		const got = normalizeFoldOrder(["editor:redo", "editor:redo"]);
		expect(got.filter((id) => id === "editor:redo")).toHaveLength(1);
		expect(got[0]).toBe("editor:redo");
	});

	// Without this a file written by a build with fewer foldable buttons
	// would leave the new ones unfoldable and the row would simply overflow.
	it("appends every missing id, in default order", () => {
		const got = normalizeFoldOrder(["handwriting:inline-tool-space"]);
		expect(got[0]).toBe("handwriting:inline-tool-space");
		expect([...got].sort()).toEqual([...DEFAULT_FOLD_ORDER].sort());
		const rest = got.slice(1);
		const expectedRest = DEFAULT_FOLD_ORDER.filter(
			(id) => id !== "handwriting:inline-tool-space"
		);
		expect(rest).toEqual(expectedRest);
	});

	// THE ONE THAT MATTERS MOST: a saved order naming a button that must
	// never fold would fold it. Pen is not in the demotable set and never
	// becomes so by being written into the file.
	it("drops an id that is not allowed to fold at all", () => {
		const got = normalizeFoldOrder(["handwriting:inline-tool-pen", "editor:redo"]);
		expect(got).not.toContain("handwriting:inline-tool-pen");
		expect(got).toEqual(["editor:redo", ...DEFAULT_FOLD_ORDER.filter((id) => id !== "editor:redo")]);
	});

	it("answers the default for anything that is not a usable array", () => {
		for (const junk of [null, undefined, 42, "editor:redo", {}, [1, 2, 3], [null]]) {
			expect(normalizeFoldOrder(junk)).toEqual([...DEFAULT_FOLD_ORDER]);
		}
	});
});

/**
 * WHERE main.ts WIRES THE FOLD ORDER, read off its own source.
 *
 * Not observable from this module: it lives in the sequence of statements in
 * `loadSettings`, and the suite cannot construct a plugin to run them. Bounded
 * at both ends, both ends asserted present and unique, CRLF normalised first,
 * and read through `codeOnly` so a prose mention cannot satisfy it.
 */
describe("main.ts reads the fold order off disk and applies it", () => {
	const src = codeOnly(mainSrc).replace(/\r\n/g, "\n");

	const onlyIndexOf = (needle: string, what: string): number => {
		const at = src.indexOf(needle);
		expect(at, `${what} is not in main.ts any more: ${needle}`).toBeGreaterThan(-1);
		expect(src.indexOf(needle, at + 1), `${what} is no longer unique in main.ts`).toBe(-1);
		return at;
	};

	it("normalises the saved field rather than trusting it", () => {
		onlyIndexOf("stripFoldOrder: normalizeFoldOrder(raw?.stripFoldOrder),", "the fold-order normalise");
	});

	// WITHIN loadSettings, and only within it. Both anchors below live in
	// that one method, so their source positions really do describe the order
	// the two statements run in. The wider guarantee - that loadSettings is
	// awaited before any surface exists - is a fact about `onload`, which is
	// a DIFFERENT method and sits EARLIER in the file than loadSettings does;
	// comparing an index from one against an index from the other compares
	// nothing at all. It is pinned separately, and by its own anchors.
	// THE DROP AND THE DROPDOWN SHARE ONE ROAD, and nothing else pinned it.
	// `setControlValue`'s toolbarCorner case no longer writes the field or
	// saves - both halves now come from this hook, so deleting the
	// registration would stop the SETTINGS DROPDOWN persisting as well as the
	// drag, and every test in this file would stay green while a user's chosen
	// placement quietly failed to survive a restart.
	it("registers the placement writer inside loadSettings, and it saves", () => {
		const hook = onlyIndexOf("setPersistToolbarCorner((corner) => {", "the placement write hook");
		const normalise = onlyIndexOf(
			"stripFoldOrder: normalizeFoldOrder(raw?.stripFoldOrder),",
			"the fold-order normalise"
		);
		expect(normalise, "the hook must be registered inside loadSettings").toBeLessThan(hook);

		const end = src.indexOf("});", hook);
		expect(end, "the hook body has no end in main.ts any more").toBeGreaterThan(hook);
		const body = src.slice(hook, end);
		expect(body).toContain("this.settings.toolbarCorner = corner;");
		expect(body, "a placement that is not saved does not survive a restart").toContain(
			"runDetached(this.persistSettings()"
		);
	});

	it("applies it inside loadSettings, after the normalise", () => {
		const normalise = onlyIndexOf(
			"stripFoldOrder: normalizeFoldOrder(raw?.stripFoldOrder),",
			"the fold-order normalise"
		);
		const apply = onlyIndexOf("setStripFoldOrder(this.settings.stripFoldOrder);", "the fold-order setter call");

		expect(normalise, "the setter must read a normalised order").toBeLessThan(apply);

		const slice = src.slice(normalise, apply);
		expect(slice.length, "the bounded slice collapsed to nothing").toBeGreaterThan(100);
		expect(slice).toContain("setToolbarCorner(this.settings.toolbarCorner);");
	});

	// And the guarantee that makes the above worth anything: settings are read
	// before the extension that builds strips is registered, so the fold order
	// is in place before the session's first strip.
	it("awaits loadSettings before registering the surface that builds strips", () => {
		const load = onlyIndexOf("await this.loadSettings();", "the settings load");
		const host = onlyIndexOf(
			"this.registerEditorExtension(inkOverlayExtension());",
			"the note surface's strip host"
		);
		expect(load, "settings must be read before any surface exists").toBeLessThan(host);
	});

	// The writer the settings control will call. It exists before the control
	// does so that slice adds a row and nothing else.
	it("has a write path that normalises, applies and saves", () => {
		const at = onlyIndexOf("applyStripFoldOrder(order: readonly string[]): void {", "the fold-order writer");
		const body = src.slice(at, at + 400);
		expect(body).toContain("normalizeFoldOrder(order)");
		expect(body).toContain("setStripFoldOrder(next)");
		expect(body).toContain("this.settings.stripFoldOrder = next;");
	});
});

/**
 * THE TIMERS, and what a strip destroyed inside one of their windows does.
 *
 * A strip is destroyed and rebuilt on a pen edge (`stale()`), so 600ms is a
 * window a real gesture lands in: press and hold a chip, the first pen contact
 * of the session rebuilds the strip underneath, and the timer fires against a
 * strip that no longer exists. The chip one had teeth - `paintPresets` empties
 * and rebuilds the row, so a hold armed on a chip that has since been redrawn
 * called `forgetPreset` with an index that now named a different pen: a
 * starred pen deleted after the finger lifted (review, 2026-09-05).
 *
 * One test per timer, each asserting the EFFECT does not happen rather than
 * that a field is null - a cleared field with an uncancelled timer would pass
 * the second and fail the user.
 */
describe("MobileTools: a strip destroyed inside a timer's window fires nothing", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		vi.useFakeTimers();
		// The suite runs on node with no DOM, and the strip reaches its timers
		// through `window`. Pointing that at globalThis is what lets the fake
		// timers see them - a captured reference taken before the fakes are
		// installed would be the real setTimeout and nothing would advance.
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const build = (
		over: Partial<MobileToolsHost> = {}
	): { doc: FakeDoc; pane: FakeEl; strip: MobileTools } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(
			pane as unknown as HTMLElement,
			fakeHost({ activeTool: () => "pen", ...over })
		);
		doc.flushFrames();
		return { doc, pane, strip };
	};

	// THE FAR END OF THE ROW, not beside the grip (alan, 2026-09-06: "it
	// already has a pulse, probably move it to trailing or far edge"). It is
	// still BUILT early - the shared tooltip has to exist before the buttons
	// are wired - so what this pins is where it ENDS UP, which is the only
	// thing anyone can see. Asserted against the grip rather than by index:
	// an index would break every time a button is added.
	it("the recording dot sits at the row's far end, past every button", () => {
		const { pane } = build({ recordingOn: () => true });
		const row = pane.querySelector(".handwriting-mobile-tools");
		expect(row, "the strip was not built").not.toBeNull();

		const kids = row!.children;
		const at = (cls: string): number => kids.findIndex((k) => k.classes.has(cls));
		const dot = at("handwriting-recording-dot");
		const grip = at("handwriting-tools-grip");
		expect(dot, "the recording dot is not on the strip").toBeGreaterThan(-1);
		expect(grip, "the grip is not on the strip").toBeGreaterThan(-1);

		expect(dot, "the dot is back beside the grip").toBeGreaterThan(grip + 1);
		// The LAST place a tool can hold: everything after it is the More
		// chevron, which a separate test pins as the final labelled control.
		const after = kids.slice(dot + 1).filter((k) => k.dataset.tipLabel !== undefined);
		expect(
			after.map((k) => k.dataset.tipLabel),
			"a labelled control other than More sits after the dot"
		).toEqual(["More tools"]);
	});

	it("the recording dot's hold does not toggle diagnostics", () => {
		const exec = vi.fn();
		const { pane, strip } = build({ exec });
		const dot = pane.querySelector(".handwriting-recording-dot");
		expect(dot, "the recording dot is on the strip").not.toBeNull();

		dot!.fire("pointerdown", { preventDefault: () => {} });
		strip.destroy();
		vi.advanceTimersByTime(2000);

		expect(exec).not.toHaveBeenCalledWith("handwriting:toggle-diagnostics");
	});

	// THE ONE THAT COST A STARRED PEN.
	it("a quick-pen chip's hold does not forget the preset", () => {
		// A TOOL IS PICKED, because the chip is only reachable through the
		// nib's hover pop and that pop only opens for a nib that can ink
		// (`nibIsLit`). This test is about the hold timer, not about the
		// grant; before `mouse-lit-truth` the launch state was wrongly lit
		// and the setup got its pop for free.
		markToolPicked();
		const forgetPreset = vi.fn();
		const { doc, pane, strip } = build({
			presetsFor: () => [{ tool: "pen", hex: "#1a1a1a", name: "black", size: 1 }],
			forgetPreset,
		});
		const penBtn = pane.findByTipLabel("Pen");
		expect(penBtn, "the pen button is on the strip").not.toBeNull();
		penBtn!.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		const chip = pane.querySelector(".handwriting-preset-chip");
		expect(chip, "the open pop carries a quick-pen chip").not.toBeNull();

		chip!.fire("pointerdown", { preventDefault: () => {} });
		strip.destroy();
		vi.advanceTimersByTime(2000);

		expect(forgetPreset).not.toHaveBeenCalled();
	});

	// And the same hold, cancelled by the ROW being rebuilt rather than by a
	// destroy: this is the path that renamed a pen rather than removing one.
	it("a chip's hold does not survive the row being repainted under it", () => {
		// Same setup correction as the test above, same reason.
		markToolPicked();
		const forgetPreset = vi.fn();
		const { doc, pane, strip } = build({
			presetsFor: () => [{ tool: "pen", hex: "#1a1a1a", name: "black", size: 1 }],
			forgetPreset,
		});
		const penBtn = pane.findByTipLabel("Pen");
		penBtn!.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		const chip = pane.querySelector(".handwriting-preset-chip");
		expect(chip).not.toBeNull();

		chip!.fire("pointerdown", { preventDefault: () => {} });
		// A repaint of the same pop: the chips are emptied and rebuilt, and
		// the armed hold belongs to a button that no longer exists.
		strip.refreshNow();
		doc.flushFrames();
		vi.advanceTimersByTime(2000);

		expect(forgetPreset).not.toHaveBeenCalled();
	});

	// DOUBLE FORGET (auditor, 2026-09-05): Windows pen and touch fire BOTH the
	// 600ms hold timer AND the contextmenu event that follows the release, and
	// both used to call forgetPreset unconditionally - one long press could
	// delete two presets. The guard is `held`, already set true by the timer;
	// the contextmenu that follows must see it and stand down.
	it("a hold that already forgot ignores the contextmenu the release fires after it", () => {
		// A TOOL IS PICKED, for the same reason its two neighbours say so: the
		// chip is only reachable through the nib's hover pop, and that pop only
		// opens for a nib that can ink. This test is about the double-forget
		// guard, not about the grant; it was written on a lane where the launch
		// state was still wrongly lit, so its setup got the pop for free.
		markToolPicked();
		const forgetPreset = vi.fn();
		const { doc, pane } = build({
			presetsFor: () => [{ tool: "pen", hex: "#1a1a1a", name: "black", size: 1 }],
			forgetPreset,
		});
		const penBtn = pane.findByTipLabel("Pen");
		penBtn!.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		const chip = pane.querySelector(".handwriting-preset-chip");
		expect(chip, "the open pop carries a quick-pen chip").not.toBeNull();

		chip!.fire("pointerdown", { preventDefault: () => {} });
		vi.advanceTimersByTime(600);
		expect(forgetPreset).toHaveBeenCalledTimes(1);

		// The same press's release, on Windows pen/touch: the contextmenu
		// event that follows the hold that already fired.
		chip!.fire("contextmenu");
		expect(forgetPreset).toHaveBeenCalledTimes(1);
	});

	it("the hover tooltip does not appear", () => {
		const { pane, strip } = build();
		const tip = pane.querySelector(".handwriting-strip-tip");
		expect(tip, "the strip carries its tooltip element").not.toBeNull();
		const undo = pane.findByTipLabel("Undo");
		expect(undo, "the undo button is on the strip").not.toBeNull();

		undo!.fire("pointerenter", { pointerType: "mouse" });
		strip.destroy();
		vi.advanceTimersByTime(2000);

		expect(tip!.classes.has("is-showing")).toBe(false);
	});
});

/**
 * DRAG TO ANCHOR (1.4.12). Alan: "drag to anchor we can get out in 1.4.12?
 * do it".
 *
 * The arithmetic - has this contact become a drag, and which of the nine did
 * it land on - is `ToolbarDrag.ts` and is pinned in its own file, against a
 * real pane with real boxes, which this suite cannot supply by accident.
 * What is pinned HERE is everything the class does around those two answers:
 * which elements are draggable at all, that a tap is still a tap, that a drop
 * reaches the one setter both surfaces share, that Escape gets the strip
 * back, and - the one with teeth - that the actions-row dodge and a live drag
 * compose instead of erasing each other.
 */
describe("MobileTools: dragging the toolbar to an anchor", () => {
	// FAKE TIMERS FOR THE WHOLE GROUP, because a drop that really lands flies
	// the last few px on a `window.setTimeout` - and this suite runs on node,
	// where there is no `window` at all until one is stubbed in. Every test
	// below that drops a strip whose anchor actually moves goes through that
	// path; the ones that drop it where it already was return before reaching
	// it, and are unaffected either way.
	beforeEach(() => {
		resetPenToolsForTest();
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	interface DragRig {
		doc: FakeDoc;
		pane: FakeEl;
		strip: MobileTools;
		el: FakeEl;
		pill: FakeEl;
		grip: FakeEl;
		/** Every placement the host was asked for, in order. */
		placed: string[];
	}

	const buildDrag = (over: Partial<MobileToolsHost> = {}): DragRig => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const placed: string[] = [];
		const strip = new MobileTools(
			pane as unknown as HTMLElement,
			fakeHost({ setPlacement: (corner) => void placed.push(corner), ...over })
		);
		// EXPANDED, said rather than assumed. `collapsedSession` is module
		// state shared by every strip in this file's run - it is a session
		// preference, deliberately - so a test that collapsed one leaves the
		// next one's strip born folded, with the pill (a zero box here) as
		// the thing that gets measured. Every drag test below that reads a
		// box wants the strip.
		strip.setCollapsed(false);
		const el = pane.querySelector(".handwriting-mobile-tools");
		const pill = pane.querySelector(".handwriting-pen-pill");
		const grip = pane.querySelector(".handwriting-tools-grip");
		if (!el || !pill || !grip) throw new Error("the strip, its pill or its grip was not built");
		return { doc, pane, strip, el, pill, grip, placed };
	};

	/**
	 * A fake element that answers where it ACTUALLY is: its resting box,
	 * shifted by whatever `paintTransform` last wrote on it.
	 *
	 * A plain `rect` cannot express this slice. Two of the strip's own reads
	 * are taken at DIFFERENT moments of the same gesture and are meant to
	 * differ: `applyHeaderClearance` clears the transform and measures the
	 * strip at rest, and the drag measures it mid-flight with the dodge - and
	 * later with the drag's own offset - still on it. A fake that answers one
	 * number to both cannot tell a dodged box from an un-dodged one, which is
	 * exactly the confusion the drop had. `resting` is a live object rather
	 * than a value so a test can move the strip's anchor under it, the way
	 * `setPlacement` does on a real surface.
	 */
	interface Resting {
		left: number;
		top: number;
		width: number;
		height: number;
	}
	const liveRect = (el: FakeEl, resting: Resting): void => {
		el.getBoundingClientRect = (): {
			left: number;
			top: number;
			right: number;
			bottom: number;
			width: number;
			height: number;
		} => {
			const seen = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform ?? "");
			const dx = seen ? Number(seen[1]) : 0;
			const dy = seen ? Number(seen[2]) : 0;
			return {
				left: resting.left + dx,
				top: resting.top + dy,
				right: resting.left + resting.width + dx,
				bottom: resting.top + resting.height + dy,
				width: resting.width,
				height: resting.height,
			};
		};
	};

	/** One whole gesture: press here, travel there, let go. */
	const gesture = (rig: DragRig, on: FakeEl, dx: number, dy: number): void => {
		on.fire("pointerdown", { pointerId: 7, clientX: 100, clientY: 100 });
		on.fire("pointermove", { pointerId: 7, clientX: 100 + dx, clientY: 100 + dy });
		rig.doc.fire("pointerup", { pointerId: 7 });
	};

	it("only the handles drag: the same gesture on a BUTTON moves nothing", () => {
		const rig = buildDrag();
		const undo = rig.pane.findByTipLabel("Undo");
		if (!undo) throw new Error("the undo button is on the strip");

		gesture(rig, undo, 300, 400);

		expect(rig.el.style.transform ?? "", "a button press translated the strip").toBe("");
		expect(rig.el.classes.has("is-dragging")).toBe(false);
		expect(rig.placed, "a button press moved the toolbar's placement").toEqual([]);

		// The same gesture on the GRIP does move it, which is what makes the
		// assertions above about the ELEMENT rather than about the gesture
		// having been built wrong.
		gesture(rig, rig.grip, 300, 400);
		expect(rig.placed.length, "the grip is draggable").toBe(1);
	});

	it("the grip is the strip's leading element and takes pointer capture", () => {
		const rig = buildDrag();
		expect(rig.el.children[0], "the grip is not the row's first element").toBe(rig.grip);
		expect(rig.grip.querySelector(".handwriting-tools-grip-dots")).not.toBeNull();

		rig.grip.fire("pointerdown", { pointerId: 3, clientX: 0, clientY: 0 });
		expect(rig.grip.captured, "the handle did not capture the pointer").toBe(3);
		rig.doc.fire("pointerup", { pointerId: 3 });
		expect(rig.grip.captured).toBeNull();
	});

	it("a tap on the pill still opens the strip; a drag on it does not", () => {
		const rig = buildDrag();
		rig.strip.setCollapsed(true);
		expect(rig.el.classes.has("is-collapsed")).toBe(true);

		// A TAP, with the pixel or two of pen jitter every tap on glass has.
		gesture(rig, rig.pill, 3, 4);
		rig.pill.fire("click");
		expect(rig.el.classes.has("is-collapsed"), "a tap on the pill no longer opens the strip").toBe(
			false
		);
		expect(rig.placed, "a tap moved the placement").toEqual([]);

		// A DRAG, whose release synthesizes the same click on the same pill.
		rig.strip.setCollapsed(true);
		gesture(rig, rig.pill, 0, 120);
		rig.pill.fire("click");
		expect(rig.el.classes.has("is-collapsed"), "a drag on the pill opened the strip").toBe(true);
		expect(rig.placed.length, "a drag on the pill did not place it").toBe(1);
	});

	it("a drop hands the chosen anchor to the setter both surfaces share", () => {
		const rig = buildDrag();
		// A 1000x800 pane with a 400x40 strip parked in its top-right corner,
		// 8px off both edges - the strip's own resting box.
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		rig.el.rect = { left: 592, top: 8, right: 992, bottom: 48, width: 400, height: 40 };

		// Down and across, to a centre of (232, 728) - nearest the bottom-left
		// anchor's resting centre of (208, 772).
		gesture(rig, rig.grip, -560, 700);

		expect(rig.placed).toEqual(["bottom-left"]);
		// And the drag's own translate is gone: the placement is what holds
		// the strip now, not an offset left behind on the element.
		expect(rig.el.style.transform).toBe("");
		expect(rig.el.classes.has("is-dragging")).toBe(false);
	});

	it("a drag to the right-middle row persists that anchor and does not collapse", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		rig.el.rect = { left: 592, top: 8, right: 992, bottom: 48, width: 400, height: 40 };

		// The strip starts centred at (792, 28). Moving it down 372px puts its
		// centre exactly on the new middle-right resting centre, (792, 400).
		gesture(rig, rig.grip, 0, 372);

		expect(rig.placed).toEqual(["middle-right"]);
		expect(rig.el.style.transform).toBe("");
		expect(rig.el.classes.has("is-dragging")).toBe(false);
		expect(rig.el.classes.has("is-collapsed"), "the drag was mistaken for a tap/collapse").toBe(
			false
		);
	});

	it("Escape mid-drag puts the strip back and writes no placement", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		rig.el.rect = { left: 592, top: 8, right: 992, bottom: 48, width: 400, height: 40 };

		rig.grip.fire("pointerdown", { pointerId: 4, clientX: 100, clientY: 100 });
		rig.grip.fire("pointermove", { pointerId: 4, clientX: -460, clientY: 800 });
		expect(rig.el.style.transform, "the drag is not live").toContain("translate(-560px, 700px)");
		expect(rig.el.classes.has("is-dragging")).toBe(true);

		rig.doc.fire("keydown", { key: "Escape", defaultPrevented: false, stopPropagation: () => {} });

		expect(rig.el.style.transform, "Escape left the strip where the drag had it").toBe("");
		expect(rig.el.classes.has("is-dragging")).toBe(false);
		expect(rig.placed, "a cancelled drag still wrote a placement").toEqual([]);

		// The lift that follows a cancel must not resurrect the drop either.
		rig.doc.fire("pointerup", { pointerId: 4 });
		expect(rig.placed).toEqual([]);
	});

	/**
	 * THE COLLISION, and the one thing in this slice that had to be designed
	 * rather than added.
	 *
	 * `applyHeaderClearance` writes an inline `transform` to dodge the pane's
	 * actions row and replaces the whole property doing it - which is why the
	 * middles are centred with auto margins and not with a transform
	 * (CornerSafeArea.test.ts). A drag wants the same property. The two are
	 * reachable together: `setCorner` calls the clearance, and the pdf
	 * surface's `refreshStrip` (PdfInkController.ts) calls `setCorner` on
	 * EVERY strip refresh - so a hotkey that changes tool while a finger is
	 * on the grip runs the clearance mid-drag. On the note surface the resize
	 * observer does the same on a rotation, on a split being dragged, or on
	 * the sidebar opening.
	 *
	 * Neither writes `transform` now. Both keep a number and `paintTransform`
	 * composes the pair, so a dodge landing mid-drag moves the strip by the
	 * amount the actions row moved and by nothing else.
	 */
	it("a dodge recomputed mid-drag keeps the drag's offset", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		rig.el.rect = { left: 800, top: 8, right: 992, bottom: 48, width: 192, height: 40 };
		const actions = rig.pane.createDiv({ cls: "view-actions" });
		actions.rect = { left: 900, top: 0, right: 990, bottom: 40, width: 90, height: 40 };

		// The dodge alone, with no drag: 100px left, clear of the dots.
		rig.strip.setCorner("top-right");
		expect(rig.pane.querySelector(".view-actions"), "the pane's actions row").toBe(actions);
		expect(rig.el.style.transform, "the actions row is not being dodged at all").toBe(
			"translate(-100px, 0px)"
		);

		rig.grip.fire("pointerdown", { pointerId: 9, clientX: 100, clientY: 100 });
		rig.grip.fire("pointermove", { pointerId: 9, clientX: 130, clientY: 140 });
		expect(rig.el.style.transform).toBe("translate(-70px, 40px) scale(1.04)");

		// THE CLEARANCE, mid-drag, by the road the pdf surface takes on every
		// strip refresh.
		rig.strip.setCorner("top-right");

		expect(
			rig.el.style.transform,
			"the clearance erased the drag's offset instead of composing with it"
		).toBe("translate(-70px, 40px) scale(1.04)");
		// And the pill moved with it, as it does for the dodge alone.
		expect(rig.pill.style.transform).toBe("translate(-70px, 40px) scale(1.04)");
	});

	/**
	 * THE SAME COLLISION AT THE OTHER END: the drop, which has to UN-dodge
	 * before it can compare.
	 *
	 * The box the drop reasons from is read off the live element and carries
	 * the actions-row dodge. `anchorRestingCentre` has no dodge term - it
	 * answers where the stylesheet puts a strip - so the drop was comparing a
	 * dodged centre against nine un-dodged predictions of it. On a pdf, where
	 * the dodge is the whole width of the three-dots row, that is a hundred px
	 * or two of error in the one direction the top anchors are told apart by:
	 * the strip is dropped where the user is not looking, off a gesture that
	 * asked for nothing.
	 */
	it("a dodged strip is dropped in the anchors' frame, not the dodge's", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		// A 400x40 strip resting in the pane's top-right corner, and an
		// actions row far enough in that clearing it costs 200px.
		liveRect(rig.el, { left: 592, top: 8, width: 400, height: 40 });
		const actions = rig.pane.createDiv({ cls: "view-actions" });
		actions.rect = { left: 800, top: 0, right: 990, bottom: 40, width: 190, height: 40 };

		rig.strip.setCorner("top-right");
		expect(rig.el.style.transform, "the strip is not dodging the actions row at all").toBe(
			"translate(-200px, 0px)"
		);

		// A NUDGE: ten px right and nothing else. Un-dodged, the strip's
		// centre is at 802 and the top-right anchor rests at 792 - ten px, the
		// distance the finger moved. Dodged, it reads 602, which is nearer the
		// top MIDDLE's 500 than the top right's 792.
		gesture(rig, rig.grip, 10, 0);

		expect(
			rig.placed,
			"a 10px nudge on a dodged strip was dropped a dodge-width from where it was aimed"
		).toEqual(["top-right"]);
	});

	it("the folded row is shut BEFORE the box is measured, not after", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 };
		// A phone-width strip with a SECOND ROW open: that row is in flow
		// inside the strip (`.handwriting-mobile-tools-more`), so the strip
		// stands 88px tall open and 40px shut, and the fake says so by reading
		// the very class `setMoreOpen` toggles.
		const resting = { left: 8, top: 190, width: 300, height: 40 };
		liveRect(rig.el, resting);
		const boxed = rig.el.getBoundingClientRect.bind(rig.el);
		rig.el.getBoundingClientRect = () => {
			resting.height = rig.el.classes.has("is-more-open") ? 88 : 40;
			return boxed();
		};
		const more = rig.pane.querySelector(".handwriting-tools-more");
		if (!more) throw new Error("the strip built no More chevron");
		more.fire("click", {});
		expect(rig.el.classes.has("is-more-open"), "the chevron did not open the row").toBe(true);

		// The nudge is HORIZONTAL, so the vertical answer is the thing under
		// test. The top/middle anchor boundary depends on the measured height: shut,
		// the centres are 28 and 400 and a strip centred at 210 is still on the
		// top side. Measured while the second row is still in the box, the top
		// centre becomes 52 and the live centre 234, which is nearer the middle
		// row - for a gesture that never moved vertically.
		gesture(rig, rig.grip, 8, 0);

		expect(
			rig.placed,
			"an open second row measured into the box pushed the drop past the midline"
		).toEqual(["top-left"]);
	});

	it("a pointercancel arms no click swallow: the pill still opens by keyboard", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		liveRect(rig.el, { left: 8, top: 8, width: 300, height: 40 });
		rig.strip.setCollapsed(true);

		// A drag on the PILL that the system takes away mid-flight. No lift
		// follows a pointercancel, so there is no synthesized click to eat.
		rig.pill.fire("pointerdown", { pointerId: 7, clientX: 100, clientY: 100 });
		rig.pill.fire("pointermove", { pointerId: 7, clientX: 140, clientY: 100 });
		rig.doc.fire("pointercancel", { pointerId: 7 });

		// The keyboard reaches a real button through `click` alone, with no
		// pointerdown ahead of it to clear a stale flag - so a swallow armed
		// here would eat the user's Enter and the strip would stay shut.
		rig.pill.fire("click", {});

		expect(
			rig.el.classes.has("is-collapsed"),
			"a cancelled drag swallowed the next press on the pill"
		).toBe(false);
	});

	it("only the primary left button drags the grip", () => {
		const rig = buildDrag();
		rig.pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		liveRect(rig.el, { left: 8, top: 8, width: 300, height: 40 });

		rig.grip.fire("pointerdown", { pointerId: 7, clientX: 100, clientY: 100, button: 2 });
		rig.grip.fire("pointermove", { pointerId: 7, clientX: 400, clientY: 700 });
		rig.doc.fire("pointerup", { pointerId: 7 });
		expect(rig.placed, "a right-button drag moved the toolbar").toEqual([]);

		rig.grip.fire("pointerdown", { pointerId: 8, clientX: 100, clientY: 100, isPrimary: false });
		rig.grip.fire("pointermove", { pointerId: 8, clientX: 400, clientY: 700 });
		rig.doc.fire("pointerup", { pointerId: 8 });
		expect(rig.placed, "a secondary contact dragged the toolbar").toEqual([]);
	});
});
