import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import css from "../../styles.css?raw";

declare const process: {env: Record<string, string | undefined>};

let browser: Browser;
let script: string;
const evidence: unknown[] = [];
beforeAll(async () => {
	const plant = process.env.ESC_PLANT ?? (process.env.ESC_PLANT_SWALLOW === "1" ? "swallow" : "");
	const bundle = await build({entryPoints: [fileURLToPath(new URL("./escapeFamilyPage.ts", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser", alias: {obsidian: fileURLToPath(new URL("./escapeObsidian.ts", import.meta.url))}, plugins: plant ? [{
		name: "escape-swallow-plant",
		setup(build) {
			build.onLoad({filter: /[/\\]InkOverlayRegistry\.ts$/}, args => {
				let source = readFileSync(args.path, "utf8");
				const peel = "releaseTipModes();";
				const floor = "export function releaseMouseInkQuietlyEverywhere(): void {";
				if (plant === "swallow") {
					if (source.split(peel).length !== 2) throw new Error("Escape plant target must occur exactly once");
					source = source.replace(peel, "/* plant: consume Escape without releasing the held tip */");
				} else if (plant === "block-pen") {
					source = 'import { setPenInk as plantSetPenInk } from "./PenInk";\n' + source.replace(floor, floor + "\nplantSetPenInk(false);");
				} else if (plant === "reset-nib") {
					if (source.split(floor).length !== 2) throw new Error("Escape nib plant target must occur exactly once");
					source ='import { setInkSizeMult as plantSetInkSizeMult } from "./InkOverlayToolState";\nimport { applyInkColor as plantApplyInkColor } from "../ink/InkColor";\n'
						+ source.replace(floor, floor + '\nplantSetInkSizeMult("pen", 1); plantApplyInkColor("pen", "#000000");');
				} else if (plant === "capture-floor") {
					const binding = 'win.addEventListener("keydown", onKey);';
					if (source.split(binding).length !== 2) throw new Error("Escape phase plant target must occur exactly once");
					source = source.replace(binding, 'win.addEventListener("keydown", onKey, true);')
						.replace('win.removeEventListener("keydown", onKey);', 'win.removeEventListener("keydown", onKey, true);');
				} else throw new Error("Unknown Escape plant");
				return {contents: source, loader: "ts"};
			});
		},
	}] : []});
	script = bundle.outputFiles[0]!.text;
	browser = await chromium.launch({headless: true});
});

it.each(["modal-container", "suggestion-container", "menu", "host-escape-consumer"])("host %s closes before the floor peels", async kind => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		await page.evaluate(kind => (window as any).escapeFamily.hostLayer(kind, true), kind);
		await page.keyboard.press("Escape");
		expect(await page.locator(`.${kind}`).count(), "host document handler removes its layer").toBe(0);
		const closed = await page.evaluate(() => (window as any).escapeFamily.state());
		expect(closed.tip, "host consumed first Escape").toBe("pan");
		expect(closed.mouseClaimsInk, "palette dismissal does not put down mouse ink").toBe(true);
		await page.keyboard.press("Escape");
		const peeled = await page.evaluate(() => (window as any).escapeFamily.state());
		evidence.push({kind, closed, peeled});
		expect(peeled.tip, "next Escape peels held tip").toBe("nib");
		expect(peeled.mouseClaimsInk, "only one layer peels").toBe(true);
	} finally { await page.close(); }
});

it.each(["modal-container", "suggestion-container", "menu"])("open %s blocks an unconsumed floor Escape", async kind => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		await page.evaluate(kind => (window as any).escapeFamily.hostLayer(kind, false), kind);
		await page.keyboard.press("Escape");
		const after = await page.evaluate(() => (window as any).escapeFamily.state());
		expect(after.tip).toBe("pan"); expect(after.mouseClaimsInk).toBe(true);
	} finally { await page.close(); }
});

it.each(["eraser", "lasso"] as const)("pen after %s floor retains last nib; mouse selects text; eraser end erases", async mode => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		const nib = await page.evaluate(mode => (window as any).escapeFamily.prepareNib(mode), mode);
		// Eraser opens its own pop: pop, held tip, then mouse ink are three distinct layers.
		for (let press = 0; press < 3; press++) await page.keyboard.press("Escape");
		const floor = await page.evaluate(() => (window as any).escapeFamily.state());
		expect.soft(floor.mouseClaimsInk, "floor releases the mouse").toBe(false);
		const point = await page.evaluate(() => (window as any).escapeFamily.contactPoint());
		await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 20, point.y, {steps: 3}); await page.mouse.up();
		const mouse = await page.evaluate(() => (window as any).escapeFamily.state());
		expect.soft(mouse.strokes.length, "mouse draws nothing").toBe(floor.strokes.length);
		expect.soft(mouse.caret, "mouse reaches text caret").not.toBe(floor.caret);
		const pen = await page.evaluate(() => (window as any).escapeFamily.penStroke());
		expect.soft(pen.strokes.length, "pen still draws after floor").toBe(mouse.strokes.length + 1);
		const stroke = pen.strokes.at(-1);
		expect.soft(stroke?.color, "last nib colour retained").toBe(nib.color);
		expect.soft(stroke?.width, "last nib width retained").toBeCloseTo(nib.width, 6);
		const erased = await page.evaluate(() => (window as any).escapeFamily.penStroke(true));
		expect.soft(erased.strokes.map((s: any) => s.id), "hardware eraser still removes the new stroke").not.toContain(stroke?.id);
		expect(errors).toEqual([]);
		evidence.push({kind: "pen-after-floor", mode, nib, floor, mouse, pen, erased, errors});
	} finally { await page.close(); }
});
afterAll(async () => {
	await browser?.close();
	if (process.env.ESC_EVIDENCE) writeFileSync(process.env.ESC_EVIDENCE, JSON.stringify(evidence, null, 2));
});

it("a hidden host dialog does not strand body-focused Escape", async () => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		await page.evaluate(() => (window as any).escapeFamily.hostLayer("modal-container", false, true));
		await page.keyboard.press("Escape");
		const after = await page.evaluate(() => (window as any).escapeFamily.state());
		expect(after.tip).toBe("nib");
		expect(after.mouseClaimsInk).toBe(true);
	} finally { await page.close(); }
});

it.each([
	["pan", 1], ["space", 1], ["lasso", 2], ["folded-pop", 2], ["paper-picker", 2],
	["fold-order-drag", 3], ["pdf-selection", 2],
	["popout-editor", 1], ["popout-body", 1],
	["cursor-control", 0],
] as const)("Escape from %s reaches cursor in layers + 1 presses", async (kind, layers) => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		const before = await page.evaluate(kind => (window as any).escapeFamily.setup(kind), kind);
		expect(before.mouseClaimsInk, "premise: tool held, except cursor control").toBe(kind !== "cursor-control");
		if (kind === "lasso") expect(before.selected, "premise: ink selected").toBe(1);
		if (kind === "folded-pop") expect(before.moreOpen, "premise: folded pop open").toBe(true);
		if (kind === "paper-picker") expect(before.pickerOpen).toBe(true);
		if (kind === "fold-order-drag") expect(before.foldDragging).toBe(true);
		if (kind === "pdf-selection") expect(before.pdfSelected).toBe(1);
		if (kind.startsWith("popout")) {
			expect(before.popClosed).toBe(true);
			expect.soft(before.popRetiredAtClose, "window-close retires its overlay before editor destruction").toBe(true);
			expect(before.closedListenerStayedQuiet, "closed window listener removed").toBe(true);
		}
		const presses: unknown[] = [];
		for (let i = 0; i < layers + 1; i++) {
			await page.keyboard.press("Escape");
			presses.push(await page.evaluate(() => (window as any).escapeFamily.state()));
		}
		const after = presses.at(-1) as any;
		evidence.push({kind, layers, before, presses, errors});
		expect(errors, "fixture errors").toEqual([]);
		expect.soft(after.tip, "no tip mode remains").toBe("nib");
		expect.soft(after.mouseClaimsInk, "cursor must select text, not ink").toBe(false);
		if (kind !== "pdf-selection") expect.soft(after.noteRouterClaimsMouse, "note router releases mouse").toBe(false);
		expect.soft(after.selected, "no ink selection remains").toBe(0);
		expect.soft(after.moreOpen, "folded pop is closed").toBe(false);
		expect.soft(after.inkPop, "ink pop is closed").toBe(false);
		expect.soft(after.pickerOpen, "paper picker is closed").toBe(false);
		expect.soft(after.foldDragging, "fold-order drag is cancelled").toBe(false);
		expect.soft(after.settingsOpen, "settings shell is closed").toBe(false);
		expect.soft(after.pdfSelected, "PDF selection is clear").toBe(0);
	} finally { await page.close(); }
});

it("an Escape consumer peels the held tip instead of swallowing", async () => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		const before = await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		expect(before.tip).toBe("pan");
		await page.keyboard.press("Escape");
		const after = await page.evaluate(() => (window as any).escapeFamily.state());
		evidence.push({kind: "swallow-control", before, after});
		expect(after.tip, "consumed Escape must release held pan").toBe("nib");
		expect(after.mouseClaimsInk, "one press must not also peel mouse ink").toBe(true);
	} finally { await page.close(); }
});

// A busy main thread: the eraser is picked and Escape lands before the strip's next frame. The strip's refresh after
// the pick is deferred one frame, so the frame is held here across the first press and released after it.
it("eraser picked, Escape before the next frame: the late refresh keeps the pop shut and three presses reach the floor", async () => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		// Any refresh setup queued runs first, so the one held below is the eraser pick's own.
		await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
		await page.evaluate(() => {
			const w = window as any;
			w.heldFrames = []; w.realFrame = w.requestAnimationFrame;
			w.requestAnimationFrame = (callback: FrameRequestCallback) => w.heldFrames.push(callback);
		});
		const nib = await page.evaluate(() => (window as any).escapeFamily.prepareNib("eraser"));
		const picked = await page.evaluate(() => (window as any).escapeFamily.state());
		await page.keyboard.press("Escape");
		const first = await page.evaluate(() => (window as any).escapeFamily.state());
		const held = await page.evaluate(() => {
			const w = window as any;
			w.requestAnimationFrame = w.realFrame;
			const queue: FrameRequestCallback[] = w.heldFrames.splice(0);
			for (const callback of queue) callback(performance.now());
			return queue.length;
		});
		const late = await page.evaluate(() => (window as any).escapeFamily.state());
		await page.keyboard.press("Escape");
		const second = await page.evaluate(() => (window as any).escapeFamily.state());
		await page.keyboard.press("Escape");
		const floor = await page.evaluate(() => (window as any).escapeFamily.state());
		const point = await page.evaluate(() => (window as any).escapeFamily.contactPoint());
		await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 20, point.y, {steps: 3}); await page.mouse.up();
		const mouse = await page.evaluate(() => (window as any).escapeFamily.state());
		evidence.push({kind: "eraser-late-frame", nib, picked, first, held, late, second, floor, mouse, errors});
		expect(held, "premise: the strip's refresh after the pick was waiting on the held frame").toBeGreaterThan(0);
		expect(picked.tip, "premise: the eraser is the held tip").toBe("eraser");
		expect(picked.inkPop, "premise: the eraser pop counts as open on the pick").toBe(true);
		expect(first.inkPop, "press 1 closes the eraser pop").toBe(false);
		expect.soft(late.inkPop, "the late refresh does not reopen the pop Escape closed").toBe(false);
		expect.soft(second.tip, "press 2 releases the held eraser").toBe("nib");
		expect.soft(floor.mouseClaimsInk, "press 3 releases the mouse").toBe(false);
		expect.soft(mouse.strokes.length, "mouse draws nothing").toBe(floor.strokes.length);
		expect.soft(mouse.caret, "mouse reaches text caret").not.toBe(floor.caret);
		expect(errors).toEqual([]);
	} finally { await page.close(); }
});

// The eraser pop already shut by an earlier close. Putting the eraser down does not clear what that close left, so a later
// pick finds the pop shut, and an Escape before the strip's next frame releases the eraser at once: one press fewer than
// when the pop paints, which is right, as the pop was never on screen. What would be wrong is a pop painting after the
// release with no eraser held. That is the pin; no press is counted.
it("eraser pop shut by an earlier close, eraser picked, Escape before the next frame: no pop paints after the release, with no eraser held", async () => {
	const page = await browser.newPage({viewport: {width: 1400, height: 1100}});
	const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
	const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
	// What is on screen: every strip pop showing and laid out, the held tip, whether the eraser is on, and the close's bit.
	const read = () => page.evaluate(() => (window as any).escapePaint());
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({content: css + readFileSync(fileURLToPath(new URL("./noteViewportCamera.css", import.meta.url)), "utf8")});
		await page.addScriptTag({content: script});
		await page.evaluate(() => (window as any).escapeFamily.setup("pan"));
		await page.evaluate(() => {
			const w = window as any, tools = w.viewportFixture.overlay("escape").mobileTools;
			w.escapePaint = () => ({
				tip: w.escapeFamily.state().tip,
				eraserOn: tools.host.eraserOn(),
				popClosedBit: tools.eraserPopClosed,
				painted: [...document.querySelectorAll<HTMLElement>(".handwriting-slider-pop")]
					.filter(el => el.classList.contains("is-showing") && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0)
					.map(el => el === tools.slider.pop ? "eraser" : el === tools.penSlider.pop ? "pen" : el === tools.hlSlider.pop ? "highlighter" : "other"),
			});
		});
		await frames();
		// The earlier close: the eraser is picked and its pop paints; Escape shuts the pop, and Escape puts the eraser down.
		await page.evaluate(() => (window as any).escapeFamily.prepareNib("eraser"));
		await frames();
		const opened = await read();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await frames();
		const earlier = await read();
		// A busy main thread from here: the pick's deferred refresh waits on a held frame across the first press.
		await page.evaluate(() => {
			const w = window as any;
			w.heldFrames = []; w.realFrame = w.requestAnimationFrame;
			w.requestAnimationFrame = (callback: FrameRequestCallback) => w.heldFrames.push(callback);
		});
		await page.evaluate(() => (window as any).escapeFamily.prepareNib("eraser"));
		const picked = await read();
		await page.keyboard.press("Escape");
		const pressed = await read();
		const held = await page.evaluate(() => {
			const w = window as any;
			w.requestAnimationFrame = w.realFrame;
			const queue: FrameRequestCallback[] = w.heldFrames.splice(0);
			for (const callback of queue) callback(performance.now());
			return queue.length;
		});
		const late = await read();
		// Were the eraser still held here (a press that shut something else first), one more Escape puts it down; then the
		// frames after the release are read one by one.
		if (late.eraserOn) await page.keyboard.press("Escape");
		const after = await page.evaluate(() => new Promise<any[]>(done => {
			const out: any[] = [];
			const tick = () => { out.push((window as any).escapePaint()); if (out.length >= 4) done(out); else requestAnimationFrame(tick); };
			requestAnimationFrame(tick);
		}));
		evidence.push({kind: "eraser-closed-earlier-late-frame", opened, earlier, picked, pressed, held, late, after, errors});
		expect(opened.painted, "premise: the first pick paints the eraser pop").toEqual(["eraser"]);
		expect([earlier.eraserOn, earlier.popClosedBit, earlier.painted], "premise: after the earlier close the eraser is down, the close's bit is still set, and nothing paints").toEqual([false, true, []]);
		expect(held, "premise: the pick's refresh was waiting on the held frame").toBeGreaterThan(0);
		expect(picked.eraserOn, "premise: the second pick holds the eraser").toBe(true);
		const released = [pressed, late, ...after].filter(s => !s.eraserOn);
		expect(after.every(s => !s.eraserOn), "the eraser is down after the release").toBe(true);
		expect(released.map(s => s.painted), "no pop paints after the release, with no eraser held").toEqual(released.map(() => []));
		expect(errors).toEqual([]);
	} finally { await page.close(); }
});
