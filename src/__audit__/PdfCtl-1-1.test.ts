/**
 * Audit probe PdfCtl-1-1: the PDF strip's pen/highlighter size slider, on
 * release (commit = true), must reach the persist hook the note strip reaches
 * (InkOverlay.ts:2954-2956), so the size lands in data.json and survives a
 * restart. Harness copied from src/pdf/PdfEraserModePersists.test.ts: the
 * real PdfInkController mounts, its `buildTools` spec is captured from the
 * MobileTools constructor, and the spec's own closure is driven.
 *
 * Asserts CORRECT behaviour: red only if the PDF host drops `commit`.
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

const captured = vi.hoisted(() => ({
	spec: null as null | {
		setInkSizeMult: (tool: string, mult: number, commit: boolean) => void;
		setEraserRadiusPx: (px: number, commit: boolean) => void;
	},
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
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "../pdf/PdfInkController";
import HandwritingPlugin from "../main";
import {
	applyInkSize,
	getInkSizeMult,
	setInkSizeMult,
	setPersistInkSize,
} from "../inline/InkOverlay";
import { resetPenToolsForTest, setPenToolsMode } from "../inline/PenToolsMode";

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

function fakePlugin(raw: unknown): Record<string, unknown> {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	// data.json as it is now: persistSettings reads the file before each
	// write and merges this device's changes over it.
	plugin.loadData = (): Promise<unknown> => {
		const saves = plugin.saves as unknown[];
		return Promise.resolve(saves.length > 0 ? JSON.parse(JSON.stringify(saves[saves.length - 1])) : raw);
	};
	plugin.saves = [] as unknown[];
	plugin.saveData = (data: Record<string, unknown>): Promise<void> => {
		(plugin.saves as unknown[]).push(JSON.parse(JSON.stringify(data)));
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

const pluginProto = HandwritingPlugin.prototype as unknown as {
	loadSettings(this: unknown): Promise<void>;
};

describe("PdfCtl-1-1: pdf strip size slider release persists like the note strip", () => {
	let open: PdfInkController[] = [];

	beforeEach(() => {
		resetPenToolsForTest();
		platform.isMobileApp = false;
		captured.spec = null;
		open = [];
		setPenToolsMode("show");
		setInkSizeMult("pen", 1);
		setInkSizeMult("highlighter", 1);
		setPersistInkSize(null);
	});

	afterEach(() => {
		for (const c of open) c.unmount();
		setInkSizeMult("pen", 1);
		setInkSizeMult("highlighter", 1);
		setPersistInkSize(null);
	});

	it("slider release (commit=true) on the pdf host fires the persist hook", () => {
		const controller = makeController();
		controller.mount();
		open.push(controller);
		if (!captured.spec) throw new Error("buildTools never ran - no strip spec captured");

		const persisted: Array<[string, number]> = [];
		setPersistInkSize((tool, mult) => persisted.push([tool, mult]));

		captured.spec.setInkSizeMult("pen", 1.5, true);
		// Precondition: the in-memory size DID change (the drag works this session).
		expect(getInkSizeMult("pen"), "precondition: in-memory pen size changed").toBe(1.5);

		captured.spec.setInkSizeMult("highlighter", 0.5, true);
		expect(getInkSizeMult("highlighter"), "precondition: in-memory hl size changed").toBe(0.5);

		expect(persisted, "pdf slider release never reached persistInkSize").toEqual([
			["pen", 1.5],
			["highlighter", 0.5],
		]);
	});

	it("round trip through the real loadSettings hook: the pdf-chosen size reaches data.json and survives restart", async () => {
		const g2 = globalThis as unknown as { document?: unknown };
		g2.document ??= {
			body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } },
		};

		// Mount first (as PdfEraserModePersists.test.ts does): loadSettings applies
		// the default pen-tools mode, which would hide the strip at a later mount.
		const controller = makeController();
		controller.mount();
		open.push(controller);
		if (!captured.spec) throw new Error("buildTools never ran - no strip spec captured");

		// The real loadSettings registers main.ts's persistInkSize hook (main.ts:5438-5441).
		const first = fakePlugin({ inkSizes: { pen: 1, highlighter: 1 } });
		await pluginProto.loadSettings.call(first);
		const settings = first.settings as { inkSizes: { pen: number; highlighter: number } };
		expect(settings.inkSizes.pen).toBe(1);

		// CONTROL: the documented set+persist road (applyInkSize) reaches a save,
		// so the hook is live in this harness and a red below is not setup.
		applyInkSize("highlighter", 1.2);
		// The save reads data.json first, so it lands after the write chain settles.
		await (first.settingsWriting as Promise<void> | null);
		const saves = first.saves as Array<{ inkSizes: { pen: number; highlighter: number } }>;
		expect(saves.length, "control: applyInkSize never reached saveData - harness broken").toBeGreaterThan(0);
		expect(saves[saves.length - 1]!.inkSizes.highlighter).toBe(1.2);
		const savesBefore = saves.length;

		// Trigger: drag the pdf strip's Pen size slider and release.
		captured.spec.setInkSizeMult("pen", 1.5, true);
		expect(getInkSizeMult("pen"), "precondition: in-memory pen size changed").toBe(1.5);
		await Promise.resolve();
		await (first.settingsWriting as Promise<void> | null);

		expect(settings.inkSizes.pen, "settings.inkSizes.pen not updated by the pdf slider release").toBe(1.5);
		expect(saves.length, "no saveData after the pdf slider release").toBeGreaterThan(savesBefore);
		const bytes = saves[saves.length - 1]!;
		expect(bytes.inkSizes.pen, "data.json would not hold the pdf-chosen pen size").toBe(1.5);

		// Restart: the saved bytes back through the real loadSettings.
		setInkSizeMult("pen", 1);
		const second = fakePlugin(JSON.parse(JSON.stringify(bytes)));
		await pluginProto.loadSettings.call(second);
		expect(getInkSizeMult("pen"), "restart reverted the pdf-chosen pen size").toBe(1.5);
	});
});
