/**
 * the fix A, red-first: does a `closePath` per quad reach the raster at all?
 *
 * WHAT IS ABOUT TO CHANGE AND WHY. `fillRibbon` emits `moveTo` + 3x `lineTo` +
 * `closePath` per quad, one quad per sample, and the whole stroke goes into one
 * path that is filled once. The ruling device trace bills `closePath` 3332.0 ms of
 * a 3536.8 ms task - beside `lineTo`'s 5.6 ms at three times the call count,
 * which is roughly 1800x the cost per call. In the rig, replacing `closePath`
 * with an empty function took the worst pinch commit from 619.8 ms to 73.2 ms at
 * an unchanged call count. So the call is the cost.
 *
 * `fill()` closes every open subpath implicitly, so the closes should not affect
 * the raster. That is a sentence in a spec, not a measurement, and removing a
 * call from the paint path on the strength of one is how a renderer regression
 * ships. This cell measures it instead.
 *
 * HOW, WITHOUT A REPLICA. Nothing here re-implements the quad geometry. The real
 * `fillRibbon` paints once into a recording context, and that exact call stream
 * is replayed onto real canvases twice: once with a `closePath` ending every
 * subpath, once with none. Both arms are the production painter's own output, so
 * the cell keeps its meaning whichever way the painter is written - before the
 * closes come out and after.
 *
 * THE PLANT IS THE RED. Two identical byte arrays prove nothing unless a
 * difference would have shown. The planted arm moves one recorded vertex by one
 * pixel; it must differ from the closed arm by a nonzero number of bytes, and if
 * the comparison ever stops being able to see that, this cell fails rather than
 * passing vacuously.
 *
 * Both painter paths are covered: smoothing on (discs at hard turns only) and
 * `perSegment`, the Boox path, which puts a disc at every joint and so has the
 * most subpaths per stroke.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";

declare const process: { env: Record<string, string | undefined> };
let browser: Browser, bundle: string;
const report: unknown[] = [];

beforeAll(async () => {
	const b = await build({
		entryPoints: [fileURLToPath(new URL("./ribbonClosePathPage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
	});
	bundle = b.outputFiles[0]!.text;
	browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
	await browser?.close();
	if (process.env.HW_S93_PARITY_REPORT) writeFileSync(process.env.HW_S93_PARITY_REPORT, JSON.stringify(report, null, 1));
});

const ARMS = [
	{ samples: 400, perSegment: false },
	{ samples: 400, perSegment: true },
	{ samples: 40, perSegment: true },
] as const;

for (const arm of ARMS) it(`a closePath per quad changes no pixel: ${arm.samples} samples, perSegment ${arm.perSegment}`, async () => {
	const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
	const errors: string[] = [];
	page.on("pageerror", e => errors.push(e.message));
	try {
		await page.addScriptTag({ content: bundle });
		const r = await page.evaluate(([samples, perSegment]) => (window as any).ribbonClosePath.run(samples, perSegment),
			[arm.samples, arm.perSegment] as const);
		report.push({ kind: "parity", ...r, errors });

		expect(errors, "no page errors while painting").toEqual([]);
		// PREMISES. A blank canvas compares equal to another blank canvas, and a
		// stroke with no quads has no closes to remove.
		expect(r.inkedPixels, "premise: the stroke actually painted something").toBeGreaterThan(1_000);
		expect(r.counts.lineTo, "premise: the painter emitted a multi-quad path").toBeGreaterThan(30);

		// THE DISCRIMINATOR, and it runs before the parity claim is read: one
		// vertex moved by one pixel must change the raster. Without this, "0 bytes
		// differ" could mean the comparison sees nothing at all.
		expect(r.plantedVsClosedBytes, "a single vertex moved by 1 px changes the raster").toBeGreaterThan(0);

		// THE CLAIM.
		expect(r.openVsClosedBytes, `bytes differing between the path closed per quad and the same path with no closes (${r.counts.moveTo} subpaths, ${r.counts.lineTo} lineTo, ${r.counts.arc} arcs)`).toBe(0);
		expect(r.openHash, "and the same by hash").toBe(r.closedHash);
	} finally {
		await page.close();
	}
}, 300_000);

/**
 * Not an assertion about the product - a measurement for the evidence file, so
 * the fix's before/after is stated in the same units the device trace used.
 * The bound is deliberately loose: it fails only if the closes turn out to be
 * FREE, which would mean the fix below it is pointless and the reasoning behind
 * it is wrong.
 */
it("what a closePath per quad costs, measured on the painter's own stream", async () => {
	const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
	try {
		await page.addScriptTag({ content: bundle });
		const rows = [];
		for (const arm of ARMS) {
			rows.push(await page.evaluate(([samples, perSegment, reps]) => (window as any).ribbonClosePath.cost(samples, perSegment, reps),
				[arm.samples, arm.perSegment, 20] as const));
		}
		report.push({ kind: "cost", rows });
		const worst = rows.reduce((w: any, r: any) => (r.deltaMs > w.deltaMs ? r : w), rows[0] as any);
		expect(worst.deltaMs, `closing every subpath costs this much more per replay (${JSON.stringify(rows.map((r: any) => ({ samples: r.samples, perSegment: r.perSegment, closedMs: r.closedMs, openMs: r.openMs, usPerClose: r.usPerClose })))})`).toBeGreaterThan(0);
	} finally {
		await page.close();
	}
}, 300_000);
