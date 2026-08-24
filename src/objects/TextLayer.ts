import { App, Component, MarkdownRenderer } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { TextBoxData } from "../model/PageData";

/**
 * OneNote-style text containers (handoff §15, §16, §55, §56, §74).
 *
 * Every container lives in one DOM layer that carries a single CSS transform
 * for the whole camera, so panning and zooming a page with fifty text boxes
 * costs one transform update rather than fifty layout writes. Boxes are laid
 * out in world units inside that layer.
 *
 * Idle boxes render through Obsidian's own Markdown renderer, so wiki links,
 * tags and embeds are real (§17, §73). Editing swaps in a plain textarea:
 * one lightweight editor at a time, never a CodeMirror per box (§16).
 *
 * The layer itself is pointer-transparent: ink must be able to cross a text
 * box (§6). Only the active editor and the move handle accept pointer events,
 * and both are marked `.handwriting-ui` so the pointer router leaves them alone.
 */

export interface TextBoxModel {
	data: TextBoxData;
	text: string;
}

export interface TextLayerCallbacks {
	/** Text committed for a box (on blur / Escape / edit end). */
	onTextChanged(id: string, text: string): void;
	/** A move gesture finished. `from` is where the box was when it started. */
	onMoved(id: string, from: { x: number; y: number }, to: { x: number; y: number }): void;
	/** A box was left empty and should disappear. */
	onEmptied(id: string): void;
	/** Editing began or ended. The view uses this to decide who owns Ctrl+Z. */
	onEditingChanged(id: string | null): void;
}

interface BoxView {
	model: TextBoxModel;
	el: HTMLElement;
	content: HTMLElement;
	editor: HTMLTextAreaElement | null;
	handle: HTMLElement;
	/** What the content element currently shows, so moves don't re-render. */
	rendered: string | null;
}

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 80;

export class TextLayer {
	readonly el: HTMLElement;
	private boxes = new Map<string, BoxView>();
	private editingId: string | null = null;
	private cam: CameraState = { x: 0, y: 0, zoom: 1 };

	constructor(
		parent: HTMLElement,
		private app: App,
		private component: Component,
		private sourcePath: string,
		private cb: TextLayerCallbacks
	) {
		this.el = parent.createDiv({ cls: "handwriting-objects" });
	}

	get isEditing(): boolean {
		return this.editingId !== null;
	}

	get editingBoxId(): string | null {
		return this.editingId;
	}

	setSourcePath(path: string): void {
		this.sourcePath = path;
	}

	setCamera(cam: CameraState): void {
		this.cam = cam;
		this.el.style.transform = `translate(${-cam.x * cam.zoom}px, ${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
	}

	/** Rebuild from scratch, used on page load. */
	setAll(models: TextBoxModel[]): void {
		this.editingId = null;
		this.el.empty();
		this.boxes.clear();
		for (const m of models) this.upsert(m);
	}

	upsert(model: TextBoxModel): void {
		const existing = this.boxes.get(model.data.id);
		if (existing) {
			const textChanged = existing.model.text !== model.text;
			existing.model = model;
			this.applyGeometry(existing);
			if (existing.editor) {
				if (textChanged) existing.editor.value = model.text;
			} else if (textChanged || existing.rendered !== model.text) {
				void this.renderContent(existing);
			}
			return;
		}
		const el = this.el.createDiv({ cls: "handwriting-box" });
		const content = el.createDiv({ cls: "handwriting-box-content" });
		const handle = el.createDiv({ cls: "handwriting-box-handle handwriting-ui" });
		handle.setAttribute("aria-label", "Move text box");
		const view: BoxView = { model, el, content, editor: null, handle, rendered: null };
		this.boxes.set(model.data.id, view);
		this.applyGeometry(view);
		void this.renderContent(view);
		this.wireHandle(view);
	}

	remove(id: string): void {
		const view = this.boxes.get(id);
		if (!view) return;
		if (this.editingId === id) {
			this.editingId = null;
			this.cb.onEditingChanged(null);
		}
		view.el.remove();
		this.boxes.delete(id);
	}

	get(id: string): TextBoxModel | undefined {
		return this.boxes.get(id)?.model;
	}

	private applyGeometry(view: BoxView): void {
		const d = view.model.data;
		view.el.style.left = `${d.x}px`;
		view.el.style.top = `${d.y}px`;
		view.el.style.width = `${Math.max(MIN_WIDTH, d.width)}px`;
		view.el.style.zIndex = String(d.z);
	}

	private async renderContent(view: BoxView): Promise<void> {
		view.content.empty();
		const text = view.model.text;
		view.rendered = text;
		if (text.trim().length === 0) {
			view.content.addClass("is-empty");
			return;
		}
		view.content.removeClass("is-empty");
		try {
			await MarkdownRenderer.render(
				this.app,
				text,
				view.content,
				this.sourcePath,
				this.component
			);
		} catch (err) {
			// A rendering failure must never lose the words.
			console.error("[handwriting] markdown render failed", err);
			view.content.setText(text);
		}
	}

	/** World-space rect of a box, using its measured height. */
	rectOf(id: string): { x: number; y: number; width: number; height: number } | null {
		const view = this.boxes.get(id);
		if (!view) return null;
		const d = view.model.data;
		return {
			x: d.x,
			y: d.y,
			width: Math.max(MIN_WIDTH, d.width),
			// offsetHeight is in world units: the layer's scale is the camera's.
			height: Math.max(24, view.el.offsetHeight),
		};
	}

	/** Topmost box containing a world point, or null. */
	hitTest(wx: number, wy: number): string | null {
		let best: string | null = null;
		let bestZ = -Infinity;
		for (const [id, view] of this.boxes) {
			const r = this.rectOf(id);
			if (!r) continue;
			if (wx < r.x || wy < r.y || wx > r.x + r.width || wy > r.y + r.height) continue;
			if (view.model.data.z >= bestZ) {
				bestZ = view.model.data.z;
				best = id;
			}
		}
		return best;
	}

	// ---- editing ------------------------------------------------------------

	beginEdit(id: string, initialChar?: string): void {
		const view = this.boxes.get(id);
		if (!view) return;
		if (this.editingId && this.editingId !== id) this.endEdit();

		const editor = view.el.createEl("textarea", {
			cls: "handwriting-box-editor handwriting-ui",
		});
		editor.value = initialChar ? view.model.text + initialChar : view.model.text;
		editor.spellcheck = false;
		view.el.addClass("is-editing");
		view.editor = editor;
		view.content.setCssStyles({ display: "none" });
		this.editingId = id;
		this.cb.onEditingChanged(id);

		const autoGrow = () => {
			editor.setCssStyles({ height: "auto" });
			editor.setCssStyles({ height: `${editor.scrollHeight}px` });
		};
		editor.addEventListener("input", () => {
			view.model.text = editor.value;
			autoGrow();
			this.cb.onTextChanged(id, editor.value);
		});
		editor.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				ev.preventDefault();
				ev.stopPropagation();
				this.endEdit();
				return;
			}
			// Ctrl+Z/Y belong to the text editor while it has focus (§23), so
			// stop those from reaching the canvas. Everything else keeps
			// bubbling, or we would break Obsidian's own hotkeys mid-sentence.
			const mod = ev.ctrlKey || ev.metaKey;
			const key = ev.key.toLowerCase();
			if (mod && (key === "z" || key === "y")) ev.stopPropagation();
		});
		editor.addEventListener("blur", () => {
			if (this.editingId === id) this.endEdit();
		});

		autoGrow();
		editor.focus();
		editor.setSelectionRange(editor.value.length, editor.value.length);
	}

	endEdit(): void {
		const id = this.editingId;
		if (!id) return;
		const view = this.boxes.get(id);
		this.editingId = null;
		if (view?.editor) {
			const text = view.editor.value;
			view.model.text = text;
			view.editor.remove();
			view.editor = null;
			view.el.removeClass("is-editing");
			view.content.setCssStyles({ display: "" });
			void this.renderContent(view);
			this.cb.onTextChanged(id, text);
			if (text.trim().length === 0) this.cb.onEmptied(id);
		}
		this.cb.onEditingChanged(null);
	}

	// ---- moving -------------------------------------------------------------

	private wireHandle(view: BoxView): void {
		let start: { px: number; py: number; x: number; y: number } | null = null;
		view.handle.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			start = {
				px: ev.clientX,
				py: ev.clientY,
				x: view.model.data.x,
				y: view.model.data.y,
			};
			view.handle.setPointerCapture(ev.pointerId);
		});
		view.handle.addEventListener("pointermove", (ev) => {
			if (!start) return;
			ev.stopPropagation();
			// Screen delta → world delta: the only place the layer needs zoom.
			view.model.data.x = start.x + (ev.clientX - start.px) / this.cam.zoom;
			view.model.data.y = start.y + (ev.clientY - start.py) / this.cam.zoom;
			this.applyGeometry(view);
		});
		const finish = (ev: PointerEvent) => {
			if (!start) return;
			ev.stopPropagation();
			const from = { x: start.x, y: start.y };
			const to = { x: view.model.data.x, y: view.model.data.y };
			start = null;
			if (from.x !== to.x || from.y !== to.y) {
				this.cb.onMoved(view.model.data.id, from, to);
			}
		};
		view.handle.addEventListener("pointerup", finish);
		view.handle.addEventListener("pointercancel", finish);
	}

	static defaultWidth(): number {
		return DEFAULT_WIDTH;
	}
}
