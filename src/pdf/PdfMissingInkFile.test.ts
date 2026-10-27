import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { ADOPTION_QUIET_MS, ADOPTION_RUN_GAP_MS, ADOPTION_STILL_FAILING } from "../inline/InlineInkStore";
import { PdfInkStore } from "./PdfInkStore";

const PDF_ID = "pdf-a1b2c3d4";
const PATH = `.handwriting/${PDF_ID}.json`;
const MISSING_MESSAGE = "this PDF's ink file is missing.\n\nyour ink is still on screen. your next stroke saves it again.";

// Exercise the callbacks installed by the plugin, including its block notice
// and the real PageStore save, rather than replacing persistence with a spy.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStartMarker = "\t\tthis.pdfStore.attachHost({";
const hostEndMarker = "\n\t\t});\n";
expect(source.split(hostStartMarker)).toHaveLength(2);
const hostStart = source.indexOf(hostStartMarker);
const hostEnd = source.indexOf(hostEndMarker, hostStart);
expect(hostStart).toBeGreaterThan(0);
expect(hostEnd).toBeGreaterThan(hostStart);
const hostRegistration = source.slice(hostStart, hostEnd + hostEndMarker.length);
const installPdfPersistenceHost = new Function(
	"Notice",
	"blockNotice",
	transformSync(hostRegistration, { loader: "ts", target: "es2022" }).code
);

function stroke(id: string, page: number): InkStroke {
	const points = [
		{ x: 10, y: 20, pressure: 0.5, t: 0 },
		{ x: 30, y: 40, pressure: 0.5, t: 8 },
	];
	return {
		id, page, tool: "pen", color: "#4b7bec", width: 2, createdAt: 100,
		points,
		bbox: computeBBox(points, 4),
	};
}

async function rig() {
	const page = emptyPage(PDF_ID);
	page.surface = "pdf";
	page.coordSpace = "page-css@1";
	page.pdfPaths = ["Folder/Doc.pdf"];
	page.strokes = [stroke("first-page", 1), stroke("second-page", 2)];
	page.unknownTop = { futurePdfField: { retained: true } };
	const original = serializePage(page);
	const adapter = new FakeAdapter();
	adapter.externalWrite(PATH, original);
	const disk = new PageStore({ vault: { adapter } });
	const ink = new PdfInkStore();
	const notices: string[] = [];
	class KeptNotice {
		constructor(message: string) { notices.push(`plain: ${message}`); }
	}
	installPdfPersistenceHost.call(
		{ pdfStore: ink, store: disk }, KeptNotice,
		(message: string) => void notices.push(message)
	);
	await ink.ensureLoaded(PDF_ID);
	return { adapter, disk, ink, notices, original };
}

function removeSidecar(r: Awaited<ReturnType<typeof rig>>): void {
	r.adapter.files.delete(PATH);
	r.adapter.mtimes.delete(PATH);
}

function advanceClock(ms: number): void {
	vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("the next stroke saves the missing ink file again", async () => {
	const r = await rig();
	removeSidecar(r);
	expect(await r.ink.adoptExternal(PDF_ID, () => true)).toMatchObject({ outcome: "held" });
	expect(r.adapter.files.has(PATH)).toBe(false);
	expect(r.ink.strokes(PDF_ID).map((s) => s.id)).toEqual(["first-page", "second-page"]);
	r.ink.commit(PDF_ID, stroke("next-stroke", 2));
	await r.disk.flush();
	expect(r.adapter.files.has(PATH), "the next stroke did not restore the missing sidecar").toBe(true);
	const bytes = r.adapter.files.get(PATH);
	if (bytes === undefined) throw new Error("restored sidecar has no bytes");
	const restored = parsePage(bytes, PDF_ID);
	expect(restored.damaged).not.toBe(true);
	expect(restored.data.pageId).toBe(PDF_ID);
	expect(restored.data.surface).toBe("pdf");
	expect(restored.data.coordSpace).toBe("page-css@1");
	expect(restored.data.pdfPaths).toEqual(["Folder/Doc.pdf"]);
	expect(restored.data.strokes).toEqual([
		stroke("first-page", 1), stroke("second-page", 2), stroke("next-stroke", 2),
	]);
	expect(restored.data.unknownTop).toEqual({ futurePdfField: { retained: true } });
	expect(r.disk.hasQueuedWrite(PDF_ID)).toBe(false);
	const reopened = new PageStore({ vault: { adapter: r.adapter } });
	expect((await reopened.load(PDF_ID))?.data.strokes).toEqual(restored.data.strokes);
});

it("announces a missing PDF ink file in two blocks once after the quiet period", async () => {
	const r = await rig();
	const before = JSON.stringify(r.ink.strokes(PDF_ID));
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
	expect(r.notices[0]?.split("\n\n")).toEqual([
		"this PDF's ink file is missing.",
		"your ink is still on screen. your next stroke saves it again.",
	]);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
	expect(JSON.stringify(r.ink.strokes(PDF_ID))).toBe(before);
	expect(r.adapter.files.has(PATH)).toBe(false);
});

it("keeps the slow-load words for a read failure with the same quiet period and latch", async () => {
	const r = await rig();
	const before = JSON.stringify(r.ink.strokes(PDF_ID));
	vi.spyOn(r.adapter, "read").mockRejectedValue(new Error("disk read failed"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([ADOPTION_STILL_FAILING]);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([ADOPTION_STILL_FAILING]);
	expect(JSON.stringify(r.ink.strokes(PDF_ID))).toBe(before);
	expect(r.adapter.files.get(PATH)).toBe(r.original);
});

it("stays quiet before the missing-file quiet period expires", async () => {
	const r = await rig();
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	advanceClock(ADOPTION_QUIET_MS - 1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
});

it("starts a new quiet period after a long gap between missing-file checks", async () => {
	const r = await rig();
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	advanceClock(ADOPTION_RUN_GAP_MS + 1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(ADOPTION_QUIET_MS - 1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
});

it("a successful read clears the earlier missing-file quiet period", async () => {
	const r = await rig();
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	advanceClock(ADOPTION_QUIET_MS / 2);
	r.adapter.externalWrite(PATH, r.original);
	expect(await r.ink.adoptExternal(PDF_ID, () => true)).toMatchObject({ outcome: "adopted" });
	removeSidecar(r);
	advanceClock(ADOPTION_QUIET_MS / 2);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(ADOPTION_QUIET_MS - 1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([]);
	advanceClock(1);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
});

it("a successful adoption allows one notice in the next missing-file run", async () => {
	const r = await rig();
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE]);
	r.adapter.externalWrite(PATH, r.original);
	expect(await r.ink.adoptExternal(PDF_ID, () => true)).toMatchObject({ outcome: "adopted" });
	removeSidecar(r);
	await r.ink.adoptExternal(PDF_ID, () => true);
	advanceClock(ADOPTION_QUIET_MS);
	await r.ink.adoptExternal(PDF_ID, () => true);
	expect(r.notices).toEqual([MISSING_MESSAGE, MISSING_MESSAGE]);
});
