/**
 * Sideways scroll is ink's to ask for, and it goes away with the ink.
 *
 * The note's scroll range comes from an invisible spacer placed at the note
 * origin plus a granted extent (src/inline/SurfaceExtent.ts). The x grant used
 * to be the ink frontier plus a chunk of headroom whatever the ink was, so one
 * stroke near the right edge of the pane pushed the spacer past it and the note
 * scrolled sideways into nothing. And the grant never shrank, so deleting the
 * far ink left the whole range behind for the rest of the session.
 *
 * Now, with Infinite Canvas off, the ink frontier buys sideways room only when
 * the ink itself reaches past the pane's right edge; with it on, as before.
 * After ink is removed (erase, lasso delete, Delete all ink), and when Infinite
 * Canvas is turned off, the x grant is re-measured from the ink and shrinks,
 * never under what any pane showing the note has on screen: the part off to the
 * right goes at once, the rest as it leaves the view. The vertical grant is
 * untouched, and growth is still chunked.
 *
 * Real overlay, real scroller, pen events (sidewaysScrollPage.ts).
 *
 * Plants, each built into the overlay by source substitution:
 *   HW_SIDEWAYS_PLANT_NO_FLOOR=1          a shrink ignores what the views show (onScreenFloorX)
 *   HW_SIDEWAYS_PLANT_NO_RELEASE_GUARD=1  the band's margin is released even when the range left would end short of the view
 *   HW_SIDEWAYS_PLANT_STEP_WHILE_SCROLLING=1  a held shrink steps on every pass, scrolled frames included
 *   HW_SIDEWAYS_PLANT_STRICT_EDGE=1       Infinite Canvas off claims sideways room only past the pane's right edge (the old rule)
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import { EXTENT_CHUNK, EXTENT_HEADROOM, SHRINK_SCROLL_IDLE_MS } from "../../src/inline/SurfaceExtent";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, script: string;
const evidence: unknown[] = [];

beforeAll(async () => {
	const plants: [string, string, string, string][] = [];
	if (process.env.HW_SIDEWAYS_PLANT_NO_FLOOR) plants.push(["no-floor", "InkOverlay", "floor = Math.max(floor, onScreenFloorX(view));", "floor = Math.max(floor, 0);"]);
	if (process.env.HW_SIDEWAYS_PLANT_NO_RELEASE_GUARD) plants.push(["no-release-guard", "InkOverlay", "if (Math.max(scroller.clientWidth, spacerRight) < scroller.scrollLeft + scroller.clientWidth) return;", ""]);
	if (process.env.HW_SIDEWAYS_PLANT_STEP_WHILE_SCROLLING) plants.push(["step-while-scrolling", "InkOverlay", "if (this.shrinkStepped.get(path) === due && !force) return granted;", ""]);
	if (process.env.HW_SIDEWAYS_PLANT_STRICT_EDGE) plants.push(["strict-edge", "SurfaceExtent", "return g.originLeft + g.frontierX * g.fontZoom > g.clientWidth - EXTENT_MARGIN * g.fontZoom ? g.frontierX : 0;", "return g.originLeft + g.frontierX * g.fontZoom > g.clientWidth ? g.frontierX : 0;"]);
	const applied = new Set<string>();
	const b = await build({ entryPoints: [fileURLToPath(new URL("./sidewaysScrollPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: plants.length ? [{ name: "sideways-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/](InkOverlay|SurfaceExtent)\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8");
				for (const [name, file, from, to] of plants) {
					if (!args.path.replace(/\\/g, "/").endsWith(`/${file}.ts`)) continue;
					if (text.split(from).length !== 2) throw new Error(`plant ${name}: anchor not found exactly once`);
					text = text.replace(from, to);
					applied.add(name);
				}
				return { contents: text, loader: "ts" };
			});
		} }] : [] });
	for (const [name] of plants) if (!applied.has(name)) throw new Error(`plant ${name} requested but never applied`);
	// eslint-disable-next-line no-console
	if (plants.length) console.log(`SIDEWAYS PLANTS ${plants.map(p => p[0]).join(",")}`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_SIDEWAYS_EVIDENCE) writeFileSync(process.env.HW_SIDEWAYS_EVIDENCE, JSON.stringify(evidence, null, 1));
});

type Snap = { frontierX: number; originLeft: number; fontZoom: number; label: string; left: number; width: number; clientWidth: number; range: number; grant: { x: number; y: number }; strokes: number; extentWrites: number; lefts?: number[]; target?: number; band?: { left: number; top: number; width: number; height: number } | null };

async function scenario(name: string, entry = "sidewaysRun"): Promise<Snap[]> {
	const page = await browser.newPage({ viewport: { width: 500, height: 850 } });
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent("<!doctype html><html><body></body></html>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(([fn, n]) => (window as any)[fn](n), [entry, name] as const);
		evidence.push(r);
		expect(errors, `${name}: page errors`).toEqual([]);
		return r.snaps;
	} finally {
		await page.close();
	}
}

const at = (snaps: Snap[], label: string) => { const s = snaps.find(k => k.label === label); if (!s) throw Error(`no snap "${label}"`); return s; };
const show = (s: unknown) => JSON.stringify(s);

/**
 * THE GROWTH TRIGGER with Infinite Canvas off: ink earns sideways room once its frontier comes within EXTENT_MARGIN
 * (120 note px) of the pane's right edge, and the room it gets is one grownAxis step: the frontier plus headroom, in
 * whole chunks. A stroke ending 100 note px inside the edge grows it; one ending 200 inside does not.
 */
const MARGIN = 120;
const inset = (s: Snap) => (s.clientWidth - (s.originLeft + s.frontierX * s.fontZoom)) / s.fontZoom;
type Placement = { reset: { strokes: number; width: number; clientWidth: number; grantX: number }; aim: number; inset: number; points: number[]; grantX: number };

/** Every placement started from a clean note, and the one the claim reads landed within 10 px of the nominal inset. */
function expectPlacedFromClean(drawn: Snap, nominal: number) {
	const attempts = (drawn as Snap & { attempts?: Placement[] }).attempts ?? [];
	expect(attempts.length, `premise: the placements are logged ${show(attempts)}`).toBeGreaterThan(0);
	for (const a of attempts) {
		expect(a.reset.strokes, `premise: no ink before each placement ${show(attempts)}`).toBe(0);
		expect(a.reset.width, `premise: no sideways range before each placement ${show(attempts)}`).toBe(a.reset.clientWidth);
		expect(a.reset.grantX, `premise: no sideways grant before each placement ${show(attempts)}`).toBe(0);
	}
	expect(Math.abs(inset(drawn) - nominal), `premise: the stroke ends within 10 px of ${nominal} note px in, after ${attempts.length} of at most 5 placements ${show(attempts)}`).toBeLessThanOrEqual(10);
}

it("INFINITE CANVAS OFF, A STROKE ENDING 100 NOTE PX INSIDE THE RIGHT EDGE: one grownAxis step of sideways room, and the view stays put", async () => {
	const snaps = await scenario("near-edge-100");
	const reset = at(snaps, "reset"), drawn = at(snaps, "drawn"), still = at(snaps, "still");
	expect(reset.grant.x, `premise: no sideways room before the stroke ${show(reset)}`).toBe(0);
	expect(drawn.strokes, `premise: the stroke landed ${show(drawn)}`).toBe(1);
	expectPlacedFromClean(drawn, 100);
	expect(inset(drawn), `premise: the stroke ends inside the margin, about 100 note px in ${show(drawn)}`).toBeGreaterThan(60);
	expect(inset(drawn), `premise: the stroke ends inside the margin, about 100 note px in ${show(drawn)}`).toBeLessThan(MARGIN);
	const step = Math.ceil((drawn.frontierX + EXTENT_HEADROOM) / EXTENT_CHUNK) * EXTENT_CHUNK;
	expect(drawn.grant.x, `the grant is one step: frontier ${drawn.frontierX} plus headroom, in chunks ${show(drawn)}`).toBe(step);
	const spacerRight = Math.round(drawn.originLeft + drawn.grant.x * drawn.fontZoom) + 1;
	expect(drawn.width, `the page reaches the spacer ${show(drawn)}`).toBeGreaterThanOrEqual(spacerRight);
	expect(drawn.width, `and no further ${show(drawn)}`).toBeLessThanOrEqual(spacerRight + 1);
	expect(drawn.range, `sideways room past the pane ${show(drawn)}`).toBeGreaterThan(0);
	expect([drawn.left, still.left], "scrollLeft does not move").toEqual([0, 0]);
	expect(still.width, "and the page stays that wide").toBe(drawn.width);
});

it("INFINITE CANVAS OFF, CONTROL: a stroke ending 200 note px inside the right edge grants no sideways room", async () => {
	const snaps = await scenario("near-edge-200");
	const drawn = at(snaps, "drawn"), still = at(snaps, "still");
	expect(drawn.strokes, `premise: the stroke landed ${show(drawn)}`).toBe(1);
	expectPlacedFromClean(drawn, 200);
	expect(inset(drawn), `premise: the stroke ends outside the margin, about 200 note px in ${show(drawn)}`).toBeGreaterThan(MARGIN + 40);
	expect(drawn.grant.x, `no x grant ${show(drawn)}`).toBe(0);
	expect(drawn.range, `no horizontal scroll range ${show(drawn)}`).toBeLessThanOrEqual(0);
	expect(still.range, `and none a moment later ${show(still)}`).toBeLessThanOrEqual(0);
});

it("INFINITE CANVAS OFF: a stroke drawn right up to the pane's right edge grants sideways room (it did not under the old past-the-edge rule)", async () => {
	const snaps = await scenario("edge-off");
	const drawn = at(snaps, "drawn near the right edge");
	expect(drawn.strokes, `premise: the stroke landed ${show(drawn)}`).toBe(1);
	expect(drawn.grant.y, `premise: the vertical grant still comes (writing room) ${show(drawn)}`).toBeGreaterThan(0);
	expect(inset(drawn), `premise: the stroke ends within the margin ${show(drawn)}`).toBeLessThan(MARGIN);
	expect(drawn.grant.x, `x grant ${show(drawn)}`).toBeGreaterThan(0);
	expect(drawn.range, `horizontal scroll range ${show(drawn)}`).toBeGreaterThan(0);
});

type Placed = Snap & { zoom: number; inkRight: number | null };

/**
 * The device gestures behind the Orion step (the release checklist's sideways
 * scroll item). A pen only lands where the pane shows, so ink gets past the
 * pane's right edge with Infinite Canvas off only when the pane showed more of
 * the note while it was drawn: zoomed out and back, or a wider pane narrowed.
 * Both then grant sideways room that reaches the ink's end and stops about a
 * chunk past it.
 */
function expectRoomReachesTheInk(placed: Placed, back: Placed, end: Placed) {
	expect(placed.strokes, `premise: the stroke landed ${show(placed)}`).toBe(1);
	// Drawn at the edge of the pane it was drawn in, the ink is within the margin there, so it may already have room.
	expect(back.zoom, `premise: back at 100% ${show(back)}`).toBeCloseTo(1, 6);
	expect(back.inkRight ?? 0, `premise: the ink now reaches past the pane's right edge ${show(back)}`).toBeGreaterThan(back.clientWidth);
	expect(back.grant.x, `sideways room is granted ${show(back)}`).toBeGreaterThan(0);
	expect(back.range, `and can be scrolled into ${show(back)}`).toBeGreaterThan(0);
	expect(end.left + end.clientWidth, `scrolled to the end, the view reaches the ink's end ${show(end)}`).toBeGreaterThanOrEqual(end.inkRight ?? Infinity);
	expect(end.width, `the room stops within two chunks past the ink ${show(end)}`).toBeLessThanOrEqual((end.inkRight ?? 0) + 2 * EXTENT_CHUNK + 1);
}

/**
 * RETIRED: "ZOOMED OUT: a stroke at the pane's right edge at
 * 50% gives the note sideways room back at 100%, reaching just past the ink".
 *
 * The cell reached its ink past the pane's right edge by zooming the note out to 50% with the Infinite Canvas
 * OFF, drawing at the visible edge, and zooming back. The ruling took the note zoom out of canvas-off altogether, so
 * the rig's `overlay.pinch(...)` is refused and the readout comes back "zoom":1 where 0.5 was asked - the
 * premise fails because the route the cell describes is not in the product any more, not because anything
 * regressed. GREEN at the shipped base aa437ff1 and red from the ruling onward (review, two independent reads:
 * the baseline gate log, and the file run in the review at aa437ff1 - 18 passed there against 17 here with the cell
 * gone), which is the stronger case for retiring it: the route was taken out by a named change rather than
 * never having worked.
 *
 * WHAT STILL COVERS THE SUBJECT, so nothing is lost by retiring this one: PANE NARROWED below reaches the same
 * state by the other canvas-off route named in the comment above (a wide pane narrowed), and INFINITE CANVAS ON
 * below that covers the zoomed case where the zoom still exists. The canvas-off refusal itself is pinned in
 * ZoomFreezeTouch (scale stays 1, the text stays put, the bar reads busy, and the surface hands the pinch to
 * the host), which is the one pin the ruling asks each rig for.
 */
it("PANE NARROWED: a stroke near the right edge of a wide pane gives the note sideways room once the pane is narrowed", async () => {
	const snaps = (await scenario("narrowed-pane-edge-ink")) as Placed[];
	expectRoomReachesTheInk(at(snaps, "drawn near the right edge of a wide pane") as Placed, at(snaps, "back at 100%") as Placed, at(snaps, "scrolled right to the end") as Placed);
});

it("INFINITE CANVAS ON: the same stroke still grants sideways room", async () => {
	const snaps = await scenario("edge-on");
	const drawn = at(snaps, "drawn near the right edge");
	expect(drawn.strokes, `premise: the stroke landed ${show(drawn)}`).toBe(1);
	expect(drawn.grant.x, `x grant ${show(drawn)}`).toBeGreaterThan(0);
	expect(drawn.range, `horizontal scroll range ${show(drawn)}`).toBeGreaterThan(0);
});

/** The shrink, read the same way whatever made it due. */
function expectShrinkWithoutJump(snaps: Snap[], strokesLeft: number, before = "seeded far right", after = "removed, still scrolled out") {
	const seeded = at(snaps, before), out = at(snaps, "scrolled out"), removed = at(snaps, after);
	const home = at(snaps, "scrolled home"), still = at(snaps, "home, still");
	expect(seeded.range, `premise: there is sideways room to begin with ${show(seeded)}`).toBeGreaterThan(0);
	expect(out.left, `premise: scrolled out into the range ${show(out)}`).toBeGreaterThan(0);
	expect(out.width - out.left - out.clientWidth, `premise: part of the range is off screen to the right ${show(out)}`).toBeGreaterThan(0);
	expect(removed.strokes, `premise: the ink is as expected ${show(removed)}`).toBe(strokesLeft);
	// No jump: the scroller never reported another scrollLeft, and the range still covers the screen.
	expect(removed.left, `scrollLeft did not move ${show(removed)}`).toBe(out.left);
	expect((removed.lefts ?? []).every(l => l === out.left), `no scroll event moved it either ${show(removed)}`).toBe(true);
	expect(removed.width, `the range still covers what is on screen ${show(removed)}`).toBeGreaterThanOrEqual(removed.left + removed.clientWidth);
	expect(removed.width, `the part off screen to the right is gone ${show({ out, removed })}`).toBeLessThan(out.width);
	expect(removed.grant.y, `the vertical grant is untouched ${show({ out, removed })}`).toBe(out.grant.y);
	// Partway home the view has left more of it, and that goes too, again without moving the view.
	const partway = at(snaps, "partway home");
	expect(partway.left, `the scroll landed where it was sent ${show(partway)}`).toBe(partway.target);
	expect((partway.lefts ?? []).every(l => l === partway.target), `and nothing moved it after ${show(partway)}`).toBe(true);
	expect(partway.width, `the range still covers what is on screen ${show(partway)}`).toBeGreaterThanOrEqual(partway.left + partway.clientWidth);
	expect(partway.width, `what the view left is gone ${show({ removed, partway })}`).toBeLessThan(removed.width);
	// Back home the rest is gone too.
	expect(home.left, `premise: back at the left edge ${show(home)}`).toBe(0);
	expect(home.grant.x, `no x grant once home ${show(home)}`).toBe(0);
	expect(home.range, `no horizontal scroll range once home ${show(home)}`).toBeLessThanOrEqual(0);
	expect(still.range, `and none a moment later ${show(still)}`).toBeLessThanOrEqual(0);
}

it("TURNING INFINITE CANVAS OFF while scrolled out: the room scrolling made shrinks with no scroll jump, and is gone once home", async () => {
	expectShrinkWithoutJump(await scenario("canvas-off-scrolled"), 0, "infinite canvas on", "infinite canvas off, still scrolled out");
});

it("TURNING INFINITE CANVAS OFF keeps the room ink past the pane needs", async () => {
	const snaps = await scenario("canvas-off-far-ink");
	const on = at(snaps, "infinite canvas on"), off = at(snaps, "infinite canvas off"), far = at(snaps, "scrolled to the far ink");
	expect(on.strokes, `premise: the far ink is there ${show(on)}`).toBe(2);
	expect(off.range, `sideways room is still there ${show(off)}`).toBeGreaterThan(0);
	// The far stroke's right edge (1500 + 40, plus its width allowance) stays reachable.
	expect(far.left + far.clientWidth, `the far ink can still be scrolled to ${show(far)}`).toBeGreaterThanOrEqual(1542);
});

it("TWO PANES on one note: Delete all ink in the pane at home does not move the pane scrolled out, and both lose the room once home", async () => {
	const snaps = await scenario("", "sidewaysTwoPanes");
	const out = at(snaps, "out: scrolled out"), removed = at(snaps, "out: removed, still scrolled out");
	const outHome = at(snaps, "out: scrolled home"), home = at(snaps, "home: after out went home");
	expect(out.left, `premise: one pane is scrolled out ${show(out)}`).toBeGreaterThan(0);
	expect(removed.strokes, `premise: the ink is gone ${show(removed)}`).toBe(0);
	expect(removed.left, `the scrolled-out pane did not move ${show(removed)}`).toBe(out.left);
	expect((removed.lefts ?? []).every(l => l === out.left), `no scroll event moved it either ${show(removed)}`).toBe(true);
	expect(removed.width, `its range still covers what it shows ${show(removed)}`).toBeGreaterThanOrEqual(removed.left + removed.clientWidth);
	expect(outHome.range, `no sideways room in the pane that went home ${show(outHome)}`).toBeLessThanOrEqual(0);
	expect(home.range, `none in the other pane either ${show(home)}`).toBeLessThanOrEqual(0);
});

it("DELETE ALL INK while scrolled out: the range shrinks with no scroll jump, and is gone once home", async () => {
	expectShrinkWithoutJump(await scenario("far-delete-all"), 0);
});

/**
 * The ink band is an absolutely positioned child of the scroller as well, and a
 * scrollable range gives it a sideways margin (ScrollBand's bandFor). Measured on
 * the first build of the shrink: with the spacer gone, that margin alone held
 * the range at the band's own right edge, and every band sync read back the
 * range it was holding and kept it - 175 px of sideways scroll into nothing.
 * The premise reads the margin in place at the shrink; the plant takes away only
 * the release, and the same reading must then fail.
 */
it("BAND MARGIN: with the band's sideways margin in place at the shrink, the range is still gone once home", async () => {
	const snaps = await scenario("far-delete-all");
	const out = at(snaps, "scrolled out"), removed = at(snaps, "removed, still scrolled out"), home = at(snaps, "home, still");
	expect(out.band && out.band.width, `premise: the band carries a sideways margin before the shrink ${show(out)}`).toBeGreaterThan(out.clientWidth);
	expect(removed.band && removed.band.width, `premise: and still at the shrink ${show(removed)}`).toBeGreaterThan(removed.clientWidth);
	expect(home.range, `no horizontal scroll range once home ${show(home)}`).toBeLessThanOrEqual(0);
	expect(home.band && home.band.width, `the band gave up its margin ${show(home)}`).toBe(home.clientWidth);
});

it("BAND MARGIN PLANT: without the release, the band's margin holds the range after the grant is gone", async () => {
	const snaps = await scenario("far-band-plant");
	const removed = at(snaps, "removed, still scrolled out"), home = at(snaps, "home, still");
	expect(removed.band && removed.band.width, `premise: the band carries a sideways margin at the shrink ${show(removed)}`).toBeGreaterThan(removed.clientWidth);
	expect(home.grant.x, `premise: the grant itself is gone ${show(home)}`).toBe(0);
	expect(home.range, `PLANT: a margin's width of range is left behind ${show(home)}`).toBeGreaterThan(0);
	expect(home.band ? home.band.width - home.clientWidth : 0, `PLANT: exactly the band's margin holds it ${show(home)}`).toBeGreaterThanOrEqual(home.range);
});

it("ERASE the far stroke while scrolled out: the same, from the ink that is left", async () => {
	expectShrinkWithoutJump(await scenario("far-erase"), 1);
});

/**
 * A held shrink never steps on a scrolled frame (fleet 3 T2 (b): at a gesture end,
 * never during a pan). Scrolled out, all ink deleted, then scrolled left 20 px a
 * frame: every frame lands where it was sent, the range covers the view on every
 * frame, and the grant stands until the scroll has been quiet; then it steps
 * down with the view where it was.
 */
it("SCROLLING LEFT THROUGH A HELD SHRINK: continuous frame to frame, never under the view, and the shrink steps only once the scroll is quiet", async () => {
	const snaps = await scenario("far-held-scroll-left");
	const removed = at(snaps, "removed, still scrolled out"), during = at(snaps, "scrolled left, frame by frame") as Snap & { perFrame: (Snap & { sent: number; t: number })[] };
	const quiet = at(snaps, "scroll quiet"), home = at(snaps, "home, still");
	expect(removed.strokes, `premise: the ink is gone ${show(removed)}`).toBe(0);
	expect(removed.grant.x, `premise: the view is holding part of the grant ${show(removed)}`).toBeGreaterThan(0);
	expect(during.perFrame.length, "premise: twenty scrolled frames").toBe(20);
	// A frame that came SHRINK_SCROLL_IDLE_MS or more after the one before it follows a quiet scroll, where a step is
	// allowed; on a loaded machine that can happen, so the no-step reading holds up to the first such gap.
	let quietYet = false, scrolledFrames = 0;
	during.perFrame.forEach((f, i) => {
		if (i > 0 && f.t - during.perFrame[i - 1]!.t >= SHRINK_SCROLL_IDLE_MS) quietYet = true;
		expect(f.left, `every frame lands where it was sent ${show(f)}`).toBe(f.sent);
		expect(f.width, `the range covers the view on every frame ${show(f)}`).toBeGreaterThanOrEqual(f.left + f.clientWidth);
		if (!quietYet) { scrolledFrames++; expect(f.grant.x, `the held shrink does not step while scrolling ${show({ removed, f })}`).toBe(removed.grant.x); }
	});
	expect(scrolledFrames, "premise: most frames came inside the quiet window").toBeGreaterThanOrEqual(10);
	expect(quiet.left, `the quiet step does not move the view ${show({ during, quiet })}`).toBe(during.left);
	expect(quiet.grant.x, `once quiet, the held shrink steps down ${show({ removed, quiet })}`).toBeLessThan(removed.grant.x);
	expect(quiet.width, `and still covers the view ${show(quiet)}`).toBeGreaterThanOrEqual(quiet.left + quiet.clientWidth);
	expect(home.range, `no sideways room once home ${show(home)}`).toBeLessThanOrEqual(0);
});

it("LASSO DELETE the far stroke while scrolled out: the same", async () => {
	expectShrinkWithoutJump(await scenario("far-lasso-delete"), 1);
});

it("UNDO the delete: the far ink comes back and so does its room", async () => {
	const snaps = await scenario("far-undo-delete");
	const undone = at(snaps, "undone"), home = at(snaps, "home, still");
	expect(undone.strokes, `premise: undo restored both strokes ${show(undone)}`).toBe(2);
	expect(home.grant.x, `x grant back ${show(home)}`).toBeGreaterThan(0);
	expect(home.range, `horizontal scroll range back ${show(home)}`).toBeGreaterThan(0);
});

it.each(["chunked-growth-on", "chunked-growth-off"])("%s: twelve strokes marching right grow the grant in chunks, never back and forth", async (name) => {
	const snaps = (await scenario(name)).filter(s => s.label.startsWith("stroke "));
	expect(snaps.at(-1)!.strokes, `premise: all twelve landed ${show(snaps.at(-1))}`).toBe(12);
	let changes = 0;
	for (let i = 1; i < snaps.length; i++) {
		const a = snaps[i - 1]!, b = snaps[i]!;
		expect(b.grant.x, `x never shrinks while writing ${show({ a, b })}`).toBeGreaterThanOrEqual(a.grant.x);
		expect(b.grant.y, `y never shrinks while writing ${show({ a, b })}`).toBeGreaterThanOrEqual(a.grant.y);
		expect(b.width, `scrollWidth never shrinks while writing ${show({ a, b })}`).toBeGreaterThanOrEqual(a.width);
		if (b.grant.x !== a.grant.x || b.grant.y !== a.grant.y) changes++;
	}
	expect(changes, `a chunked grant changes a few times, not per stroke ${show(snaps.map(s => s.grant))}`).toBeLessThanOrEqual(3);
	// Infinite Canvas off: no x grant while every stroke ends outside the margin, a grant once one ends inside it.
	if (name.endsWith("-off")) for (const s of snaps) expect(s.grant.x > 0, `x grant exactly when the frontier is within the margin (inset ${inset(s)}) ${show(s.grant)}`).toBe(inset(s) < MARGIN);
});
