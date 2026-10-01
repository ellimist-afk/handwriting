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
			build.onLoad({filter: /[/\\]InkOverlay\.ts$/}, args => {
				let source = readFileSync(args.path, "utf8");
				const peel = "releaseTipModes();";
				const floor = "export function releaseMouseInkQuietlyEverywhere(): void {";
				if (plant === "swallow") {
					if (source.split(peel).length !== 2) throw new Error("Escape plant target must occur exactly once");
					source = source.replace(peel, "/* plant: consume Escape without releasing the held tip */");
				} else if (plant === "block-pen") {
					source = 'import { setPenInk as plantSetPenInk } from "./PenInk";\n' + source.replace(floor, floor + "\nplantSetPenInk(false);");
				} else if (plant === "reset-nib") {
					source = source.replace(floor, floor + '\nsetInkSizeMult("pen", 1); applyInkColor("pen", "#000000");');
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
