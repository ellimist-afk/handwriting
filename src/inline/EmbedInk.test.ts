import { describe, expect, it } from "vitest";
import {
	attachEmbedInk,
	embedInkExtent,
	embedInkLayerCount,
	embedInkMarker,
	embedInkNeedsPaint,
	embedInkAnchor,
	embedInkRootFor,
	embedInkRootIsEmbed,
	embedInkScale,
	teardownEmbedInk,
} from "./EmbedInk";
import { InkStroke } from "../ink/Stroke";

function strokeWithBBox(x: number, y: number, width: number, height: number): InkStroke {
	return {
		id: "s",
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [],
		bbox: { x, y, width, height },
	} as unknown as InkStroke;
}

describe("embedInkExtent", () => {
	it("covers the farthest stroke corner, rounded up", () => {
		const { w, h } = embedInkExtent([
			strokeWithBBox(10, 20, 30.2, 5),
			strokeWithBBox(0, 90.5, 5, 5.4),
		]);
		expect(w).toBe(41);
		expect(h).toBe(96);
	});

	it("never clips, however far down the page the ink goes", () => {
		// The 2048-per-side cap this replaces did not bound cost - two capped
		// sides still buy 4.2M pixels - and it silently dropped every stroke
		// below the line on a long note, in reading view and in anything
		// printed from it.
		const { w, h } = embedInkExtent([strokeWithBBox(0, 0, 900, 9000)]);
		expect(w).toBe(900);
		expect(h).toBe(9000);
	});

	it("empty input has zero extent", () => {
		expect(embedInkExtent([])).toEqual({ w: 0, h: 0 });
	});
});

describe("embedInkScale", () => {
	it("renders at the display's resolution when it fits", () => {
		expect(embedInkScale(800, 1000, 2)).toBe(2);
		expect(embedInkScale(800, 1000, 1)).toBe(1);
	});

	it("never renders below the css size", () => {
		expect(embedInkScale(800, 1000, 0.5)).toBe(1);
	});

	it("spends resolution, not strokes, when the page is enormous", () => {
		// Never clips. A page can hold as much ink as someone wants to draw;
		// what gives way under an enormous one is sharpness, not content.
		const scale = embedInkScale(2000, 20000, 3);
		expect(scale).toBeLessThan(1);
		expect(2000 * 20000 * scale * scale).toBeLessThanOrEqual(4_000_000 + 1);
	});

	it("has nothing to say about an empty layer", () => {
		expect(embedInkScale(0, 0, 2)).toBe(1);
	});
});

describe("embedInkMarker", () => {
	it("a moved revision changes the marker; a stable one does not", () => {
		expect(embedInkMarker("a.md", 0)).toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("a.md", 1)).not.toBe(embedInkMarker("a.md", 0));
		expect(embedInkMarker("b.md", 0)).not.toBe(embedInkMarker("a.md", 0));
	});
});

describe("embedInkNeedsPaint (reading view drops the canvas, keeps the marker)", () => {
	const marker = embedInkMarker("note.md", 3);

	it("repaints when the canvas is gone even though the marker matches", () => {
		// The reported bug: reading view re-renders sections while keeping
		// the sizer, so the canvas disappears and the attribute survives. A
		// marker-only check called that up to date and drew nothing.
		expect(embedInkNeedsPaint(marker, marker, false)).toBe(true);
	});

	it("stands down when the marker matches and the canvas is still there", () => {
		expect(embedInkNeedsPaint(marker, marker, true)).toBe(false);
	});

	it("repaints when the revision moved", () => {
		expect(embedInkNeedsPaint(embedInkMarker("note.md", 2), marker, true)).toBe(true);
	});

	it("paints a root that has never been marked", () => {
		expect(embedInkNeedsPaint(null, marker, false)).toBe(true);
	});
});

/**
 * A minimal stand-in for the one DOM method `embedInkRoot` calls: `closest`,
 * walking a `parent` chain. A real element carries many classes at once -
 * a Live Preview table widget is `cm-embed-block cm-table-widget
 * markdown-rendered` - so each fake node takes a set, not a single class.
 * Still no jsdom (see the teardown fakes below): `closest` is all either
 * function touches, so a real element would only add ceremony.
 */
function fakeNode(
	classes: string | string[] | null,
	parent: { closest(sel: string): unknown } | null = null
) {
	const set = new Set(Array.isArray(classes) ? classes : classes ? [classes] : []);
	const node = {
		closest(sel: string): unknown {
			const wanted = sel.replace(/^\./, "");
			return set.has(wanted) ? node : (parent?.closest(sel) ?? null);
		},
	};
	return node;
}

describe("embedInkRootFor (the renderer loads a section before inserting it)", () => {
	it("climbs from a detached section's container to the embed content around it", () => {
		// The virtualised renderer's own case: the section is not in any
		// tree yet, but the sizer it will eventually sit in already is.
		const embedContent = fakeNode("markdown-embed-content");
		const sizer = fakeNode("markdown-preview-sizer", embedContent);
		const detachedSection = fakeNode(null); // no class, no parent: unreachable via closest
		expect(embedInkRootFor(detachedSection as unknown as HTMLElement, sizer as unknown as HTMLElement)).toBe(
			embedContent
		);
	});

	it("prefers the preview view over the sizer inside it, in a plain reading view", () => {
		// The sizer is nearer the section and used to win, but the renderer
		// evicts a canvas appended to it. The view survives a re-render.
		const view = fakeNode("markdown-preview-view");
		const sizer = fakeNode("markdown-preview-sizer", view);
		const section = fakeNode(null, sizer);
		expect(embedInkRootFor(section as unknown as HTMLElement, null)).toBe(view);
	});

	it("still falls back to a bare sizer when nothing recognisable sits above it", () => {
		// An evicted canvas is a better failure than no root at all.
		const sizer = fakeNode("markdown-preview-sizer");
		const detachedSection = fakeNode(null);
		expect(embedInkRootFor(detachedSection as unknown as HTMLElement, sizer as unknown as HTMLElement)).toBe(
			sizer
		);
	});

	it("keeps an embed on its own content box, never the view inside it", () => {
		// An embed holds a preview view of its own; the content box must keep
		// winning, or every embed's ink would move by that view's margins.
		const embedContent = fakeNode("markdown-embed-content");
		const view = fakeNode("markdown-preview-view", embedContent);
		const sizer = fakeNode("markdown-preview-sizer", view);
		const section = fakeNode(null, sizer);
		expect(embedInkRootFor(section as unknown as HTMLElement, null)).toBe(embedContent);
	});

	it("prefers the section's own root when it is already attached, ignoring the container", () => {
		const embedContent = fakeNode("markdown-embed-content");
		const attachedSection = fakeNode(null, embedContent);
		const unrelatedContainer = fakeNode("markdown-preview-sizer");
		expect(
			embedInkRootFor(attachedSection as unknown as HTMLElement, unrelatedContainer as unknown as HTMLElement)
		).toBe(embedContent);
	});

	it("returns null when the section is detached and there is no container to fall back to", () => {
		const detachedSection = fakeNode(null);
		expect(embedInkRootFor(detachedSection as unknown as HTMLElement, null)).toBeNull();
		expect(embedInkRootFor(detachedSection as unknown as HTMLElement, undefined)).toBeNull();
	});
});

describe("embedInkRoot territory rule: editor chrome is not an embed root", () => {
	it("returns null for a table widget, even though it carries markdown-rendered", () => {
		// The Live Preview table widget's wrapper has class
		// `cm-embed-block cm-table-widget markdown-rendered` and used to be
		// picked by the final fallback, giving it a frozen copy of the
		// note's ink painted over the table.
		const cmEditor = fakeNode("cm-editor");
		const tableWidget = fakeNode(
			["cm-embed-block", "cm-table-widget", "markdown-rendered"],
			cmEditor
		);
		const section = fakeNode(null, tableWidget);
		expect(embedInkRootFor(section as unknown as HTMLElement, null)).toBeNull();
	});

	it("returns null for a callout, even though it carries markdown-rendered", () => {
		const cmEditor = fakeNode("cm-editor");
		const callout = fakeNode(["callout", "markdown-rendered"], cmEditor);
		const section = fakeNode(null, callout);
		expect(embedInkRootFor(section as unknown as HTMLElement, null)).toBeNull();
	});

	it("returns null when the container fallback would also land in the editor", () => {
		// `embedInkResolveRoot` tries the section, then the renderer's
		// container. Both are inside the editor for editor chrome; the
		// guard must reject both, not just the section.
		const cmEditor = fakeNode("cm-editor");
		const tableWidget = fakeNode(["cm-table-widget", "markdown-rendered"], cmEditor);
		const detachedSection = fakeNode(null);
		expect(
			embedInkRootFor(
				detachedSection as unknown as HTMLElement,
				tableWidget as unknown as HTMLElement
			)
		).toBeNull();
	});

	it("keeps painting an embedded note's own content, which lives inside the editor", () => {
		// A `![[note]]` embed in Live Preview sits inside the host
		// `.cm-editor`, but its ink is not what the host InkOverlay
		// paints - the embed needs its own surface. Regression guard: the
		// territory rule must not swallow this case.
		const cmEditor = fakeNode("cm-editor");
		const embedContent = fakeNode("markdown-embed-content", cmEditor);
		const section = fakeNode(null, embedContent);
		expect(embedInkRootFor(section as unknown as HTMLElement, null)).toBe(embedContent);
	});
});

/**
 * Unload takes the layers back out of the DOM (audit, 2026-09-01).
 *
 * These layers live in rendered views, hover previews and exported panes -
 * someone else's tree, which Obsidian does not clean up for us. Disabling the
 * plugin left the canvas, the marker attribute and the `position: relative`
 * patch behind on every rendered embed, still showing ink from a plugin that
 * was no longer running, until each section happened to re-render.
 *
 * No jsdom here, so the root is the smallest object the code actually
 * touches. Zero strokes on purpose: paint() returns before it needs a
 * canvas context, which keeps the fake to the surface under test.
 */
function fakeRoot() {
	const attrs = new Map<string, string>();
	const removed: string[] = [];
	return {
		removed,
		attrs,
		isConnected: true,
		// Not an embed content box: these tests exercise teardown's generic
		// canvas/marker/position cleanup, which runs the same regardless.
		classList: { contains: () => false },
		style: {
			position: "relative",
			removeProperty(name: string) {
				removed.push(`style:${name}`);
				this.position = "";
			},
		},
		querySelector(sel: string) {
			if (!sel.includes("canvas") && !sel.includes("svg")) return null;
			return { remove: () => removed.push(sel.includes("canvas") ? "canvas" : "svg") };
		},
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void (attrs.delete(k), removed.push(`attr:${k}`)),
		ownerDocument: {
			defaultView: { addEventListener() {}, removeEventListener() {} },
		},
	};
}

describe("teardownEmbedInk", () => {
	it("removes the canvas, the marker and our position patch", () => {
		const root = fakeRoot();
		attachEmbedInk(root as unknown as HTMLElement, "note.md", []);
		expect(embedInkLayerCount()).toBe(1);
		root.removed.length = 0; // attach's own empty-canvas cleanup is not the subject

		teardownEmbedInk();
		expect(root.removed).toContain("canvas");
		expect(root.removed).toContain("svg");
		expect(root.removed.some((r) => r.startsWith("attr:"))).toBe(true);
		expect(root.removed).toContain("style:position");
		expect(embedInkLayerCount()).toBe(0);
	});

	it("leaves a position the plugin did not set", () => {
		// `relative` is ours; anything else belonged to the theme or to
		// Obsidian, and removing it would move somebody else's layout.
		const root = fakeRoot();
		root.style.position = "absolute";
		attachEmbedInk(root as unknown as HTMLElement, "note.md", []);
		root.removed.length = 0;
		teardownEmbedInk();
		expect(root.removed).not.toContain("style:position");
		expect(root.style.position).toBe("absolute");
	});

	it("skips roots the DOM already dropped, and still empties the registry", () => {
		const gone = fakeRoot();
		gone.isConnected = false;
		attachEmbedInk(gone as unknown as HTMLElement, "note.md", []);
		gone.removed.length = 0;
		teardownEmbedInk();
		expect(gone.removed).toEqual([]);
		expect(embedInkLayerCount()).toBe(0);
	});
});

/** A root for `embedInkAnchor`: a class list and one optional child sizer. */
function fakeAnchorRoot(
	cls: string,
	sizer: { offsetLeft: number; offsetTop: number; offsetParent: unknown } | null
) {
	return {
		classList: { contains: (c: string) => c === cls },
		querySelector: (sel: string) => (sel.includes("markdown-preview-sizer") ? sizer : null),
	};
}

describe("embedInkAnchor", () => {
	it("offsets a reading view's layer by its sizer, so the ink does not move", () => {
		const sizer = { offsetLeft: 32, offsetTop: 32, offsetParent: null as unknown };
		const root = fakeAnchorRoot("markdown-preview-view", sizer);
		sizer.offsetParent = root;
		expect(embedInkAnchor(root as unknown as HTMLElement)).toEqual({ left: 32, top: 32 });
	});

	it("leaves an embed's layer where the stylesheet puts it", () => {
		const embed = fakeAnchorRoot("markdown-embed-content", null);
		expect(embedInkAnchor(embed as unknown as HTMLElement)).toBeNull();
	});

	it("keeps the last offset for a reading view that is not laid out", () => {
		// `display: none` gives every offset the value 0, which is a real
		// coordinate and not a missing one.
		const root = fakeAnchorRoot("markdown-preview-view", {
			offsetLeft: 0,
			offsetTop: 0,
			offsetParent: null,
		});
		expect(embedInkAnchor(root as unknown as HTMLElement)).toBeNull();
	});
});

describe("embedInkRootIsEmbed", () => {
	it("recognizes an embed's content box", () => {
		expect(embedInkRootIsEmbed({ classList: { contains: (c) => c === "markdown-embed-content" } })).toBe(
			true
		);
	});

	it("does not mistake a plain reading view's sizer for an embed", () => {
		expect(embedInkRootIsEmbed({ classList: { contains: (c) => c === "markdown-preview-sizer" } })).toBe(
			false
		);
	});
});

/**
 * An embed's content box sizes itself to its TEXT and clips the ink hanging
 * below it (measured: a 24px-tall box against 368px of ink). `paint` grows
 * `.markdown-embed-content` roots to the ink's own height so nothing is lost;
 * a plain reading view's sizer is left alone (its own describe block below).
 *
 * `querySelector` always answers "no canvas yet", same trick as `fakeRoot`
 * above but pushed one step further: it means `paint` never thinks a canvas
 * is already there, so every call re-enters the paint path regardless of
 * marker state, without this suite having to reach into `embedInkChanged`'s
 * revision bookkeeping just to force a second paint.
 */
function fakeEmbedRoot(cls: string) {
	const attrs = new Map<string, string>();
	return {
		isConnected: true,
		classList: { contains: (c: string) => c === cls },
		style: {
			position: "static",
			minHeight: "",
			removeProperty(this: { position: string; minHeight: string }, name: string) {
				if (name === "position") this.position = "";
				if (name === "min-height") this.minHeight = "";
			},
		},
		setCssStyles(this: { style: { position: string; minHeight: string } }, styles: Record<string, string>) {
			if ("position" in styles) this.style.position = styles.position;
			if ("minHeight" in styles) this.style.minHeight = styles.minHeight;
		},
		querySelector: () => null,
		getAttribute: (k: string) => attrs.get(k) ?? null,
		setAttribute: (k: string, v: string) => void attrs.set(k, v),
		removeAttribute: (k: string) => void attrs.delete(k),
		createEl: () => ({
			style: {} as Record<string, string>,
			width: 0,
			height: 0,
			setCssStyles(this: { style: Record<string, string> }, styles: Record<string, string>) {
				Object.assign(this.style, styles);
			},
			getContext: () => ({
				setTransform() {},
				clearRect() {},
				globalAlpha: 1,
			}),
			remove() {},
		}),
		ownerDocument: {
			defaultView: {
				addEventListener() {},
				removeEventListener() {},
				getComputedStyle: (el: { style: { position: string } }) => ({ position: el.style.position }),
				devicePixelRatio: 1,
			},
		},
	};
}

describe("embed min-height (the embed grows to hold ink that would otherwise clip)", () => {
	it("grows an embed root's min-height to the ink's extent after painting strokes", () => {
		const root = fakeEmbedRoot("markdown-embed-content");
		attachEmbedInk(root as unknown as HTMLElement, "note.md", [strokeWithBBox(0, 0, 100, 368)]);
		expect(root.style.minHeight).toBe("368px");
		teardownEmbedInk();
	});

	it("clears the min-height once the last stroke is erased", () => {
		const root = fakeEmbedRoot("markdown-embed-content");
		attachEmbedInk(root as unknown as HTMLElement, "note.md", [strokeWithBBox(0, 0, 100, 368)]);
		expect(root.style.minHeight).toBe("368px");
		attachEmbedInk(root as unknown as HTMLElement, "note.md", []);
		expect(root.style.minHeight).toBe("");
		teardownEmbedInk();
	});

	it("never touches min-height on a plain reading view's sizer", () => {
		const root = fakeEmbedRoot("markdown-preview-sizer");
		attachEmbedInk(root as unknown as HTMLElement, "note.md", [strokeWithBBox(0, 0, 100, 368)]);
		expect(root.style.minHeight).toBe("");
		teardownEmbedInk();
	});

	it("teardown clears the min-height it set", () => {
		const root = fakeEmbedRoot("markdown-embed-content");
		attachEmbedInk(root as unknown as HTMLElement, "note.md", [strokeWithBBox(0, 0, 100, 368)]);
		expect(root.style.minHeight).toBe("368px");
		teardownEmbedInk();
		expect(root.style.minHeight).toBe("");
	});

	it("leaves a foreign min-height alone: paint never wrote it, so teardown won't clear it", () => {
		// Mirrors the `position` revert test above: a value we never recorded
		// as ours (MIN_HEIGHT_ATTR unset) is not ours to remove, whatever it
		// is set to. Zero strokes means `paint` returns before touching
		// min-height at all, so this root's own value stands.
		const root = fakeEmbedRoot("markdown-embed-content");
		root.style.minHeight = "500px";
		attachEmbedInk(root as unknown as HTMLElement, "note.md", []);
		teardownEmbedInk();
		expect(root.style.minHeight).toBe("500px");
	});
});
