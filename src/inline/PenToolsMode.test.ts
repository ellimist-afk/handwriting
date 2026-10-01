import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mainSrc from "../main.ts?raw";
import { codeOnly } from "../CodeOnly";
import {
	clearPenHardwareSeen,
	deviceHasNeverSeenAPen,
	markPenHardwareSeen,
	markPenSeen,
	nextPenToolsMode,
	normalizePenToolsMode,
	onPenToolsChanged,
	penHardwareEverSeen,
	penHardwareSeen,
	penSeenThisSession,
	penToolsListenerCountForTest,
	penToolsVisible,
	persistPenHardwareSeenToStore,
	resetPenToolsForTest,
	restorePenHardwareEverSeen,
	restorePenHardwareEverSeenFromStore,
	setPenHardwareStore,
	setPenToolsMode,
	setPersistPenHardwareSeen,
	shouldRaiseStripOnPenOff,
} from "./PenToolsMode";

describe("pen tools visibility", () => {
	beforeEach(resetPenToolsForTest);

	it("auto: mobile always, desktop only once a pen was seen", () => {
		expect(penToolsVisible("auto", true, false)).toBe(true);
		expect(penToolsVisible("auto", false, false)).toBe(false);
		expect(penToolsVisible("auto", false, true)).toBe(true);
	});

	it("show and hide override auto in both directions", () => {
		expect(penToolsVisible("show", false, false)).toBe(true);
		expect(penToolsVisible("hide", true, true)).toBe(false);
	});

	it("cycles auto -> show -> hide -> auto", () => {
		expect(nextPenToolsMode("auto")).toBe("show");
		expect(nextPenToolsMode("show")).toBe("hide");
		expect(nextPenToolsMode("hide")).toBe("auto");
	});

	it("normalizes junk to auto", () => {
		expect(normalizePenToolsMode("hide")).toBe("hide");
		expect(normalizePenToolsMode("banana")).toBe("auto");
	});

	it("pen sightings latch for the session", () => {
		expect(penSeenThisSession()).toBe(false);
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
	});
});

/**
 * The registry a surface with no fan-out of its own subscribes to.
 *
 * `refreshPenToolsAll` (InkOverlay.ts) is the note surface's fan-out and it
 * walks only note overlays, so the PDF controller had no way to hear that the
 * setting changed - the whole reason "Pen toolbar → Hide" left the strip on
 * screen over a PDF. Announcing from the two setters here is what makes a
 * surface's subscription enough on its own.
 */
describe("pen tools change notifications", () => {
	beforeEach(resetPenToolsForTest);

	it("announces a mode change, and only a real one", () => {
		const heard = vi.fn();
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		// Re-applying the same mode is what a settings save does. Nothing
		// changed, so nothing is told.
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		setPenToolsMode("auto");
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("announces the first pen sighting and no later one", () => {
		const heard = vi.fn();
		onPenToolsChanged(heard);
		markPenSeen();
		expect(heard).toHaveBeenCalledTimes(1);
		// Every pen-down calls this. Only the edge changes the answer, and the
		// first sample of every stroke is the last place to spend a fan-out.
		markPenSeen();
		markPenSeen();
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it("the unsubscribe actually unsubscribes", () => {
		const heard = vi.fn();
		const off = onPenToolsChanged(heard);
		expect(penToolsListenerCountForTest()).toBe(1);
		off();
		expect(penToolsListenerCountForTest()).toBe(0);
		setPenToolsMode("show");
		expect(heard).not.toHaveBeenCalled();
	});

	it("one listener throwing does not stop the next being told", () => {
		// Both ink surfaces subscribe. A strip that cannot mount on one pane
		// must not leave the other pane's strip stale - the same bulkhead
		// every ensure-tools path in this plugin already carries.
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		const heard = vi.fn();
		onPenToolsChanged(() => {
			throw new Error("chrome failed");
		});
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		quiet.mockRestore();
	});

	it("a listener may unsubscribe from inside the announcement", () => {
		// A mode change can tear a surface down, and the teardown drops its
		// subscription - so the set is being mutated while it is walked.
		const heard = vi.fn();
		const off = onPenToolsChanged(() => off());
		onPenToolsChanged(heard);
		setPenToolsMode("hide");
		expect(heard).toHaveBeenCalledTimes(1);
		expect(penToolsListenerCountForTest()).toBe(1);
	});
});

/**
 * The two flags are separate, and only one of them may move.
 *
 * `penSeen` answers "show the strip" and is deliberately set by UI paths -
 * every tool command, the mouse-ink toggle, the settings switch. `penHardware`
 * answers "does the tip ink without mouse ink" and only real pen events set
 * it. Collapsing them in either direction is a shipped bug:
 *
 *  - reading penSeen as hardware is what left the nib light stuck on for a
 *    mouse user through 1.4.6, 1.4.7 and 1.4.8 (alan, 2026-09-02);
 *  - gating markPenSeen on the pointer type - the tempting one-line "fix" -
 *    would take the toolbar away from every mouse-ink user on a desktop in
 *    auto mode, which is a behaviour change nobody asked for. The last test
 *    here is the one that goes red if anyone tries it.
 */
describe("pen sightings: visibility and hardware are different questions", () => {
	beforeEach(resetPenToolsForTest);

	it("a UI sighting shows the strip without claiming a pen exists", () => {
		markPenSeen();
		expect(penSeenThisSession()).toBe(true);
		expect(penHardwareSeen()).toBe(false);
	});

	it("a real pen answers both", () => {
		markPenHardwareSeen();
		expect(penHardwareSeen()).toBe(true);
		// Visibility rides along: a pen is proof for both questions, and this
		// is what keeps the strip appearing exactly when it did before.
		expect(penSeenThisSession()).toBe(true);
	});

	it("a pen after a UI sighting still upgrades the hardware answer", () => {
		// markPenSeen latches and returns early on the second call. If the
		// hardware flag were set inside that early-returning edge it would be
		// lost here - a pen user who opened the palette first would never
		// light their own nib.
		markPenSeen();
		markPenHardwareSeen();
		expect(penHardwareSeen()).toBe(true);
	});

	it("a mouse-only user still gets the strip on a desktop in auto mode", () => {
		// Exactly what a mouse user's first click does: the tool command
		// calls markPenSeen to raise the pen UI. The strip must appear, and
		// must go on appearing, with no pen anywhere in the session.
		markPenSeen();
		expect(penToolsVisible("auto", false, penSeenThisSession())).toBe(true);
		expect(penHardwareSeen()).toBe(false);
	});
});

/**
 * Alan's "and hide" ruling: turning pen input OFF from `pen-ink-toggle`
 * (main.ts) must not raise the strip on a device that has never seen pen
 * HARDWARE, but still must on one that has - the strip is the only way
 * back to ON. `shouldRaiseStripOnPenOff` is that decision, pulled out pure
 * so both cases are asserted here rather than through a live plugin
 * instance. Turning the pen ON is unaffected and keeps calling
 * `markPenSeen()` unconditionally at the call site - only the OFF branch
 * reads this.
 */
describe('shouldRaiseStripOnPenOff: the pen-off half of "and hide"', () => {
	it("does not raise the strip on a device that has never seen pen hardware", () => {
		expect(shouldRaiseStripOnPenOff(false)).toBe(false);
	});

	it("still raises the strip once a real pen has been seen this session - it is the way back", () => {
		expect(shouldRaiseStripOnPenOff(true)).toBe(true);
	});
});

/**
 * 1.4.12: THE LATCH OUTLIVES THE SESSION.
 *
 * Alan, 2026-09-05, ruling on the Keyboard button: "mouse only users should
 * never see it". The session-scoped latch honoured that and charged the pen
 * user for it - a restart took the button away until the nib next touched the
 * glass, which reads as the button being broken on the device that has the
 * most right to it. So the latch is written to settings on the first contact
 * this device ever makes and restored at load, before any strip is built.
 *
 * Two things must not happen on that restore, and both have a test here:
 * it must not present itself as a CONTACT (the cursor-mode light-up
 * subscribes to that edge and would arm the pen at every launch), and it must
 * not write the setting straight back.
 */
describe("the pen-hardware latch persists across a restart", () => {
	beforeEach(resetPenToolsForTest);
	afterEach(() => {
		vi.useRealTimers();
	});

	it("restore, then read: a device that held a pen yesterday held one today", () => {
		expect(penHardwareEverSeen()).toBe(false);
		restorePenHardwareEverSeen();
		expect(penHardwareEverSeen()).toBe(true);
	});

	// The restore sets the LATCH and nothing beside it. Both neighbours are
	// present-tense facts: `penHardware` says the tip inks right now (it lights
	// the nib), `penSeen` says the strip should exist at all. Restoring either
	// would open a desktop with chrome and a lit nib for a pen that is not in
	// the room - the `nibIsLit` bug arriving by a new road.
	it("sets the latch alone, leaving both present-tense flags false", () => {
		restorePenHardwareEverSeen();
		expect(penHardwareSeen()).toBe(false);
		expect(penSeenThisSession()).toBe(false);
	});

	it("still survives clearPenHardwareSeen after a restore, exactly as after a contact", () => {
		restorePenHardwareEverSeen();
		clearPenHardwareSeen();
		expect(penHardwareSeen()).toBe(false);
		expect(penHardwareEverSeen()).toBe(true);
	});

	it("writes the latch down on the first contact - once, and not synchronously", () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		setPersistPenHardwareSeen(persist);

		markPenHardwareSeen();
		// NOT YET, and this is the assertion the whole shape exists for.
		// `markPenHardwareSeen` runs from inside both surfaces' pen-down - the
		// one place in this plugin where nothing may be spent - and the
		// callback reaches `persistPenHardwareSeenToStore`, a write to this
		// device's local store. The ANSWER is available immediately; only the
		// filing of it waits.
		expect(persist, "a local-store write must not land inside the first ink sample").not.toHaveBeenCalled();
		expect(penHardwareEverSeen(), "the answer itself is synchronous").toBe(true);

		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it("a second contact schedules nothing - the edge is once, and so is the write", () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		setPersistPenHardwareSeen(persist);

		markPenHardwareSeen();
		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(1);

		// Every pen-down of the rest of the session comes through here. One
		// more write per stroke is the cost of getting this wrong.
		markPenHardwareSeen();
		markPenHardwareSeen();
		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(1);
	});

	// A restore came FROM the setting. Writing it back would be a round-trip
	// to the vault at every launch on every pen device, for no change.
	it("a restore schedules no write at all", () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		setPersistPenHardwareSeen(persist);

		restorePenHardwareEverSeen();
		vi.runAllTimers();
		expect(persist).not.toHaveBeenCalled();
	});

	// And the contact after a restore does not either: the latch was already
	// true, so there is no edge left to spend.
	it("a contact after a restore schedules no write either", () => {
		vi.useFakeTimers();
		const persist = vi.fn();
		setPersistPenHardwareSeen(persist);

		restorePenHardwareEverSeen();
		markPenHardwareSeen();
		vi.runAllTimers();
		expect(persist).not.toHaveBeenCalled();
	});
});

/**
 * ONE CHANNEL, and what a restore is allowed to do on it.
 *
 * `onPenToolsChanged` means "an answer moved, rebuild if you are stale", and
 * it is the only fan-out this module has. A dedicated `onFirstPenContact`
 * channel lived beside it until 1.4.12, built for a cursor-mode light-up
 * subscriber that never arrived: the light-up shipped as `InlinePenRouter`'s
 * own `setPenInk(true)` inside the contact it is deciding about, so the
 * channel had no production subscriber and these tests were the only thing
 * holding it up. It is gone; what it protected is not.
 *
 * The rule it existed for is now structural rather than policed: a restore
 * and a contact are two different entry points (`restorePenHardwareEverSeen`
 * and `markPenHardwareSeen`), and the restore has no argument and no branch
 * that can reach a contact's work. What is still worth executing is that a
 * restore DOES announce on the generic channel, and only on the edge.
 */
describe("a restore announces on the generic channel, and only on the edge", () => {
	beforeEach(resetPenToolsForTest);

	// It runs before any strip exists so it is free today, and announcing
	// keeps a listener registered earlier from missing the one change to this
	// answer a whole session may contain.
	it("announces once, and the latch really is set", () => {
		const heard = vi.fn();
		onPenToolsChanged(heard);
		restorePenHardwareEverSeen();
		expect(penHardwareEverSeen(), "the latch really was set").toBe(true);
		expect(heard).toHaveBeenCalledTimes(1);
		// And only on the edge. A second restore changes nothing.
		restorePenHardwareEverSeen();
		expect(heard).toHaveBeenCalledTimes(1);
	});
});

describe("the latch is per device: it goes to the local store, not the settings file", () => {
	beforeEach(resetPenToolsForTest);
	afterEach(() => setPenHardwareStore(null));

	const KEY = "handwriting-device-pen-hardware-seen";

	/** The pressure tests' idiom (PressureGain.test.ts): an in-memory stand-in
	 *  for Obsidian's per-vault, per-device store. */
	const fakeStore = () => {
		const saved = new Map<string, string>();
		return {
			saved,
			load: (key: string): string | null => saved.get(key) ?? null,
			save: (key: string, value: string): void => {
				saved.set(key, value);
			},
		};
	};

	it("the first pen contact writes the device key, and nothing else", () => {
		vi.useFakeTimers();
		const store = fakeStore();
		setPenHardwareStore(store);
		// Exactly what main.ts registers, so this pins the real wiring's body
		// and not a test-only stand-in for it.
		setPersistPenHardwareSeen(persistPenHardwareSeenToStore);

		markPenHardwareSeen();
		vi.runAllTimers();

		expect([...store.saved.entries()]).toEqual([[KEY, "true"]]);
	});

	it("the restore reads that key back and sets the latch", () => {
		const store = fakeStore();
		store.save(KEY, "true");
		setPenHardwareStore(store);

		expect(penHardwareEverSeen(), "nothing has happened yet").toBe(false);
		restorePenHardwareEverSeenFromStore();
		expect(penHardwareEverSeen(), "this device has held a pen before").toBe(true);
	});

	// THE POINT OF THE WHOLE MOVE. A mouse-only desktop syncing data.json from
	// a Surface has no key of its own, and the restore must leave it alone
	// whatever that file says: settings are not consulted at all any more.
	it("a device with no key of its own restores nothing, whatever data.json says", () => {
		const store = fakeStore();
		setPenHardwareStore(store);

		restorePenHardwareEverSeenFromStore();

		expect(penHardwareEverSeen(), "a synced setting must not latch this device").toBe(false);
	});

	it("a key holding anything but true is not a pen", () => {
		const store = fakeStore();
		store.save(KEY, "false");
		setPenHardwareStore(store);

		restorePenHardwareEverSeenFromStore();

		expect(penHardwareEverSeen()).toBe(false);
	});

	// Before onload registers the seam, and in every test that never sets one.
	it("no store registered is a no-op on both halves, not a crash", () => {
		setPenHardwareStore(null);

		expect(() => persistPenHardwareSeenToStore()).not.toThrow();
		expect(() => restorePenHardwareEverSeenFromStore()).not.toThrow();
		expect(penHardwareEverSeen()).toBe(false);
	});

	it("a store that throws costs the session its write, not the ink", () => {
		setPenHardwareStore({
			load: () => {
				throw new Error("storage denied");
			},
			save: () => {
				throw new Error("storage denied");
			},
		});

		expect(() => persistPenHardwareSeenToStore()).not.toThrow();
		expect(() => restorePenHardwareEverSeenFromStore()).not.toThrow();
		expect(penHardwareEverSeen(), "a denied read is not a pen").toBe(false);
	});
});

/**
 * WHAT COUNTS AS TRUE COMING BACK OUT OF THE STORE.
 *
 * The restore's whole body is one equality, and until 1.4.12 that equality was
 * `stored === "true"` alone. Obsidian's `loadLocalStorage` is TYPED
 * `string | null` but reads back through a JSON decode in some versions, and a
 * decode turns the `"true"` this module writes into the boolean `true` - which
 * that single test failed, silently, on every launch. Nothing crashes and
 * nothing is logged; the device just comes up as one that has never held a pen,
 * and the Keyboard button the latch exists to keep never comes back. It is an
 * INFERRED risk rather than a reported one (auditor, 1.4.12) and the fix costs
 * one `||`, so it is taken.
 *
 * The write is deliberately NOT widened: `persistPenHardwareSeenToStore` still
 * saves the string, so this build never puts a boolean in anyone's store. Only
 * the read is tolerant, and only of the two spellings of true - the negative
 * half below matters as much as the positive one, because a restore that
 * latched on anything truthy would put a Keyboard button on the mouse-only
 * desktop this whole move exists to keep it off.
 */
describe("the restore accepts either spelling of a stored true", () => {
	beforeEach(resetPenToolsForTest);
	afterEach(() => setPenHardwareStore(null));

	/** A store that hands back one fixed value, however Obsidian decoded it. */
	const storeReturning = (value: unknown): void => {
		setPenHardwareStore({
			load: () => value as string | boolean | null,
			save: () => {},
		});
	};

	it.each([
		["the string this module writes", "true"],
		["a JSON-decoded boolean", true],
	])("restores the latch from %s", (_label, value) => {
		storeReturning(value);

		expect(penHardwareEverSeen(), "nothing has happened yet").toBe(false);
		restorePenHardwareEverSeenFromStore();
		expect(penHardwareEverSeen()).toBe(true);
	});

	it.each([
		["the string false", "false"],
		["a decoded boolean false", false],
		["an empty store", null],
		["a store that answers undefined", undefined],
		["a truthy number", 1],
		["the wrong case", "TRUE"],
		["an object", {}],
		["garbage", "yes please"],
	])("leaves the latch alone for %s", (_label, value) => {
		storeReturning(value);

		restorePenHardwareEverSeenFromStore();

		expect(penHardwareEverSeen(), "a mouse-only device must not be latched").toBe(false);
	});

	it("still writes the string, even on a device whose store decodes booleans", () => {
		vi.useFakeTimers();
		const saved = new Map<string, string>();
		setPenHardwareStore({
			// Reads decoded, as the host does.
			load: () => true,
			save: (key: string, value: string) => {
				saved.set(key, value);
			},
		});
		setPersistPenHardwareSeen(persistPenHardwareSeenToStore);

		markPenHardwareSeen();
		vi.runAllTimers();

		expect([...saved.values()], "the widened read must not widen the write").toEqual(["true"]);
	});
});

/**
 * WHERE main.ts RESTORES, read off its own source.
 *
 * Not a taste question. `ButtonSpec.shownOn` is read ONCE per strip
 * (MobileTools.ts), so a restore that landed after the first strip was built
 * would leave a pen device without its Keyboard button until something else
 * happened to rebuild the strip - which is the exact defect the persistence
 * was written to remove. The ordering IS the feature, and nothing about it is
 * observable from this module: it lives in the sequence of two statements in
 * `onload`.
 *
 * Bounded at both ends, both ends asserted present and unique, and the slice
 * checked to be a real span of source rather than an empty match. CRLF is
 * normalised first - this repo checks out with CRLF, and every anchor below
 * would otherwise depend on which line ending the matcher happened to meet.
 * `codeOnly` blanks comments, so a prose mention of any of these symbols
 * cannot satisfy the guard (see CodeOnly.ts for the two defects that taught
 * this repo to do that).
 */
describe("main.ts restores the latch before any strip can be built", () => {
	const src = codeOnly(mainSrc).replace(/\r\n/g, "\n");

	const LOAD = "await this.loadSettings();";
	const LOAD_SETTINGS = "private async loadSettings(): Promise<void> {";
	const STRIP_HOST = "this.registerEditorExtension(inkOverlayExtension());";
	const STORE = "setPenHardwareStore({";
	const MODE = "setPenToolsMode(this.settings.penTools);";
	const RESTORE = "restorePenHardwareEverSeenFromStore();";

	const onlyIndexOf = (needle: string, what: string): number => {
		const at = src.indexOf(needle);
		expect(at, `${what} is not in main.ts any more: ${needle}`).toBeGreaterThan(-1);
		expect(src.indexOf(needle, at + 1), `${what} is no longer unique in main.ts`).toBe(-1);
		return at;
	};

	it("awaits loadSettings before it registers the editor extension that builds strips", () => {
		const load = onlyIndexOf(LOAD, "the settings load");
		const host = onlyIndexOf(STRIP_HOST, "the note surface's strip host");
		expect(load, "settings must be read before any surface exists").toBeLessThan(host);
	});

	it("wires the device store before loadSettings is ever called, and before the restore reads through the seam", () => {
		const store = onlyIndexOf(STORE, "the pen hardware device store wiring");
		const load = onlyIndexOf(LOAD, "the settings load");
		const restore = onlyIndexOf(RESTORE, "the latch restore");

		// The seam must be filled before the restore reads through it: a
		// restore through an empty seam reads nothing, and silently answers
		// "no pen has ever been here" on a device that has held one.
		expect(store, "the store must be registered before settings load").toBeLessThan(load);
		expect(store, "a restore through an empty seam reads nothing").toBeLessThan(restore);
	});

	/**
	 * `loadSettings`' OWN BODY, bounded by name and by brace balance.
	 *
	 * WHY THIS REPLACED A PAIR OF FILE OFFSETS. The containment claim below
	 * used to be three comparisons of offsets into main.ts, guarded by
	 * `slice(store, mode).length > 200` - over a span some 2,600 lines long.
	 * Move `restorePenHardwareEverSeenFromStore()` OUT of `loadSettings` and
	 * up into `onload` beside the store wiring, and every one of those
	 * assertions still passed: it was still after `setPenHardwareStore({`,
	 * still before `setPenToolsMode(...)`, and a 2,600-line slice is never
	 * going to fall under 200 characters. The guard could not fail, so it
	 * measured nothing - while the test's name claimed to pin exactly the
	 * ordering that had moved.
	 *
	 * What is worth pinning is CONTAINMENT: the restore runs INSIDE the
	 * awaited `loadSettings`, which `onload` awaits before
	 * `registerEditorExtension(inkOverlayExtension())`. `ButtonSpec.shownOn`
	 * is read once per strip, so a restore that landed after the first strip
	 * was built would leave a pen device without its Keyboard button until
	 * something else happened to rebuild the strip - the exact defect the
	 * persistence exists to fix.
	 *
	 * BRACE BALANCE, not "up to the next `\t}`": this body is 180-odd lines
	 * of nested object literals and callbacks, and a first-closing-brace rule
	 * would stop inside the settings literal on its eighth line. `codeOnly`
	 * blanks comments before the walk, so a brace in prose cannot unbalance
	 * the count. String literals are NOT blanked (CodeOnly.ts says so), and
	 * this body holds no brace inside a string today - if one is ever added,
	 * this walk is where it shows up, and it shows up loudly.
	 */
	const bodyOfMethod = (signature: string): string => {
		const at = onlyIndexOf(signature, "the settings reader's declaration");
		const open = src.indexOf("{", at);
		expect(open, "that declaration has no body at all").toBeGreaterThan(-1);
		let depth = 0;
		for (let i = open; i < src.length; i += 1) {
			if (src[i] === "{") depth += 1;
			else if (src[i] === "}") {
				depth -= 1;
				if (depth === 0) return src.slice(open + 1, i);
			}
		}
		throw new Error(`${signature} never closes: the brace walk ran off the end of main.ts`);
	};

	it("restores the latch INSIDE loadSettings, and before the pen tools mode is applied", () => {
		const body = bodyOfMethod(LOAD_SETTINGS);

		// Bounded to this method's REAL size, not to a floor no slice of a
		// 200,000-character file could fall under. `loadSettings` reads and
		// normalises the whole settings object and fills a dozen persist
		// seams, so it runs to thousands of characters; and it is one method
		// of many, so it is a small fraction of the file. Either bound
		// failing means the walk found something that is not this body.
		expect(body.length, "the brace walk collapsed to something far smaller than this method").toBeGreaterThan(4000);
		expect(body.length, "the brace walk swallowed more than loadSettings").toBeLessThan(src.length / 8);

		// The mode is applied by applyRuntimeSettings, which loadSettings calls;
		// the latch must be restored before that call.
		const restore = body.indexOf(RESTORE);
		const apply = body.indexOf("this.applyRuntimeSettings();");
		expect(
			restore,
			"the restore has left loadSettings: a latch restored after the first strip is built leaves a pen device with no Keyboard button"
		).toBeGreaterThan(-1);
		expect(apply, "loadSettings no longer applies the runtime settings").toBeGreaterThan(-1);
		expect(bodyOfMethod("private applyRuntimeSettings(): void {"), "the pen tools mode is no longer applied").toContain(MODE);
		expect(restore, "the latch must be set before the mode that decides who gets a strip").toBeLessThan(apply);
	});

	// The other half of the move, and the half a synced vault depends on: an
	// old data.json's `penHardwareEverSeen: true` may have come from another
	// machine, so main.ts must not read it ANYWHERE - not as a setting, not
	// through the normalise. `codeOnly` blanks comments, so the prose above
	// that explains the removal cannot satisfy either check.
	it("reads the latch from no setting at all, so a synced data.json cannot carry it", () => {
		expect(src, "the setting is read again; the latch would travel between machines").not.toContain(
			"settings.penHardwareEverSeen"
		);
		expect(src, "the normalise is back; an old key from another machine would be trusted").not.toContain(
			"raw?.penHardwareEverSeen"
		);
	});

	// A restore is not a contact, at the call site too. main.ts must never
	// reach for the contact function to replay a stored fact: that would fire
	// the cursor-mode light-up on startup and set both present-tense flags.
	it("never calls markPenHardwareSeen", () => {
		expect(src).not.toContain("markPenHardwareSeen(");
	});
});

/**
 * `deviceHasNeverSeenAPen`: the pen-less test behind "button should become
 * the truth" (alan, 2026-09-05) and its own same-day addendum. Since this
 * branch rebased onto 1.4.12 it reads `penHardwareEverSeen()` - the latch
 * that outlives BOTH a mouse-ink-off and the session - rather than the
 * present-tense `penHardwareSeen()`. So both limits earlier drafts of these
 * tests pinned are gone: a mouse-ink-off no longer clears it, and it now
 * survives a relaunch through this device's local store. The restart half
 * is proved by the persistence describes above, which own the store; these
 * pin the derivation itself.
 */
describe("deviceHasNeverSeenAPen: the pen-less test", () => {
	beforeEach(resetPenToolsForTest);

	it("true after a reset - a device whose store has never recorded a pen", () => {
		// resetPenToolsForTest clears the latch AND the device store it is
		// restored from (PenToolsMode.ts), so this is the never-seen-a-pen
		// device, not merely one before its first contact this session.
		expect(deviceHasNeverSeenAPen()).toBe(true);
	});

	it("false once a real pen has touched or hovered the glass this session", () => {
		markPenHardwareSeen();
		expect(deviceHasNeverSeenAPen()).toBe(false);
	});

	/**
	 * CHANGED, once this branch rebased onto the tip carrying the persisted
	 * latch: BEFORE, this test was named "LIMIT: reverts to true after a
	 * mouse-ink-off" and asserted `true` at the end - `deviceHasNeverSeenAPen`
	 * read the present-tense `penHardwareSeen()`, which `clearPenHardwareSeen`
	 * (called from every mouse-ink-off) puts back to false. Repointing onto
	 * `penHardwareEverSeen()`, which that function is NEVER
	 * cleared with (PenToolsMode.ts's own comment on the latch: "never
	 * cleared with it"), closes that hole - a real pen device stays reading
	 * as pen-seen through a mouse-ink-off now. NOW asserts the CLOSED
	 * reading, `false`, and is named for what it now proves rather than
	 * what it used to.
	 */
	it("CLOSED: stays false after a mouse-ink-off, for a device that has held a pen this session", () => {
		markPenHardwareSeen();
		expect(deviceHasNeverSeenAPen()).toBe(false);
		clearPenHardwareSeen();
		expect(deviceHasNeverSeenAPen()).toBe(false);
	});
});
