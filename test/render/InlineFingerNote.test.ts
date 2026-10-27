import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

interface Snapshot {
	downs: number;
	ups: number;
	cancels: number;
	raw: number;
	pinches: string[];
	scrollTop: number;
	selection: string;
	touchAction: string;
	downPrevented: boolean;
}

async function call(method: "draw" | "pinch" | "nativeAfterKeyboard"): Promise<Snapshot> {
	return page.evaluate((name) => {
		const api = (window as unknown as Window & {
			inlineFingerNote: Record<string, () => Snapshot>;
		}).inlineFingerNote;
		return api[name]!();
	}, method);
}

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL("./inlineFingerNotePage.ts", import.meta.url))],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
	});
	browser = await chromium.launch({ headless: true });
	page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true });
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
	const mounted = await page.evaluate(() => "inlineFingerNote" in window);
	if (!mounted) throw new Error(`finger fixture failed to mount: ${pageErrors.join(" | ")}`);
});

afterAll(async () => browser?.close());

describe("mounted ordinary-note finger route in Chromium", () => {
	it("guards before contact, draws once, and leaves scroll/caret state untouched", async () => {
		const result = await call("draw");
		expect(result.touchAction).toBe("none");
		expect(result.downPrevented).toBe(true);
		expect(result.downs).toBe(1);
		expect(result.raw).toBeGreaterThan(0);
		expect(result.ups).toBe(1);
		expect(result.scrollTop).toBe(240);
		expect(result.selection).not.toBe("");
	});

	it("drops provisional ink and lets the existing pinch own both contacts", async () => {
		const result = await call("pinch");
		expect(result.downs).toBe(1);
		expect(result.ups).toBe(0);
		expect(result.cancels).toBe(1);
		expect(result.pinches).toContain("start");
		expect(result.pinches).toContain("move");
		expect(result.pinches).toContain("end");
	});

	it("restores the native pointer route after Keyboard mode", async () => {
		const result = await call("nativeAfterKeyboard");
		expect(result.downPrevented).toBe(false);
		expect(result.downs).toBe(0);
		expect(result.ups).toBe(0);
	});
});
