/**
 * A PEN THAT IS NOT THE PRIMARY POINTER STILL DRAGS THE TOOLBAR AND WRITES ON A SLIDE.
 *
 * Windows with a second mouse live beside the pen (Alan's Orion, lanmouse):
 * Chromium reported the pen with `isPrimary: false` on every event. The
 * toolbar's grip and its folded pill refused the press - their drag gate
 * turned away any non-primary pointer to keep a second finger from starting a
 * second drag - and a slide refused the pen outright, so the same pen drew
 * nothing there. The note itself was unaffected: its router has no such gate.
 *
 * The non-primary state cannot be produced through headless Chromium's input
 * pipeline, so `penNotPrimaryPage.ts` shadows `isPrimary` on real, trusted
 * events at window capture (see its header). Every row checks that premise
 * from what the page's first listener actually saw.
 *
 * The second-finger rule is kept, and pinned here: a non-primary touch on the
 * grip still starts nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import css from "../../styles.css?raw";

let browser: Browser;
let notePage: string;
let slidesPage: string;

const bundle = async (entry: string): Promise<string> => {
	const out = await build({
		entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL(entry === "./slidesNibPage.ts" ? "../obsidian-stub.ts" : "./mouseUndoObsidianStub.ts", import.meta.url)) },
	});
	return out.outputFiles[0]!.text;
};

beforeAll(async () => {
	notePage = await bundle("./penNotPrimaryPage.ts");
	slidesPage = await bundle("./slidesNibPage.ts");
	browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => {
	await browser?.close();
});

type Device = "pen" | "mouse" | "touch";

const mouseLike = (cdp: CDPSession, pointerType: "pen" | "mouse", type: string, x: number, y: number, buttons: number) =>
	cdp.send("Input.dispatchMouseEvent", {
		type, x, y, buttons, pointerType,
		button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
		clickCount: type === "mouseMoved" ? 0 : 1,
		force: buttons ? 0.5 : 0,
	} as never);
const touch = (cdp: CDPSession, type: string, x: number, y: number) =>
	cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] } as never);

interface DragRow {
	dragging: boolean;
	captured: boolean;
	dragLive: boolean;
	downs: Array<{ pointerType: string; isPrimary: boolean; trusted: boolean }>;
}

/**
 * Real note, real strip. A primary pen stroke on the note first (that is what
 * raises the desktop strip), then `device` presses the handle with its
 * `isPrimary` shadowed as asked, and drags it 12 steps.
 */
async function dragHandle(handle: "grip" | "pill", device: Device, notPrimary: boolean): Promise<DragRow> {
	const context: BrowserContext = await browser.newContext({ viewport: { width: 1100, height: 760 }, hasTouch: device === "touch" });
	const page: Page = await context.newPage();
	try {
		await page.setContent("<!doctype html><body style='margin:0'></body>");
		await page.addStyleTag({ content: css });
		await page.addScriptTag({ content: notePage });
		const cdp = await context.newCDPSession(page);
		const setup = await page.evaluate(() => (window as any).__np.setupNote());
		expect(setup.overlay, "premise: the real overlay mounted").toBe(true);
		await mouseLike(cdp, "pen", "mousePressed", 300, 300, 1);
		for (let i = 1; i <= 8; i++) await mouseLike(cdp, "pen", "mouseMoved", 300 + i * 12, 300 + i * 3, 1);
		await mouseLike(cdp, "pen", "mouseReleased", 396, 324, 0);
		await mouseLike(cdp, "pen", "mouseMoved", 420, 340, 0);
		const at = await page.evaluate((h) => (window as any).__np.handleAt(h), handle);
		expect(at, `premise: the ${handle} is on the page`).not.toBeNull();
		await page.evaluate((t) => (window as any).__np.setNotPrimary(t), notPrimary ? [device] : []);
		const { x, y } = at!;
		if (device === "touch") await touch(cdp, "touchStart", x, y);
		else await mouseLike(cdp, device, "mousePressed", x, y, 1);
		const id = await page.evaluate(() => (window as any).__np.lastPenDownId());
		for (let i = 1; i <= 12; i++) {
			const px = x - (220 * i) / 12, py = y + (260 * i) / 12;
			if (device === "touch") await touch(cdp, "touchMove", px, py);
			else await mouseLike(cdp, device, "mouseMoved", px, py, 1);
		}
		const mid = (await page.evaluate(([h, p]) => (window as any).__np.midDrag(h, p), [handle, id] as const)) as DragRow;
		if (device === "touch") await touch(cdp, "touchEnd", x, y);
		else await mouseLike(cdp, device, "mouseReleased", x - 220, y + 260, 0);
		const down = mid.downs[0];
		expect(down, "premise: the press reached the page").toBeDefined();
		expect(down!.trusted, "premise: real browser input").toBe(true);
		expect(down!.pointerType, "premise: the device under test").toBe(device);
		expect(down!.isPrimary, "premise: isPrimary as the row asks").toBe(!notPrimary);
		return mid;
	} finally {
		await context.close();
	}
}

describe("the toolbar handles take a pen that is not the primary pointer", () => {
	for (const handle of ["grip", "pill"] as const) {
		it(`non-primary pen drags the ${handle}, and the ${handle} holds its capture`, async () => {
			const r = await dragHandle(handle, "pen", true);
			expect(r.dragging, "the drag never started").toBe(true);
			expect(r.captured, "the handle did not take the pen's capture").toBe(true);
		}, 60_000);

		it(`non-primary mouse, left button, drags the ${handle}`, async () => {
			const r = await dragHandle(handle, "mouse", true);
			expect(r.dragging, "the drag never started").toBe(true);
		}, 60_000);

		it(`control: a primary pen drags the ${handle}`, async () => {
			const r = await dragHandle(handle, "pen", false);
			expect(r.dragging).toBe(true);
			expect(r.captured).toBe(true);
		}, 60_000);
	}

	it("a non-primary touch - a second finger - still starts no drag on the grip", async () => {
		const r = await dragHandle("grip", "touch", true);
		expect(r.dragging).toBe(false);
		expect(r.dragLive).toBe(false);
	}, 60_000);
});

describe("a slide takes a pen that is not the primary pointer", () => {
	/** The production Slides chain (slidesNibPage.ts), its pen strokes shadowed or not. */
	async function slidesStored(notPrimary: boolean): Promise<{ stored: number; downs: Array<{ isPrimary: boolean }> }> {
		const page = await browser.newPage({ viewport: { width: 1060, height: 820 } });
		try {
			await page.setContent("<!doctype html><meta charset=utf-8><body style='margin:0;background:#1e1e1e'></body>");
			await page.addStyleTag({ content: css });
			await page.addScriptTag({ content: slidesPage });
			await page.evaluate((np) => {
				const w = window as any;
				w.__downs = [];
				for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
					window.addEventListener(type, (e) => {
						const p = e as PointerEvent;
						if (np && p.pointerType === "pen") Object.defineProperty(p, "isPrimary", { value: false });
						if (type === "pointerdown") w.__downs.push({ isPrimary: p.isPrimary });
					}, { capture: true });
				}
			}, notPrimary);
			const run = await page.evaluate(() => (window as any).__nib.nibRun());
			const downs = await page.evaluate(() => (window as any).__downs);
			return { stored: run.stored.length, downs };
		} finally {
			await page.close();
		}
	}

	it("a non-primary pen writes on a slide", async () => {
		const r = await slidesStored(true);
		expect(r.downs.length, "premise: the strokes reached the page").toBe(12);
		expect(r.downs.every((d) => d.isPrimary === false), "premise: every pen-down was non-primary").toBe(true);
		expect(r.stored, "the slide stored no stroke from the pen").toBe(12);
	}, 60_000);

	it("control: a primary pen writes on a slide", async () => {
		const r = await slidesStored(false);
		expect(r.downs.every((d) => d.isPrimary === true)).toBe(true);
		expect(r.stored).toBe(12);
	}, 60_000);
});
