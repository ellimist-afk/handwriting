/**
 * The tool pop is SOLID, and the strip it hangs from is not.
 *
 * The strip is drawn at 0.92 so the page shows faintly through it; the pop
 * under it is meant to be fully opaque, because a swatch that shows ink
 * through itself is not showing its colour (see `.handwriting-slider-pop`).
 * Opacity below 1 on an element paints its whole subtree as one group, so a
 * pop that is a descendant of the 0.92 box paints at 0.92 whatever its own
 * fill says - the owner saw ink through the open pen pop on every device.
 *
 * So this file puts bright ink under everything and reads the pixels back:
 *
 *   - the pop's pixel over the ink is the pop's fill, within 1/255;
 *   - the strip's pixel over the ink is what a 0.92 box of the same fill
 *     paints over that ink - today's look, unchanged - with the pop open and
 *     with it shut, in a row and wrapped;
 *   - collapsed, neither paints at all;
 *   - pen-down hides both, pen-up brings both back;
 *   - the pop still hangs where it did, within a pixel.
 *
 * The references are painted in the same page rather than written down: a
 * plain box with the strip's fill at opacity 0.92 is what "today's strip"
 * means in this engine, and a plain box at opacity 1 is what "solid" means.
 * Neither depends on how the strip is built, so the cell reads the same on
 * the code before the fix and after it.
 *
 * Run: npm run test:render.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { hostVars, launch, openStrip, type Harness } from "./harness";
import type { DragProbe } from "./stripPage";

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

/** Pure green: as far from every theme's grey as a colour gets. */
const INK = "#00ff00";

/** A dark theme's tokens, laid under the plugin's sheet as Obsidian would. */
const DARK = hostVars({
	"--background-secondary": "#262626",
	"--background-modifier-border": "#363636",
	"--background-primary": "#1e1e1e",
	"--text-normal": "#dadada",
	"--text-muted": "#999999",
});

type Rgb = [number, number, number];
/** A read pixel, or the named miss of a spot that lies off the screenshot: the line that reads it reports it by name. */
type Px = Rgb | { miss: string };

interface Point {
	x: number;
	y: number;
}

/** Where to read, in page pixels. Device scale is 1, so one CSS px is one pixel. */
interface Spots {
	/** Inside the pop's top padding, under the centre of the pop. */
	pop: Point;
	/** Inside the strip's top padding, mid-row, clear of every button. */
	strip: Point;
	/** Inside the reference box painted at the strip's opacity. */
	refStrip: Point;
	/** Inside the reference box painted solid. */
	refSolid: Point;
	/** Bare ink, nothing over it. */
	ink: Point;
}

interface Boxes {
	strip: { left: number; top: number; right: number; bottom: number };
	pop: { left: number; top: number; right: number; bottom: number; width: number };
	button: { left: number; right: number };
	viewport: { width: number };
}

/**
 * Lay the ink and the two reference boxes into the page the harness built,
 * with the pen pop already open. The ink is FIXED to the viewport, under
 * everything, so a pop that hangs past its pane is still over ink.
 */
const stage = async (page: Page): Promise<void> => {
	await page.evaluate((ink: string) => {
		const under = document.createElement("div");
		under.style.cssText = `position:fixed;inset:0;z-index:0;background:${ink};`;
		document.body.prepend(under);
		const ref = (opacity: string, left: number): void => {
			const box = document.createElement("div");
			box.className = "popout-opaque-ref";
			box.style.cssText =
				`position:fixed;left:${left}px;bottom:20px;width:40px;height:40px;z-index:1;` +
				`background:var(--background-secondary);opacity:${opacity};`;
			document.body.appendChild(box);
		};
		ref("0.92", 20);
		ref("1", 80);
	}, INK);
};

/**
 * Wait until the open pen pop holds still: the same box two frames running, with part of it inside the viewport (on a
 * narrow pane the shipped pop hangs past the left edge, clipped). No fixed frame count - under load the strip's re-layout after a wrap lands later, and a box read before it lands is a box
 * the pop is about to leave. A pop that never settles is measured at its last box, so the cell still reads and reports
 * every pixel there; `settled` says so, and each cell asserts it last (expectSettled), hard.
 */
let settled = true;
const settle = async (page: Page): Promise<void> => {
	const ok = await page.evaluate(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		let last = "";
		for (let i = 0; i < 120; i++) {
			await frame();
			const pop = document.querySelector<HTMLElement>(".handwriting-slider-pop.is-showing");
			if (!pop) {
				last = "";
				continue;
			}
			const r = pop.getBoundingClientRect();
			const inside = r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0;
			const key = `${r.left},${r.top},${r.right},${r.bottom}`;
			if (inside && key === last) return true;
			last = inside ? key : "";
		}
		return false;
	});
	if (!ok) settled = false;
};

/** Last in every cell that measured: the pop held one box, partly on screen, for two frames. */
const expectSettled = (): void => {
	expect(settled, "the open pen pop never held the same box, partly inside the viewport, for two frames").toBe(true);
};

/** The strip's root, the open pen pop and the pen button, measured once the pop holds still. */
const measure = async (page: Page): Promise<Boxes> => {
	await settle(page);
	return page.evaluate(() => {
		const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools");
		const pop = document.querySelector<HTMLElement>(".handwriting-slider-pop.is-showing");
		const button = [...document.querySelectorAll<HTMLElement>(".handwriting-mobile-tool")].find(
			(b) => (b.dataset.tipLabel ?? "").startsWith("Pen")
		);
		if (!strip || !pop || !button) {
			throw new Error(`missing: strip ${!!strip}, open pop ${!!pop}, pen button ${!!button}`);
		}
		const s = strip.getBoundingClientRect();
		const p = pop.getBoundingClientRect();
		const b = button.getBoundingClientRect();
		return {
			strip: { left: s.left, top: s.top, right: s.right, bottom: s.bottom },
			pop: { left: p.left, top: p.top, right: p.right, bottom: p.bottom, width: p.width },
			button: { left: b.left, right: b.right },
			viewport: { width: innerWidth },
		};
	});
};

const spotsFor = (b: Boxes): Spots => ({
	// The pop's border is 1px and its padding 8px: 4px down is padding. Across, the middle of the part on screen.
	pop: { x: Math.round((Math.max(b.pop.left, 0) + Math.min(b.pop.right, b.viewport.width)) / 2), y: Math.round(b.pop.top) + 4 },
	// The strip's border is 1px and its padding 4px: 3px down is padding,
	// above the buttons, which start 5px down.
	strip: { x: Math.round((b.strip.left + b.strip.right) / 2), y: Math.round(b.strip.top) + 3 },
	refStrip: { x: 40, y: 900 - 40 },
	refSolid: { x: 100, y: 900 - 40 },
	ink: { x: 400, y: 880 },
});

type Png = Awaited<ReturnType<Page["screenshot"]>>;

/** Every named spot read off one screenshot taken earlier, so a reference can be read before the state it is compared with. */
const readShot = async <K extends string>(page: Page, png: Png, at: Record<K, Point>): Promise<Record<K, Px>> => {
	const url = `data:image/png;base64,${png.toString("base64")}`;
	return page.evaluate(
		async ({ url, at }) => {
			const img = new Image();
			img.src = url;
			await img.decode();
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("no 2d context for the screenshot");
			ctx.drawImage(img, 0, 0);
			const out: Record<string, [number, number, number] | { miss: string }> = {};
			for (const [name, p] of Object.entries(at as Record<string, { x: number; y: number }>)) {
				// Off the canvas getImageData answers transparent black, which reads as a colour; name it instead.
				// A miss, not a throw: the cell's other lines still read, and the line that reads this spot reports it.
				if (p.x < 0 || p.y < 0 || p.x >= canvas.width || p.y >= canvas.height) {
					out[name] = { miss: `spot ${name} (${p.x}, ${p.y}) is outside the ${canvas.width}x${canvas.height} screenshot` };
					continue;
				}
				const d = ctx.getImageData(p.x, p.y, 1, 1).data;
				out[name] = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
			}
			return out;
		},
		{ url, at }
	) as Promise<Record<K, Px>>;
};

/** One screenshot now, every named spot read off it. */
const read = async <K extends string>(page: Page, at: Record<K, Point>): Promise<Record<K, Px>> =>
	readShot(page, await page.screenshot({ type: "png" }), at);

/** Every channel within `tol` of the reference. A missed spot is never near anything. */
const near = (got: Px, want: Px, tol = 1): boolean => {
	if (!Array.isArray(got) || !Array.isArray(want)) return false;
	const w: Rgb = want;
	return got.every((v, i) => Math.abs(v - w[i]!) <= tol);
};

const say = (p: Px): string => (Array.isArray(p) ? `rgb(${p.join(", ")})` : p.miss);

const openPen = async (dark: boolean): Promise<Harness> => {
	const h = await openStrip(browser, dark ? { hostCss: DARK } : {});
	await h.pop({ tool: "pen", presets: 4 });
	await stage(h.page);
	return h;
};

/**
 * A strip with no pop ever opened, the ink laid under it. The harness's plain host holds the pen, so a tap on the
 * pen button opens its pop on THIS host, in whatever layout the pane has then (`tapPen`). `h.pop` cannot: it
 * rebuilds the page at a 1200px pane and opens the pop there.
 */
const openBare = async (): Promise<Harness> => {
	const h = await openStrip(browser);
	await stage(h.page);
	return h;
};

/** A finger's tap on the pen button: the tool already held, so the tap opens its pop (the refresh lands a frame later). */
const tapPen = async (page: Page): Promise<void> => {
	await page.evaluate(() => {
		const btn = [...document.querySelectorAll<HTMLElement>(".handwriting-mobile-tool")].find((b) =>
			(b.dataset.tipLabel ?? "").startsWith("Pen")
		);
		if (!btn) throw new Error("no Pen button was built");
		btn.dispatchEvent(new PointerEvent("click", { bubbles: true, pointerType: "touch" }));
	});
};

/** Toggle a class on the strip's root, then wait out its transition. */
const rootClass = async (page: Page, cls: string, on: boolean, waitMs: number): Promise<void> => {
	await page.evaluate(
		({ cls, on }) => {
			document.querySelector(".handwriting-mobile-tools")?.classList.toggle(cls, on);
		},
		{ cls, on }
	);
	await page.waitForTimeout(waitMs);
};

/**
 * Shut the pops the way the product does: a tap outside the strip (MobileTools.outsideTap, which calls
 * closeInkSliders). A class toggle alone left the strip's state open, and its next refresh showed the pop again.
 * Then wait until no pop is showing two frames running; fails by name if one stays.
 */
const shutPops = async (page: Page): Promise<void> => {
	const ok = await page.evaluate(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		// The ink underlay `stage` laid first in the body: outside the strip and its pill.
		const outside = document.body.firstElementChild ?? document.body;
		outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
		let clear = 0;
		for (let i = 0; i < 60 && clear < 2; i++) {
			await frame();
			clear = document.querySelector(".handwriting-slider-pop.is-showing") ? 0 : clear + 1;
		}
		return clear >= 2;
	});
	if (!ok) throw new Error("a pop was still showing two frames after a tap outside the strip");
};

/** The strip's 0.92 transition back in is 160ms late and 60ms long. */
const RETURN_MS = 450;
const HIDE_MS = 200;

describe("the open pen pop over ink", () => {
	for (const dark of [false, true]) {
		const theme = dark ? "dark" : "light";

		it(`is solid, and the strip is unchanged (${theme})`, async () => {
			settled = true;
			const h = await openPen(dark);
			try {
				const spots = spotsFor(await measure(h.page));
				const px = await read(h.page, spots);
				console.log("[px]", expect.getState().currentTestName, "px", JSON.stringify(px));
				// The stage is what it claims to be: ink is ink, and the
				// translucent reference is visibly not the solid one.
				expect.soft(near(px.ink, [0, 255, 0]), `ink reads ${say(px.ink)}`).toBe(true);
				expect.soft(near(px.refStrip, px.refSolid, 3), "the 0.92 reference shows no ink").toBe(false);
				expect.soft(
					near(px.pop, px.refSolid),
					`pop pixel ${say(px.pop)}, its fill ${say(px.refSolid)}, ink showing through it`
				).toBe(true);
				expect.soft(
					near(px.strip, px.refStrip),
					`strip pixel ${say(px.strip)}, today's 0.92 strip ${say(px.refStrip)}`
				).toBe(true);
				expectSettled();
			} finally {
				await h.close();
			}
		});
	}

	it("leaves the strip as it is with the pop shut", async () => {
		settled = true;
		const h = await openBare();
		try {
			// The reference: this host, before the pop ever opened. The ink swatch is not one: around the pop spot the page
			// is a gradient, two spots a pixel apart read 0,254,0 and 0,253,0 with no pop ever opened.
			const never = await h.page.screenshot({ type: "png" });
			await tapPen(h.page);
			const spots = spotsFor(await measure(h.page));
			await shutPops(h.page);
			const px = await read(h.page, spots);
			const before = await readShot(h.page, never, spots);
			console.log("[px]", expect.getState().currentTestName, "px", JSON.stringify(px), "never opened", JSON.stringify(before));
			expect.soft(
				near(px.strip, px.refStrip),
				`strip pixel ${say(px.strip)}, today's 0.92 strip ${say(px.refStrip)}`
			).toBe(true);
			// The pop is gone, so its spot reads as it did before the pop first opened.
			expect.soft(near(px.pop, before.pop), `shut pop spot ${say(px.pop)}, never opened ${say(before.pop)}`).toBe(true);
			expectSettled();
		} finally {
			await h.close();
		}
	});

	it("is solid on a wrapped strip, and the wrapped strip is unchanged", async () => {
		settled = true;
		// Wrap first, then open, as a user on a narrow pane does: the pop hangs in the wrapped layout. A pop opened
		// before the wrap keeps the place it hung at (shipped behaviour), which is not what this cell reads.
		const h = await openBare();
		try {
			await h.page.evaluate(async () => {
				const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools");
				const pane = strip?.parentElement;
				if (!pane) throw new Error("no pane");
				pane.style.width = "180px";
				// Until the strip wears the wrap, not a fixed frame count; measure() then waits for the pop to settle.
				for (let i = 0; i < 60 && !strip?.classList.contains("is-wrapped"); i++) {
					await new Promise((r) => requestAnimationFrame(r));
				}
				if (!strip?.classList.contains("is-wrapped")) {
					throw new Error("a 180px pane did not wrap the strip within 60 frames");
				}
			});
			await tapPen(h.page);
			const spots = spotsFor(await measure(h.page));
			const open = await read(h.page, spots);
			console.log("[px]", expect.getState().currentTestName, "open", JSON.stringify(open));
			expect.soft(near(open.pop, open.refSolid), `wrapped pop pixel ${say(open.pop)}, fill ${say(open.refSolid)}`).toBe(
				true
			);
			expect.soft(
				near(open.strip, open.refStrip),
				`wrapped strip pixel ${say(open.strip)}, today's ${say(open.refStrip)}`
			).toBe(true);
			await shutPops(h.page);
			const shut = await read(h.page, spots);
			console.log("[px]", expect.getState().currentTestName, "shut", JSON.stringify(shut));
			expect.soft(
				near(shut.strip, shut.refStrip),
				`wrapped strip, pop shut ${say(shut.strip)}, today's ${say(shut.refStrip)}`
			).toBe(true);
			expectSettled();
		} finally {
			await h.close();
		}
	});

	it("paints nothing, strip or pop, while the strip is collapsed", async () => {
		settled = true;
		const h = await openPen(false);
		try {
			const spots = spotsFor(await measure(h.page));
			await rootClass(h.page, "is-collapsed", true, 50);
			const px = await read(h.page, spots);
			console.log("[px]", expect.getState().currentTestName, "px", JSON.stringify(px));
			expect.soft(near(px.strip, px.ink), `collapsed strip spot ${say(px.strip)}`).toBe(true);
			expect.soft(near(px.pop, px.ink), `collapsed pop spot ${say(px.pop)}`).toBe(true);
			expectSettled();
		} finally {
			await h.close();
		}
	});

	it("hides with the strip at pen-down and comes back with it at pen-up", async () => {
		settled = true;
		const h = await openPen(false);
		try {
			const spots = spotsFor(await measure(h.page));
			await rootClass(h.page, "is-inking", true, HIDE_MS);
			const down = await read(h.page, spots);
			console.log("[px]", expect.getState().currentTestName, "down", JSON.stringify(down));
			expect.soft(near(down.strip, down.ink), `pen-down strip ${say(down.strip)}`).toBe(true);
			expect.soft(near(down.pop, down.ink), `pen-down pop ${say(down.pop)}`).toBe(true);
			await rootClass(h.page, "is-inking", false, RETURN_MS);
			const up = await read(h.page, spots);
			console.log("[px]", expect.getState().currentTestName, "up", JSON.stringify(up));
			expect.soft(near(up.pop, up.refSolid), `pen-up pop ${say(up.pop)}, fill ${say(up.refSolid)}`).toBe(true);
			expect.soft(near(up.strip, up.refStrip), `pen-up strip ${say(up.strip)}, today's ${say(up.refStrip)}`).toBe(
				true
			);
			expectSettled();
		} finally {
			await h.close();
		}
	});

	it("hangs where it did, within a pixel", async () => {
		settled = true;
		const h = await openPen(false);
		try {
			const b = await measure(h.page);
			// Today the pop's `top: 100%` and its `right` are measured from
			// inside the strip's 1px border, so it sits 3px under the strip's
			// outer edge (4px margin less the border) and 1px left of dead
			// centre under its button. Within a pixel of both.
			expect(Math.abs(b.pop.top - b.strip.bottom - 3), `gap ${b.pop.top - b.strip.bottom}`).toBeLessThanOrEqual(1);
			const popMid = (b.pop.left + b.pop.right) / 2;
			const btnMid = (b.button.left + b.button.right) / 2;
			expect(Math.abs(popMid - (btnMid - 1)), `pop centre ${popMid}, button centre ${btnMid}`).toBeLessThanOrEqual(1);
			expect(b.pop.width).toBe(144);
			expectSettled();
		} finally {
			await h.close();
		}
	});
});

/**
 * The fold budget still counts the strip's border.
 *
 * `layoutOverflow` prices the row against the pane less the strip's border
 * and padding, and reads the border as `offsetWidth - clientWidth`. The
 * border is the face's now; read off the root it is zero, the budget comes
 * out 2px too generous, and in a 2px band above every fold point the plan
 * calls the row a fit that the engine then wraps onto a second line. So the
 * pane is narrowed ONE pixel per frame across the whole band - two would
 * step over half of every such band - and every frame of the unwrapped row
 * must sit on one line: a row either fits or is folded, never wrapped by
 * the engine behind the plan's back.
 */
describe("the fold decision at every pane width", () => {
	let h: Harness;
	let drag: DragProbe;
	beforeAll(async () => {
		h = await openStrip(browser);
		drag = await h.drag({ from: 520, to: 116, step: 1 });
	}, 300_000);
	afterAll(async () => {
		await h?.close();
	});

	it("walks the band one pixel at a time", () => {
		expect(drag.steps.length).toBe(520 - 116 + 1);
		expect(drag.steps.some((s) => s.wrapped)).toBe(true);
		expect(drag.steps.some((s) => !s.wrapped)).toBe(true);
	});

	it("never leaves the unwrapped row on two lines", () => {
		const split = drag.steps.filter((s) => !s.wrapped && s.lines !== 1).map((s) => `${s.width}px: ${s.lines} lines`);
		expect(split).toEqual([]);
	});
});
