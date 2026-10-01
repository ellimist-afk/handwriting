import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { decodePng } from "./pngInk";

declare const process: { env: Record<string, string | undefined> };

type LayerSize = { width: number; height: number };
type Layers = Record<string, LayerSize> & { tail: LayerSize };
type Snapshot = {
	full: { layers: Layers; origin: { x: number; y: number }; widthWrites: number; heightWrites: number };
	compact: { layers: Layers; origin: { x: number; y: number }; widthWrites: number; heightWrites: number };
	mismatch: number; ink: number; tailInk: number;
};
type Head = { from: { x: number; y: number }; to: { x: number; y: number }; hw: number; pressure?: number; highlighter?: boolean };
type Prediction = { fromX: number; fromY: number; points: { x: number; y: number }[]; width: number };
type Config = { width: number; height: number; backing: number; cssScale?: number; hostZoom?: boolean };

let browser: Browser, page: Page, bundleText: string;
const call = async <T>(name: string, ...args: unknown[]): Promise<T> => page.evaluate(({ name, args }) => (window as any).tailBackingPage[name](...args), { name, args });
const snapshot = () => call<Snapshot>("read");
const setup = (config: Config) => call<void>("setup", config);
const event = (head: Head | null, prediction: Prediction | null = null) => call<void>("event", head, prediction);
async function selectDsf(dsf: number): Promise<void> {
	await page.close();
	page = await browser.newPage({ viewport: { width: 1900, height: 900 }, deviceScaleFactor: dsf });
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addScriptTag({ content: bundleText });
}
async function compositorMismatch(): Promise<number> {
	const a = decodePng(await page.locator('[data-arm="full"]').screenshot());
	const b = decodePng(await page.locator('[data-arm="compact"]').screenshot());
	expect([b.width, b.height, b.channels]).toEqual([a.width, a.height, a.channels]);
	let mismatch = 0;
	for (let i = 0; i < a.px.length; i += a.channels) {
		for (let c = 0; c < a.channels; c++) if (a.px[i + c] !== b.px[i + c]) { mismatch++; break; }
	}
	return mismatch;
}

function pngDifference(fullPng: Uint8Array, compactPng: Uint8Array) {
	const a = decodePng(fullPng), b = decodePng(compactPng);
	expect([b.width, b.height, b.channels]).toEqual([a.width, a.height, a.channels]);
	const channels = Array<number>(a.channels).fill(0);
	let pixels = 0, minX = a.width, minY = a.height, maxX = -1, maxY = -1;
	const first: { x: number; y: number; full: number[]; compact: number[] }[] = [];
	for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
		const i = (y * a.width + x) * a.channels;
		let changed = false;
		for (let c = 0; c < a.channels; c++) if (a.px[i + c] !== b.px[i + c]) {
			channels[c] = (channels[c] ?? 0) + 1; changed = true;
		}
		if (!changed) continue;
		pixels++;
		minX = Math.min(minX, x); minY = Math.min(minY, y);
		maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
		if (first.length < 12) first.push({ x, y,
			full: Array.from(a.px.slice(i, i + a.channels)), compact: Array.from(b.px.slice(i, i + a.channels)) });
	}
	return { width: a.width, height: a.height, channels: a.channels, mismatchedPixels: pixels,
		mismatchedChannels: channels, bounds: pixels ? { minX, minY, maxX, maxY } : null, first };
}

async function screenGeometry() {
	return page.evaluate(() => {
		const dpr = window.devicePixelRatio;
		const describe = (root: HTMLElement) => {
			const tail = root.querySelector('[data-layer="tail"]') as HTMLCanvasElement;
			const rect = (el: Element) => {
				const r = el.getBoundingClientRect();
				return { x: r.x, y: r.y, left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
			};
			const css = (el: Element) => {
				const s = getComputedStyle(el);
				return { position: s.position, left: s.left, top: s.top, right: s.right, bottom: s.bottom,
					width: s.width, height: s.height, transform: s.transform, transformOrigin: s.transformOrigin,
					translate: s.translate, zoom: s.getPropertyValue("zoom"), opacity: s.opacity,
					visibility: s.visibility, clipPath: s.clipPath, filter: s.filter, imageRendering: s.imageRendering };
			};
			const rootRect = rect(root), tailRect = rect(tail);
			const deviceX = (tailRect.left - rootRect.left) * dpr;
			const deviceY = (tailRect.top - rootRect.top) * dpr;
			return { rootRect, rootCss: css(root), tailRect, tailCss: css(tail),
				bitmap: { width: tail.width, height: tail.height },
				deviceOrigin: { x: deviceX, y: deviceY, fractionX: deviceX - Math.round(deviceX), fractionY: deviceY - Math.round(deviceY) },
				bitmapToScreen: { x: tailRect.width * dpr / tail.width, y: tailRect.height * dpr / tail.height } };
		};
		return { dpr, full: describe(document.querySelector('[data-arm="full"]') as HTMLElement),
			compact: describe(document.querySelector('[data-arm="compact"]') as HTMLElement) };
	});
}

async function captureCompositorDiagnostic(directory: string): Promise<void> {
	mkdirSync(directory, { recursive: true });
	const full = page.locator('[data-arm="full"]'), compact = page.locator('[data-arm="compact"]');
	const originalGeometry = await screenGeometry();
	const originalFull = await full.screenshot(), originalCompact = await compact.screenshot();
	writeFileSync(join(directory, "original-full.png"), originalFull);
	writeFileSync(join(directory, "original-compact.png"), originalCompact);
	const saved = await page.evaluate(() => {
		const a = document.querySelector('[data-arm="full"]') as HTMLElement;
		const b = document.querySelector('[data-arm="compact"]') as HTMLElement;
		return { body: document.body.style.cssText, full: a.style.cssText, compact: b.style.cssText };
	});
	let sameFull: Uint8Array, sameCompact: Uint8Array;
	let sameGeometry: Awaited<ReturnType<typeof screenGeometry>>;
	try {
		await page.evaluate(() => {
			const a = document.querySelector('[data-arm="full"]') as HTMLElement;
			const b = document.querySelector('[data-arm="compact"]') as HTMLElement;
			document.body.style.display = "block";
			for (const root of [a, b]) { root.style.position = "absolute"; root.style.left = "0px"; root.style.top = "0px"; }
			a.style.visibility = "visible"; b.style.visibility = "hidden";
		});
		sameFull = await full.screenshot();
		await page.evaluate(() => {
			(document.querySelector('[data-arm="full"]') as HTMLElement).style.visibility = "hidden";
			(document.querySelector('[data-arm="compact"]') as HTMLElement).style.visibility = "visible";
		});
		sameGeometry = await screenGeometry();
		sameCompact = await compact.screenshot();
	} finally {
		await page.evaluate(styles => {
			document.body.style.cssText = styles.body;
			(document.querySelector('[data-arm="full"]') as HTMLElement).style.cssText = styles.full;
			(document.querySelector('[data-arm="compact"]') as HTMLElement).style.cssText = styles.compact;
		}, saved);
	}
	writeFileSync(join(directory, "same-slot-full.png"), sameFull!);
	writeFileSync(join(directory, "same-slot-compact.png"), sameCompact!);
	writeFileSync(join(directory, "diagnostic.json"), JSON.stringify({ browserVersion: browser.version(),
		original: { geometry: originalGeometry, difference: pngDifference(originalFull, originalCompact) },
		sameSlot: { geometry: sameGeometry, difference: pngDifference(sameFull!, sameCompact!) } }, null, 2));
}

beforeAll(async () => {
	const entry = fileURLToPath(new URL("./tailBackingPage.ts", import.meta.url));
	const nodeModules = process.env.HW_TAIL_TEST_NODE_MODULES;
	const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
		nodePaths: nodeModules ? [nodeModules] : undefined,
		alias: { obsidian: fileURLToPath(new URL("./iphoneObsidianStub.ts", import.meta.url)) } });
	bundleText = bundle.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 1900, height: 900 }, deviceScaleFactor: 1.5 });
	await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
	await page.addScriptTag({ content: bundleText });
}, 120_000);
afterAll(async () => { await browser?.close(); });

const little: Head = { from: { x: 50, y: 50 }, to: { x: 66, y: 61 }, hw: 4 };
const longPrediction: Prediction = { fromX: 66, fromY: 61, points: [{ x: 135, y: 82 }, { x: 220, y: 90 }], width: 8 };
const pane: Config = { width: 800, height: 500, backing: 1.5 };
// Away from the band corner, so the compact tile sits at a non-zero origin.
const away: Head = { from: { x: 400, y: 250 }, to: { x: 416, y: 261 }, hw: 4 };
const awayPrediction: Prediction = { fromX: 416, fromY: 261, points: [{ x: 485, y: 282 }, { x: 570, y: 290 }], width: 8 };

describe("live tail bitmap pixels against the full-surface arm", () => {
	it("keeps a nonempty head and prediction byte-identical with the four unchanged layers", async () => {
		await setup(pane);
		await event(little, longPrediction);
		const s = await snapshot();
		expect(s.tailInk, "head/prediction fixture drew no tail pixels").toBeGreaterThan(0);
		expect(s.ink).toBeGreaterThan(s.tailInk);
		expect(s.mismatch, "same-browser composited pixel difference").toBe(0);
		expect(await compositorMismatch(), "browser compositor differs with head and prediction").toBe(0);
		for (const name of ["committed", "wet", "highlight", "highlightWet"]) {
			expect(s.compact.layers[name]).toEqual({ width: 1200, height: 750 });
			expect(s.compact.layers[name]).toEqual(s.full.layers[name]);
		}
	});

	it("uses a genuinely smaller current-event bitmap on a compact head", async () => {
		await setup(pane);
		await event(away);
		const s = await snapshot();
		expect(s.tailInk).toBeGreaterThan(0);
		expect(s.mismatch).toBe(0);
		const diagnosticDir = process.env.HW_TAIL_DIAG_DIR;
		if (diagnosticDir) await captureCompositorDiagnostic(diagnosticDir);
		expect(await compositorMismatch(), "browser compositor differs with compact head").toBe(0);
		expect(s.compact.layers.tail.width * s.compact.layers.tail.height,
		"the actual live canvas stayed full-sized").toBeLessThan(s.full.layers.tail.width * s.full.layers.tail.height);
		expect(s.compact.origin.x).toBeGreaterThan(0);
		expect(s.compact.origin.y).toBeGreaterThan(0);
		expect(s.compact.origin.x * pane.backing).toBeCloseTo(Math.round(s.compact.origin.x * pane.backing), 9);
		expect(s.compact.origin.y * pane.backing).toBeCloseTo(Math.round(s.compact.origin.y * pane.backing), 9);
	});

	it("covers prediction extension, wide highlighter, jumps, and viewport edges", async () => {
		await setup(pane);
		for (const [head, prediction] of [
			[little, null],
			[little, longPrediction],
			[{ from: { x: 220, y: 90 }, to: { x: 790, y: 490 }, hw: 18, highlighter: true }, null],
			[{ from: { x: 790, y: 490 }, to: { x: 1, y: 1 }, hw: 12 }, null],
		] as [Head, Prediction | null][]) {
			await event(head, prediction);
			const s = await snapshot();
			expect(s.tailInk).toBeGreaterThan(0);
			expect(s.mismatch, `head ${JSON.stringify(head)} differs from full surface`).toBe(0);
			expect(await compositorMismatch(), `compositor differs at ${JSON.stringify(head)}`).toBe(0);
		}
	});

	it("keeps band carry, full UI chrome, and the next live head in phase", async () => {
		await setup({ ...pane, backing: 2 });
		await event(little, longPrediction);
		await call<void>("carry", 10.25, 5.5);
		let s = await snapshot();
		expect(s.tailInk).toBeGreaterThan(0);
		expect(s.mismatch, "carry shifted one bitmap differently").toBe(0);
		expect(await compositorMismatch(), "compositor differs after carry").toBe(0);
		await call<void>("ui");
		s = await snapshot();
		expect(s.tailInk).toBeGreaterThan(0);
		expect(s.mismatch, "selection UI was clipped").toBe(0);
		expect(await compositorMismatch(), "compositor differs in selection UI").toBe(0);
		expect(s.compact.layers.tail).toEqual(s.full.layers.tail);
		await call<void>("clear");
		await event(little);
		s = await snapshot();
		expect(s.mismatch, "return to live ink differs").toBe(0);
		expect(await compositorMismatch(), "compositor differs on return to ink").toBe(0);
	});

	it("keeps fractional backing and low zoom counter-scale pixels", async () => {
		for (const config of [
			{ width: 680, height: 360, backing: 1.25, cssScale: 0.3, hostZoom: false },
			{ width: 680, height: 360, backing: 2.5, cssScale: 0.3, hostZoom: true },
		]) {
			await setup(config);
			await event(little, longPrediction);
			const s = await snapshot();
			expect(s.tailInk).toBeGreaterThan(0);
			expect(s.mismatch, `pixel difference at ${JSON.stringify(config)}`).toBe(0);
			expect(await compositorMismatch(), `compositor difference at ${JSON.stringify(config)}`).toBe(0);
		}
	});

	it("keeps translated compact pixels aligned in an RTL host", async () => {
		await setup(pane);
		await call<void>("rtl");
		await event(away, awayPrediction);
		const geometry = await screenGeometry();
		const inlineStyle = await call<{ left: string; top: string; right: string; bottom: string; translate: string }>("tailInlineStyle");
		expect(inlineStyle.left).toBe("0px");
		expect(inlineStyle.top).toBe("0px");
		expect(inlineStyle.right).toBe("auto");
		expect(inlineStyle.bottom).toBe("auto");
		expect(inlineStyle.translate).not.toBe("none");
		expect(geometry.compact.deviceOrigin.fractionX).toBeCloseTo(0, 6);
		expect(geometry.compact.deviceOrigin.fractionY).toBeCloseTo(0, 6);
		expect((await snapshot()).mismatch, "RTL backing pixels differ").toBe(0);
		expect(await compositorMismatch(), "RTL compositor pixels differ").toBe(0);
	});

	it("keeps an aligned compact carry and dirty clear in phase", async () => {
		await setup({ ...pane, backing: 2 });
		await event(little, longPrediction);
		const before = await snapshot();
		const beforeAlpha = await call<{ full: number; compact: number }>("tailAlpha");
		expect(beforeAlpha.full).toBeGreaterThan(0);
		expect(beforeAlpha.compact).toBeGreaterThan(0);
		expect(before.compact.layers.tail.width * before.compact.layers.tail.height)
			.toBeLessThan(before.full.layers.tail.width * before.full.layers.tail.height);
		await call<void>("carry", 12, 6);
		const carried = await snapshot();
		expect(carried.full.layers.tail).toEqual(before.full.layers.tail);
		expect(carried.compact.layers.tail).toEqual(before.compact.layers.tail);
		expect(carried.full.widthWrites).toBe(before.full.widthWrites);
		expect(carried.full.heightWrites).toBe(before.full.heightWrites);
		expect(carried.compact.widthWrites).toBe(before.compact.widthWrites);
		expect(carried.compact.heightWrites).toBe(before.compact.heightWrites);
		expect(carried.compact.origin.x - before.compact.origin.x).toBe(12);
		expect(carried.compact.origin.y - before.compact.origin.y).toBe(6);
		expect(carried.mismatch, "aligned carry shifted one bitmap differently").toBe(0);
		expect(await compositorMismatch(), "compositor differs after aligned carry").toBe(0);
		const carriedAlpha = await call<{ full: number; compact: number }>("tailAlpha");
		expect(carriedAlpha.full).toBeGreaterThan(0);
		expect(carriedAlpha.compact).toBeGreaterThan(0);
		expect(await call<{ full: number; compact: number }>("clearTailDirty"))
			.toEqual({ full: 0, compact: 0 });
		await event(little, longPrediction);
		const redrawn = await snapshot();
		const redrawnAlpha = await call<{ full: number; compact: number }>("tailAlpha");
		expect(redrawnAlpha.full).toBeGreaterThan(0);
		expect(redrawnAlpha.compact).toBeGreaterThan(0);
		expect(redrawn.mismatch, "redraw after compact dirty clear differs").toBe(0);
		expect(await compositorMismatch(), "compositor differs after compact dirty clear").toBe(0);
	});

	it("keeps the joint grid in phase across device scales and CSS counter-scale", async () => {
		const cases = [
			{ dsf: 1, backing: 1, cssScale: 1 },
			{ dsf: 1.25, backing: 1.25, cssScale: 1 },
			{ dsf: 1.5, backing: 1.5, cssScale: 1 },
			{ dsf: 2, backing: 2, cssScale: 1 },
			{ dsf: 1.5, backing: 2, cssScale: 1 },
			{ dsf: 1, backing: 1, cssScale: 0.3 },
			{ dsf: 1.25, backing: 1.25, cssScale: 0.3 },
			{ dsf: 1.5, backing: 1.5, cssScale: 0.3 },
			{ dsf: 1.5, backing: 2, cssScale: 0.3 },
			{ dsf: 2, backing: 2, cssScale: 0.3 },
		] as const;
		try {
			for (const row of cases) {
				await selectDsf(row.dsf);
				await setup({ width: 680, height: 360, backing: row.backing, cssScale: row.cssScale });
				await event(little, longPrediction);
				const s = await snapshot();
				expect(s.tailInk, JSON.stringify(row)).toBeGreaterThan(0);
				expect(s.mismatch, JSON.stringify(row)).toBe(0);
				expect(await compositorMismatch(), JSON.stringify(row)).toBe(0);
				expect(s.compact.layers.tail.width * s.compact.layers.tail.height,
					JSON.stringify(row)).toBeLessThan(s.full.layers.tail.width * s.full.layers.tail.height);
				const geometry = await screenGeometry();
				expect(geometry.compact.deviceOrigin.fractionX, JSON.stringify(row)).toBeCloseTo(0, 6);
				expect(geometry.compact.deviceOrigin.fractionY, JSON.stringify(row)).toBeCloseTo(0, 6);
			}
		} finally {
			await selectDsf(1.5);
		}
	}, 120_000);

	it("detects layer-order and wash plants before accepting parity", async () => {
		await setup(pane);
		await event(little, longPrediction);
		expect(await compositorMismatch()).toBe(0);
		await call<void>("plantOrder");
		expect(await compositorMismatch(), "order plant was invisible").toBeGreaterThan(0);
		await call<void>("restoreOrder");
		expect(await compositorMismatch(), "order was not restored").toBe(0);
		await call<void>("plantOpacity");
		expect(await compositorMismatch(), "wash plant was invisible").toBeGreaterThan(0);
		await call<void>("restoreOpacity");
		expect(await compositorMismatch(), "wash was not restored").toBe(0);
	});

	it("executes inline allocation, pen events, release, and unmount", async () => {
		const integration = await browser.newPage({ viewport: { width: 1900, height: 900 }, deviceScaleFactor: 1.5 });
		try {
			await integration.setContent("<!doctype html><html><body></body></html>");
			await integration.addScriptTag({ content: bundleText });
			const invoke = <T>(name: string) => integration.evaluate(name_ => (window as any).tailBackingPage[name_](), name) as Promise<T>;
			const mounted = await invoke<any>("mountInline");
			expect(mounted.mountTailWrites, "mount first allocates a full tail backing")
				.not.toContainEqual({ dimension: "width", value: mounted.layers.committed.width });
			expect(mounted.mountTailWrites, "mount first allocates a full tail backing")
				.not.toContainEqual({ dimension: "height", value: mounted.layers.committed.height });
			expect(mounted.layers.committed.width).toBeGreaterThan(300);
			const live = await invoke<any>("inkInline");
			expect(live.mode, "pen event did not enter inline ink mode").toBe("ink");
			expect(live.active, "pen event did not keep a live builder").toBe(true);
			expect(live.tailInk, "real inline head did not draw").toBeGreaterThan(0);
			const lifted = await invoke<any>("liftInline");
			expect(lifted.active).toBe(false);
			expect(lifted.tailInk, "pen-up left tail pixels behind").toBe(0);
			// One size for the whole stroke: the backing is sized before it, moved
			// during it and hidden, not shrunk, after it.
			const counted = await invoke<any>("strokeCounted");
			const boxOut = process.env.HW_TAIL_BOX_OUT;
			if (boxOut) writeFileSync(boxOut, JSON.stringify({ mounted: mounted.layers.tail, live: live.layers.tail,
				lifted: lifted.layers.tail, strokeBoxes: counted.boxes, strokeWrites: counted.writes,
				afterStroke: counted.lifted.layers.tail, visibilityAfter: counted.lifted.visibility }, null, 1));
			expect(counted.writes, "a pen event or its release wrote the tail backing size").toEqual([]);
			expect(new Set(counted.boxes.map((b: any) => `${b.width}x${b.height}`)).size, "the tail backing changed size mid-stroke").toBe(1);
			expect(new Set(counted.boxes.map((b: any) => `${b.origin.x},${b.origin.y}`)).size, "the tile never followed the head").toBeGreaterThan(1);
			expect(counted.live.tailInk, "the moved tile drew no head").toBeGreaterThan(0);
			expect(counted.lifted.tailInk, "release left tail pixels behind").toBe(0);
			expect(counted.lifted.visibility, "the tail wrote its own visibility; the pinch owns it").toBe("");
			expect(counted.lifted.layers.tail).toEqual(counted.live.layers.tail);
			const gone = await invoke<Record<string, { width: number; height: number }>>("unmountInline");
			for (const name of ["highlight", "highlightWet", "committed", "wet", "tail"]) expect(gone[name]).toEqual({ width: 0, height: 0 });
			expect.soft(live.layers.tail.width * live.layers.tail.height,
				"InkOverlay retained a full live tail despite compact renderer support").toBeLessThan(live.layers.committed.width * live.layers.committed.height);
			expect.soft(lifted.layers.tail, "pen-up resized the compact backing").toEqual(live.layers.tail);
			expect.soft(lifted.visibility, "pen-up wrote tail visibility; the pinch owns it").toBe("");
		} finally { await integration.close(); }
	}, 120_000);
});
