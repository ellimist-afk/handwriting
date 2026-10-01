/**
 * Issue #22: a stroke near the note start appears as non-editable raster over
 * a newly inserted table. Synthetic Chromium reproduction, not an Obsidian
 * 1.13.7 / XP-PEN / Windows acceptance claim. Table rendering uses a real CM
 * block widget with host-shaped DOM; the proprietary table renderer is absent.
 *
 * HW_ISSUE22_PLANT=duplicate-raster copies real committed ink into the table
 * canvas region after insertion. Store/selection assertions must stay green;
 * "no second ink component over table" must turn red. Table-first control is
 * never planted. An early premise failure is not a successful falsification.
 *
 * The nested-cell cases model the detached HJ -> UJ lifecycle found in the
 * installed 1.13.7 host source. Ordinary reproduction adds NO raster plant.
 * Surface ownership and composite duplication are separate assertions: a red
 * surface census alone is not proof of the reporter's exact visible symptom.
 * Set HW_ISSUE22_EVIDENCE to a fresh absolute directory outside the repository
 * to save PNGs, canvas backings, owner census and independent no-ink references.
 * When unset, all product assertions run without writing artifacts.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import css from "../../styles.css?raw";
import type {} from "./issue22TableDuplicatePage";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, script: string;
const plant = process.env.HW_ISSUE22_PLANT;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const fixtureCSS = `body { margin:0; background:white; color:black; }
.issue22-proof { position:relative; width:640px; height:600px; overflow:hidden; }
.issue22-proof .cm-scroller { overflow:auto; }
.issue22-proof .cm-line { padding:0; }
.issue22-proof table { border-collapse:collapse; width:400px; table-layout:fixed; background:white; color:black; }
.issue22-proof td { border:1px solid #555; height:80px; padding:8px; vertical-align:top; }
.issue22-proof .cm-content { caret-color:transparent; }`;

beforeAll(async () => {
	if (plant && plant !== "duplicate-raster") throw Error(`unknown issue22 plant: ${plant}`);
	const bundled = await build({ entryPoints: [here("./issue22TableDuplicatePage.ts")], bundle: true, write: false,
		format: "iife", platform: "browser", alias: { obsidian: here("./issue22ObsidianStub.ts") } });
	script = bundled.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

async function open(dpr: number, tableFirst: boolean) {
	const page = await browser.newPage({ viewport: { width: 800, height: 700 }, deviceScaleFactor: dpr });
	const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
	try {
		await page.setContent("<!doctype html><body></body>");
		await page.addStyleTag({ content: css + fixtureCSS });
		await page.addScriptTag({ content: script });
		const initial = await page.evaluate(first => window.issue22.mount(first), tableFirst);
		return { page, errors, initial };
	} catch (error) { await page.close(); throw error; }
}

type Census = Awaited<ReturnType<Window["issue22"]["census"]>>;
function evidenceDirectory(dpr: number, test: string, phase: string) {
	const root = process.env.HW_ISSUE22_EVIDENCE;
	if (root === undefined) return null;
	if (!isAbsolute(root)) throw Error("HW_ISSUE22_EVIDENCE must be an absolute external artifact directory");
	const normalized = resolve(root).replaceAll("\\", "/").toLowerCase();
	const repository = resolve(here("../..")).replaceAll("\\", "/").toLowerCase();
	if (normalized === repository || normalized.startsWith(repository + "/")) throw Error("Issue22 evidence must be outside the repository");
	const dir = join(resolve(root), `dpr-${dpr}`, test, phase);
	mkdirSync(dir, { recursive: true });
	return dir;
}
async function capture(page: Page, dpr: number, test: string, phase: string) {
	const dir = evidenceDirectory(dpr, test, phase);
	const state = await page.evaluate(() => window.issue22.census());
	const backing = await page.evaluate(() => window.issue22.layerPNGs());
	if (dir !== null) {
		writeFileSync(join(dir, "census.json"), JSON.stringify(state, null, 2), { flag: "wx" });
		writeFileSync(join(dir, "composite.png"), await page.screenshot({ animations: "disabled" }), { flag: "wx" });
		writeFileSync(join(dir, "backing-index.json"), JSON.stringify(backing.map(({ png, ...entry }) => ({ ...entry, hasPNG: png !== null })), null, 2), { flag: "wx" });
	}
	for (const image of backing) {
		if (image.png === null) continue; // Zero-size layer is recorded, never passed off as a saved PNG.
		if (!image.png.startsWith("data:image/png;base64,")) throw Error("unreadable canvas backing");
		if (dir !== null) writeFileSync(join(dir, `${image.editor}-surface-${image.surface}-layer-${image.layer}.png`), Uint8Array.from(atob(image.png.split(",")[1]!), char => char.charCodeAt(0)), { flag: "wx" });
	}
	const table = await tableShot(page);
	if (dir !== null) writeFileSync(join(dir, "table.png"), Uint8Array.from(table.bytes), { flag: "wx" });
	const originalRect = state.original.raster.screen;
	let originalPixels: Awaited<ReturnType<Window["issue22"]["pixels"]>> | null = null;
	if (originalRect) {
		const original = await page.screenshot({ clip: originalRect });
		if (dir !== null) writeFileSync(join(dir, "original.png"), original, { flag: "wx" });
		originalPixels = await page.evaluate(bytes => window.issue22.pixels(bytes), [...original]);
	}
	return { state, table, originalPixels };
}
function assertOriginal(state: Census, before: Census["original"]) {
	expect.soft(state.original.strokes, "store contains exactly unchanged original stroke").toEqual(before.strokes);
	expect.soft(state.original.selectable, "original remains selectable by real lasso geometry").toEqual(["issue22-original"]);
	expect.soft(state.surfaces.filter(s => s.editor === "note-main"), "original note has exactly one surface").toHaveLength(1);
	expect.soft(state.surfaces.filter(s => s.editor === "unregistered"), "all ink surfaces have a known editor owner").toHaveLength(0);
}
async function assertCellPhase(subject: Page, reference: Page, dpr: number, phase: string, before: Census["original"]) {
	const clean = await capture(reference, dpr, "nested-cell", `${phase}-reference`);
	const actual = await capture(subject, dpr, "nested-cell", `${phase}-subject`);
	const cleanPixels = await reference.evaluate(bytes => window.issue22.pixels(bytes), clean.table.bytes);
	expect(cleanPixels.dark, "reference table has visible borders and text").toBeGreaterThan(200 * dpr * dpr);
	expect(clean.state.original.strokes).toEqual([]);
	expect(actual.table.rect, "subject and independent reference use the same cell layout").toEqual(clean.table.rect);
	const pixels = await subject.evaluate(({ bytes, reference }) => window.issue22.pixels(bytes, reference),
		{ bytes: actual.table.bytes, reference: clean.table.bytes });
	console.log("ISSUE22_NESTED", JSON.stringify({ dpr, phase, census: actual.state, reference: clean.state,
		pixels, cleanPixels, originalPixels: actual.originalPixels }));
	assertOriginal(actual.state, before);
	expect.soft(actual.originalPixels?.largest ?? 0, "original remains visibly painted").toBeGreaterThan(100);
	expect.soft(actual.state.surfaces.filter(s => s.kind === "cell" || s.kind === "bare"),
		"no note ink surface inside the table-cell editor").toHaveLength(0);
	expect.soft(actual.state.surfaces.filter(s => s.insideTable), "no table descendant owns note ink").toHaveLength(0);
	expect.soft(pixels.missingDark, "table paint remains present").toBeLessThan(48 * dpr * dpr);
	expect.soft(pixels.largest, "no second ink component over focused table cell").toBeLessThan(24 * dpr * dpr);
	expect.soft(pixels.addedDark, "no substantial extra dark paint over focused table cell").toBeLessThan(48 * dpr * dpr);
	return actual.state;
}

for (const dpr of [1, 2]) {
	it(`nested-cell: detached same-owner child never owns note ink, DPR ${dpr}`, async () => {
		if (plant) throw Error("nested-cell ordinary reproduction must not use the raster plant");
		const reference = await open(dpr, true), subject = await open(dpr, false);
		try {
			const before = await subject.page.evaluate(() => window.issue22.addInk());
			expect(before.raster.count, "original ink premise").toBeGreaterThan(100);
			expect(before.strokes.map(s => s.id)).toEqual(["issue22-original"]);
			await subject.page.evaluate(() => window.issue22.insertTable());
			await assertCellPhase(subject.page, reference.page, dpr, "plain-table", before);
			const refFocused = await reference.page.evaluate(() => window.issue22.focusCell());
			const focused = await subject.page.evaluate(() => window.issue22.focusCell());
			const detachedDir = evidenceDirectory(dpr, "nested-cell", "detached");
			if (detachedDir !== null) writeFileSync(join(detachedDir, "states.json"),
				JSON.stringify({ subject: focused.detached, reference: refFocused.detached }, null, 2), { flag: "wx" });
			const detachedChild = focused.detached.editors.find(e => e.id === focused.id)!;
			expect(detachedChild.connected, "child initialized while detached").toBe(false);
			expect(detachedChild.ownMarkdownRoot, "child's own note-root class removed before initialization").toBe(false);
			expect(detachedChild.sameOwner, "nested child inherits exact note owner object").toBe(true);
			expect.soft(focused.detached.surfaces.filter(s => s.editor === focused.id), "detached table-cell child gets no ink surface").toHaveLength(0);
			expect(focused.attached.editors.find(e => e.id === focused.id)?.insideParentEditor).toBe(true);
			expect(focused.attached.editors.find(e => e.id === focused.id)?.focused, "real cell focus reached").toBe(true);
			await assertCellPhase(subject.page, reference.page, dpr, "focused", before);
			await reference.page.evaluate(() => window.issue22.blurCell()); await subject.page.evaluate(() => window.issue22.blurCell());
			await assertCellPhase(subject.page, reference.page, dpr, "blurred", before);
			await reference.page.evaluate(() => window.issue22.refocusCell()); await subject.page.evaluate(() => window.issue22.refocusCell());
			await assertCellPhase(subject.page, reference.page, dpr, "refocused", before);
			await reference.page.evaluate(() => window.issue22.focusCell(true, 1)); await subject.page.evaluate(() => window.issue22.focusCell(true, 1));
			const switched = await assertCellPhase(subject.page, reference.page, dpr, "switched-cell", before);
			expect.soft(switched.editors.filter(e => e.kind === "cell"), "old child retired after new child focus").toHaveLength(1);
			await reference.page.evaluate(() => window.issue22.destroyCell()); await subject.page.evaluate(() => window.issue22.destroyCell());
			const destroyed = await assertCellPhase(subject.page, reference.page, dpr, "destroyed", before);
			expect.soft(destroyed.editors.filter(e => e.kind === "cell"), "destroy removed child editor").toHaveLength(0);
			await reference.page.evaluate(() => window.issue22.focusCell(true, 1)); await subject.page.evaluate(() => window.issue22.focusCell(true, 1));
			await assertCellPhase(subject.page, reference.page, dpr, "recreated-second-cell", before);
			expect.soft(subject.errors).toEqual([]); expect.soft(reference.errors).toEqual([]);
		} finally { await subject.page.close(); await reference.page.close(); }
	});
	it(`nested-cell control: child without file-owner metadata stays inert, DPR ${dpr}`, async () => {
		const subject = await open(dpr, true);
		try {
			const before = await subject.page.evaluate(() => window.issue22.addInk());
			const focused = await subject.page.evaluate(() => window.issue22.focusCell(false));
			expect(focused.attached.editors.find(e => e.id === focused.id)?.file).toBe(null);
			expect(focused.attached.editors.find(e => e.id === focused.id)?.focused).toBe(true);
			expect(focused.attached.editors.find(e => e.id === focused.id)?.connected).toBe(true);
			const actual = await capture(subject.page, dpr, "no-owner", "focused");
			assertOriginal(actual.state, before);
			expect(actual.state.surfaces.filter(s => s.kind === "bare")).toHaveLength(0);
			expect(actual.originalPixels?.largest ?? 0).toBeGreaterThan(100);
			expect(subject.errors).toEqual([]);
		} finally { await subject.page.close(); }
	});
	for (const popout of [false, true]) it(`nested-cell control: legitimate same-file ${popout ? "second-window" : "second-pane"} keeps ink, DPR ${dpr}`, async () => {
		const subject = await open(dpr, true);
		try {
			await subject.page.setViewportSize({ width: 1320, height: 700 });
			const before = await subject.page.evaluate(() => window.issue22.addInk());
			const attachment = await subject.page.evaluate(otherWindow => window.issue22.addLegitimatePane(otherWindow), popout);
			const attachmentDir = evidenceDirectory(dpr, popout ? "second-window" : "second-pane", "detached-attach");
			if (attachmentDir !== null) writeFileSync(join(attachmentDir, "lifecycle.json"),
				JSON.stringify(attachment, null, 2), { flag: "wx" });
			const id = popout ? "note-popout" : "note-second";
			const detached = attachment.detached.editors.find(e => e.id === id)!;
			expect(detached.connected, "legitimate top-level editor constructed detached").toBe(false);
			expect(detached.ownMarkdownRoot, "construction starts without a Markdown root").toBe(false);
			expect(detached.insideParentEditor, "delayed editor is top-level, not a table child").toBe(false);
			expect(attachment.detached.surfaces.filter(s => s.editor === id), "rootless constructor is inert").toHaveLength(0);
			expect(attachment.attachedBeforeUpdate.editors.find(e => e.id === id)?.connected).toBe(true);
			expect(attachment.attachedBeforeUpdate.editors.find(e => e.id === id)?.ownMarkdownRoot).toBe(true);
			expect(attachment.attachedBeforeUpdate.surfaces.filter(s => s.editor === id), "attachment witness precedes first update").toHaveLength(0);
			expect(attachment.firstUpdateTransactions, "exactly one first normal transaction").toBe(1);
			expect(attachment.afterFirstUpdate.surfaces.filter(s => s.editor === id), "first normal update mounts newly eligible top-level pane").toHaveLength(1);
			for (const state of [attachment.detached, attachment.attachedBeforeUpdate, attachment.afterFirstUpdate]) assertOriginal(state, before);
			const actual = await capture(subject.page, dpr, popout ? "second-window" : "second-pane", "mounted");
			assertOriginal(actual.state, before);
			expect(actual.state.editors.find(e => e.id === id)?.differentWindow).toBe(popout);
			expect(actual.state.editors.find(e => e.id === id)?.file).toBe("synthetic-issue22.md");
			const surfaces = actual.state.surfaces.filter(s => s.editor === id);
			expect(surfaces, "legitimate same-file pane retains its own ink surface").toHaveLength(1);
			expect(surfaces[0]!.canvases[2]!.raster.count, "legitimate second pane paints shared note ink").toBeGreaterThan(100);
			const crop = surfaces[0]!.canvases[2]!.raster.screen!;
			const frameRect = popout ? await subject.page.locator("iframe").boundingBox() : null;
			if (popout && !frameRect) throw Error("second-window frame has no visible rectangle");
			const composite = await subject.page.screenshot({ clip: { ...crop,
				x: crop.x + (frameRect?.x ?? 0), y: crop.y + (frameRect?.y ?? 0) } });
			const mountedDir = evidenceDirectory(dpr, popout ? "second-window" : "second-pane", "mounted");
			if (mountedDir !== null) writeFileSync(join(mountedDir, "secondary-original.png"), composite, { flag: "wx" });
			const visible = await subject.page.evaluate(bytes => window.issue22.pixels(bytes), [...composite]);
			expect(visible.largest, "legitimate second pane ink is visible in browser composite").toBeGreaterThan(100);
			expect(actual.originalPixels?.largest ?? 0).toBeGreaterThan(100);
			await subject.page.evaluate(otherWindow => window.issue22.setPaneRootEligibility(otherWindow, false), popout);
			const rootless = await capture(subject.page, dpr, popout ? "second-window" : "second-pane", "rootless");
			assertOriginal(rootless.state, before);
			expect(rootless.state.surfaces.filter(s => s.editor === id), "mounted pane retires after losing its owned root").toHaveLength(0);
			await subject.page.evaluate(otherWindow => window.issue22.setPaneRootEligibility(otherWindow, true), popout);
			const restored = await capture(subject.page, dpr, popout ? "second-window" : "second-pane", "root-restored");
			assertOriginal(restored.state, before);
			const remounted = restored.state.surfaces.filter(s => s.editor === id);
			expect(remounted, "same pane remounts after regaining its owned root").toHaveLength(1);
			expect(remounted[0]!.canvases[2]!.raster.count, "remounted legitimate pane still paints shared ink").toBeGreaterThan(100);
			expect(subject.errors).toEqual([]);
		} finally { await subject.page.close(); }
	});
}
async function tableShot(page: Page) {
	const rect = await page.evaluate(() => window.issue22.tableRect());
	expect(rect.width).toBeGreaterThan(300); expect(rect.height).toBeGreaterThan(150);
	expect(rect.y).toBeGreaterThan(100); expect(rect.y + rect.height).toBeLessThan(600);
	const bytes = [...await page.screenshot({ clip: rect, animations: "disabled" })];
	return { bytes, rect };
}

for (const dpr of [1, 2]) {
	it(`static-block: own-note table and callout never copy ink, DPR ${dpr}`, async () => {
		const reference = await open(dpr, true), subject = await open(dpr, false);
		try {
			const before = await subject.page.evaluate(() => window.issue22.addInk());
			expect(before.raster.count, "non-empty original ink premise").toBeGreaterThan(100);
			await subject.page.evaluate(() => window.issue22.insertTable());
			const clean = await tableShot(reference.page);
			const cleanPixels = await reference.page.evaluate(bytes => window.issue22.pixels(bytes), clean.bytes);
			expect(cleanPixels.dark, "independent table is visibly rendered").toBeGreaterThan(200 * dpr * dpr);
			const first = await subject.page.evaluate(() => window.issue22.postprocessOwnBlock("table"));
			const second = await subject.page.evaluate(() => window.issue22.postprocessOwnBlock("table"));
			const callout = await subject.page.evaluate(() => window.issue22.postprocessOwnBlock("callout"));
			const afterChange = await subject.page.evaluate(() => window.issue22.notifyOwnBlockInkChanged());
			const actual = await capture(subject.page, dpr, "static-block", "subject");
			const pixels = await subject.page.evaluate(({ bytes, reference }) => window.issue22.pixels(bytes, reference),
				{ bytes: actual.table.bytes, reference: clean.bytes });
			console.log("ISSUE22_STATIC", JSON.stringify({ dpr, first, second, callout, afterChange,
				pixels, originalPixels: actual.originalPixels, errors: subject.errors }));
			expect.soft(first.children, "own table registered no render child").toBe(0);
			expect.soft(second.children, "own table rerender registered no child").toBe(0);
			expect.soft(callout.children, "own callout registered no render child").toBe(0);
			expect.soft(first.staticCanvases + second.staticCanvases + callout.staticCanvases + afterChange,
			"own blocks and notification have no static canvas").toBe(0);
			assertOriginal(actual.state, before);
			expect.soft(actual.originalPixels?.largest ?? 0, "original ink remains visible").toBeGreaterThan(100);
			expect.soft(pixels.missingDark, "table paint remains present").toBeLessThan(48 * dpr * dpr);
			expect.soft(pixels.largest, "no extra visible ink component over table").toBeLessThan(24 * dpr * dpr);
			expect.soft(pixels.addedDark, "no extra dark ink over table").toBeLessThan(48 * dpr * dpr);
			expect.soft(subject.errors).toEqual([]);
		} finally { await subject.page.close(); await reference.page.close(); }
	});
	for (const kind of ["detached-container", "delayed"] as const) {
		it(`static-block: ${kind} own Live Preview boundary stays ink-free, DPR ${dpr}`, async () => {
			const reference = await open(dpr, true), subject = await open(dpr, true);
			try {
				const before = await subject.page.evaluate(() => window.issue22.addInk());
				expect(before.raster.count, "non-empty note ink premise").toBeGreaterThan(100);
				const clean = await reference.page.evaluate(k => window.issue22.postprocessOwnBlockBoundary(k), kind);
				const actual = await subject.page.evaluate(k => window.issue22.postprocessOwnBlockBoundary(k), kind);
				const afterChange = await subject.page.evaluate(() => window.issue22.notifyOwnBlockInkChanged());
				const cleanShot = [...await reference.page.screenshot({ clip: clean.rect, animations: "disabled" })];
				const actualShot = [...await subject.page.screenshot({ clip: actual.rect, animations: "disabled" })];
				const pixels = await subject.page.evaluate(({ bytes, reference }) => window.issue22.pixels(bytes, reference),
					{ bytes: actualShot, reference: cleanShot });
				const originalRect = actual.original.raster.screen!;
				const originalShot = [...await subject.page.screenshot({ clip: originalRect, animations: "disabled" })];
				const visible = await subject.page.evaluate(bytes => window.issue22.pixels(bytes), originalShot);
				console.log("ISSUE22_BOUNDARY", JSON.stringify({ kind, dpr, clean, actual, afterChange, pixels, visible }));
				expect.soft(actual.children).toBe(kind === "delayed" ? 1 : 0);
				expect.soft(actual.staticCanvases).toBe(0);
				expect.soft(afterChange, "notification cannot revive own block").toBe(0);
				expect.soft(actual.rect).toEqual(clean.rect);
				expect.soft(actual.original.strokes).toEqual(before.strokes);
				expect.soft(actual.original.selectable).toEqual(["issue22-original"]);
				expect.soft(visible.largest, "original ink stays visible").toBeGreaterThan(100);
				expect.soft(pixels.largest, "own block has no extra ink component").toBeLessThan(24 * dpr * dpr);
				expect.soft(pixels.addedDark, "own block has no extra dark ink").toBeLessThan(48 * dpr * dpr);
				expect.soft(subject.errors).toEqual([]); expect.soft(reference.errors).toEqual([]);
			} finally { await subject.page.close(); await reference.page.close(); }
		});
	}
	for (const kind of ["reading", "embed", "other-note", "delayed", "unloaded", "popout"] as const) {
		it(`static-block: ${kind} rendered control keeps correct target ink, DPR ${dpr}`, async () => {
			const reference = await open(dpr, true), subject = await open(dpr, true);
			try {
				const clean = await reference.page.evaluate(k => window.issue22.postprocessRenderedControl(k, false), kind);
				const actual = await subject.page.evaluate(k => window.issue22.postprocessRenderedControl(k, true), kind);
				console.log("ISSUE22_RENDER_CONTROL", JSON.stringify({ kind, dpr, clean, actual }));
				expect.soft(actual.children, "real callback registered a render child").toBe(1);
				if (kind === "other-note") expect.soft(actual.insideCallout,
					"note B embed is inside note A callout").toBe(true);
				expect.soft(actual.storeCount).toBe(1);
				if (kind === "unloaded") {
					expect.soft(actual.canvasCount, "unloaded wait never paints").toBe(0);
				} else {
					expect.soft(actual.canvasCount, "genuine rendered context owns one canvas").toBe(1);
					expect.soft(actual.raster?.count ?? 0, "target note has non-empty painted ink").toBeGreaterThan(100);
					expect.soft(clean.canvasCount, "empty control has no bitmap").toBe(0);
					const painted = [...await subject.page.screenshot({ clip: actual.rect, animations: "disabled" })];
					const unpainted = [...await reference.page.screenshot({ clip: clean.rect, animations: "disabled" })];
					const pixels = await subject.page.evaluate(({ bytes, reference }) => window.issue22.pixels(bytes, reference),
						{ bytes: painted, reference: unpainted });
					expect.soft(pixels.largest, "embedded target ink appears in browser composite").toBeGreaterThan(100);
				}
				expect.soft(subject.errors).toEqual([]); expect.soft(reference.errors).toEqual([]);
			} finally { await subject.page.close(); await reference.page.close(); }
		});
	}
	it(`cell-paste: nested cell consumes marker without changing note ink or history, DPR ${dpr}`, async () => {
		const subject = await open(dpr, true);
		try {
			await subject.page.evaluate(() => window.issue22.addInk());
			const seeded = await subject.page.evaluate(() => window.issue22.seedParentTextEdit());
			expect(seeded.parentUndo, "real parent text edit exists").toBeGreaterThan(0);
			await subject.page.evaluate(() => window.issue22.focusCell());
			const selection = await subject.page.evaluate(() => window.issue22.seedCellSelection());
			expect(selection.cellSelection).toEqual({ anchor: 1, head: 3 });
			expect(selection.parentSelection.head,
				"synthetic host forwarded cell selection to parent").toBeGreaterThan(3);
			const marker = await subject.page.evaluate(() => window.issue22.prepareInkPaste());
			expect(marker).toMatch(/^handwriting-ink\/v1 /);
			const refusal = await subject.page.evaluate(() => window.issue22.cellPasteProbe("current"));
			console.log("ISSUE22_CELL_PASTE", JSON.stringify({ dpr, refusal }));
			expect.soft(refusal.event.prevented, "recognized marker is consumed").toBe(true);
			expect.soft(refusal.event.bubbled, "recognized marker does not bubble").toBe(0);
			expect.soft(refusal.after.parentDoc).toBe(refusal.before.parentDoc);
			expect.soft(refusal.after.cellDoc).toBe(refusal.before.cellDoc);
			expect.soft(refusal.after.parentSelection).toEqual(refusal.before.parentSelection);
			expect.soft(refusal.after.cellSelection).toEqual(refusal.before.cellSelection);
			expect.soft(refusal.after.parentUndo).toBe(refusal.before.parentUndo);
			expect.soft(refusal.after.cellUndo).toBe(refusal.before.cellUndo);
			expect.soft(refusal.after.ids).toEqual(refusal.before.ids);
			expect.soft(refusal.after.points).toEqual(refusal.before.points);
			expect.soft(refusal.after.selected).toEqual(refusal.before.selected);
			expect.soft(refusal.after.persistenceWrites).toBe(refusal.before.persistenceWrites);
			expect.soft(refusal.after.notices).toContain("Handwriting: click outside the table to paste ink.");
			const command = await subject.page.evaluate(() => window.issue22.capturedCommandCellRefusal());
			expect.soft(command.map(c => c.routine)).toEqual([false, true]);
			for (const result of command) {
				expect.soft(result.accepted).toBe(true);
				expect.soft(result.after.notices,
					"real refused command emits exactly one actionable notice").toEqual([
					"Handwriting: click outside the table to paste ink.",
				]);
				expect.soft(result.after.ids).toEqual(result.before.ids);
				expect.soft(result.after.points).toEqual(result.before.points);
				expect.soft(result.after.parentUndo).toBe(result.before.parentUndo);
				expect.soft(result.after.cellUndo).toBe(result.before.cellUndo);
				expect.soft(result.after.persistenceWrites).toBe(result.before.persistenceWrites);
			}
			const undoneText = await subject.page.evaluate(() => window.issue22.cellUndoParent());
			expect.soft(undoneText.prevented, "cell Mod-z routed to parent").toBe(true);
			expect.soft(undoneText.after.parentDoc,
				"parent undo removes the earlier text edit").toBe(undoneText.before.parentDoc.slice(0, -4));
			expect.soft(undoneText.after.parentUndo).toBe(undoneText.before.parentUndo - 1);
			expect.soft(undoneText.after.ids).toEqual(undoneText.before.ids);
			expect.soft(undoneText.after.persistenceWrites).toBe(undoneText.before.persistenceWrites);
			await subject.page.evaluate(() => window.issue22.destroyCell());
			const retained = await subject.page.evaluate(() => window.issue22.pasteSnapshot());
			expect.soft(retained.ids).toEqual(undoneText.before.ids);
			expect.soft(retained.persistenceWrites).toBe(undoneText.before.persistenceWrites);
			expect.soft(retained.parentDoc).toBe(undoneText.after.parentDoc);
			const allowed = await subject.page.evaluate(() => window.issue22.parentPasteAndUndo());
			console.log("ISSUE22_PARENT_PASTE", JSON.stringify({ dpr, allowed }));
			expect.soft(allowed.event.prevented, "top-level marker is consumed").toBe(true);
			expect.soft(allowed.after.ids).toHaveLength(2);
			expect.soft(allowed.after.points[1]?.[0]?.x,
				"refused paste did not advance first normal stagger").toBe(96);
			expect.soft(allowed.after.selected).toEqual([allowed.after.ids[1]]);
			expect.soft(allowed.after.parentUndo).toBe(allowed.before.parentUndo + 1);
			expect.soft(allowed.after.persistenceWrites,
				"allowed paste schedules the sidecar").toBeGreaterThan(allowed.before.persistenceWrites);
			expect.soft(allowed.undid).toBe(true);
			expect.soft(allowed.afterUndo.ids).toEqual(allowed.before.ids);
			expect.soft(allowed.redid).toBe(true);
			expect.soft(allowed.afterRedo.ids).toEqual(allowed.after.ids);
			expect.soft(subject.errors).toEqual([]);
		} finally { await subject.page.close(); }
	});
}

it("cell-paste: normal text and stale marker retain their distinct handling", async () => {
	const subject = await open(1, true);
	try {
		await subject.page.evaluate(() => window.issue22.focusCell());
		await subject.page.evaluate(() => window.issue22.prepareInkPaste());
		const stale = await subject.page.evaluate(() => window.issue22.cellPasteProbe("stale"));
		const text = await subject.page.evaluate(() => window.issue22.cellPasteProbe("text"));
		console.log("ISSUE22_CELL_CONTROLS", JSON.stringify({ text, stale }));
		expect.soft(text.event.bubbled, "ordinary paste reaches CodeMirror").toBeGreaterThan(0);
		expect.soft(text.after.cellDoc).toContain("ordinary text");
		expect.soft(text.after.parentDoc).toContain("ordinary text");
		expect.soft(text.after.ids).toEqual(text.before.ids);
		expect.soft(stale.event.prevented, "stale marker is consumed").toBe(true);
		expect.soft(stale.event.bubbled).toBe(0);
		expect.soft(stale.after.ids).toEqual(stale.before.ids);
		expect.soft(stale.after.notices).toContain("Handwriting: that ink was copied before the app restarted");
		expect.soft(subject.errors).toEqual([]);
	} finally { await subject.page.close(); }
});

it("cell-paste: missing owner and a separate same-note pane cannot receive cell history", async () => {
	const subject = await open(1, true);
	try {
		await subject.page.evaluate(() => window.issue22.addInk());
		await subject.page.evaluate(() => window.issue22.addLegitimatePane(false));
		await subject.page.evaluate(() => window.issue22.focusCell(false));
		await subject.page.evaluate(() => window.issue22.prepareInkPaste());
		const refusal = await subject.page.evaluate(() => window.issue22.cellPasteProbe("current"));
		console.log("ISSUE22_MISSING_OWNER", JSON.stringify(refusal));
		expect.soft(refusal.event.prevented).toBe(true);
		expect.soft(refusal.event.bubbled).toBe(0);
		expect.soft(refusal.after.ids).toEqual(refusal.before.ids);
		expect.soft(refusal.after.parentUndo).toBe(refusal.before.parentUndo);
		expect.soft(refusal.after.cellUndo).toBe(refusal.before.cellUndo);
		expect.soft(refusal.after.otherUndo).toBe(refusal.before.otherUndo);
		expect.soft(refusal.after.otherDoc).toBe(refusal.before.otherDoc);
		expect.soft(refusal.after.persistenceWrites).toBe(refusal.before.persistenceWrites);
		expect.soft(refusal.after.notices).toContain("Handwriting: click outside the table to paste ink.");
		expect.soft(subject.errors).toEqual([]);
	} finally { await subject.page.close(); }
});

for (const dpr of [1, 2]) for (const order of ["ink-first", "table-first"] as const) {
	it(`${order}: table insertion preserves one editable stroke without a raster duplicate, DPR ${dpr}`, async () => {
		const reference = await open(dpr, true);
		try {
			// Separate no-ink page supplies actual DOM text/border pixels. Never
			// derive the oracle by erasing the suspect raster in the subject.
			const clean = await tableShot(reference.page);
			const cleanPixels = await reference.page.evaluate(bytes => window.issue22.pixels(bytes), clean.bytes);
			// A blank reference or disappearing table is not a successful
			// duplicate-stroke check. Require visible table paint independently.
			expect(cleanPixels.dark, "reference table has visible borders and text").toBeGreaterThan(200 * dpr * dpr);
			expect(reference.initial.strokes).toEqual([]);
			const subject = await open(dpr, order === "table-first");
			try {
				const before = await subject.page.evaluate(() => window.issue22.addInk());
				expect(before.strokes.map(s => s.id)).toEqual(["issue22-original"]);
				expect(before.selectable).toEqual(["issue22-original"]);
				expect(before.tableCount).toBe(order === "table-first" ? 1 : 0);
				expect(before.raster.count, "original committed raster is nonempty").toBeGreaterThan(100);
				const originalRect = before.raster.screen!;
				const originalPNG = [...await subject.page.screenshot({ clip: originalRect })];
				const originalPixels = await subject.page.evaluate(bytes => window.issue22.pixels(bytes), originalPNG);
				expect(originalPixels.largest, "original stroke is visible in browser composite").toBeGreaterThan(100);
				const after = order === "ink-first" ? await subject.page.evaluate(() => window.issue22.insertTable())
					: await subject.page.evaluate(async () => { await window.issue22.settle(); return window.issue22.snapshot(); });
				expect(after.tableCount).toBe(1);
				expect(after.doc).toBe(reference.initial.doc);
				if (order === "ink-first") {
					expect(after.mutations, "real table DOM mutation observed").toBeGreaterThan(before.mutations);
					expect(after.measures, "CM measure ran after insertion").toBeGreaterThan(before.measures);
				}
				if (plant && order === "ink-first") await subject.page.evaluate(() => window.issue22.duplicateRaster());
				const actual = await tableShot(subject.page);
				expect(actual.rect).toEqual(clean.rect);
				expect(originalRect.y + originalRect.height, "original is disjoint from table").toBeLessThan(actual.rect.y - 20);
				const pixels = await subject.page.evaluate(({ bytes, reference }) => window.issue22.pixels(bytes, reference),
					{ bytes: actual.bytes, reference: clean.bytes });
				const final = await subject.page.evaluate(() => window.issue22.snapshot());
				const retainedPNG = [...await subject.page.screenshot({ clip: originalRect })];
				const retained = await subject.page.evaluate(bytes => window.issue22.pixels(bytes), retainedPNG);
				console.log("ISSUE22", JSON.stringify({ order, dpr, plant: plant ?? null, before, after, final, pixels, cleanPixels, originalPixels, retained }));
				// Soft checks ensure store/selection failures cannot hide the visual
				// assertion. The plant must fail the visual assertion specifically.
				expect.soft(final.strokes, "store contains exactly unchanged original stroke").toEqual(before.strokes);
				expect.soft(final.selectable, "original remains selectable by real lasso geometry").toEqual(["issue22-original"]);
				expect.soft(retained.largest, "original remains visibly painted").toBeGreaterThan(100);
				expect.soft(pixels.missingDark, "table paint remains present").toBeLessThan(48 * dpr * dpr);
				expect.soft(pixels.largest, "no second ink component over table").toBeLessThan(24 * dpr * dpr);
				expect.soft(pixels.addedDark, "no substantial extra dark paint over table").toBeLessThan(48 * dpr * dpr);
				expect.soft(subject.errors).toEqual([]); expect.soft(reference.errors).toEqual([]);
			} finally { await subject.page.close(); }
		} finally { await reference.page.close(); }
	});
}
