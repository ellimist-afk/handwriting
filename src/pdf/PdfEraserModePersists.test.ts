/**
 * THE DEFECT: the PDF strip's eraser-mode chip writes the shared runtime
 * flag (`setEraserWholeStrokes`) but never calls `persistEraserMode`, the
 * note host's other half (InkOverlay.ts:1888-1891). A Reticle chosen from a
 * PDF changes the mode everywhere in-session but never reaches data.json, so
 * it silently reverts to Stroke on the next restart.
 *
 * THE FIX'S SHAPE, driven here rather than read: `buildTools` in
 * PdfInkController.ts owns its own `setEraserWholeStroke` closure, so the
 * spec handed to `MobileTools` is captured and called directly - the same
 * harness `PdfPenTools.test.ts` uses to reach this controller's strip.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

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

/** The spec `buildTools` hands `MobileTools` - captured, not counted. */
const captured = vi.hoisted(() => ({
	spec: null as null | { setEraserWholeStroke: (on: boolean) => void },
}));
vi.mock("../inline/MobileTools", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class MobileTools {
		constructor(_root: unknown, spec: unknown) {
			captured.spec = spec as typeof captured.spec;
		}
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		destroy(): void {}
	}
	return { ...actual, MobileTools };
});

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "./PdfInkController";
import HandwritingPlugin from "../main";
import {
	getEraserWholeStrokes,
	persistEraserModeNow,
	setEraserWholeStrokes,
	setPersistEraserMode,
} from "../inline/InkOverlay";
import { resetPenToolsForTest, setPenToolsMode } from "../inline/PenToolsMode";

const SCALE = 2;

/** Enough element for a strip mount and no more (PdfPenTools.test.ts's fixture). */
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
		scaleFactor: SCALE,
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
	return new PdfInkController(
		root,
		win as unknown as Window,
		() => [],
		() => "doc-1",
		() => []
	);
}

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

describe("a pdf's eraser-mode chip persists the same way a note's does", () => {
	let open: PdfInkController[] = [];

	beforeEach(() => {
		resetPenToolsForTest();
		platform.isMobileApp = false;
		captured.spec = null;
		open = [];
		setPenToolsMode("show"); // a strip at mount, no pen contact required
		setEraserWholeStrokes(true);
		setPersistEraserMode(null);
	});

	afterEach(() => {
		for (const c of open) c.unmount();
		setEraserWholeStrokes(true);
		setPersistEraserMode(null);
	});

	it("driving the pdf host's setEraserWholeStroke(false) fires the persist hook with false", () => {
		const controller = makeController();
		controller.mount();
		open.push(controller);
		if (!captured.spec) throw new Error("buildTools never ran - no strip spec captured");

		const persisted: boolean[] = [];
		setPersistEraserMode((on) => persisted.push(on));

		captured.spec.setEraserWholeStroke(false);

		expect(persisted, "the pdf chip changed the flag but never told the persist hook").toEqual([
			false,
		]);
		// Acceptance #4: this adds persistence, it does not move when the flag
		// takes effect - PdfInkController.ts:3354 reads it live either way.
		expect(getEraserWholeStrokes(), "the runtime flag still flips immediately").toBe(false);
	});

	it("the mode survives a round trip through the real loadSettings", async () => {
		const controller = makeController();
		controller.mount();
		open.push(controller);
		if (!captured.spec) throw new Error("buildTools never ran - no strip spec captured");

		const pluginProto = HandwritingPlugin.prototype as unknown as {
			loadSettings(this: unknown): Promise<void>;
			persistSettings(this: unknown): Promise<void>;
		};
		function fakePlugin(raw: unknown): Record<string, unknown> {
			const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
			plugin.loadData = (): Promise<unknown> => Promise.resolve(raw);
			plugin.saved = null;
			plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
				plugin.saved = data;
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
		const g2 = globalThis as unknown as { document?: unknown };
		g2.document ??= {
			body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
		};

		// Registered exactly as main.ts wires it (main.ts:4260-4263).
		const first = fakePlugin({});
		setPersistEraserMode((on) => {
			(first.settings as Record<string, unknown>).eraserMode = on ? "stroke" : "reticle";
			first.saved = { ...(first.settings as Record<string, unknown>) };
		});
		await pluginProto.loadSettings.call(first);
		expect((first.settings as Record<string, unknown>).eraserMode).toBe("stroke");

		captured.spec.setEraserWholeStroke(false);
		// A save reads the file before it writes, so it lands a tick later.
		for (let i = 0; i < 5; i++) {
			await (first.settingsWriting as Promise<void> | null);
			await Promise.resolve();
		}

		const bytes = first.saved as Record<string, unknown> | null;
		if (!bytes) throw new Error("the pdf chip's choice never reached a save");
		expect(bytes.eraserMode, "data.json would not hold the pdf-chosen mode").toBe("reticle");

		// The restart: those bytes back through the real loadSettings, the one
		// place `setEraserWholeStrokes` is called to APPLY a stored value.
		setEraserWholeStrokes(true);
		const second = fakePlugin(JSON.parse(JSON.stringify(bytes)));
		await pluginProto.loadSettings.call(second);
		expect((second.settings as Record<string, unknown>).eraserMode).toBe("reticle");
		expect(
			getEraserWholeStrokes(),
			"the restart re-applied stroke over the pdf-stored reticle"
		).toBe(false);
	});

	it("NEGATIVE CONTROL: setEraserWholeStrokes alone still does not persist, and the pairing persists exactly once", () => {
		// The note host's own pairing (InkOverlay.ts:1888-1891) is two calls,
		// not one. If persistence had been folded into `setEraserWholeStrokes`
		// itself (option (b), and the dangerous one - it is also the call
		// `loadSettings` makes to APPLY a stored value, main.ts:4352), this
		// first line alone would already persist.
		const persisted: boolean[] = [];
		setPersistEraserMode((on) => persisted.push(on));

		setEraserWholeStrokes(false);
		expect(
			persisted,
			"setEraserWholeStrokes alone persisted - loadSettings would now write on every startup"
		).toEqual([]);

		persistEraserModeNow(false);
		expect(persisted, "the note host's pairing must persist exactly once per click, not twice").toEqual(
			[false]
		);
	});
});
