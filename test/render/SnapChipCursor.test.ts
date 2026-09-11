import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launch, type Browser } from "./harness";

let browser: Browser;
let script: string;

beforeAll(async () => {
	browser = await launch();
	const result = await build({
		stdin: {
			contents: `
				import { SnapChip } from './src/inline/SnapChip';
				const created: HTMLElement[] = [];
				const parent = document.getElementById('ink')! as HTMLElement & { createDiv: Function };
				parent.createDiv = ({ cls, text }: { cls: string; text?: string }) => {
					const el = document.createElement('div') as HTMLElement & { setCssStyles: Function };
					el.className = cls;
					if (text) el.textContent = text;
					el.setCssStyles = (styles: Record<string, string>) => Object.assign(el.style, styles);
					parent.appendChild(el);
					created.push(el);
					return el;
				};
				window.snapChipCase = () => {
					const targets = { addEventListener() {}, removeEventListener() {} };
					const chip = new SnapChip();
					chip.offer({ parent, guardRoot: targets, scroller: targets, keyRoot: targets,
						pane: { width: 800, height: 600 }, clock: { setTimeout: () => 1, clearTimeout() {} } }, 100, 100, () => {});
					const el = created.at(-1)!;
					return { tag: el.tagName, role: el.getAttribute('role'), cursor: getComputedStyle(el).cursor, showing: chip.showing };
				};
			`,
			resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
			loader: "ts",
		},
			bundle: true,
			write: false,
			format: "iife",
			platform: "browser",
		});
		script = result.outputFiles![0]!.text;
	});

afterAll(async () => { await browser?.close(); });

it("keeps the real SnapChip div pointer-visible through the scroller cursor guard", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<div class="cm-scroller"><div id="ink"></div></div>');
		await page.addStyleTag({ content: '.cm-scroller * { cursor: none; }' });
		await page.addStyleTag({ content: readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8") });
		await page.addScriptTag({ content: script });
		const result = await page.evaluate(() => (window as any).snapChipCase());
		expect(result).toEqual({ tag: "DIV", role: "button", cursor: "pointer", showing: true });
	} finally { await page.close(); }
});
