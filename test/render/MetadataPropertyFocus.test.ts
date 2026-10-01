import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";

const hostCss = readFileSync(fileURLToPath(new URL("./obsidianMetadataHost.css", import.meta.url)), "utf8");

describe("a new property takes focus before the metadata observer runs", () => {
	it.each(["absent", "empty"] as const)("an id-only block with a %s row key", async (key) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(`
				<div class="markdown-source-view is-live-preview show-properties">
					<div class="metadata-container handwriting-metadata-id-only" data-property-count="1">
						<div class="metadata-properties">
							<div class="metadata-property" data-property-key="handwriting-page-id">id</div>
						</div>
					</div>
				</div>
			`);
			// Put the host sheet last to require our selector to win by specificity.
			await page.addStyleTag({ content: css + "\n" + hostCss });
			const result = await page.evaluate((rowKey) => {
				const container = document.querySelector<HTMLElement>(".metadata-container")!;
				const list = container.querySelector<HTMLElement>(".metadata-properties")!;
				const before = getComputedStyle(container).display;
				const row = document.createElement("div");
				row.className = "metadata-property";
				if (rowKey === "empty") row.setAttribute("data-property-key", "");
				const input = document.createElement("input");
				row.appendChild(input);
				list.appendChild(row);
				container.setAttribute("data-property-count", "2");
				// The host focuses in this same task. Do not yield to an observer or frame.
				input.focus();
				return {
					before,
					rowKey: row.getAttribute("data-property-key"),
					classAtFocus: container.classList.contains("handwriting-metadata-id-only"),
					displayAtFocus: getComputedStyle(container).display,
					focused: document.activeElement === input,
				};
			}, key);
			expect(result.before).toBe("none");
			expect(result.rowKey).toBe(key === "empty" ? "" : null);
			expect(result.classAtFocus).toBe(true);
			expect(result.displayAtFocus).not.toBe("none");
			expect(result.focused).toBe(true);
		} finally {
			await browser.close();
		}
	}, 30_000);
});
