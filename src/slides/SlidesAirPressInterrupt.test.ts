/**
 * Android: a pen contact on a presentation is a contact for the pen button's air click too.
 *
 * The air-click machine (SideButtonAir.ts) switches the tip between pen and eraser when the button is pressed and
 * let go in the air. Any contact in between means it was not a click: the note surface's pointerdown tells the
 * machine so (`sideButtonAirInterrupt`), which also leaves it spent until a buttons-0 hover row, so a button held
 * through a lift cannot click. A contact on a Slides deck never reached that pointerdown, so the machine never
 * heard of it:
 *
 *   - a stroke on the deck with the button pressed in it and held through the lift: the first hover row over a
 *     note (buttons 1, pressure 0) armed a press, and the release clicked, flipping the tip to the eraser;
 *   - the button pressed in the air over a note, then the pen landed on the deck with it held: the release after
 *     the lift clicked the same way.
 *
 * The real SlidesDeck over the shared fake DOM; the hover rows a note pane feeds the machine are fed to it here
 * directly, the way the note router's hover handlers do (`sideButtonAirHover` with the row's own fields).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { resetSideButtonAirForTest, sideButtonAirHover } from "../inline/SideButtonAir";
import { resetTipModeForTest, tipMode } from "../inline/TipMode";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { SlidesDeck, type SlidesInkHost } from "./SlidesInkSurface";

type Row = [buttons: number, pressure: number];
const up: Row = [0, 0];
const held: Row = [1, 0];

let clock = 0;
let switches: string[] = [];

/** Hover rows over a note pane, as its router feeds them to the machine. */
function hoverOverNote(rows: Row[]): void {
	for (const [buttons, pressure] of rows) {
		clock += 10;
		const line = sideButtonAirHover("pen", buttons, pressure, clock);
		if (line !== null) switches.push(line);
	}
}

function mountDeck(): { deck: SlidesDeck; reveal: FakeEl; doc: FakeDoc } {
	const doc = new FakeDoc();
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
	container.querySelector = (sel: string) => (sel === ".reveal" ? reveal : null);
	reveal.querySelector = (sel: string) => (sel === ".slides" ? slides : null);
	doc.container = container;
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
		buildId: "slides-air-press-interrupt",
	};
	const deck = new SlidesDeck(
		container as unknown as HTMLElement,
		reveal as unknown as HTMLElement,
		slides as unknown as HTMLElement,
		host
	);
	return { deck, reveal, doc };
}

let time = 0;
/** One pen stroke on the deck: down, two moves past the slop, lift. `buttons` is the contact's buttons field. */
function strokeOnDeck(reveal: FakeEl, doc: FakeDoc, buttons: number): void {
	for (const [type, x, y, b] of [
		["pointerdown", 200, 200, buttons], ["pointermove", 260, 260, buttons], ["pointermove", 300, 300, buttons], ["pointerup", 300, 300, 0],
	] as const) {
		reveal.dispatch({ type, pointerId: 1, pointerType: "pen", isPrimary: true, buttons: b, button: 0, clientX: x, clientY: y,
			pressure: type === "pointerup" ? 0 : 0.5, timeStamp: (time += 20), preventDefault: () => {}, stopPropagation: () => {} });
	}
	doc.flushFrames();
}

describe("the pen button and a contact on a presentation (Android)", () => {
	const wasAndroid = Platform.isAndroidApp;
	let deck: SlidesDeck | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
		vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "debug").mockImplementation(() => {});
		resetTipModeForTest();
		resetSideButtonAirForTest();
		Platform.isAndroidApp = true;
		clock = 0;
		time = 0;
		switches = [];
	});
	afterEach(() => {
		deck?.dispose();
		deck = null;
		Platform.isAndroidApp = wasAndroid;
		resetTipModeForTest();
		resetSideButtonAirForTest();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function ready(): Promise<{ reveal: FakeEl; doc: FakeDoc }> {
		const m = mountDeck();
		deck = m.deck;
		for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
		return { reveal: m.reveal, doc: m.doc };
	}

	it("a stroke on the deck, the button pressed in it and held through the lift, let go over a note: the tip stays the pen", async () => {
		const { reveal, doc } = await ready();
		hoverOverNote([up]);
		strokeOnDeck(reveal, doc, 1);
		expect(deck!.totalStrokes(), "premise: the stroke is on the slide").toBe(1);
		hoverOverNote([held, held, up]);
		expect(tipMode(), "the next stroke would erase").toBe("nib");
		expect(switches).toEqual([]);
		// A plain click in the air after it still switches.
		hoverOverNote([held, up]);
		expect(tipMode()).toBe("eraser");
	});

	it("the button pressed in the air over a note, the pen landed on the deck with it held, let go after the lift: the tip stays the pen", async () => {
		const { reveal, doc } = await ready();
		hoverOverNote([up, held]);
		strokeOnDeck(reveal, doc, 1);
		expect(deck!.totalStrokes(), "premise: the stroke is on the slide").toBe(1);
		hoverOverNote([held, up]);
		expect(tipMode(), "the next stroke would erase").toBe("nib");
		expect(switches).toEqual([]);
	});

	it("control: with no contact, a press and release in the air over a note switches", async () => {
		await ready();
		hoverOverNote([up, held, up]);
		expect(tipMode()).toBe("eraser");
		expect(switches).toEqual(["side button in the air: nib -> eraser"]);
	});

	it("control: a deck stroke with the pen button let go before the lift, then a plain click in the air: it switches", async () => {
		const { reveal, doc } = await ready();
		hoverOverNote([up]);
		strokeOnDeck(reveal, doc, 1);
		hoverOverNote([up, held, up]);
		expect(tipMode()).toBe("eraser");
		expect(switches).toEqual(["side button in the air: nib -> eraser"]);
	});
});
