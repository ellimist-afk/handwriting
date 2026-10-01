/**
 * The plumbing half: A NOTE'S OWN INFINITE CANVAS CHOICE SURVIVES THE ROUND TRIP.
 *
 * Write the choice into the note's frontmatter, let the vault's metadata catch up, read it back
 * through the getter the overlay will call, and do the same for an edit the user makes by hand.
 * Two notes with opposite values are read under one global in the same reader, which is the
 * side-by-side case reduced to the only thing this half owns: the answer, not the behaviour.
 *
 * WHAT THIS CELL CANNOT PROVE, stated so nobody reads more into it: the vault here is
 * a fake, as in `notePaperPage`. It stores a frontmatter object, re-parses it and feeds the change
 * event back the way Obsidian does, so the read / listen / write loop is real - but Obsidian's own
 * YAML serialisation is not exercised, and neither is a note on disk. A real-file round trip needs
 * a device run, and nothing here should be read as covering one.
 *
 * The behaviour this override drives - zoom, zoom bar, bounce, momentum, scroll room - is slice B's
 * and is not read here at all.
 *
 * Run: npm run test:render. Not in `npx vitest run`.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { NOTE_CANVAS_KEY } from "../../src/inline/CanvasNoteOverride";

let browser: Browser, bundle: string;

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./canvasOverridePage.ts", import.meta.url))],
		bundle: true, write: false, format: "iife", platform: "browser",
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) },
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
});

async function probe(): Promise<Page> {
	const page = await browser.newPage();
	await page.addScriptTag({ content: bundle });
	await page.evaluate(() => { (window as any).p = (window as any).canvasOverride(); });
	return page;
}

it("a note that had no opinion keeps the one it is given, through the write and the re-parse", async () => {
	const page = await probe();
	try {
		const r = await page.evaluate(([key]) => (window as any).p.roundTrip("a.md", true, false), [NOTE_CANVAS_KEY] as const) as any;
		expect(r.before, "premise: a.md starts with no override, so the global answers").toBe(false);
		expect(r.saved).toBe(true);
		expect(r.onDisk[NOTE_CANVAS_KEY], "the key did not reach the note").toBe(true);
		expect(r.onDisk.title, "the write disturbed the rest of the frontmatter").toBe("A");
		expect(r.afterWrite, "the value was not readable until the cache caught up").toBe(true);
		expect(r.afterReparse, "the value did not survive the re-parse").toBe(true);
		expect(r.heard, "the listener was not told which note changed").toContain("a.md");
	} finally {
		await page.close();
	}
}, 120_000);

it("removing the override hands the note back to the global, in both directions", async () => {
	const page = await probe();
	try {
		const off = await page.evaluate(([key]) => (window as any).p.roundTrip("b.md", "default", true), [NOTE_CANVAS_KEY] as const) as any;
		expect(off.before, "premise: b.md starts with an override of false").toBe(false);
		expect(off.onDisk[NOTE_CANVAS_KEY], "the key was left in the note").toBeUndefined();
		expect(off.afterReparse, "the note did not fall back to the global").toBe(true);
		const on = await page.evaluate(() => (window as any).p.both(false)) as any;
		expect(on.b, "the same note under the opposite global").toBe(false);
	} finally {
		await page.close();
	}
}, 120_000);

it("an edit the user types into the note themselves is picked up and announced", async () => {
	const page = await probe();
	try {
		const r = await page.evaluate(([key]) => (window as any).p.external("a.md", { title: "A", [key]: "true" }, false), [NOTE_CANVAS_KEY] as const) as any;
		expect(r.value, "a quoted true in a hand-typed note was not read as an override").toBe(true);
		expect(r.heard).toContain("a.md");
		const junk = await page.evaluate(([key]) => (window as any).p.external("a.md", { title: "A", [key]: "yes" }, false), [NOTE_CANVAS_KEY] as const) as any;
		expect(junk.value, "yes was treated as an override instead of being left to the global").toBe(false);
	} finally {
		await page.close();
	}
}, 120_000);

it("two notes with opposite values are answered independently under one global", async () => {
	const page = await probe();
	try {
		await page.evaluate(() => (window as any).p.roundTrip("a.md", true, false));
		const under = await page.evaluate(() => (window as any).p.both(false)) as any;
		expect([under.a, under.b], "the two notes did not answer for themselves").toEqual([true, false]);
		const over = await page.evaluate(() => (window as any).p.both(true)) as any;
		expect([over.a, over.b], "the global moved a note that had its own value").toEqual([true, false]);
		expect(over.unknown, "a note with no override did not follow the global").toBe(true);
	} finally {
		await page.close();
	}
}, 120_000);
