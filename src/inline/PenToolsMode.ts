import { timerHost } from "../util/RuntimeScheduler";
/**
 * When the floating pen-tools strip shows (roadmap wishlist: pen GUI).
 *
 * Mobile always shows it: the palette lives in a toolbar the pen keeps
 * hidden, so the strip is the only path. Desktop is the judgment call - a
 * keyboard user writing prose does not want floating chrome, and a Surface
 * in tablet mode has exactly the iPad's problem. "auto" resolves it without
 * a setting safari: the strip appears the first time a pen is actually
 * seen (hover or contact) and stays for the session. "show" and "hide"
 * override in either direction, for the people auto guesses wrong about.
 */

import { clearToolPicked, disarmMouseInkQuietly, mouseActsAsPen } from "./MouseInk";

export type PenToolsMode = "auto" | "show" | "hide";

export const PEN_TOOLS_MODES: readonly PenToolsMode[] = ["auto", "show", "hide"];

let mode: PenToolsMode = "auto";
let penSeen = false;
/**
 * A real pen fired a real event.
 *
 * SEPARATE from `penSeen`, which answers the STRIP-VISIBILITY question and is
 * deliberately set by UI paths too: every tool command, the mouse-ink toggle
 * and the settings switch call `markPenSeen` so that asking for a pen tool
 * raises the pen UI on a machine that has never held a pen. That is correct
 * for visibility and fatal for anything reading `penSeen` as "a pen exists" -
 * a mouse-only user turns it true on their first click of the strip, and
 * every read after that is a constant.
 *
 * `nibIsLit` was reading it that way, which is why the pen button would not
 * go dark when a mouse click handed the tip back to text (alan, 2026-09-02:
 * "doesnt unhighlight the boxes, they are still lit"). This flag answers the
 * question that one actually wanted - does the tip ink WITHOUT mouse ink -
 * and only genuine pen contact or pen hover may set it.
 */
let penHardware = false;
/**
 * Has real pen hardware EVER touched this device THIS SESSION?
 *
 * THE THIRD FLAG IN THIS FILE, and the two above it are one word away from
 * it, so read all three together before using any of them:
 *
 *   `penSeen`      - should the strip EXIST. Set by UI paths too (every tool
 *                    command, the mouse-ink toggle, the settings switch), so
 *                    it is a constant `true` for a mouse-only user from their
 *                    first click onward. NOT interchangeable with either flag
 *                    below, and reading it as "a pen exists" is the mistake
 *                    that hid the `nibIsLit` bug for three releases.
 *   `penHardware`  - does the tip ink RIGHT NOW without mouse ink. Honest,
 *                    and deliberately NON-MONOTONIC: `clearPenHardwareSeen`
 *                    puts it back to false whenever mouse ink goes off.
 *   this one       - has a pen EVER been here. Set beside `penHardware` and
 *                    never cleared with it.
 *
 * WHAT IT IS FOR. The Keyboard button's existence (`ButtonSpec.shownOn`,
 * MobileTools.ts). Alan, 2026-09-05, ruling on it directly: "yeah mouse only
 * users should never see it, i think" - a machine that has never held a pen
 * has no pen to turn off, so the button is 32px of a row he had just called
 * too wide for a phone.
 *
 * WHY NOT `penSeen`, which is what the brief asked for. It is `true` for a
 * mouse-only user the moment they press anything on the strip, so the button
 * would appear for exactly the people the ruling is about.
 *
 * WHY NOT `penHardwareSeen()`, which is the honest read of "a pen is here".
 * Because it GOES BACK TO FALSE. `clearPenHardwareSeen` clears it on every
 * mouse-ink-off, and does so deliberately - see its own comment - while
 * deliberately sparing `penSeen`, because Alan separated the two precisely so
 * the toolbar would stop vanishing ("why the fuck would the toolbar
 * disappear"). Keying a BUTTON's existence off a flag that goes false is that
 * same complaint at one button's scale, and this slice's own brief forbids it
 * in as many words: nothing may disappear based on state.
 *
 * So the latch. It goes false-to-true once and stays, which is what makes it
 * safe to read from a build-time predicate at all: `shownOn` runs once per
 * strip, and a predicate over anything that could go back down would freeze a
 * button into whichever answer the build happened to catch.
 *
 * PERSISTED SINCE 1.4.12, and no longer session-scoped. Alan, 2026-09-05,
 * ruling on the session-scoped version above: "mouse only users should never
 * see it". The half that still needed fixing was the other one - a PEN user
 * who restarts Obsidian got no Keyboard button until the pen next touched the
 * glass, which reads as the button being broken on the device that has the
 * most right to it. So the latch outlives the session: main.ts writes it to
 * THIS DEVICE's local store on the false-to-true edge and calls
 * `restorePenHardwareEverSeenFromStore()` at load, before any strip can be
 * built. It lived in `settings.penHardwareEverSeen` until 2026-09-05; see
 * `PEN_HARDWARE_SEEN_KEY` below for why one day was enough.
 *
 * ONE FLAG, NOT TWO. A restore sets this same variable rather than a second
 * "restored" boolean OR'd into the read, because every consumer asks the same
 * question - has a pen ever been on this device - and two spellings of one
 * fact in a file that already carries three flags one word apart is how the
 * fourth confusion gets written. What a restore must NOT do is pretend to be a
 * contact; that distinction lives in the two ENTRY POINTS below -
 * `markPenHardwareSeen` for a contact, `restorePenHardwareEverSeen` for a
 * load - and not in the flag they share.
 */
let penHardwareEver = false;

/**
 * How main.ts is told to write the latch down. Same shape as
 * `setPersistInkSize` (InkOverlay.ts): live state here, persistence there.
 *
 * Null until `loadSettings` registers it, and that is safe rather than lucky -
 * `loadSettings` is awaited in `onload` before `registerEditorExtension`, so
 * no surface, no router and therefore no pen contact exists while this is
 * still null.
 */
let persistPenHardwareSeen: (() => void) | null = null;

export function setPersistPenHardwareSeen(fn: (() => void) | null): void {
	persistPenHardwareSeen = fn;
}

/**
 * WHERE THE LATCH IS WRITTEN DOWN: this DEVICE's own store, not `data.json`.
 *
 * data.json syncs between machines. Alan's vaults sync between a Surface with
 * a pen and a desktop with only a mouse, so a latch kept in settings taught
 * the desktop that it had held a pen and put a Keyboard button on a machine
 * that can never use one - the exact outcome the ruling this feature serves
 * forbids ("mouse only users should never see it", 2026-09-05). The settings
 * field's own comment called this edge accepted and said "revisit it if anyone
 * reports the button on a machine with no pen". Someone did.
 *
 * Whether a pen has touched THIS glass is a fact about the device, so it is
 * stored the way the pressure calibration's device maximum already is:
 * through Obsidian's per-vault AND per-device local store, wired in from
 * main.ts's `onload` beside `setPressureStore`. Nothing here touches the raw
 * `localStorage` global (community directory scorecard, 2026-08-27).
 */
const PEN_HARDWARE_SEEN_KEY = "handwriting-device-pen-hardware-seen";

/**
 * The same seam shape as `PressureStore` (PressureGain.ts), and null both
 * before `onload` registers one and in the unit tests, which have no
 * Obsidian - so every access below is a no-op rather than a crash when it is
 * absent.
 */
export interface PenHardwareStore {
	/**
	 * `string | boolean | null`, not the `string | null` Obsidian's types
	 * promise. `loadLocalStorage` reads back through a JSON decode in some
	 * versions, and a decode turns the `"true"` written below into the
	 * BOOLEAN true. Typed for what can actually arrive, so the restore has to
	 * handle it rather than silently failing its one `=== "true"` test and
	 * leaving a pen device with no Keyboard button.
	 */
	load(key: string): string | boolean | null;
	save(key: string, value: string): void;
}

let penHardwareStore: PenHardwareStore | null = null;

export function setPenHardwareStore(s: PenHardwareStore | null): void {
	penHardwareStore = s;
}

/**
 * The body main.ts registers with `setPersistPenHardwareSeen`. Synchronous,
 * unlike the `data.json` write it replaces: a local-store save is not a vault
 * file, so there is nothing to debounce, nothing to conflict with and nothing
 * to await.
 *
 * A throw is swallowed for the same reason the pressure store swallows one -
 * storage can be denied - and the cost is bounded: the button is still correct
 * for the session that saw the pen, and the next pen contact writes it again.
 */
export function persistPenHardwareSeenToStore(): void {
	try {
		penHardwareStore?.save(PEN_HARDWARE_SEEN_KEY, "true");
	} catch {
		/* storage denied: the next pen contact on this device writes it again */
	}
}

/**
 * The load-time half, called by main.ts's `loadSettings` in place of the old
 * `if (this.settings.penHardwareEverSeen)` test.
 *
 * AN OLD data.json CARRYING `penHardwareEverSeen: true` IS IGNORED, on purpose
 * and permanently: that key may have arrived from another machine - which is
 * the whole defect - so it is no evidence about this one. It is also NOT
 * deleted. Another machine may still be running a build that reads it, and
 * dropping a key from a file that syncs would take that machine's latch away
 * with it. It simply goes unread, and one pen contact here writes the local
 * key that does count.
 *
 * BOTH SPELLINGS OF TRUE ARE ACCEPTED (auditor, 1.4.12): the string `"true"`
 * this module writes, and the boolean `true` a JSON-decoding `loadLocalStorage`
 * hands back for the same stored value. The write is unchanged - always the
 * string - so nothing new is ever put in the store; this only stops the read
 * from being a single-spelling test that a host-side decode would silently
 * fail, taking the Keyboard button off a pen device that had earned it. Only
 * those two count: `"false"`, `false`, `null`, a missing key and anything else
 * leave the latch alone, so a stray value cannot latch a mouse-only machine.
 */
export function restorePenHardwareEverSeenFromStore(): void {
	let stored: string | boolean | null = null;
	try {
		stored = penHardwareStore?.load(PEN_HARDWARE_SEEN_KEY) ?? null;
	} catch {
		return;
	}
	if (stored === "true" || stored === true) restorePenHardwareEverSeen();
}

/**
 * Surfaces waiting to be told the answer changed.
 *
 * The note surface never needed this: `refreshPenToolsAll` (InkOverlay.ts)
 * walks InkOverlay's own set of open editors, and every place in main.ts that
 * changes the mode or marks a pen calls it on the next line. The PDF surface
 * is not in that set - main.ts holds its controllers in a different map, and
 * the note's fan-out has never looked there - so "Pen toolbar → Hide" hid the
 * strip on notes and left it on screen over every PDF (alan, 2026-09-02).
 *
 * A registry HERE rather than a second fan-out in main.ts, because the two
 * things that can change the answer - `setPenToolsMode` and `markPenSeen` -
 * both live in this file, and a subscriber therefore cannot be missed by a
 * caller who forgot to refresh. That is not hypothetical: `markPenSeen` is
 * called from inside both ink surfaces' own pen paths (InkOverlay's
 * `showPenCursor` and ink branch, PdfInkController's `showCursor` and
 * `penDown`), where no `refreshPenToolsAll` follows it and none should.
 */
type PenToolsListener = () => void;
const listeners = new Set<PenToolsListener>();

/**
 * Be told whenever `penToolsVisible` would answer differently than it just
 * did. Returns the unsubscribe, which a surface MUST call at teardown: a PDF
 * viewer is rebuilt inside a leaf that outlives it, and a controller leaking
 * one of these per teardown would hold a dead pane's strip logic alive for
 * the rest of the session.
 */
export function onPenToolsChanged(listener: PenToolsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Tell everyone, and let nobody's failure stop the next.
 *
 * Copied before walking, because a listener is allowed to unsubscribe from
 * inside the call - tearing a surface down IS one of the things a mode change
 * can do - and mutating the set being iterated is how that turns into a
 * missed surface. Each call is bulkheaded for the reason every strip path in
 * this plugin is: chrome must never take the ink down with it.
 */
function announce(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch (err) {
			console.error("[handwriting] pen tools listener failed", err);
		}
	}
}

/**
 * NO SECOND CHANNEL FOR THE FIRST-EVER CONTACT, and there never needs to be
 * one. A `onFirstPenContact` / `announceFirstPenContact` pair lived here
 * until 1.4.12, built for a cursor-mode light-up subscriber that was never
 * written: the light-up shipped as `InlinePenRouter`'s own one-boolean flip
 * (`setPenInk(true)`, PenInk.ts) inside the contact it is deciding about,
 * which needs nothing from this file, and the Keyboard button's edge is
 * served by `stale()` + `refreshPenToolsAll` (InkOverlay.ts). A fan-out with
 * no subscriber is not a seam, it is a second spelling of an edge that this
 * file's own history says gets read for the wrong one - see the account of
 * `penSeen` read as `penHardware` at the head of this file.
 *
 * What that pair was PROTECTING is still protected, and by construction
 * rather than by a rule: a restore must never be treated as a contact, and
 * `restorePenHardwareEverSeen` below sets the latch and announces on the
 * generic channel only. There is no contact-shaped thing left for it to
 * reach by accident.
 */

export function getPenToolsMode(): PenToolsMode {
	return mode;
}

export function setPenToolsMode(m: PenToolsMode): void {
	// Only on a real change. The setting is re-applied at every settings save
	// and again at load, and announcing an unchanged answer would have every
	// open surface re-run its create-or-destroy for nothing.
	if (mode === m) return;
	mode = m;
	announce();
}

export function normalizePenToolsMode(raw: unknown): PenToolsMode {
	return raw === "show" || raw === "hide" ? raw : "auto";
}

export function nextPenToolsMode(cur: PenToolsMode): PenToolsMode {
	const i = PEN_TOOLS_MODES.indexOf(cur);
	return PEN_TOOLS_MODES[(i + 1) % PEN_TOOLS_MODES.length] ?? "auto";
}

/**
 * Show the strip: something asked for the pen UI. NOT proof of a pen - see
 * `penHardware` above for why, and `markPenHardwareSeen` for the flag that is.
 */
export function markPenSeen(): void {
	// The false-to-true edge only. This runs on every pen-down on both
	// surfaces, and announcing on each of them would put a create-or-destroy
	// sweep in the middle of every stroke's first sample - the one place in
	// this plugin where nothing may be spent.
	if (penSeen) return;
	penSeen = true;
	announce();
}

export function penSeenThisSession(): boolean {
	return penSeen;
}

/**
 * A real pen touched or hovered the glass (hover counts: it is proof enough).
 *
 * Marks the strip visible too - a pen is proof for both questions, and every
 * caller of this one used to call `markPenSeen` here, so routing visibility
 * through it is what keeps the strip appearing exactly when it did before.
 *
 * No `announce` on the hardware edge of its own: the visibility answer is
 * what listeners create and destroy surfaces for, `markPenSeen` already
 * announces that edge, and this runs from inside both surfaces' pen-down -
 * the one place in this plugin where nothing may be spent. The LIGHT does not
 * need one either; every caller follows this with `ensurePenTools`, whose
 * strip refreshes on the same contact.
 *
 * The gate lives at the CALL SITES rather than in here, matching
 * `PdfInkController.showCursor`'s `if (pointerType === "pen") markPenSeen()` -
 * they are the only code that still knows what fired the event.
 *
 * THE LATCH EDGE DOES THREE THINGS, IN THIS ORDER, and the order is the whole
 * of the design rather than an accident of how it was written:
 *
 *   1. set the flag SYNCHRONOUSLY. Everything downstream of a pen-down reads
 *      it in the same tick, so it cannot be deferred by anything.
 *   2. announce, on the generic fan-out (`markPenSeen` -> `announce`) and on
 *      nothing else: "an answer moved, rebuild if you are stale". There is no
 *      first-contact channel beside it - see the note above
 *      `getPenToolsMode` for where that light-up actually lives.
 *   3. SCHEDULE THE PERSIST, once, and never again in the session. Last, and
 *      never anything after it.
 *
 * WHY (3) IS SCHEDULED AND (1) IS NOT. This runs from inside both surfaces'
 * pen-down - the one place in this plugin where nothing may be spent - and
 * writing data.json is a vault round-trip. Deferring the answer would be
 * wrong; deferring the FILING of the answer costs the stroke nothing and the
 * user nothing, because the only reader of the file is the next launch.
 */
export function markPenHardwareSeen(): void {
	// The hardware answer FIRST, then visibility. `markPenSeen` announces,
	// and a listener that woke on that edge and read `penHardwareSeen()`
	// would otherwise be told there was no pen by the very call a pen made.
	// It also survives anyone later putting a guard on `markPenSeen`: the
	// flag this function exists to set is already set by then.
	penHardware = true;
	// Read the edge before setting it: steps 2 and 3 below are both
	// once-ever, and after the assignment there is nothing left to tell them
	// apart from the ten-thousandth sample of the same session.
	const firstEver = !penHardwareEver;
	// The LATCH, beside the flag it shadows and never cleared with it. Every
	// route a real pen can take into this module comes through here, so this
	// is the one line that has to be right for "a pen has been on this
	// device" to be answerable at all.
	penHardwareEver = true;
	// NO FIRST-CONTACT HOOK HERE: the light-up for the contact that woke this
	// is `InlinePenRouter`'s own `setPenInk(true)`, decided inside the claim.
	// STEP 2: the generic fan-out, unchanged - `markPenSeen` announces its
	// own edge and this call is exactly what it always was.
	markPenSeen();
	// ---- STEP 3, THE PERSIST. Nothing goes after this line. ----------------
	if (firstEver) schedulePersistPenHardwareSeen();
}

/**
 * File the latch, off the pen-down path.
 *
 * ONE SEAM, at the end of the edge, so the persist has a single obvious home
 * that survives the edge being restructured around it.
 *
 * SCHEDULED, NOT CALLED. `markPenHardwareSeen` runs from inside both surfaces'
 * pen-down, and main.ts's callback reaches `persistPenHardwareSeenToStore` -
 * THIS DEVICE's local store, not a vault write. A `setTimeout(0)` puts it
 * after this contact has been claimed, sampled and drawn, which costs
 * nothing: the only reader of the stored key is the next launch. Fire-and-
 * forget by construction - it returns void, nothing on the pen-down path can
 * await it, and `persistPenHardwareSeenToStore` is itself synchronous, so
 * there is no promise for main.ts to hand anywhere.
 *
 * ONCE PER SESSION, guarded HERE rather than only by the caller's edge.
 * `markPenHardwareSeen`'s edge is already once-ever and this flag is
 * therefore redundant today - which is the point. It is what keeps "never
 * again in the session" true if the edge is ever restructured, and a second
 * local-store save on a later contact is a write nobody asked for.
 *
 * `setTimeout` rather than `queueMicrotask`: a microtask runs before the
 * browser can paint, so it would still land inside the frame that owes the
 * user their first ink, and the suite's fake timers can pin a setTimeout.
 */
let persistScheduled = false;

function schedulePersistPenHardwareSeen(): void {
	if (persistScheduled) return;
	persistScheduled = true;
	timerHost().setTimeout(() => {
		try {
			persistPenHardwareSeen?.();
		} catch (err) {
			// Same bulkhead as the fan-outs: chrome and bookkeeping must never
			// take the ink down with them, and this one runs unattended.
			console.error("[handwriting] persisting the pen hardware latch failed", err);
		}
	}, 0);
}

/**
 * A PREVIOUS session's pen on THIS device, read back from the local store by
 * `restorePenHardwareEverSeenFromStore` above. Called once per launch, from
 * main.ts's `loadSettings`, before any strip can be built.
 *
 * DELIBERATELY NOT `markPenHardwareSeen()`, and the difference is the whole
 * reason this function exists rather than main.ts calling that one:
 *
 *   - it does NOT run the contact edge at all. A LOAD IS NOT A CONTACT: the
 *     pen light-up belongs to the contact that woke it (`InlinePenRouter`'s
 *     `setPenInk(true)`), and a load reaching that edge would arm the pen at
 *     every launch on a device whose owner deliberately left it in cursor
 *     mode. Keeping the two entry points separate is what makes that
 *     unwriteable rather than merely discouraged.
 *   - it does NOT touch `penHardware` or `penSeen`. Neither is a fact about
 *     the past: `penHardware` says the tip inks RIGHT NOW, and restoring it
 *     would light the nib for a pen that is not in the room, which is the
 *     `nibIsLit` bug arriving by a new road. `penSeen` decides whether the
 *     strip exists at all, and a desktop that showed no strip yesterday must
 *     not open with one today.
 *   - it does NOT schedule the persist. The value came from THIS DEVICE's
 *     local store, key `handwriting-device-pen-hardware-seen`, which already
 *     says true - so the write would be a synchronous local-store save of a
 *     value that is already sitting there. Not the vault: the latch left
 *     `data.json` on 2026-09-05 precisely so a synced file could not carry
 *     another machine's pen onto this one, and an old `data.json` key is
 *     deliberately IGNORED at load rather than read as a fallback.
 *
 * It DOES announce on the generic channel. Nothing is listening yet - this
 * runs before `registerEditorExtension` - so it is free today, and it is what
 * keeps a future listener registered earlier from missing the one change to
 * this answer a whole session may contain.
 */
export function restorePenHardwareEverSeen(): void {
	if (penHardwareEver) return;
	penHardwareEver = true;
	announce();
}

/**
 * Does the tip ink without mouse ink? Only a real pen makes this true.
 *
 * Read by `nibIsLit` (MobileTools.ts) and by nothing that decides visibility.
 * A finger cannot ink an ordinary note at all - `InlinePenRouter.pointerDown`
 * returns on every branch of its `pointerType === "touch"` block - so touch
 * not setting this is the honest answer rather than a gap.
 */
export function penHardwareSeen(): boolean {
	return penHardware;
}

/**
 * Has a real pen EVER been on this device? The latch above, read - this
 * session's contact OR a previous session's, restored at load. ONE read for
 * both, so no caller has to know which it was.
 *
 * NAMED WITHOUT "ThisSession" SINCE 1.4.12, and renamed rather than aliased.
 * It was `penHardwareEverSeenThisSession` while the latch died with the
 * session; the whole of this change is that it no longer does, so the old
 * name is now a false statement about the answer, in a file whose standing
 * defect is three flags one word apart being read for each other.
 *
 * Read by the Keyboard button's `shownOn` (MobileTools.ts), by
 * `deviceHasNeverSeenAPen()` below, and by nothing else. NOT interchangeable
 * with `penHardwareSeen()` beside it, which answers the present tense and
 * goes back to false on every mouse-ink-off, nor with `penSeenThisSession()`,
 * which every tool command sets. See the latch's own comment at the top of
 * this file for the ruling behind all three.
 */
export function penHardwareEverSeen(): boolean {
	return penHardwareEver;
}

/**
 * Has this device seen a pen?
 *
 * The one function every caller reads for "pen-less" (alan's addendum to
 * "button should become the truth", 2026-09-05: mouse-draws-from-a-lit-tool
 * on a pen-less device, MouseInk.ts), so the meaning has a single home
 * rather than a flag test copied to each call site.
 *
 * DURABLE ACROSS A RESTART as of this branch's rebase onto 1.4.12. It reads
 * `penHardwareEverSeen()` above: the session latch OR the value restored
 * from THIS DEVICE's local store - the store rather than data.json, so a
 * vault synced from a pen device cannot make a mouse-only one read as
 * pen-holding. That latch is also never cleared by `clearPenHardwareSeen()`,
 * so an ordinary mouse-ink-off cannot make a pen-holding device read
 * pen-less again mid-session. Both holes an earlier draft of this docstring
 * warned about are closed, and this function is no longer a placeholder.
 *
 * What that buys the grant this function gates: a pen user who restarts
 * with a tool still lit is NOT handed the mouse-draws grant, because
 * main.ts restores the latch before any strip is built - an ordering
 * pinned in PenToolsMode.test.ts rather than left to chance.
 */
export function deviceHasNeverSeenAPen(): boolean {
	return !penHardwareEverSeen();
}

/**
 * NOTHING BUILT HERE FOR THE FIRST-EVER-CONTACT EDGE, deliberately, and
 * `markPenHardwareSeen()` above is not even CALLED any earlier than it
 * already was. Two earlier passes through this brief tried otherwise (a
 * home-grown `markPenHardwareSeenOnFirstContact` with its own scheduled
 * announce and a no-op persist seam, then a version that called this
 * ORDINARY `markPenHardwareSeen()` straight from the router ahead of its
 * pen-off check) - both dropped once it became clear that `markPenSeen()`
 * -> `announce()` inside this function is SYNCHRONOUS, and `announce()`'s
 * one production subscriber today walks straight into a full PDF strip
 * rebuild (`PdfInkController`'s `onPenToolsChanged(() => this.ensureTools())`,
 * registered in InkOverlay.ts). Calling this function from ahead of the
 * router's pen-off check would have run that rebuild ABOVE the point where
 * "nothing may be spent" (InlinePenRouter.ts's own comment on its pen-off
 * early return) - exactly the spend that comment warns against, whether or
 * not the contact ends up claimed.
 *
 * So `InlinePenRouter`'s addendum-3 branch (InlinePenRouter.ts) does NOT
 * call anything in this file at all: it flips only `setPenInk(true)`
 * (PenInk.ts, a bare module boolean with no listeners), which is the one
 * thing its claim decision reads. `markPenHardwareSeen()` still fires for
 * that same contact - unchanged, from its ordinary call sites inside the
 * two surfaces' own `penDown`/`showCursor` - just a few lines later in the
 * SAME synchronous call, once the claim that flip enabled has gone
 * through. The persisted latch has since merged, and those same ordinary
 * call sites run its `schedulePersistPenHardwareSeen()` edge for free, with
 * no change needed here OR in the router - which is also why the
 * first-contact fan-out this file used to carry beside it was removed rather
 * than wired up: the router had already made it a channel with no
 * subscriber.
 */

/**
 * Should turning pen input OFF raise the pen-tools strip?
 *
 * `pen-ink-toggle` (main.ts) used to call `markPenSeen()` on every press,
 * on or off: someone who turns the pen off on a machine that has never
 * shown the strip would otherwise have no visible switch to turn it back
 * on. Alan's "and hide" ruling narrows that to a device that has actually
 * held a pen - turning the pen off from a hotkey or the palette must not
 * be what FIRST raises a strip nobody has needed yet.
 *
 * Takes `penHardwareSeen()`, deliberately not `penSeenThisSession()` - see
 * the warning on `penHardware` above for why those two are not
 * interchangeable. `penSeen` goes true on a mouse-only user's very first
 * tool command, which would make this predicate a constant `true` and
 * undo the ruling on the first press it was written for.
 *
 * Turning the pen ON is unaffected: that branch still calls `markPenSeen()`
 * unconditionally, exactly as before - asking for the pen BY NAME raises
 * the UI regardless of hardware, and only the OFF half of the rule moved.
 *
 * Pure, so both cases are a source-level assertion rather than a click
 * through a live strip: see `PenToolsMode.test.ts`.
 */
export function shouldRaiseStripOnPenOff(hardwareSeen: boolean): boolean {
	return hardwareSeen;
}

/**
 * Forget the pen, for the LIGHT only. Turning mouse ink off calls this.
 *
 * ALAN'S RULE, 2026-09-03, in his words: the pen button "should be dark until
 * you touch with your pen", and turning mouse ink off should turn the light
 * off "at any point". Before this, one stroke from a real pen latched
 * `penHardware` for the rest of the session, so the button stayed lit however
 * many times mouse ink was switched off afterwards - he read that as the light
 * being stuck, and testing it by hand could not make it go dark.
 *
 * It clears `penHardware` and DELIBERATELY NOT `penSeen`. Those two answer
 * different questions and he separated them explicitly when asked: `penSeen`
 * decides whether the pen TOOLBAR exists, and he does not want the toolbar
 * disappearing ("why the fuck would the toolbar disappear"). `penHardware`
 * decides only whether the nib reads as able to ink. Clearing both would take
 * the strip away from under him, which is the opposite of what he asked for.
 *
 * AND DELIBERATELY NOT `penHardwareEver`, for the same reason one step down.
 * The latch decides whether the Keyboard BUTTON exists; clearing it here
 * would make that button come and go with every mouse-ink toggle, which is
 * the toolbar complaint above applied to one button. See the latch's comment
 * at the top of this file.
 *
 * Nothing is lost by clearing it: every real pen contact calls
 * `markPenHardwareSeen` again on both surfaces, so the next touch of the nib
 * lights it straight back up. That is the whole of "dark until you touch with
 * your pen".
 *
 * No `announce()`. This changes no surface's existence - only how the strip
 * draws - and both callers follow it with `refreshPenToolsAll()`, which is the
 * repaint that actually matters here.
 */
export function clearPenHardwareSeen(): void {
	penHardware = false;
}

/**
 * Put a tool DOWN with a mouse: hand the pointer back to text, light out.
 *
 * The two halves are paired here, once, because they are one rule with two
 * writers. Mouse ink going off darkens the nib light "at any point" (alan,
 * 2026-09-03); the loud toggle command spells that pair out itself, and this
 * is the quiet path that the strip's own buttons take. Written twice - once
 * per ink surface's host - it would be the same duplication that has cost
 * this project nine one-surface divergences.
 *
 * It lives in THIS module rather than `MouseInk.ts` because the light is this
 * module's state and `MouseInk` cannot reach it: the import already runs the
 * other way (`mouseActsAsPen`, above), so the cycle would be real.
 *
 * `penSeen` and `penHardwareEver` are both untouched, deliberately, exactly
 * as in `clearPenHardwareSeen`. Putting a tool down must take away neither
 * the toolbar nor a button on it.
 */
export function releaseMouseInkQuietly(): void {
	disarmMouseInkQuietly();
	penHardware = false;
	// THE THIRD HALF, since the put-down stopped being reachable only through
	// the armed switch. On a pen-less device the mouse draws because a tool is
	// PICKED (MouseInk.ts, `toolPicked`) and not because anything was armed,
	// so disarming a flag that was already false put nothing down: the tool
	// stayed lit, the mouse kept inking, and the only exit left was the
	// pen-ink toggle - whose strip button is hidden on exactly these devices.
	// Unpicking here rather than at the strip's two put-down branches for the
	// reason the pair above is paired at all: one rule, one place, both ink
	// surfaces.
	clearToolPicked();
}

/**
 * May this pointer raise the pen toolbar? "Can it ink", not "is it a pen".
 *
 * ALAN REVERSED HIS OWN 1.4.6 RULING TO GET THIS, 2026-09-03. He was asked
 * directly, with the old rationale quoted back to him - "a mouse in the room,
 * reticle off, raised the pen toolbar in auto mode for a pointer that was
 * never a pen" (1.4.6-design.md 5m/AF5) - and answered "with mouse ink armed,
 * yes a hovering mouse should bring toolbar out". AF5 refused the mouse
 * outright; the armed mouse is the case it did not separate out, and a mouse
 * whose owner has deliberately turned mouse ink on is asking for the tools.
 * The unarmed mouse is still refused, which is the half of AF5 that stands.
 *
 * The gate lives here and the surfaces read it, rather than each spelling the
 * condition out: the note and the pdf disagreeing about exactly this was the
 * defect (this was the note surface's behaviour and not the pdf's), and two
 * copies of the new rule would be the same defect with a fresh coat.
 *
 * VISIBILITY ONLY. A mouse with ink armed may raise the strip and may never
 * set the hardware flag - `markPenHardwareSeen` stays gated on a real pen on
 * both surfaces. `nibIsLit` already answers the mouse case through its own
 * `|| h.mouseInkOn()` disjunct, and routing the mouse into `penHardware` to
 * light the nib would be the 1.4.6-through-1.4.8 bug rebuilt from the far end.
 */
export function pointerRaisesPenTools(pointerType?: string): boolean {
	return pointerType === "pen" || mouseActsAsPen(pointerType);
}

/** The whole visibility rule, pure. */
export function penToolsVisible(m: PenToolsMode, isMobile: boolean, seen: boolean): boolean {
	if (m === "show") return true;
	if (m === "hide") return false;
	return isMobile || seen;
}

/** Test seam. */
export function resetPenToolsForTest(): void {
	mode = "auto";
	penSeen = false;
	penHardware = false;
	// The latch too. It is the one flag here that NOTHING in the shipped code
	// clears, which makes it precisely the one a test suite must, or the
	// first test to touch a pen would hand every later test a device that has
	// held one.
	penHardwareEver = false;
	// The persist seam and its once-per-session guard, which are module state
	// exactly as the flags are. Without the guard reset, the FIRST test to
	// mark a pen would spend the session's one schedule and every later test
	// asserting that the latch is written down would watch nothing happen.
	persistScheduled = false;
	persistPenHardwareSeen = null;
	// The device store is module state exactly as the seam above it is: a fake
	// left registered by one test would answer the next one's restore.
	penHardwareStore = null;
	// The subscribers too, and not as an afterthought: this is module state
	// like the other two, and a listener left over from a surface an earlier
	// test never tore down would fire into a dead fixture on the next test's
	// first mode change.
	listeners.clear();
}

/**
 * How many surfaces are listening. Test seam, and the only witness there is
 * that a teardown actually ran its unsubscribe - a leaked listener is
 * invisible from the outside until the session has accumulated enough of them
 * to matter, which is exactly too late to notice.
 */
export function penToolsListenerCountForTest(): number {
	return listeners.size;
}
