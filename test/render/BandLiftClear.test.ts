/**
 * The wait after a lasso lift is spent once: a later growth with no lift of its own takes the band's sideways margin at
 * once.
 *
 * What it looks like: dropping a dragged lasso selection past the pane's right edge widens the note's scroll range. The
 * band that holds the ink layers does not grow for it until the pane scrolls out of the band (the lift would otherwise
 * pay a whole repaint for pixels no one can see). That wait belongs to the lift: the sync that takes the growth spends
 * it. If it were never spent, every later widening of the range, a paste or a note arriving, would wait for a scroll
 * as well, and the band would sit short of the range it is meant to hold.
 *
 * The walk, on one note with Infinite Canvas off: three short strokes inside the pane; a real lasso drag moves them right
 * past the pane's edge and lets go (the range widens, the band keeps the pane's width); the pane scrolls one css px right
 * (the band takes the margin); the strokes are deleted and the pane goes home (the range narrows, the band loses the
 * margin); a stroke added at the right edge with no lift (the range widens again). Asserted at each step, in band and
 * scroll geometry only, no millisecond bound, so the cell runs outside a quiet window:
 * the first widening after the lift leaves the band at the pane's width; the second takes the margin at once, the band
 * the pane's width plus one bandMargin each side, and covers the pane.
 *
 * The device ratio is forced on the browser (--force-device-scale-factor HW_BLC_DPR, default 2); the page sets no
 * deviceScaleFactor, and the cell reads window.devicePixelRatio back to say so.
 *
 * Plant, built into the overlay by source substitution:
 *   HW_BANDLIFT_PLANT_NEVER_CLEARED=1   the sync that takes the growth never spends the lift's mark
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";
import { bandCovers, bandMargin } from "../../src/inline/ScrollBand";

declare const process: { env: Record<string, string | undefined> };
const DPR = Number(process.env.HW_BLC_DPR ?? "2");
let browser: Browser, script: string;
const evidence: unknown[] = [];

beforeAll(async () => {
	const plants: [string, string, string, string][] = [];
	if (process.env.HW_BANDLIFT_PLANT_NEVER_CLEARED) plants.push(["never-cleared", "InkOverlayBand", "this.bandGrowthMayWait = false;", ""]);
	const applied = new Set<string>();
	const b = await build({ entryPoints: [fileURLToPath(new URL("./bandLiftClearPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
		plugins: plants.length ? [{ name: "band-lift-plants", setup(builder) {
			builder.onLoad({ filter: /src[\\/]inline[\\/]InkOverlayBand\.ts$/ }, args => {
				let text = readFileSync(args.path, "utf8");
				for (const [name, , from, to] of plants) {
					if (text.split(from).length !== 2) throw new Error(`plant ${name}: anchor not found exactly once`);
					text = text.replace(from, to);
					applied.add(name);
				}
				return { contents: text, loader: "ts" };
			});
		} }] : [] });
	for (const [name] of plants) if (!applied.has(name)) throw new Error(`plant ${name} requested but never applied`);
	// eslint-disable-next-line no-console
	if (plants.length) console.log(`BAND LIFT PLANTS ${plants.map(p => p[0]).join(",")}`);
	script = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true, args: [`--force-device-scale-factor=${DPR}`, "--window-size=1000,900"] });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_BANDLIFT_EVIDENCE) writeFileSync(process.env.HW_BANDLIFT_EVIDENCE, JSON.stringify(evidence, null, 1));
});

type Band = { left: number; top: number; width: number; height: number };
type Snap = { label: string; scrollLeft: number; scrollWidth: number; clientWidth: number; clientHeight: number; scale: number; band: Band | null; strokes: number; frontierX: number; dpr: number; mark: boolean | null };

async function walk(): Promise<Snap[]> {
	const page = await (await browser.newContext({ viewport: null })).newPage();
	try {
		const errors: string[] = [];
		page.on("pageerror", e => errors.push(e.message));
		await page.setContent("<!doctype html><html><body></body></html>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: script });
		const r = await page.evaluate(() => (window as any).bandLiftClear());
		evidence.push(r);
		expect(errors, "page errors").toEqual([]);
		expect(r.events, "premise: the pen grabbed the selection").toEqual(["grabbed true"]);
		return r.snaps;
	} finally {
		await page.close();
	}
}

const at = (snaps: Snap[], label: string) => { const s = snaps.find(k => k.label === label); if (!s) throw Error(`no snap "${label}"`); return s; };
const show = (s: unknown) => JSON.stringify(s);
const view = (s: Snap) => ({ scrollLeft: s.scrollLeft, scrollTop: 0, clientWidth: s.clientWidth, clientHeight: s.clientHeight, scrollWidth: s.scrollWidth, scrollHeight: s.clientHeight, scale: s.scale });

it("a lift's wait is spent once: the first widening after a lasso lift waits, a later one with no lift takes the margin at once", async () => {
	const snaps = await walk();
	// eslint-disable-next-line no-console
	console.log("BAND-LIFT " + show(snaps));
	const mounted = at(snaps, "mounted"), lifted = at(snaps, "lifted"), scrolled = at(snaps, "scrolled"), emptied = at(snaps, "emptied"), grown = at(snaps, "grown");
	expect(mounted.dpr, `premise: the forced device ratio, read back ${show(mounted)}`).toBe(DPR);
	expect(mounted.scrollWidth, `premise: the note fits the pane before the lift ${show(mounted)}`).toBe(mounted.clientWidth);
	expect(mounted.band?.width, `premise: no sideways margin on the band ${show(mounted)}`).toBe(mounted.clientWidth);
	expect(mounted.strokes, `premise: the three strokes are in ${show(mounted)}`).toBe(3);
	const margin = bandMargin(lifted.clientHeight, lifted.scale);
	expect(lifted.scrollWidth, `premise: the lift widened the range past the pane ${show(lifted)}`).toBeGreaterThan(lifted.clientWidth);
	expect(lifted.band, `the first widening after the lift waits: the band is the one it was ${show(lifted)}`).toEqual(mounted.band);
	expect(scrolled.band?.width, `the scroll out of the band takes the growth ${show(scrolled)}`).toBe(scrolled.clientWidth + 2 * margin);
	expect(emptied.strokes, `premise: the strokes are deleted ${show(emptied)}`).toBe(0);
	expect(emptied.scrollWidth, `premise: the range is back to the pane ${show(emptied)}`).toBe(emptied.clientWidth);
	expect(emptied.band?.width, `premise: the band lost the margin ${show(emptied)}`).toBe(emptied.clientWidth);
	expect(grown.strokes, `premise: the late stroke is in ${show(grown)}`).toBe(1);
	expect(grown.scrollWidth, `premise: the late stroke widened the range past the pane ${show(grown)}`).toBeGreaterThan(grown.clientWidth);
	expect(grown.band?.width, `the second widening has no lift: the band takes the margin at once ${show(grown)}`).toBe(grown.clientWidth + 2 * margin);
	expect(bandCovers(grown.band!, view(grown)), `and covers the pane ${show(grown)}`).toBe(true);
});
