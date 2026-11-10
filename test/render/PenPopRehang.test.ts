/**
 * An open tool pop follows the strip when the pane narrows.
 *
 * A pop is hung under its button once, when it opens, from the rects of the
 * strip, the button and the pane at that moment. A pane that narrows under an
 * open pop reaches the strip through its resize observer, which re-folds the
 * row and may wrap it into a grid; the pop used to keep the place it was hung
 * at, which on a narrow pane is past the pane's left edge, off screen, until
 * the pop was shut and opened again.
 *
 * So each cell opens a pop on a wide pane, narrows the pane under it, and
 * reads where the pop now is, against the button it hangs from and the pane:
 *
 *   - the pen, highlighter and eraser pops each end inside the pane, centred
 *     under their button or held at the pane's edge;
 *   - a further narrowing inside the wrap moves it again;
 *   - widening back hangs it where it first opened;
 *   - a held slider keeps its value and a shut pop stays shut;
 *   - with the strip in the top-right corner, a pop near the pane's right
 *     edge stays inside the pane at every step as the pane narrows.
 *
 * Run: npm run test:render.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launch, openStrip, type Harness } from "./harness";

let browser: Browser;
beforeAll(async () => {
	browser = await launch();
});
afterAll(async () => {
	await browser?.close();
});

type Tool = "pen" | "highlighter" | "eraser";

const LABEL: Record<Tool, string> = { pen: "Pen", highlighter: "Highlighter", eraser: "Eraser" };

interface Box {
	left: number;
	right: number;
}

interface Seen {
	pane: Box;
	button: Box;
	pop: Box | null;
	wrapped: boolean;
	cols: string;
}

/** The pane, the tool's button and its open pop, read in the page. */
const look = (page: Page, tool: Tool): Promise<Seen> =>
	page.evaluate((label) => {
		const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools");
		const pane = strip?.parentElement;
		const button = [...document.querySelectorAll<HTMLElement>(".handwriting-mobile-tool")].find((b) =>
			(b.dataset.tipLabel ?? "").startsWith(label)
		);
		if (!strip || !pane || !button) throw new Error(`missing: strip ${!!strip}, pane ${!!pane}, ${label} button ${!!button}`);
		const box = (e: Element): { left: number; right: number } => {
			const r = e.getBoundingClientRect();
			return { left: r.left, right: r.right };
		};
		const pop = document.querySelector<HTMLElement>(".handwriting-slider-pop.is-showing");
		return {
			pane: box(pane),
			button: box(button),
			pop: pop ? box(pop) : null,
			wrapped: strip.classList.contains("is-wrapped"),
			cols: strip.style.getPropertyValue("--hw-strip-cols"),
		};
	}, LABEL[tool]);

/**
 * Narrow (or widen) the pane, then wait until the open pop holds one box for
 * two frames running, up to 60 frames. The resize observer delivers after
 * layout, so the first frame after the width change may still show the old box.
 */
const resize = async (page: Page, width: number): Promise<void> => {
	await page.evaluate(async (w) => {
		const pane = document.querySelector<HTMLElement>(".handwriting-mobile-tools")?.parentElement;
		if (!pane) throw new Error("no pane");
		pane.style.width = `${w}px`;
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		let last = "";
		let same = 0;
		for (let i = 0; i < 60 && same < 2; i++) {
			await frame();
			const p = document.querySelector<HTMLElement>(".handwriting-slider-pop.is-showing");
			const r = p?.getBoundingClientRect();
			const key = r ? `${r.left},${r.right}` : "none";
			same = key === last ? same + 1 : 0;
			last = key;
		}
	}, width);
};

/**
 * Where the pop belongs: inside the pane, and centred under its button - 1px
 * left of dead centre, the pop's `right` being measured inside the strip's
 * 1px border - unless that would cross the pane's edge, where it is held at
 * the edge. Within a pixel.
 *
 * A pop wider than the pane cannot fit both edges. It keeps its left edge at
 * the pane's left, because that is where its content starts, and its right part
 * is clipped (popRightOffset in PopPlacement.ts).
 */
const placed = (s: Seen): string | null => {
	if (!s.pop) return "no pop is showing";
	const { pop, pane, button } = s;
	if (pop.right - pop.left > pane.right - pane.left) {
		return Math.abs(pop.left - pane.left) <= 1
			? null
			: `pop ${pop.left}..${pop.right} is wider than the pane ${pane.left}..${pane.right} and its left edge is not at the pane's left`;
	}
	if (pop.left < pane.left - 1 || pop.right > pane.right + 1) {
		return `pop ${pop.left}..${pop.right} is outside the pane ${pane.left}..${pane.right}`;
	}
	const popMid = (pop.left + pop.right) / 2;
	const btnMid = (button.left + button.right) / 2;
	const centred = Math.abs(popMid - (btnMid - 1)) <= 1;
	const atEdge = Math.abs(pop.left - pane.left) <= 1 || Math.abs(pop.right - pane.right) <= 1;
	return centred || atEdge ? null : `pop centre ${popMid}, button centre ${btnMid}, and the pop is at neither pane edge`;
};

/** The pane narrow enough that every strip wraps into a grid. */
const NARROW = 180;
const WIDE = 1200;
/** Pane widths for the right-anchor cell, wide to narrow, all above the 180 px wrap of the cells above. */
const RIGHT_STEPS = [800, 600, 480, 400, 320, 260, 220] as const;

const opened = async (tool: Tool): Promise<Harness> => {
	const h = await openStrip(browser);
	await h.pop({ tool, presets: 4 });
	return h;
};

describe("an open tool pop when the pane narrows", () => {
	for (const tool of ["pen", "highlighter", "eraser"] as const) {
		it(`the ${tool} pop follows the strip into the wrap`, async () => {
			const h = await opened(tool);
			try {
				const before = await look(h.page, tool);
				expect(placed(before), `at ${WIDE}px`).toBeNull();
				await resize(h.page, NARROW);
				const after = await look(h.page, tool);
				console.log("[rehang]", tool, JSON.stringify({ before, after }));
				expect(after.wrapped, `a ${NARROW}px pane wraps the strip`).toBe(true);
				expect(placed(after), `at ${NARROW}px`).toBeNull();
			} finally {
				await h.close();
			}
		});
	}

	it("the pen pop moves again when the pane narrows inside the wrap", async () => {
		const h = await opened("pen");
		try {
			await resize(h.page, NARROW);
			const first = await look(h.page, "pen");
			await resize(h.page, 120);
			const second = await look(h.page, "pen");
			console.log("[rehang] inside the wrap", JSON.stringify({ first, second }));
			expect(second.wrapped, "a 120px pane keeps the strip wrapped").toBe(true);
			expect(placed(second), "at 120px").toBeNull();
			// The pop is wider than this pane, so the part on screen must be its left part.
			const pop = second.pop!;
			expect(Math.abs(pop.left - second.pane.left), `pop left ${pop.left}, pane left ${second.pane.left}`).toBeLessThanOrEqual(1);
			expect(pop.right, "the pop's right part runs past the pane").toBeGreaterThan(second.pane.right);
		} finally {
			await h.close();
		}
	});

	it("the pen pop hangs where it first opened once the pane is wide again", async () => {
		const h = await opened("pen");
		try {
			const first = await look(h.page, "pen");
			await resize(h.page, NARROW);
			await resize(h.page, WIDE);
			const back = await look(h.page, "pen");
			console.log("[rehang] widened back", JSON.stringify({ first, back }));
			expect(back.pop, "the pop is still showing").not.toBeNull();
			expect(Math.abs(back.pop!.left - first.pop!.left), `left ${back.pop!.left}, first ${first.pop!.left}`).toBeLessThanOrEqual(1);
			expect(Math.abs(back.pop!.right - first.pop!.right), `right ${back.pop!.right}, first ${first.pop!.right}`).toBeLessThanOrEqual(1);
		} finally {
			await h.close();
		}
	});

	it("keeps a held slider's value and leaves the shut pops shut", async () => {
		const h = await opened("pen");
		try {
			const held = await h.page.evaluate(() => {
				const input = document.querySelector<HTMLInputElement>('input[aria-label="Pen size"]');
				if (!input) throw new Error("no Pen size slider");
				// A finger down on the slider, and the value it has dragged to.
				input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
				input.value = String(Number(input.min) + Number(input.step));
				return input.value;
			});
			await resize(h.page, NARROW);
			const after = await h.page.evaluate(() => ({
				value: document.querySelector<HTMLInputElement>('input[aria-label="Pen size"]')?.value ?? null,
				showing: [...document.querySelectorAll<HTMLElement>(".handwriting-slider-pop.is-showing")].map(
					(p) => p.querySelector("input")?.getAttribute("aria-label") ?? "?"
				),
			}));
			console.log("[rehang] held", JSON.stringify({ held, after }));
			expect(after.value, "the held slider's value").toBe(held);
			expect(after.showing, "the pops showing after the resize").toEqual(["Pen size"]);
		} finally {
			await h.close();
		}
	});

	it("a pop near the pane's right edge stays inside it when a right-anchored strip narrows", async () => {
		// The strip in the top-right corner, as setCorner("top-right") anchors it: its right edge 8 px in from the pane's
		// right. The cells above all keep the strip at the pane's left, where a narrowed pop is only ever held at the left
		// edge, so a re-hang that read a pane box kept from the open, or that lost the right-edge clamp, passed them. Here the
		// pane narrows step by step under each open pop; at every step the pop must sit inside the pane, and at one step at
		// least its centred place must cross the pane's right edge, so the right clamp is what holds it.
		let binds = 0;
		const seen: string[] = [];
		for (const tool of ["pen", "highlighter", "eraser"] as const) {
			const h = await openStrip(browser);
			try {
				// As setCorner does: every corner class off, then the one wanted. The strip is built in its default corner, whose
				// `left` would otherwise win over the added `right`.
				await h.page.evaluate(() => {
					const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools");
					if (!strip) throw new Error("no strip");
					for (const c of [...strip.classList]) if (c.startsWith("handwriting-corner-")) strip.classList.remove(c);
					strip.classList.add("handwriting-corner-top-right");
				});
				await resize(h.page, WIDE);
				const inset = await h.page.evaluate(() => {
					const strip = document.querySelector<HTMLElement>(".handwriting-mobile-tools")!;
					return strip.parentElement!.getBoundingClientRect().right - strip.getBoundingClientRect().right;
				});
				expect(Math.abs(inset - 8), `${tool}: the strip's right edge sits 8px in from the pane's right, not ${inset}px`).toBeLessThanOrEqual(1);
				await h.pop({ tool, presets: 4 });
				const first = await look(h.page, tool);
				expect(placed(first), `${tool} at ${WIDE}px`).toBeNull();
				for (const width of RIGHT_STEPS) {
					await resize(h.page, width);
					const s = await look(h.page, tool);
					const pop = s.pop;
					expect(pop, `${tool} at ${width}px: the pop is still showing`).not.toBeNull();
					const popW = pop!.right - pop!.left;
					const centredRight = (s.button.left + s.button.right) / 2 - 1 + popW / 2;
					const wouldCross = popW <= s.pane.right - s.pane.left && centredRight > s.pane.right + 1;
					if (wouldCross) binds++;
					seen.push(`${tool} ${width}: pane ${s.pane.left}..${s.pane.right}, pop ${pop!.left}..${pop!.right}, centred right ${centredRight}`);
					expect(pop!.right, `${tool} at ${width}px: the pop's right edge stays inside the pane`).toBeLessThanOrEqual(s.pane.right + 1);
					expect(placed(s), `${tool} at ${width}px`).toBeNull();
				}
			} finally {
				await h.close();
			}
		}
		console.log("[rehang] right anchor", JSON.stringify(seen));
		expect(binds, "at least one step where the centred pop would cross the pane's right edge").toBeGreaterThan(0);
	});
});
