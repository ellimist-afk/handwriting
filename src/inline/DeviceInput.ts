/**
 * What this DEVICE can do with a pointer, for the buttons whose existence
 * depends on it.
 *
 * One question so far: does this machine have a touchscreen.
 *
 * NOTHING READS IT TODAY. The Pan button asked it for a day - panning with
 * the tip is a workaround for not having a finger, so on anything with glass
 * it was a button spending a slot on a gesture the user already had (alan,
 * 2026-09-05, on the strip being too wide for a phone) - until the same day's
 * later ruling put Pan back on every device and gave the width problem to the
 * fold list instead ("pan in the fold list fine"). The read is kept, with its
 * tests: it is cheap, it is the only standard reading of the device fact, and
 * a per-device DEFAULT fold order is the obvious next customer for it.
 *
 * `navigator.maxTouchPoints`, NOT Obsidian's `Platform.isMobile`, and the
 * difference is the whole reason this module exists rather than another
 * `Platform` read at the call site. `Platform.isMobile` answers "is this the
 * mobile app", which is a different question with different answers on the
 * two devices that matter here: a Surface running the DESKTOP app has a
 * touchscreen and would keep a Pan button it does not need, and a desktop
 * build in mobile emulation has no glass and would lose one it does. The
 * device fact is the one the rule is about, and `maxTouchPoints` is the only
 * standard reading of it - it is a count of contacts the hardware reports,
 * not a guess from a user-agent string.
 *
 * `ontouchstart` is the fallback for engines predating pointer events. It is
 * a WEAKER test - some desktop browsers define it whether or not glass is
 * attached - so it is reached only when `maxTouchPoints` is missing
 * altogether, never as a second opinion on a 0 it already gave.
 *
 * DOM-free by construction where it can be, like `PenToolsMode` and
 * `ToolbarCorner`: the reads are wrapped so a test can answer for a device
 * it is not running on, and so a headless suite with no `navigator` gets a
 * defined answer instead of a throw from inside a strip constructor.
 */

/** Set by `setHasTouchForTest`; null means "ask the device". */
let forced: boolean | null = null;

/**
 * Does this device have a touchscreen?
 *
 * Read ONCE per strip, at build (see `ButtonSpec.shownOn`), which is honest
 * for this fact in a way it would not be for a state flag: no device grows or
 * loses a digitizer mid-session, so there is no edge for a live read to
 * catch and nothing that could make the answer move under an open strip.
 */
export function deviceHasTouch(): boolean {
	if (forced !== null) return forced;
	// Node-based geometry tests have no browser window or navigator.
	const nav = typeof navigator === "undefined" ? undefined : navigator;
	const points = nav?.maxTouchPoints;
	if (typeof points === "number") return points > 0;
	return typeof window !== "undefined" && "ontouchstart" in window;
}

/**
 * Test seam. Pass a boolean to answer for a device the suite is not running
 * on; pass null to go back to asking this one.
 *
 * A seam rather than a stub of `navigator`, because the thing worth pinning
 * is the RULE - which buttons a touch device gets - and a test that installs
 * a fake navigator would be pinning this file's reading of it twice over.
 */
export function setHasTouchForTest(value: boolean | null): void {
	forced = value;
}
