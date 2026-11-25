import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { mountOverlay, type MountedOverlay } from "../inline/mountRig.test.util";
import { noteCameras, setNoteCameraStore } from "../inline/NoteCamera";
import { resetTipModeForTest } from "../inline/TipMode";

/** Issue 66 rows: a note opening in an editor, and each try to put its remembered camera back, from both callers. */
const KEY = "handwriting:note-cameras";

function storeWith(cameras: Record<string, { zoom: number; left: number; top: number }>) {
	const kept: Record<string, unknown> = {};
	for (const [p, c] of Object.entries(cameras)) kept[p] = { ...c, at: 1 };
	const values = new Map<string, unknown>([[KEY, { v: 1, cameras: kept }]]);
	return { load: (key: string) => values.get(key) ?? null, save: (key: string, value: unknown) => void values.set(key, value) };
}

/** The commit's layout sinks stubbed, so the real commitCameraScale can run through to its success return. */
function commitReady(m: MountedOverlay): void {
	const o = m.o;
	const scroller = m.scrollDOM as unknown as { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number };
	scroller.scrollWidth = 64000;
	scroller.scrollHeight = 48000;
	o.pinchScaleNow = 1;
	o.cssScale = 1;
	o.scale = 1;
	o.prepareViewportLayout = () => true;
	o.restoreViewportLayout = vi.fn();
	o.viewportLayout = { width: 800, height: 600, baseTransform: "none", externalScale: 1, columnLocal: null };
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize", "applyViewportBox"]) o[name] = vi.fn();
	o.setViewportScroll = (left: number, top: number) => {
		scroller.scrollLeft = left;
		scroller.scrollTop = top;
	};
	o.syncBand = () => "none";
	o.firstSettleConsumer = () => false;
}

/** Measure requests the overlay makes, kept so the test runs their write by hand. */
function measures(m: MountedOverlay): Array<{ write?: () => unknown }> {
	const asked: Array<{ write?: () => unknown }> = [];
	(m.o.view as Record<string, unknown>).requestMeasure = (spec: { write?: () => unknown }) => void asked.push(spec);
	return asked;
}

/** Switch the mounted editor to another note, through the overlay's own update. */
function switchTo(m: MountedOverlay, path: string, focused = true): void {
	const view = m.o.view as { state: Record<string, unknown>; hasFocus: boolean };
	const info = { file: { path }, editor: {} };
	view.state = { ...view.state, field: () => info };
	view.hasFocus = focused;
	(m.o as { update(u: unknown): void }).update({ transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false, selectionSet: false, focusChanged: false, heightChanged: false });
}

const rows = (type: string) =>
	formatInlinePenTrace()
		.split("\n")
		.filter((line) => new RegExp(`ms {2}${type} `).test(line));

let mounted: MountedOverlay[] = [];
function mount(path: string): MountedOverlay {
	const m = mountOverlay(path);
	mounted.push(m);
	return m;
}

beforeEach(() => {
	resetTipModeForTest();
	noteCameras.clear();
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
});
afterEach(() => {
	for (const m of mounted) m.destroy();
	mounted = [];
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	noteCameras.clear();
	resetTipModeForTest();
});

describe("issue 66 note-open row", () => {
	it("a note switch writes one row: camera remembered for the target, and editor focus, with no path", () => {
		const m = mount("pen66/first.md");
		setNoteCameraStore(storeWith({ "pen66/second.md": { zoom: 1, left: 0, top: 900 } }));
		measures(m);
		clearInlinePenTrace();
		switchTo(m, "pen66/second.md", false);
		const got = rows("note-open");
		expect(got, "note-open rows for one switch").toHaveLength(1);
		expect(got[0]).toContain("via switch: camera remembered=yes, editor focused=no");
		expect(got[0], "no note path in the row").not.toMatch(/pen66|second|\.md/);
	});

	it("a switch to a note with no remembered camera says so", () => {
		const m = mount("pen66/first.md");
		setNoteCameraStore(storeWith({}));
		clearInlinePenTrace();
		switchTo(m, "pen66/third.md", true);
		expect(rows("note-open")).toEqual([expect.stringContaining("via switch: camera remembered=no, editor focused=yes")]);
	});

	it("a mount writes the same row, named as a mount", () => {
		setNoteCameraStore(storeWith({}));
		mount("pen66/mounted.md");
		const got = rows("note-open");
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("via mount: camera remembered=no, editor focused=yes");
	});
});

describe("issue 66 camera-restore row", () => {
	function armedSwitch(camera: { zoom: number; left: number; top: number }) {
		const m = mount("pen66/a.md");
		setNoteCameraStore(storeWith({ "pen66/b.md": camera }));
		const asked = measures(m);
		switchTo(m, "pen66/b.md");
		commitReady(m);
		clearInlinePenTrace();
		const restore = asked.find((spec) => spec.write);
		expect(restore, "the switch asked for a measure to restore the camera").toBeDefined();
		return { m, run: () => restore!.write!() };
	}

	it("the measure caller: a restore that commits writes restored", () => {
		const { m, run } = armedSwitch({ zoom: 1, left: 0, top: 900 });
		run();
		expect(m.scrollDOM.scrollTop, "the camera came back").toBe(900);
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from measure: restored")]);
	});

	it("the measure caller: a commit the camera refuses writes refused, still armed", () => {
		const { m, run } = armedSwitch({ zoom: 1, left: 0, top: 900 });
		m.o.commitCameraScale = () => false;
		run();
		expect(m.o.noteCameraRestore, "still armed").toBe("pen66/b.md");
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from measure: refused, still armed")]);
	});

	it("the measure caller: a page scrolled before the measure drops the restore and says why", () => {
		const { m, run } = armedSwitch({ zoom: 1, left: 0, top: 900 });
		m.scrollDOM.scrollTop = 40;
		run();
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from measure: dropped (scrolled already)")]);
	});

	it("the measure caller: a zoomed camera on a canvas-off note is dropped and says why", () => {
		const { m, run } = armedSwitch({ zoom: 2, left: 0, top: 900 });
		m.o.canvasMode = false;
		run();
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from measure: dropped (canvas off, zoomed camera)")]);
	});

	it("the measure caller: nothing armed any more writes skipped", () => {
		const { m, run } = armedSwitch({ zoom: 1, left: 0, top: 900 });
		m.o.noteCameraRestore = null;
		run();
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from measure: skipped")]);
	});

	it("the ink-read caller writes its own row once the note's ink has loaded", async () => {
		const m = mount("pen66/c.md");
		setNoteCameraStore(storeWith({ "pen66/d.md": { zoom: 1, left: 0, top: 700 } }));
		const asked = measures(m);
		switchTo(m, "pen66/d.md");
		commitReady(m);
		expect(asked.some((spec) => spec.write), "armed").toBe(true);
		clearInlinePenTrace();
		await vi.waitFor(() => expect(rows("camera-restore").length).toBeGreaterThan(0));
		expect(rows("camera-restore")).toEqual([expect.stringContaining("from ink read: restored")]);
		expect(m.scrollDOM.scrollTop).toBe(700);
	});
});
