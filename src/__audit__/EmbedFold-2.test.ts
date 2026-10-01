/**
 * AUDIT PROBE EmbedFold-2 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: the id-only Properties class (`handwriting-metadata-id-only`) is computed only inside the
 * overlay's `.markdown-source-view` (InkOverlay.ts:2742-2743, observer :2758, recompute :2754/:2771,
 * MetadataVisibility.ts:40). Obsidian 1.13.7 keeps ONE metadataEditor.containerEl per MarkdownView and
 * moves it: MarkdownPreviewView.show does `renderer.header.el.appendChild(view.metadataEditor.containerEl)`
 * (the reading view is a sibling of `.markdown-source-view` under view.contentEl), MarkdownEditView.show
 * does `sizerEl.prepend(containerEl)`. MetadataEditor.synchronize never touches the container's classes
 * (only data-property-count / mod-error). So a container marked id-only in Live Preview keeps the class
 * after Ctrl+E, and when the same tab opens a note with real properties in reading view
 * (setViewData(clear) -> every mode set, loadFrontmatter -> synchronize), the stylesheet rule
 * `.markdown-preview-view.show-properties .metadata-container.handwriting-metadata-id-only {display:none}`
 * hides that note's whole Properties block.
 *
 * Rig: the REAL InkOverlayPlugin.prototype.updateHandwritingPageClass (which builds the real
 * MutationObserver callback, gate isMetadataMutation, and calls the real updateMetadataVisibility),
 * run on an object built off the prototype (pattern of InkOverlay-3-1 / K4 probes). A tiny tree DOM
 * stands in for the browser with the exact element shapes Obsidian builds; a fake MutationObserver
 * delivers childList/attribute records only for targets inside the observed root (subtree semantics).
 * The Obsidian actions are the DOM operations app.js performs (quoted above), nothing more.
 *
 * Assertions state the CORRECT behaviour: a note whose Properties hold real keys must not carry the
 * id-only class in reading view. Green = no bug, red = bug.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import css from "../../styles.css?raw";
import { InkOverlayPlugin } from "../inline/InkOverlay";
import { clearMetadataVisibility, ID_ONLY_METADATA_CLASS } from "../inline/MetadataVisibility";

type Fields = Record<string, unknown>;

// ---------------------------------------------------------------- tiny tree DOM
interface Rec {
	type: "childList" | "attributes";
	target: El;
	addedNodes: El[];
	removedNodes: El[];
	attributeName?: string;
}

const observers: FakeMO[] = [];

class FakeMO {
	root: El | null = null;
	queue: Rec[] = [];
	constructor(private readonly cb: (records: Rec[]) => void) {
		observers.push(this);
	}
	observe(root: El): void {
		this.root = root;
	}
	disconnect(): void {
		this.root = null;
	}
	deliver(): void {
		if (this.queue.length === 0) return;
		const q = this.queue;
		this.queue = [];
		this.cb(q);
	}
}

function notify(rec: Rec): void {
	for (const mo of observers) {
		if (mo.root && mo.root.containsInclusive(rec.target)) mo.queue.push(rec);
	}
}

class El {
	readonly nodeType = 1;
	parentElement: El | null = null;
	children: El[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	ownerDocument: unknown = null;
	constructor(cls: string, attrs: Record<string, string> = {}) {
		for (const c of cls.split(/\s+/).filter(Boolean)) this.classes.add(c);
		for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
	}
	readonly classList = {
		toggle: (name: string, force?: boolean): boolean => {
			const on = force ?? !this.classes.has(name);
			if (on) this.classes.add(name);
			else this.classes.delete(name);
			return on;
		},
		add: (name: string): void => void this.classes.add(name),
		remove: (name: string): void => void this.classes.delete(name),
		contains: (name: string): boolean => this.classes.has(name),
	};
	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
		notify({ type: "attributes", target: this, addedNodes: [], removedNodes: [], attributeName: name });
	}
	private static simple(el: El, sel: string): boolean {
		const m = /^\.([\w-]+)$/.exec(sel);
		if (!m) throw new Error(`El: unsupported selector ${sel}`);
		return el.classes.has(m[1]!);
	}
	matches(sel: string): boolean {
		return El.simple(this, sel);
	}
	closest(sel: string): El | null {
		for (let e: El | null = this; e; e = e.parentElement) if (El.simple(e, sel)) return e;
		return null;
	}
	querySelectorAll<T = El>(sel: string): T[] {
		const out: El[] = [];
		const walk = (e: El): void => {
			for (const c of e.children) {
				if (El.simple(c, sel)) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out as unknown as T[];
	}
	querySelector(sel: string): El | null {
		return this.querySelectorAll(sel)[0] ?? null;
	}
	containsInclusive(other: El): boolean {
		for (let e: El | null = other; e; e = e.parentElement) if (e === this) return true;
		return false;
	}
	/** DOM appendChild: moves a node that already has a parent (removal record there first). */
	appendChild(child: El): El {
		const old = child.parentElement;
		if (old) {
			old.children = old.children.filter((c) => c !== child);
			child.parentElement = null;
			notify({ type: "childList", target: old, addedNodes: [], removedNodes: [child] });
		}
		this.children.push(child);
		child.parentElement = this;
		notify({ type: "childList", target: this, addedNodes: [child], removedNodes: [] });
		return child;
	}
	/** Element.setChildrenInPlace as MetadataEditor.synchronize uses it on propertyListEl. */
	replaceChildren(...kids: El[]): void {
		const removed = this.children;
		for (const c of removed) c.parentElement = null;
		this.children = [];
		for (const k of kids) {
			this.children.push(k);
			k.parentElement = this;
		}
		notify({ type: "childList", target: this, addedNodes: kids, removedNodes: removed });
	}
}

// ---------------------------------------------------------------- rig
function row(key: string): El {
	return new El("metadata-property", { "data-property-key": key });
}

function buildTab(startPath: string) {
	const frames: Array<() => void> = [];
	const win = {
		requestAnimationFrame: (cb: () => void): number => {
			frames.push(cb);
			return frames.length;
		},
		cancelAnimationFrame: (): void => undefined,
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	};
	const doc = { defaultView: win };

	// MarkdownView.contentEl
	const contentEl = new El("view-content");
	// MarkdownEditView: editorEl `.markdown-source-view` > .cm-editor (view.dom) > .cm-scroller > .cm-sizer
	const sourceView = contentEl.appendChild(
		new El("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview show-properties")
	);
	const cmEditor = sourceView.appendChild(new El("cm-editor"));
	const scroller = cmEditor.appendChild(new El("cm-scroller"));
	const sizer = scroller.appendChild(new El("cm-sizer"));
	// MarkdownPreviewView: contentEl.createDiv("markdown-reading-view") > .markdown-preview-view > header
	const readingView = contentEl.appendChild(new El("markdown-reading-view"));
	const previewView = readingView.appendChild(
		new El("markdown-preview-view markdown-rendered show-properties")
	);
	const header = previewView.appendChild(new El("mod-header"));
	// MetadataEditor.containerEl, created once per MarkdownView (oN constructor).
	const container = new El("metadata-container", { "data-property-count": "0" });
	const propertyList = container.appendChild(new El("metadata-properties"));
	for (const e of [contentEl, sourceView, cmEditor, scroller, sizer, readingView, previewView, header, container, propertyList])
		e.ownerDocument = doc;
	// MarkdownEditView.show: sizerEl.prepend(containerEl) - Live Preview is the default mode.
	sizer.appendChild(container);

	let current = startPath;
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		dom: cmEditor,
		state: { field: () => ({ file: { path: current } }), sliceDoc: () => "" },
	};
	o.pageClassHost = null;
	o.metadataObserver = null;
	o.metadataFrame = null;

	const flush = (): void => {
		for (let i = 0; i < 5; i++) {
			for (const mo of observers) mo.deliver();
			const due = frames.splice(0);
			for (const f of due) f();
		}
	};
	const updateClass = (): void => {
		(o.updateHandwritingPageClass as () => void).call(o);
		flush();
	};
	/** MetadataEditor.synchronize: rows rendered into the SAME container, count attribute updated. */
	const synchronize = (keys: string[]): void => {
		propertyList.replaceChildren(...keys.map(row));
		container.setAttribute("data-property-count", String(keys.length));
		flush();
	};
	return {
		o,
		contentEl,
		container,
		sourceView,
		sizer,
		previewView,
		header,
		flush,
		deliverMutations: (): void => { for (const mo of observers) mo.deliver(); },
		pendingFrames: (): number => frames.length,
		updateClass,
		synchronize,
		setPath: (p: string) => {
			current = p;
		},
		idOnly: () => container.classList.contains(ID_ONLY_METADATA_CLASS),
	};
}

(globalThis as { MutationObserver?: unknown }).MutationObserver = FakeMO;

const ID_ONLY_NOTE = "embedfold2-id-only.md";
const REAL_PROPS_NOTE = "embedfold2-with-tags.md";

describe("EmbedFold-2: id-only Properties class goes stale when the container moves to reading view", () => {
	it("precondition: the shipped stylesheet hides the classed container in reading view", () => {
		expect(css).toContain(
			".markdown-preview-view.show-properties .metadata-container.handwriting-metadata-id-only"
		);
	});

	it("CONTROL (Live Preview): same-tab switch to a note with real properties clears the class", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass(); // mount (InkOverlay.ts:2608)
		expect(t.idOnly()).toBe(true); // the id-only note's block is hidden: intended

		// Same tab, still Live Preview: setViewData(clear) -> synchronize; overlay path-change -> :3207
		t.synchronize(["tags", "aliases", "handwriting-page-id"]);
		t.setPath(REAL_PROPS_NOTE);
		t.updateClass();
		expect(t.idOnly()).toBe(false);
	});

	it("reading view: a note with real properties opened in the same tab must not carry the id-only class", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass(); // mount
		expect(t.idOnly()).toBe(true); // precondition: class set while in Live Preview

		// Ctrl+E: MarkdownPreviewView.show -> renderer.header.el.appendChild(metadataEditor.containerEl)
		t.header.appendChild(t.container);
		t.flush();
		// preconditions: the container really moved out of the observed root, into the reading view,
		// and the overlay (edit mode is only hidden, not destroyed) still observes its source view.
		expect(t.sourceView.containsInclusive(t.container)).toBe(false);
		expect(t.previewView.containsInclusive(t.container)).toBe(true);
		expect(t.o.pageClassHost).toBe(t.sourceView);
		expect((t.o.metadataObserver as FakeMO).root).toBe(t.contentEl);

		// Follow a link in the same tab (openFile passes no mode -> reading view kept).
		// setViewData(clear): every mode is set, so the hidden editor changes file and the overlay's
		// path-change branch runs updateHandwritingPageClass (InkOverlay.ts:3207); loadFrontmatter ->
		// metadataEditor.synchronize renders the new note's rows into the same container.
		t.synchronize(["tags", "aliases"]);
		t.setPath(REAL_PROPS_NOTE);
		t.updateClass();
		expect(t.container.getAttribute("data-property-count")).toBe("2"); // the rows are really there

		// CORRECT: the note has tags and aliases, so its Properties block must not be hidden.
		expect(
			t.idOnly(),
			"container in reading view still carries handwriting-metadata-id-only after the tab opened a note with real properties"
		).toBe(false);
	});

	it("reading view: an id-only note opened directly hides its empty Properties block", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.header.appendChild(t.container);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass();
		expect(t.idOnly()).toBe(true);
	});

	it("reading view: a property change updates the moved container without an editor path event", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass();
		expect(t.idOnly()).toBe(true);
		t.header.appendChild(t.container);
		t.flush();
		t.synchronize(["tags", "aliases"]);
		expect(t.idOnly()).toBe(false);
	});

	it("editor and reading-view redraws do not schedule a Properties update", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass();
		expect((t.o.metadataObserver as FakeMO).root).toBe(t.contentEl);
		t.sourceView.appendChild(new El("cm-line"));
		t.previewView.appendChild(new El("markdown-preview-section"));
		t.deliverMutations();
		expect(t.pendingFrames()).toBe(0);
	});

	it("unmount clears the class after the container moved to reading view", () => {
		const t = buildTab(ID_ONLY_NOTE);
		t.synchronize(["handwriting-page-id"]);
		t.updateClass();
		t.header.appendChild(t.container);
		t.flush();
		expect(t.idOnly()).toBe(true);
		clearMetadataVisibility(t.sourceView as unknown as ParentNode);
		expect(t.idOnly()).toBe(false);
	});
});
