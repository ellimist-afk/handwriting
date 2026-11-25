/**
 * The export page setting: white, as every export has always been, dark, or
 * matching Obsidian's theme at the moment of each export.
 *
 * Two exports paint a page of their own, and only those two answer to it:
 * "Export ink as PDF (drawing only)" and "Snip the selection to an image" on a
 * note. Dark puts one #1e1e1e rectangle under the whole PDF page, first, and
 * fills the note snip with the same colour; in both the ink is made readable on
 * that page, or left as drawn under "Keep original colors". White, and any
 * value this build does not know, writes what the writer wrote before the
 * setting existed.
 *
 * Everything runs through the real registered commands on a plugin built
 * without its constructor, so the setting is read where the export reads it:
 * the PDF bytes are the ones handed to the vault, and the snip is the real
 * snipSelection after the plugin's commands were registered.
 *
 * The white pins are sha256 hashes of the bytes the export command wrote at
 * 59703a92, the last writer without the setting, for three notes: a small one,
 * one past the page-size limit, and one with ink left of the origin. The dark
 * pins are the same three notes' bytes at a51b8996, where Dark landed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { HandwritingPlugin, HandwritingSettingTab } from "../main";
import { inlineInk, InkOverlayPlugin } from "../inline/InkOverlay";
import { contrastRatio, EXPORT_MIN_CONTRAST, relativeLuminance, resetInkTheme, setInkExportReadability } from "../ink/InkTheme";
import { DEFAULT_SETTINGS } from "../settings/SettingsModel";
import type { InkStroke } from "../ink/Stroke";
import { sha256 } from "../pdf/Sha256";

const DARK = "#1e1e1e";
const WHITE = "#ffffff";
const PEN_BLACK = "#000000";
/** The palette's near-white pen: the colour the dark theme draws with. */
const PEN_WHITE = "#f4f4f2";

type Settings = Record<string, unknown>;
type Command = { id: string; checkCallback(checking: boolean): boolean };

function line(id: string, color: string, tool: InkStroke["tool"], from: [number, number], to: [number, number]): InkStroke {
	const points = [
		{ x: from[0], y: from[1], pressure: 0.5, t: 0 },
		{ x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2 + 7, pressure: 0.5, t: 8 },
		{ x: to[0], y: to[1], pressure: 0.5, t: 16 },
	];
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const pad = tool === "highlighter" ? 9 : 2;
	return {
		id, tool, color, width: tool === "highlighter" ? 18 : 4, createdAt: 1, points,
		bbox: {
			x: Math.min(...xs) - pad, y: Math.min(...ys) - pad,
			width: Math.max(...xs) - Math.min(...xs) + 2 * pad, height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
		},
	};
}

/** A black pen over a yellow highlight. */
const SMALL = [line("h", "#ffd60a", "highlighter", [20, 40], [180, 46]), line("p", PEN_BLACK, "pen", [10, 20], [160, 60])];
/** Tall enough that the page needs a UserUnit of 2 (25,000 px is 18,750 pt; the limit is 14,400). */
const TALL = [line("t", PEN_BLACK, "pen", [30, 10], [60, 25000])];
/** Ink left of and above the origin, so the page starts before the note does. */
const NEGATIVE = [line("n", PEN_BLACK, "pen", [-40, -25], [70, 50])];

const NOTES = { small: SMALL, tall: TALL, negative: NEGATIVE } as const;

/** sha256 of the bytes the export command wrote at 59703a92 for each note. */
const BASE_SHA = {
	small: "576a990970fdebec3a50467c97c9e4a11068ec1f5c203943d488180630c7c606",
	tall: "05bb6d4624c6de0dd25aeebe7f763ea7aaa86b325d055dbfc344df0b5d595ca6",
	negative: "004237ada95f37b5e4b1b4957b97986e368bd1a1cc96694a85bccd4a5e79837a",
} as const;

/** sha256 of the bytes the export command wrote on the dark page at a51b8996 for each note. */
const DARK_SHA = {
	small: "04faca751e759920c7c3ad7481fb197e4e16b8f33a7998a8164ce4bc0edecdd5",
	tall: "63ed456716fbbb3055b8b2b0eb9f2fe49be1e65c7534cca22ed64deece1d5f40",
	negative: "79bf49d3a4e625ebc3977d6de237d58d3b9fd214db171b0f121c9739186118ec",
} as const;

/**
 * The ink colours the note snip set at 59703a92 for a near-white pen then a
 * black one: the near-white pen darkened for the white page, the black left.
 */
const SNIP_WHITE_INK: readonly string[] = ["#000000", "#000000", "#000000", "#000000"];

/** A plugin without its constructor, with its commands registered and the export surface stubbed. */
function pluginWith(settings: Settings, strokes: readonly InkStroke[] = []) {
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	const commands = new Map<string, Command>();
	plugin.addCommand = (command: Command) => {
		commands.set(command.id, command);
		return command;
	};
	plugin.settings = settings;
	const writes: Uint8Array[] = [];
	let wrote!: (bytes: Uint8Array) => void;
	const written = new Promise<Uint8Array>((resolve) => (wrote = resolve));
	// Ask before the run for the bytes of the run's own write.
	const waiting: ((bytes: Uint8Array) => void)[] = [];
	const nextWrite = () => new Promise<Uint8Array>((resolve) => waiting.push(resolve));
	plugin.app = {
		workspace: { getActiveFile: () => ({ path: "note.md", extension: "md" }) },
		vault: {
			createBinary: async (_path: string, data: ArrayBuffer) => {
				const bytes = new Uint8Array(data.slice(0));
				writes.push(bytes);
				wrote(bytes);
				waiting.shift()?.(bytes);
				return {};
			},
		},
	};
	plugin.firstFreePath = async (candidate: (n: number) => string) => candidate(1);
	plugin.exportedStrokes = () => strokes;
	vi.spyOn(inlineInk, "strokes").mockReturnValue(strokes);
	(plugin as unknown as HandwritingPlugin).registerExportSelectionCommands();
	return { commands, written, writes, nextWrite };
}

function shaOf(bytes: Uint8Array): string {
	return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Obsidian's theme as an export sees it: the class Obsidian stamps on the
 * body. Each read of it is counted. The cleanup below takes the stub away.
 */
function inTheme(dark: boolean): { reads: number; set(dark: boolean): void } {
	const theme = {
		reads: 0,
		set(next: boolean): void {
			dark = next;
		},
	};
	const contains = (name: string): boolean => {
		theme.reads++;
		return dark && name === "theme-dark";
	};
	vi.stubGlobal("document", { body: { classList: { contains } } });
	return theme;
}

/** The PDF "Export ink as PDF (drawing only)" hands the vault, as text. */
async function exportPdf(settings: Settings, strokes: readonly InkStroke[]): Promise<{ text: string; sha: string }> {
	const { commands, written } = pluginWith(settings, strokes);
	const command = commands.get("export-ink-pdf");
	expect(command, "premise: the PDF export is registered").toBeDefined();
	expect(command!.checkCallback(false)).toBe(true);
	const bytes = await written;
	let text = "";
	for (const b of bytes) text += String.fromCharCode(b);
	return { text, sha: shaOf(bytes) };
}

function page(text: string): { w: string; h: string; unit: number; body: string } {
	const box = text.match(/\/MediaBox \[0 0 ([0-9.]+) ([0-9.]+)\]/);
	expect(box, "premise: the page has a MediaBox").not.toBeNull();
	const unit = text.match(/\/UserUnit ([0-9]+)/);
	const stream = text.match(/stream\n([\s\S]*?)\nendstream/);
	expect(stream, "premise: the page has a content stream").not.toBeNull();
	return { w: box![1]!, h: box![2]!, unit: unit ? Number(unit[1]) : 1, body: stream![1]! };
}

const PATH_OPS = new Set(["m", "l", "c", "v", "y", "re", "h"]);
const PAINT_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "n", "sh", "Do", "BT"]);

/**
 * The first thing the content stream paints: its operator, the path it paints,
 * the fill colour then in force, and whether any `cm` came before it (with
 * none, the path is in the MediaBox's own units).
 */
function firstPaint(body: string) {
	const operands: string[] = [];
	const path: { op: string; args: string[] }[] = [];
	let fill: string[] | null = null;
	let transformed = false;
	for (const t of body.trim().split(/\s+/)) {
		if (/^-?[0-9.]+$/.test(t) || t.startsWith("/")) {
			operands.push(t);
			continue;
		}
		const args = operands.splice(0);
		if (t === "rg") fill = args;
		else if (t === "cm") transformed = true;
		else if (PATH_OPS.has(t)) path.push({ op: t, args });
		else if (PAINT_OPS.has(t)) return { op: t, path, fill, transformed };
	}
	return null;
}

/** Every fill colour the stream sets, in order, as hex. */
function fills(body: string): string[] {
	const out: string[] = [];
	const re = /(-?[0-9.]+) (-?[0-9.]+) (-?[0-9.]+) rg/g;
	for (let m = re.exec(body); m; m = re.exec(body)) out.push(hex([m[1]!, m[2]!, m[3]!]));
	return out;
}

function hex(rgb: readonly string[]): string {
	return "#" + rgb.map((v) => Math.round(Number(v) * 255).toString(16).padStart(2, "0")).join("");
}

function lum(color: string): number {
	const n = Number.parseInt(color.slice(1), 16);
	return relativeLuminance((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

function expectDarkPage(text: string): void {
	const { w, h, body } = page(text);
	const first = firstPaint(body);
	expect(first, "the page paints something").not.toBeNull();
	expect(first!.op, "the first paint is a fill").toBe("f");
	expect(first!.path, "the first fill is one rectangle covering the whole MediaBox").toEqual([{ op: "re", args: ["0", "0", w, h] }]);
	expect(first!.transformed, "no transform before the page rectangle: it is in the MediaBox's units").toBe(false);
	expect(first!.fill && hex(first!.fill), "the page rectangle is #1e1e1e").toBe(DARK);
}

/** The real note snipSelection on an unmounted overlay, with a context that records every colour set. */
async function snip(strokes: InkStroke[]) {
	const log: { op: string; prop?: string; value?: unknown }[] = [];
	const target: Record<string, unknown> = {};
	const ctx = new Proxy(target, {
		get: (_t, prop: string) => (prop in target ? target[prop] : () => void log.push({ op: prop })),
		set: (_t, prop: string, value) => {
			target[prop] = value;
			if (prop === "fillStyle" || prop === "strokeStyle") log.push({ op: "set", prop, value });
			return true;
		},
	});
	vi.stubGlobal("createEl", () => ({
		width: 0, height: 0,
		getContext: () => ctx,
		toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
	}));
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	overlay.selection = { isEmpty: false };
	overlay.selectionBounds = () => ({ x: 8, y: 8, width: 160, height: 60 });
	overlay.strokesHere = () => strokes;
	Object.defineProperty(overlay, "winRef", { value: { devicePixelRatio: 1 } });
	const result = await (overlay as unknown as InkOverlayPlugin).snipSelection();
	expect(result.ok, "premise: the snip produced an image").toBe(true);
	const at = log.findIndex((e) => e.op === "fillRect");
	expect(at, "premise: the snip fills its page").toBeGreaterThan(-1);
	const before = [...log.slice(0, at)].reverse().find((e) => e.op === "set" && e.prop === "fillStyle");
	const ink = log.slice(at + 1).filter((e) => e.op === "set").map((e) => cssHex(e.value));
	return { fill: cssHex(before?.value), ink, fillRects: log.filter((e) => e.op === "fillRect").length };
}

function cssHex(css: unknown): string {
	const s = String(css).trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(s)) return s;
	const m = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (!m) throw new Error(`unreadable colour ${s}`);
	return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	resetInkTheme();
});

describe("Export ink as PDF (drawing only), on a dark page", () => {
	it("paints one #1e1e1e rectangle over the whole page before anything else", async () => {
		const { text } = await exportPdf({ exportPage: "dark" }, SMALL);
		expect(page(text).unit, "premise: a page inside the size limit").toBe(1);
		expectDarkPage(text);
	});

	it("covers the whole page past the page-size limit, where the page carries a UserUnit", async () => {
		const { text } = await exportPdf({ exportPage: "dark" }, TALL);
		expect(page(text).unit, "premise: the page is past the limit").toBe(2);
		expectDarkPage(text);
	});

	it("covers the whole page when the ink starts left of and above the origin", async () => {
		const { text } = await exportPdf({ exportPage: "dark" }, NEGATIVE);
		expect(page(text).body, "premise: the ink is moved onto the page").toMatch(/q 1 0 0 1 [0-9.]+ -?[0-9.]+ cm/);
		expectDarkPage(text);
	});

	it("writes a black pen in a colour that reads on the dark page, and as drawn under Keep original colors", async () => {
		const pen = [line("p", PEN_BLACK, "pen", [10, 20], [160, 60])];
		const readable = fills(page((await exportPdf({ exportPage: "dark" }, pen)).text).body);
		expect(readable[0], "premise: the page is the first colour set").toBe(DARK);
		const ink = readable.slice(1);
		expect(ink, "premise: the pen set its colour").toHaveLength(1);
		expect(ink[0], "the black pen is not left black on the dark page").not.toBe(PEN_BLACK);
		expect(contrastRatio(lum(ink[0]!), lum(DARK)), `pen colour ${ink[0]} reads on ${DARK}`).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);

		setInkExportReadability(false);
		const kept = (await exportPdf({ exportPage: "dark" }, pen)).text;
		expectDarkPage(kept);
		expect(fills(page(kept).body), "under Keep original colors the pen stays black, on the same dark page").toEqual([DARK, PEN_BLACK]);
	});
});

describe("Snip the selection to an image, on a note, on a dark page", () => {
	it("fills #1e1e1e under the ink and makes the ink readable on it", async () => {
		pluginWith({ exportPage: "dark" });
		const { fill, ink, fillRects } = await snip([line("b", PEN_BLACK, "pen", [10, 20], [160, 60])]);
		expect(fill, "the snip's page is #1e1e1e").toBe(DARK);
		expect(fillRects, "one page fill, before the ink").toBeGreaterThan(0);
		expect(ink.length, "premise: the ink set a colour").toBeGreaterThan(0);
		for (const c of ink) {
			expect(contrastRatio(lum(c), lum(DARK)), `ink colour ${c} reads on ${DARK}`).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		}
	});
});

describe("White, and a missing or unknown value, write what the writer wrote before the setting", () => {
	for (const [label, settings] of [
		["white", { exportPage: "white" }],
		["missing", {}],
		["unknown", { exportPage: "purple" }],
		["not a string", { exportPage: 1 }],
	] as const) {
		for (const name of Object.keys(NOTES) as (keyof typeof NOTES)[]) {
			it(`${label}: the ${name} note's PDF is the base writer's bytes`, async () => {
				const { sha } = await exportPdf(settings, NOTES[name]);
				expect(sha).toBe(BASE_SHA[name]);
			});
		}

		it(`${label}: the note snip fills white and adapts the ink to white`, async () => {
			pluginWith(settings);
			const shot = await snip([line("w", PEN_WHITE, "pen", [10, 20], [160, 60]), line("b", PEN_BLACK, "pen", [10, 40], [160, 70])]);
			expect(shot.fill).toBe(WHITE);
			expect(shot.ink).toEqual(SNIP_WHITE_INK);
		});
	}
});

describe("Dark writes what it wrote when it landed", () => {
	for (const name of Object.keys(NOTES) as (keyof typeof NOTES)[]) {
		it(`the ${name} note's dark PDF is the landed bytes`, async () => {
			expect((await exportPdf({ exportPage: "dark" }, NOTES[name])).sha).toBe(DARK_SHA[name]);
		});
	}
});

describe("Match theme: each export takes the page of Obsidian's theme at that moment", () => {
	for (const name of Object.keys(NOTES) as (keyof typeof NOTES)[]) {
		it(`in a dark theme, the ${name} note's PDF is Dark's bytes`, async () => {
			inTheme(true);
			const dark = await exportPdf({ exportPage: "dark" }, NOTES[name]);
			expect(dark.sha, "premise: Dark writes its landed bytes in a dark theme too").toBe(DARK_SHA[name]);
			expect((await exportPdf({ exportPage: "theme" }, NOTES[name])).sha).toBe(dark.sha);
		});

		it(`in a light theme, the ${name} note's PDF is White's bytes`, async () => {
			inTheme(false);
			expect((await exportPdf({ exportPage: "theme" }, NOTES[name])).sha).toBe(BASE_SHA[name]);
		});
	}

	const PENS = () => [line("w", PEN_WHITE, "pen", [10, 20], [160, 60]), line("b", PEN_BLACK, "pen", [10, 40], [160, 70])];

	it("in a dark theme, the note snip is Dark's: the #1e1e1e fill and Dark's ink colours", async () => {
		inTheme(true);
		pluginWith({ exportPage: "dark" });
		const dark = await snip(PENS());
		expect(dark.fill, "premise: Dark fills #1e1e1e in a dark theme too").toBe(DARK);
		pluginWith({ exportPage: "theme" });
		const shot = await snip(PENS());
		expect(shot.fill).toBe(DARK);
		expect(shot.ink).toEqual(dark.ink);
		expect(shot.fillRects).toBe(dark.fillRects);
	});

	it("in a light theme, the note snip is White's: a white fill and the ink adapted to white", async () => {
		inTheme(false);
		pluginWith({ exportPage: "theme" });
		const shot = await snip(PENS());
		expect(shot.fill).toBe(WHITE);
		expect(shot.ink).toEqual(SNIP_WHITE_INK);
	});

	it("reads the theme once at each export, so a theme change holds from the next export", async () => {
		const theme = inTheme(true);
		const { commands, nextWrite } = pluginWith({ exportPage: "theme" }, SMALL);
		const command = commands.get("export-ink-pdf")!;

		let wrote = nextWrite();
		theme.reads = 0;
		expect(command.checkCallback(false)).toBe(true);
		expect(shaOf(await wrote), "the first PDF, in a dark theme, is Dark's").toBe(DARK_SHA.small);
		expect(theme.reads, "one theme read for the PDF export").toBe(1);

		theme.set(false);
		wrote = nextWrite();
		theme.reads = 0;
		expect(command.checkCallback(false)).toBe(true);
		expect(shaOf(await wrote), "the next PDF, after a switch to a light theme, is White's").toBe(BASE_SHA.small);
		expect(theme.reads, "one theme read for the next PDF export").toBe(1);

		theme.set(true);
		theme.reads = 0;
		expect((await snip(PENS())).fill, "the snip, back in a dark theme, is Dark's").toBe(DARK);
		expect(theme.reads, "one theme read for the snip").toBe(1);
		theme.set(false);
		theme.reads = 0;
		expect((await snip(PENS())).fill, "the next snip, in a light theme, is White's").toBe(WHITE);
		expect(theme.reads, "one theme read for the next snip").toBe(1);
	});
});

describe("the export page setting", () => {
	function tab(settings: Settings) {
		const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
		plugin.manifest = { version: "1.5.2" };
		plugin.settings = { booxMode: false, extendCanvasWhileScrolling: false, ...settings };
		plugin.removeCommand = undefined;
		plugin.app = { commands: {} };
		plugin.saveSettingsNow = () => undefined;
		const t = Object.create(HandwritingSettingTab.prototype) as {
			plugin: { settings: Settings };
			getSettingDefinitions(): Row[];
			getControlValue(key: string): unknown;
			setControlValue(key: string, value: unknown): void;
		};
		t.plugin = plugin as never;
		return t;
	}
	type Row = { name?: string; desc?: string; heading?: string; items?: Row[]; control?: { type: string; key: string; options?: Record<string, string> } };

	it("is a White, Dark or Match theme dropdown in the Export group, white by default, and anything unknown reads white", () => {
		expect(DEFAULT_SETTINGS.exportPage, "the default is white").toBe("white");
		const t = tab({});
		const exportGroup = t.getSettingDefinitions().find((row) => row.heading === "Export");
		expect(exportGroup, "premise: an Export group").toBeDefined();
		const row = exportGroup!.items!.find((item) => item.control?.key === "exportPage");
		expect(row, "the Export group has the page row").toBeDefined();
		expect(row!.control).toEqual({
			type: "dropdown", key: "exportPage", options: { white: "White", dark: "Dark", theme: "Match theme" },
		});
		expect(row!.name).toBe("Page color when exporting");

		expect(t.getControlValue("exportPage"), "missing reads white").toBe("white");
		t.setControlValue("exportPage", "dark");
		expect(t.plugin.settings.exportPage).toBe("dark");
		expect(t.getControlValue("exportPage")).toBe("dark");
		t.setControlValue("exportPage", "purple");
		expect(t.plugin.settings.exportPage, "an unknown choice is stored as white").toBe("white");
		expect(tab({ exportPage: "purple" }).getControlValue("exportPage"), "a stored unknown value reads white").toBe("white");
	});

	it("stores Match theme as its own value and shows it back", () => {
		const t = tab({});
		t.setControlValue("exportPage", "theme");
		expect(t.plugin.settings.exportPage).toBe("theme");
		expect(t.getControlValue("exportPage")).toBe("theme");
		expect(tab({ exportPage: "theme" }).getControlValue("exportPage"), "a stored Match theme reads back").toBe("theme");
	});
});
