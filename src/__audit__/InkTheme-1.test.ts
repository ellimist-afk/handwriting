/**
 * AUDIT PROBE InkTheme-1 (1.4.21, 1a05f62c). Verifier, lens EXECUTION.
 *
 * Claim: a nib size set with the size slider on the PDF strip or the slides
 * strip is never saved. The slider's change event (MobileTools.ts:2221) calls
 * host.setInkSizeMult(tool, mult, true). The note host persists on that flag
 * (InkOverlay.ts:2954-2957); the PDF host (PdfInkController.ts:1154-1157)
 * drops it with `void commit;`, and the slides host (SlidesTools.ts:80) takes
 * no flag. So settings.inkSizes never changes and main.ts:5494 restores the
 * old size at the next load.
 *
 * Harness: the one PdfEraserModePersists.test.ts uses. MobileTools is mocked
 * only to CAPTURE the spec each REAL host builds (PdfInkController.buildTools,
 * SlidesTools.buildSlidesTools); the host closures under test are production
 * code. The persist hook is the REAL one main.ts registers inside the REAL
 * loadSettings; the restart is a second REAL loadSettings over the saved bytes.
 *
 * Asserts the CORRECT behaviour (the size the user released on is in data.json
 * and survives a restart). Control arm: applyInkSize (the preset/command road)
 * through the same rig must persist and survive, so a red on the strip arms is
 * the strip host, not the rig.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMobileApp: false }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Platform: {
			...(actual.Platform as Record<string, unknown>),
			get isMobileApp(): boolean {
				return platform.isMobileApp;
			},
		},
	};
});

type SizeSpec = {
	setInkSizeMult: (tool: string, mult: number, commit: boolean) => void;
	inkSizeMult: (tool: string) => number;
};
/** Every spec a real host hands MobileTools, in build order. */
const captured = vi.hoisted(() => ({ specs: [] as unknown[] }));
vi.mock("../inline/MobileTools", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class MobileTools {
		constructor(_root: unknown, spec: unknown) {
			captured.specs.push(spec);
		}
		setCorner(): void {}
		refresh(): void {}
		refreshNow(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		stale(): boolean {
			return false;
		}
		destroy(): void {}
	}
	return { ...actual, MobileTools };
});

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "../pdf/PdfInkController";
import { mountSlidesTools } from "../slides/SlidesTools";
import type { SlidesActions } from "../slides/SlidesActions";
import HandwritingPlugin from "../main";
import { applyInkSize, getInkSizeMult, setInkSizeMult, setPersistInkSize } from "../inline/InkOverlay";
import { resetPenToolsForTest, setPenToolsMode } from "../inline/PenToolsMode";

// ------------------------------------------------------------ PDF fixture
// PdfEraserModePersists.test.ts's makeController, verbatim in substance.
function fakeEl(): Record<string, unknown> {
	return {
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		setAttribute: () => {},
		setCssStyles: () => {},
		remove: () => {},
		parentElement: null as unknown,
	};
}
function makeController(): PdfInkController {
	const scroller: Record<string, unknown> = {
		scrollLeft: 0,
		scrollTop: 0,
		classList: { add: () => {}, remove: () => {} },
		querySelector: () => null,
		setCssStyles: () => {},
	};
	scroller.createDiv = (): Record<string, unknown> => {
		const el = fakeEl();
		el.parentElement = scroller;
		return el;
	};
	probe.current = {
		scroller,
		scaleFactor: 2,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
	};
	const root = {
		addEventListener: () => {},
		removeEventListener: () => {},
		setAttribute: () => {},
		hasAttribute: () => false,
	} as unknown as HTMLElement;
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { maxTouchPoints: 0, userAgent: "test" },
	};
	return new PdfInkController(root, win as unknown as Window, () => [], () => "doc-1", () => []);
}

// --------------------------------------------------------- slides fixture
function slidesParent(): HTMLElement {
	const statusEl = { setCssStyles: () => {}, textContent: "" };
	const root = {
		setCssStyles: () => {},
		querySelectorAll: () => [],
		createDiv: () => statusEl,
		remove: () => {},
	};
	return { createDiv: () => root } as unknown as HTMLElement;
}
function liveActions(): SlidesActions {
	return {
		ownerDocument: {} as Document,
		status: () =>
			({
				live: true,
				mutable: true,
				undoLabel: null,
				redoLabel: null,
				pendingGesture: false,
				currentCount: 0,
				totalCount: 0,
				revision: 0,
			}) as unknown as ReturnType<SlidesActions["status"]>,
		run: () => true,
		finishGesture: () => {},
		onChange: () => () => {},
	};
}

// ------------------------------------------------ real loadSettings rig
// PdfEraserModePersists.test.ts's fakePlugin, with every saveData snapshotted.
const pluginProto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
};
type FakePlugin = Record<string, unknown> & { saves: Array<Record<string, unknown>> };
function fakePlugin(raw: unknown): FakePlugin {
	const plugin = Object.create(HandwritingPlugin.prototype) as FakePlugin;
	plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
	plugin.saves = [];
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		plugin.saves.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
		return Promise.resolve();
	};
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.pdfStore = { attachHost: () => {} };
	plugin.app = { workspace: { onLayoutReady: () => {} } };
	plugin.applyPaperTo = () => {};
	plugin.applyPaper = () => {};
	plugin.applyBooxMode = () => {};
	return plugin;
}
const g = globalThis as unknown as Record<string, unknown>;
g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

/** What data.json holds now: the last write, or the file as loaded if none. */
function dataJson(p: FakePlugin, loaded: Record<string, unknown>): Record<string, unknown> {
	return p.saves.length ? p.saves[p.saves.length - 1]! : loaded;
}
/** Settings as they sit in data.json after the first load (the user's file). */
const START = 1;
const PICKED = 2.2;

/**
 * One whole session: load, apply `act`, then restart from the bytes on disk
 * and read the pen size the plugin comes back with.
 */
async function sessionThenRestart(act: () => void): Promise<{
	sessionPen: number;
	persistedPen: unknown;
	afterRestartPen: number;
}> {
	const first = fakePlugin({ inkSizes: { pen: START, highlighter: 1 } });
	await pluginProto.loadSettings.call(first);
	// Precondition: the real hook is registered and the load applied START.
	expect(getInkSizeMult("pen"), "rig: first load did not apply the stored size").toBe(START);
	const loadedBytes = JSON.parse(JSON.stringify(first.settings)) as Record<string, unknown>;
	act();
	await Promise.resolve();
	await Promise.resolve();
	const sessionPen = getInkSizeMult("pen");
	const bytes = dataJson(first, loadedBytes);
	const persistedPen = (bytes.inkSizes as Record<string, unknown> | undefined)?.pen;
	// Restart: fresh module value, then the real loadSettings over those bytes.
	setInkSizeMult("pen", 1);
	const second = fakePlugin(JSON.parse(JSON.stringify(bytes)));
	await pluginProto.loadSettings.call(second);
	return { sessionPen, persistedPen, afterRestartPen: getInkSizeMult("pen") };
}

describe("InkTheme-1: a nib size released on the PDF / slides strip survives a restart", () => {
	const unmounts: Array<() => void> = [];

	beforeEach(() => {
		resetPenToolsForTest();
		platform.isMobileApp = false;
		captured.specs.length = 0;
		setPenToolsMode("show"); // a strip at mount, no pen contact needed
		setPersistInkSize(null);
		setInkSizeMult("pen", 1);
		setInkSizeMult("highlighter", 1);
	});

	afterEach(() => {
		for (const u of unmounts.splice(0)) u();
		setPersistInkSize(null);
		setInkSizeMult("pen", 1);
		setInkSizeMult("highlighter", 1);
	});

	it("CONTROL: the preset/command road (applyInkSize) persists and survives through the same rig", async () => {
		const r = await sessionThenRestart(() => applyInkSize("pen", PICKED));
		expect(r.sessionPen).toBe(PICKED);
		expect(r.persistedPen, "rig: applyInkSize did not reach data.json").toBe(PICKED);
		expect(r.afterRestartPen, "rig: restart did not re-apply the saved size").toBe(PICKED);
	});

	// The PDF strip's half of this probe is carried by the PDF lane (PdfCtl-1-1).

	it("slides strip: slider release setInkSizeMult('pen', 2.2, commit=true) is saved and survives restart", async () => {
		const off = mountSlidesTools(slidesParent(), liveActions(), {} as never, () => {}, () => {});
		unmounts.push(off);
		const spec = captured.specs[0] as SizeSpec | undefined;
		if (!spec) throw new Error("buildSlidesTools never ran - no strip spec captured");

		const r = await sessionThenRestart(() => spec.setInkSizeMult("pen", PICKED, true));
		expect(r.sessionPen, "precondition: the slides host did not apply the size").toBe(PICKED);
		expect(r.persistedPen, "slides strip size release never reached data.json (settings.inkSizes.pen)").toBe(
			PICKED
		);
		expect(r.afterRestartPen, "slides strip size lost at restart").toBe(PICKED);
	});
});
