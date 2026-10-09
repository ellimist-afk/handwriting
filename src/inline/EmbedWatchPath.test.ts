import { afterEach, describe, expect, it } from "vitest";
import {
	attachEmbedInk,
	embedInkChanged,
	embedInkFileOpened,
	embedInkRenamed,
	embedInkSizeWatchCount,
	initEmbedInkRefresh,
	teardownEmbedInk,
} from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

const MARKER = "data-handwriting-embed-ink";

function stroke(height: number): InkStroke {
	return {
		id: `s${height}`,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [],
		bbox: { x: 0, y: 0, width: 200, height },
	} as unknown as InkStroke;
}

/**
 * A tab's reading-view root (`.markdown-preview-view`). Obsidian keeps it
 * connected but `display: none` while the tab is in Live Preview, so it
 * measures 0x0 until the tab goes back to reading view.
 */
function readingViewRoot() {
	const attrs = new Map<string, string>();
	const observers: Array<() => void> = [];
	let rect = { width: 800, height: 600 };
	class FakeResizeObserver {
		constructor(private readonly cb: () => void) {}
		observe(): void {
			observers.push(() => this.cb());
		}
		unobserve(): void {}
		disconnect(): void {}
	}
	const style: Record<string, unknown> = { position: "relative", display: "", removeProperty(): void {} };
	return {
		style,
		isConnected: true,
		parentElement: null,
		hide(): void {
			style.display = "none";
			rect = { width: 0, height: 0 };
		},
		show(): void {
			style.display = "";
			rect = { width: 800, height: 600 };
			for (const fire of [...observers]) fire();
		},
		classList: { contains: (c: string) => c === "markdown-preview-view" },
		setCssStyles(): void {},
		getBoundingClientRect: () => rect,
		querySelector: () => null,
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => ({
			style: {},
			width: 0,
			height: 0,
			setCssStyles() {},
			getContext: () => ({ setTransform() {}, clearRect() {}, globalAlpha: 1 }),
			remove() {},
		}),
		ownerDocument: {
			defaultView: {
				addEventListener() {},
				removeEventListener() {},
				getComputedStyle: () => ({ position: "relative" }),
				devicePixelRatio: 1,
				ResizeObserver: FakeResizeObserver,
			},
		},
	};
}

afterEach(() => teardownEmbedInk());

describe("a hidden reading view repaints the note it shows NOW when it is shown again", () => {
	it("another note opened in the tab while it was in Live Preview: no ink from the previous note", () => {
		const ink = new Map<string, InkStroke[]>([
			["prev.md", [stroke(900)]],
			["next.md", [stroke(50)]],
		]);
		const asked: string[] = [];
		initEmbedInkRefresh((p) => (asked.push(p), ink.get(p) ?? []));
		const tab = readingViewRoot();
		attachEmbedInk(tab as unknown as HTMLElement, "prev.md", ink.get("prev.md")!);

		tab.hide(); // the tab switches to Live Preview
		embedInkChanged("prev.md"); // a stroke on prev.md: hidden root is left to the size watch
		expect(embedInkSizeWatchCount()).toBe(1);

		// file-open: the same tab now shows next.md (main.ts -> embedInkFileOpened).
		embedInkFileOpened({ contains: (n: Node) => (n as unknown) === tab }, "next.md");

		tab.show(); // back to reading view: the size watch fires
		expect(asked.at(-1)).toBe("next.md");
		expect(tab.getAttribute(MARKER)?.startsWith("next.md@")).toBe(true);
	});

	it("note renamed while its reading view was hidden: its ink is still drawn", () => {
		const ink = new Map<string, InkStroke[]>([["old.md", [stroke(368)]]]);
		const asked: string[] = [];
		initEmbedInkRefresh((p) => (asked.push(p), ink.get(p) ?? []));
		const tab = readingViewRoot();
		attachEmbedInk(tab as unknown as HTMLElement, "old.md", ink.get("old.md")!);

		tab.hide();
		embedInkChanged("old.md");
		expect(embedInkSizeWatchCount()).toBe(1);

		// main.ts rename handler: the store moves the record, then the layers follow.
		ink.set("new.md", ink.get("old.md")!);
		ink.delete("old.md");
		embedInkRenamed("old.md", "new.md");

		tab.show();
		expect(asked.at(-1)).toBe("new.md");
		expect(tab.getAttribute(MARKER)?.startsWith("new.md@")).toBe(true);
	});
});
