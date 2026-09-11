import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { launch, type Browser, type BrowserEngine } from "./harness";
import css from "../../styles.css?raw";
import { readFileSync } from "node:fs";
const hostCss = readFileSync(fileURLToPath(new URL("./obsidianMetadataHost.css", import.meta.url)), "utf8");

describe.each(["chromium", "webkit"] satisfies BrowserEngine[])("mounted paper metadata transitions in %s", engine => {
	let browser: Browser;
	let script: string;
	beforeAll(async () => {
		const bundled = await build({
			entryPoints: [fileURLToPath(new URL("./paperMetadataTransitionPage.ts", import.meta.url))],
			bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
			alias: { obsidian: fileURLToPath(new URL("../obsidian-stub.ts", import.meta.url)) },
		});
		script = bundled.outputFiles[0]!.text;
		browser = await launch(engine);
	});
	afterAll(async () => { await browser?.close(); });

	it("persists every paper choice and keeps Properties visibility stable", async () => {
		const page = await browser.newPage();
		try {
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await page.setContent("<!doctype html><html><body></body></html>");
			await page.addScriptTag({ content: script });
			const result = await page.evaluate(cssText => window.paperMetadataTransitionProbe(cssText), css + "\n" + hostCss);
			expect(result.transitions.map(item => item.choice)).toEqual(["none", "lines", "grid", "dots", "default", "none", "lines", "grid", "dots", "default"]);
			expect(result.transitions.slice(0, 5).map(item => item.state.paper)).toEqual(["none", "lines", "grid", "dots", null]);
			expect(result.transitions.slice(0, 5).every(item => item.state.idOnly)).toBe(true);
			expect(result.transitions.slice(0, 5).every(item => item.state.display === "none" && item.state.height === 0)).toBe(true);
			expect(result.transitions.slice(5).every(item => !item.state.idOnly && item.state.userDisplay !== "none")).toBe(true);
			expect(result.transitions.slice(5).every(item => item.state.userDisplay !== "absent" && item.state.display !== "none" && item.state.height > 0)).toBe(true);
			expect(result.transitions.slice(5).every(item => item.state.userValue === "title: user value")).toBe(true);
			expect(result.transitions.slice(0, 4).every(item => item.state.paperDisplay === "none")).toBe(true);
			expect(result.transitions.slice(5, 9).every(item => item.state.paperDisplay === "none")).toBe(true);
			expect(result.transitions.every(item => item.state.rows >= 1 && item.state.rows <= 3)).toBe(true);
			expect(result.remount.after.paper).toBeNull();
			expect(result.remount.after.rows).toBe(result.remount.before.rows);
			expect(result.remount.after.display).not.toBe("none");
			expect(result.remount.after.userValue).toBe("title: user value");
			expect(result.control).toEqual({ unitCssCheck: true, layoutAssertion: false });
			expect(errors).toEqual([]);
		} finally { await page.close(); }
	});
});
