/**
 * The eraser TOOL - not the eraser end - as the first pen contact of a session
 * on a page whose ink was already there.
 *
 * WHY THIS FILE EXISTS BESIDE `EraserColdPage.test.ts`. That file pinned the
 * reported sequence with the eraser END (`buttons: 32, button: 5`) and a tip
 * mode of "nib", and it erases. The owner has since confirmed the missing
 * half: THE ERASER TOOL WAS SELECTED ON THE TOOLBAR at the time. That changes
 * two things and neither was covered.
 *
 *   1. `penContactIntent` (TipMode.ts) answers "erase" from the MODE alone, so
 *      the pen's barrel bits stop mattering - a PLAIN TIP contact erases too.
 *      "The digitizer did not report the eraser end" is therefore not an
 *      available explanation, and the first test here is that plain-tip
 *      contact, end to end.
 *   2. The HOVER ring wears the eraser look with NO CONTACT AT ALL whenever
 *      `tipMode() === "eraser"` (`showPenCursor`, InkOverlay.ts). So "an eraser
 *      reticle appeared" stopped being evidence that a contact was ever
 *      claimed. Test two pins that, because it is what lets the leading
 *      hypothesis - the contact never reached `penDown` - survive the report.
 *
 * THE ROUTER IS REAL HERE, which is the other thing `EraserColdPage.test.ts`
 * could not say. It called `penDown` directly, so it could only ever answer
 * "given a contact, does the erase work". These tests fire a pointerdown into
 * `InlinePenRouter`'s own registered capture handler with the same callbacks
 * `InkOverlay.mount` wires (`onPenDown` -> the real `penDown`, `penOff` ->
 * `!penInkEnabled()`), so the claim decision is under test too.
 *
 * RESULT: NOT REPRODUCED. With the eraser tool selected, no pen seen this
 * session, no stroke drawn this session and ink already in the store, the
 * plain tip contact ERASES.
 *
 * THE WALK BEHIND THAT, written here because it is the durable part. Between
 * `InlinePenRouter.pointerDown` and the erase branch of `InkOverlay.penDown`
 * there are exactly three early returns a PEN contact can meet, and with the
 * eraser tool selected the third cannot fire at all:
 *
 *   - pen off on this surface (`InlinePenRouter.pointerDown`, the `penOff()`
 *     return). `penInkEnabled()` defaults TRUE, is session-only and is never
 *     written to data.json, so a fresh vault reaches it only if the user
 *     pressed Keyboard / the pen-input toggle in that same session.
 *   - a stroke still active (the `activePenId !== null` return). Needs a claim
 *     that never ended; a session's FIRST contact has none.
 *   - the selection GRAB in `penDown` - and it is spelled `!eraser && ...`, so
 *     an eraser is never swallowed by it.
 *
 * AND THE OWNER'S RETICLE RULES THE FIRST TWO OUT BY ITSELF, which is the one
 * thing this file adds that a code read alone does not. The hover callback
 * that paints the ring sits INSIDE `if (this.activePenId === null)` and BELOW
 * the same `penOff()` return, in `InlinePenRouter.pointerMove`. So a ring that
 * is up and following the pen is proof that pen input was on and that no
 * stroke was held. The last two tests in the first block are that proof,
 * asserted from both directions.
 *
 * WHAT THE WALK LEFT OPEN is in the third block below: selecting the tool can
 * hand the MOUSE the same erase gesture, and a mouse click is a route into the
 * index rebuild that no pen contact was needed for. Read that block's own
 * header; it is a lead, not a diagnosis.
 *
 * ONE THING THE WALK TURNED UP THAT 1.4.11 DID NOT HAVE: the addendum-3 flip
 * in `pointerDown` (`deviceHasNeverSeenAPen() && penOff()` -> `setPenInk(true)`)
 * is 1.4.12-era, and 1.4.11's router has no `deviceHasNeverSeenAPen` in it at
 * all. On THIS branch keyboard mode therefore does not refuse a pen-less
 * device's first contact; on the shipped build it did. Pinned below so the
 * difference is a test rather than a memory.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	InkOverlayPlugin,
	inlineInk,
	releaseTipModes,
	setInlineEraserMode,
} from "./InkOverlay";
import { ERASER_CURSOR_CLASS } from "./PenCursor";
import { InlinePenCallbacks, InlinePenRouter } from "./InlinePenRouter";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "./PenInk";
import { clearToolPicked, setMouseInk } from "./MouseInk";
import {
	deviceHasNeverSeenAPen,
	markPenHardwareSeen,
	markPenSeen,
	penSeenThisSession,
	resetPenToolsForTest,
} from "./PenToolsMode";
import { InkStroke } from "../ink/Stroke";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { PenSample } from "../input/PointerRouter";
import { fakeEl, installFakeWindow } from "../../test/routerHarness";
import { hideReticle, reticleShown } from "../testUtils/ReticleShown";

const PATH = "eraser-tool-cold-page.md";
/** Where the ink is, and where the tip lands on it. */
const AT = { x: 120, y: 90 };

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
	uninstallWindow();
});

/** A stroke as the sidecar hands it over: bbox already computed, id stable. */
function sidecarStroke(id: string, at: { x: number; y: number }): InkStroke {
	return {
		id,
		tool: "pen",
		color: DEFAULT_PEN.color,
		width: DEFAULT_PEN.baseWidth,
		points: [
			{ x: at.x, y: at.y, pressure: 0.5, t: 0 },
			{ x: at.x + 10, y: at.y, pressure: 0.5, t: 8 },
		],
		bbox: { x: at.x, y: at.y, width: 10, height: 0 },
		createdAt: 0,
	};
}

/**
 * A PLAIN TIP contact. No barrel bits at all: `buttons` 1 is the tip alone and
 * `button` 0 is the primary transition, which is what makes this the contact
 * the corrected premise is about - it can only erase through the MODE.
 */
function tipEvent(type: string, x: number, y: number, ts: number, over: Partial<Record<string, unknown>> = {}): PointerEvent {
	return {
		type,
		pointerType: "pen",
		pointerId: 7,
		isPrimary: true,
		clientX: x,
		clientY: y,
		pressure: 0.5,
		buttons: 1,
		button: 0,
		timeStamp: ts,
		tiltX: 0,
		tiltY: 0,
		width: 0,
		height: 0,
		preventDefault: () => undefined,
		stopPropagation: () => undefined,
		...over,
	} as unknown as PointerEvent;
}

/** The same pen, off the glass: what a hover sample looks like. */
function hoverEvent(x: number, y: number, ts: number): PointerEvent {
	return tipEvent("pointermove", x, y, ts, { pressure: 0, buttons: 0 });
}

/** An ordinary mouse, left button down. */
function mouseEvent(type: string, x: number, y: number, ts: number): PointerEvent {
	return tipEvent(type, x, y, ts, { pointerType: "mouse", pointerId: 1, pressure: 0.5 });
}

const noop = (): void => undefined;

function fakeRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
	} as DOMRect;
}

interface Proto {
	penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
	showPenCursor(this: unknown, s: PenSample, pointerType?: string): void;
}
const proto = InkOverlayPlugin.prototype as unknown as Proto;

interface Rig {
	overlay: Record<string, unknown>;
	router: InlinePenRouter;
	/** Fire an event at the router's own registered capture handler. */
	fire(ev: PointerEvent): void;
	/** What the hover ring is wearing: the classes and the last styles written. */
	ringClasses: Set<string>;
	ringStyle: Record<string, unknown>;
	/** What `showEraserCursor` wrote - the in-gesture reticle, not the hover one. */
	eraserStyle: Record<string, unknown>;
	downs: number[];
	destroy(): void;
}

/**
 * A REAL overlay and a REAL router, wired to each other the way
 * `InkOverlay.mount` wires them.
 *
 * The overlay is `new`, not `Object.create`, so every class-field initialiser
 * runs and nothing about the erase path's state is chosen here;
 * `view.state.field` answers `undefined`, which is `mount()`'s own "not a
 * file-backed editor" exit, so no canvas is wanted. Same idiom as
 * `EraserColdPage.test.ts`'s rig and `GestureReticlePersists.test.ts`'s
 * `liveOverlay`.
 *
 * Zero origins throughout - the scroller rect, the container rect, the content
 * rect and `documentTop` are all 0 - so a client point (x, y) is the sample
 * (x, y) is the world point (x, y), and the router's rect and the overlay's
 * camera agree by construction rather than by arithmetic.
 */
function makeRig(): Rig {
	const eraserStyle: Record<string, unknown> = { display: "none" };
	const ringStyle: Record<string, unknown> = { display: "none" };
	const ringClasses = new Set<string>();
	const win = {
		setTimeout: () => 1,
		clearTimeout: noop,
		getComputedStyle: () => ({ position: "relative", fontSize: "16px" }),
		cancelAnimationFrame: noop,
		requestAnimationFrame: () => 1,
		devicePixelRatio: 1,
		matchMedia: () => ({ addEventListener: noop, removeEventListener: noop }),
		addEventListener: noop,
		removeEventListener: noop,
	};
	const view = {
		dom: {
			parentElement: { setCssStyles: noop },
			ownerDocument: { defaultView: win },
			style: { removeProperty: noop },
			setCssStyles: noop,
		},
		hasFocus: true,
		focus: noop,
		documentTop: 0,
		scaleX: 1,
		scaleY: 1,
		contentDOM: {
			getBoundingClientRect: () => fakeRect(0, 0, 800, 2000),
			querySelector: () => null,
			querySelectorAll: () => [],
			children: [],
			firstElementChild: null,
		},
		scrollDOM: {
			addEventListener: noop,
			removeEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
			scrollLeft: 0,
			scrollTop: 0,
			scrollWidth: 800,
			scrollHeight: 2000,
			clientWidth: 800,
			clientHeight: 600,
		},
		state: { field: () => undefined },
	};

	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	overlay.container = {
		getBoundingClientRect: () => fakeRect(0, 0, 800, 600),
		offsetWidth: 800,
		offsetHeight: 600,
		remove: noop,
	};
	overlay.eraserEl = {
		setAttribute: noop,
		setCssStyles: (s: Record<string, unknown>) => Object.assign(eraserStyle, s),
	};
	// The hover ring, present here (unlike EraserColdPage.test.ts's rig, which
	// nulls it): the eraser LOOK it wears with no contact is half of what this
	// file exists to pin.
	overlay.penCursorEl = {
		setAttribute: noop,
		classList: {
			add: (c: string) => void ringClasses.add(c),
			remove: (c: string) => void ringClasses.delete(c),
			contains: (c: string) => ringClasses.has(c),
		},
		setCssStyles: (s: Record<string, unknown>) => Object.assign(ringStyle, s),
	};
	// Own properties, so the prototype's versions never run: `filePath` reads a
	// CodeMirror field, and `ensurePenTools` would try to build a real strip
	// out of an `app` this fixture has no reason to own (its own try/catch
	// would swallow the throw, but the console noise says nothing true).
	overlay.filePath = (): string => PATH;
	overlay.ensurePenTools = noop;

	const el = fakeEl();
	const downs: number[] = [];
	// EXACTLY the members `InkOverlay.mount` passes, for the paths a contact
	// walks. `penOff` is the one the claim decision reads, and it is wired to
	// the same predicate the shipped surface wires it to.
	const cb: InlinePenCallbacks = {
		onPenDown: (s, ev) => {
			downs.push(s.x);
			proto.penDown.call(overlay, s, ev);
		},
		onPenHover: (s, pt) => proto.showPenCursor.call(overlay, s, pt),
		onPenLeave: noop,
		onPinch: noop,
		onPenRaw: noop,
		onPenMove: noop,
		onPenUp: noop,
		penOff: () => !penInkEnabled(),
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);

	return {
		overlay,
		router,
		fire: (ev: PointerEvent) => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`router registered no handler for ${ev.type}`);
			h(ev);
		},
		ringClasses,
		ringStyle,
		eraserStyle,
		downs,
		destroy: () => {
			router.dispose();
			(overlay as unknown as { destroy(): void }).destroy();
		},
	};
}

function idsInStore(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
}

/**
 * A FRESH SESSION, spelled out: no tip mode, no pen ever seen, pen input at
 * its launch default, no tool picked, mouse ink off. Every one of these is a
 * fact the reported vault had, and every one of them is module state that a
 * previous test in this process could otherwise hand over.
 */
function freshSession(): void {
	releaseTipModes();
	resetPenToolsForTest();
	resetPenInkForTest();
	clearToolPicked();
	setMouseInk(false);
	inlineInk.applyRemove(PATH, idsInStore());
}

describe("the eraser TOOL, first contact of the session, ink already on the page", () => {
	beforeEach(freshSession);
	afterEach(freshSession);

	it("erases on a PLAIN TIP contact driven through the real router", () => {
		// The strip route: the pen hovered, so the strip is visible and its
		// eraser button is reachable. `setInlineEraserMode` is what that
		// button's command calls (main.ts, "inline-tool-eraser"), and
		// `markPenSeen` is the visibility half the same command runs through
		// `enterTipMode`. No private field is poked.
		markPenSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("sidecar", AT)]);

		const rig = makeRig();
		try {
			rig.fire(tipEvent("pointerdown", AT.x, AT.y, 100));

			// The contact was CLAIMED and reached the surface: without this the
			// assertion below could pass for a refusal that never ran at all.
			expect(rig.downs, "the router refused the contact").toEqual([AT.x]);
			expect(rig.overlay.mode, "the tool did not make the tip an eraser").toBe("erase");
			expect(rig.eraserStyle.display, "no in-gesture reticle: the erase branch never ran").toBe(
				"block"
			);
			expect(idsInStore(), "the eraser tool did not erase on a cold page").toEqual([]);
		} finally {
			rig.destroy();
		}
	});

	it("wears the eraser ring on HOVER ALONE, so a reticle is not evidence of a contact", () => {
		markPenSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("sidecar", AT)]);

		const rig = makeRig();
		try {
			// Hover only. `buttons` 0, `pressure` 0 - the pen is off the glass.
			rig.fire(hoverEvent(AT.x, AT.y, 100));

			expect(rig.downs, "a hover must never claim a contact").toEqual([]);
			expect(
				rig.ringClasses.has(ERASER_CURSOR_CLASS),
				"the hover ring did not take the eraser look"
			).toBe(true);
			expect(reticleShown(rig.ringStyle)).toBe(true);
			// And nothing happened to the page. This is the whole point: the
			// reported symptom - an eraser reticle under the pen and untouched
			// ink - is what a session that never got a `penDown` looks like.
			expect(idsInStore()).toEqual(["sidecar"]);
			expect(rig.eraserStyle.display, "the in-gesture reticle must stay down").toBe("none");
		} finally {
			rig.destroy();
		}
	});

	it("keyboard mode on a device that has never held a pen does not even refuse", () => {
		markPenSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("sidecar", AT)]);
		// `penInkEnabled` defaults TRUE at every launch and is never written to
		// data.json (PenInk.ts), so the only way here is the user pressing
		// Keyboard / the pen-input toggle in THIS session.
		expect(penInkEnabled(), "pen input must default on, or this test proves nothing").toBe(true);
		setPenInk(false);
		// `markPenSeen` above is VISIBILITY only; no pen hardware has been
		// seen, so this is the addendum-3 edge (InlinePenRouter.ts): a device
		// that has never held a pen gets its first real pen contact treated as
		// a request into pen input, and `setPenInk(true)` runs ABOVE the
		// pen-off check that would otherwise refuse it.
		expect(deviceHasNeverSeenAPen()).toBe(true);

		const rig = makeRig();
		try {
			rig.fire(tipEvent("pointerdown", AT.x, AT.y, 100));
			expect(rig.downs, "the addendum-3 flip did not let the contact in").toEqual([AT.x]);
			expect(penInkEnabled(), "the contact should have turned pen input back on").toBe(true);
			expect(idsInStore(), "the let-in contact still had to erase").toEqual([]);
		} finally {
			rig.destroy();
		}
	});

	it("keyboard mode DOES refuse once a pen has been held - and takes the hover ring with it", () => {
		markPenHardwareSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("sidecar", AT)]);
		setPenInk(false);

		const rig = makeRig();
		try {
			rig.fire(tipEvent("pointerdown", AT.x, AT.y, 100));
			expect(rig.downs, "keyboard mode must hand the contact back").toEqual([]);
			expect(idsInStore()).toEqual(["sidecar"]);
			// THE HALF THAT MATTERS FOR THE REPORT. The hover branch sits below
			// the SAME `penOff()` return (InlinePenRouter.pointerMove), so a pen
			// whose contact this refusal ate paints no ring either. A live
			// eraser ring tracking the pen is therefore proof that pen input was
			// ON - which is what removes this refusal from the list of things
			// that could have been happening on the owner's screen.
			rig.fire(hoverEvent(AT.x + 4, AT.y + 4, 110));
			expect(reticleShown(rig.ringStyle), "pen off must paint no hover ring").toBe(false);
			expect(rig.ringClasses.has(ERASER_CURSOR_CLASS)).toBe(false);
		} finally {
			rig.destroy();
		}
	});

	it("refuses a second contact while one is still live - and a first contact has none", () => {
		markPenSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("a", AT), sidecarStroke("b", { x: 400, y: 300 })]);

		const rig = makeRig();
		try {
			// The first contact is claimed and erases what it sits on.
			rig.fire(tipEvent("pointerdown", AT.x, AT.y, 100));
			expect(idsInStore()).toEqual(["b"]);
			// A SECOND pointerdown with the first still live is the router's
			// "pen IGNORED: stroke N still active" branch. It is the only other
			// way a pen contact dies before `penDown`, and it needs a claim
			// that never ended - which a session's FIRST contact cannot have.
			rig.fire(tipEvent("pointerdown", 400, 300, 110, { pointerId: 9 }));
			expect(rig.downs.length, "the second contact must be ignored").toBe(1);
			expect(idsInStore(), "the ignored contact must not erase").toEqual(["b"]);
			// And the same claim silences the HOVER ring: `pointerMove`'s ring
			// branch is inside `if (this.activePenId === null)`, so a router
			// holding a stroke paints nothing for a second pen either. Between
			// this and the test above, BOTH of the router's pen refusals take
			// the ring down with them - so a ring that is up and following the
			// pen says neither of them was in force.
			hideReticle(rig.ringStyle);
			rig.fire(hoverEvent(400, 300, 120));
			expect(reticleShown(rig.ringStyle), "a live stroke must paint no hover ring").toBe(false);
		} finally {
			rig.destroy();
		}
	});
});

/**
 * WHAT THE SELECTED TOOL DOES TO THE MOUSE, and why it belongs in a file about
 * an eraser that found nothing.
 *
 * `armTipModeInput` (main.ts, reached from every one of the four tip-mode
 * commands through `enterTipMode`) arms MOUSE INK, quietly and for the
 * session, whenever the command runs and no pen has been seen yet - because a
 * tip mode means nothing on a machine whose mouse is not a tip. It is in
 * 1.4.11 with the same body.
 *
 * So on the reported vault the eraser tool did not only change what the PEN
 * does at contact. It can also have made an ordinary left-click an ERASE
 * GESTURE, and an erase gesture is the one thing that rebuilds `strokeIndex`
 * and clears `indexDirty` (`eraseCandidates`). `EraserColdPage.test.ts` looked
 * for a route that leaves that flag down before a first-of-session eraser
 * contact and found none, and it was right to: it was looking at PEN contacts,
 * and every one of them is either the erase itself or a stroke that re-dirties
 * the flag. A mouse click is neither.
 *
 * NOT A REPRODUCTION AND NOT A DIAGNOSIS - the ordering against the sidecar
 * read is unresolved and the previous session's third test shows the load's
 * own repaint re-dirtying the flag. These two tests pin only that the route
 * exists, so the next pass starts from a fact instead of an argument.
 */
describe("the selected eraser tool makes a mouse click an erase gesture", () => {
	beforeEach(freshSession);
	afterEach(freshSession);

	it("a left-click erases through the real router once the tool armed the mouse", () => {
		// What `armTipModeInput` does on a session that has seen no pen. Spelled
		// with the module's own setter rather than reaching into main.ts.
		setMouseInk(true);
		markPenSeen();
		setInlineEraserMode(true);
		inlineInk.applyAdd(PATH, [sidecarStroke("sidecar", AT)]);

		const rig = makeRig();
		try {
			rig.fire(mouseEvent("pointerdown", AT.x, AT.y, 100));
			expect(rig.downs, "the mouse contact was not claimed").toEqual([AT.x]);
			expect(rig.overlay.mode).toBe("erase");
			expect(idsInStore(), "the mouse did not run the erase gesture").toEqual([]);
		} finally {
			rig.destroy();
		}
	});

	it("and that click caches an empty index when it lands before the page's ink does", () => {
		setMouseInk(true);
		markPenSeen();
		setInlineEraserMode(true);
		// The store is EMPTY: a sidecar read that has not landed yet.
		const rig = makeRig();
		try {
			expect(rig.overlay.indexDirty, "the index must start dirty").toBe(true);
			rig.fire(mouseEvent("pointerdown", AT.x, AT.y, 100));
			// `eraseCandidates` rebuilt over nothing and cleared the flag, then
			// `eraseAt` returned on an empty hit list before anything could
			// re-dirty it. This is the state `EraserColdPage.test.ts`'s second
			// test drives by hand, reached here by a pointer that is not a pen.
			expect(
				rig.overlay.indexDirty,
				"the empty rebuild should have left the flag down"
			).toBe(false);
		} finally {
			rig.destroy();
		}
	});
});

describe("how the eraser tool is reached when no pen has been seen", () => {
	beforeEach(freshSession);
	afterEach(freshSession);

	it("the strip cannot be the route: it is not on screen until a pen is seen", () => {
		// `penToolsVisible(getPenToolsMode(), isMobile, seen)` is `isMobile ||
		// seen` under the default "auto" mode, so on desktop a vault that has
		// never seen a pen has no strip and no eraser button on it. The tool
		// has to come from the command (palette or hotkey) instead - which is
		// the branch the test below is about.
		expect(penSeenThisSession()).toBe(false);
	});

	it("a hover is enough to raise it, and that is the fresh vault's route to the button", () => {
		const rig = makeRig();
		try {
			// `showPenCursor` marks a real pen seen before it paints anything,
			// so one hover over the note is all the strip's visibility rule
			// needs. This is why the owner could have a toolbar - and an eraser
			// button on it - in a vault that had never been written in.
			rig.fire(hoverEvent(AT.x, AT.y, 100));
			expect(penSeenThisSession()).toBe(true);
		} finally {
			rig.destroy();
		}
	});
});
