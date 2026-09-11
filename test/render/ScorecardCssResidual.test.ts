import { afterAll, beforeAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launch, type Browser } from "./harness";

let browser: Browser;
const css = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
const hostCss = readFileSync(fileURLToPath(new URL("./obsidianMetadataHost.css", import.meta.url)), "utf8");

beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

it("wins the owned hidden states and preserves tab removal", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<div class="handwriting-mobile-tool" hidden>mobile</div><button class="handwriting-fold-reset" hidden>reset</button>');
		await page.addStyleTag({ content: '.handwriting-mobile-tool { display:flex } .handwriting-fold-reset { display:flex }' });
		await page.addStyleTag({ content: css });
		const result = await page.evaluate(() => [...document.querySelectorAll("[hidden]")].map((el) => ({ display: getComputedStyle(el).display, tabIndex: (el as HTMLElement).tabIndex })));
		expect(result).toEqual([{ display: "none", tabIndex: -1 }, { display: "none", tabIndex: 0 }]);
	} finally { await page.close(); }
});

it("keeps the gated label hanging without changing wrapped names", async () => {
	const page = await browser.newPage({ viewport: { width: 320, height: 300 } });
	try {
		await page.setContent('<div class="handwriting-gated-group"><span class="handwriting-gated-label">Long label</span> <span>first name</span> <span>second name</span></div>');
		await page.addStyleTag({ content: css });
		const result = await page.evaluate(() => {
			const group = document.querySelector(".handwriting-gated-group")!;
			const label = group.querySelector(".handwriting-gated-label")! as HTMLElement;
			return { textIndent: getComputedStyle(group).textIndent, marginLeft: getComputedStyle(label).marginLeft, paddingLeft: getComputedStyle(group).paddingLeft };
		});
		expect(result).toEqual({ textIndent: "0px", marginLeft: "-16px", paddingLeft: "16px" });
	} finally { await page.close(); }
});

it("applies the ten viewport geometry properties through the prepared DOM chain", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<div class="handwriting-note-viewport-pane"><div class="cm-editor handwriting-note-viewport"><div class="cm-scroller"><div class="cm-content">text</div></div></div></div>');
		await page.addStyleTag({ content: '.cm-editor { display:flex; max-width:500px; max-height:400px } .cm-content { width:900px; margin:0 }' });
		await page.addStyleTag({ content: ':root { --handwriting-note-column-width: 240px; --handwriting-note-column-margin-left: 12px; --handwriting-note-column-margin-right: 18px; }' });
		await page.addStyleTag({ content: css });
		const result = await page.evaluate(() => {
			const editor = document.querySelector(".handwriting-note-viewport")!;
			const content = document.querySelector(".cm-content")!;
			const e = getComputedStyle(editor); const c = getComputedStyle(content);
			return { flex: e.flex, maxWidth: e.maxWidth, maxHeight: e.maxHeight, boxSizing: c.boxSizing, width: c.width, minWidth: c.minWidth, maxWidthContent: c.maxWidth, flexContent: c.flex, marginLeft: c.marginLeft, marginRight: c.marginRight };
		});
		expect(result).toEqual({ flex: "0 0 auto", maxWidth: "none", maxHeight: "none", boxSizing: "border-box", width: "240px", minWidth: "240px", maxWidthContent: "240px", flexContent: "0 0 240px", marginLeft: "12px", marginRight: "18px" });
	} finally { await page.close(); }
});

it.each([
	"markdown-source-view is-live-preview show-properties",
	"markdown-preview-view show-properties",
	"markdown-source-view is-live-preview",
])("preserves metadata visibility against installed host rules in %s", async (classes) => {
	const page = await browser.newPage();
	try {
		await page.setContent(`<div class="hover-popover bases-new-item-popover"><div class="${classes}">
			<div id="only" class="metadata-container handwriting-metadata-id-only"><div class="metadata-property" data-property-key="handwriting-page-id">id</div></div>
			<div id="shell" class="metadata-container handwriting-metadata-id-only">Properties</div>
			<div id="mixed" class="metadata-container"><div class="metadata-property" data-property-key="handwriting-page-id">id</div><div class="metadata-property" data-property-key="handwriting-paper">grid</div><div class="metadata-property" data-property-key="title">title</div></div>
		</div></div>`);
		await page.addStyleTag({ content: css });
		// Host loaded last: specificity, rather than source order, must win.
		await page.addStyleTag({ content: hostCss });
		const result = await page.evaluate(() => ({
			id: getComputedStyle(document.querySelector('[data-property-key="handwriting-page-id"]')!).display,
			paper: getComputedStyle(document.querySelector('[data-property-key="handwriting-paper"]')!).display,
			user: getComputedStyle(document.querySelector('[data-property-key="title"]')!).display,
			onlyHeight: document.querySelector('#only')!.getBoundingClientRect().height,
			shellHeight: document.querySelector('#shell')!.getBoundingClientRect().height,
			mixedVisible: document.querySelector('#mixed')!.getBoundingClientRect().height > 0,
			rows: document.querySelectorAll('.metadata-property').length,
		}));
		expect(result).toEqual({ id: "none", paper: "none", user: "flex", onlyHeight: 0, shellHeight: 0, mixedVisible: true, rows: 4 });
	} finally { await page.close(); }
});
