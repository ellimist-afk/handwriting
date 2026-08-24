import { App, TFile } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { BBox } from "../ink/Stroke";
import { ImageData } from "../model/PageData";

/**
 * Images on the canvas.
 *
 * The picture itself is an ordinary vault attachment. Handwriting never owns the
 * bytes, only where the picture sits, exactly as it never owns typed words.
 * The element is an `<img>` pointed at the vault's own resource path, so
 * Obsidian's cache, its rename handling and its "attachment is in use"
 * accounting all keep working.
 *
 * Like the text layer, everything lives under one CSS transform, so panning a
 * page full of images is a single composited change and the pictures scale
 * with the camera for free.
 *
 * Structurally this mirrors TextLayer closely. That duplication is deliberate
 * and contained: when a third spatial object type arrives, these two are the
 * evidence for what a shared object layer actually needs.
 */

export interface ImageModel {
	data: ImageData;
	/** Vault path from the Markdown embed. */
	target: string;
}

interface ImageView {
	model: ImageModel;
	el: HTMLElement;
	img: HTMLImageElement;
	resolved: string | null;
}

export class ImageLayer {
	readonly el: HTMLElement;
	private items = new Map<string, ImageView>();

	constructor(
		parent: HTMLElement,
		private app: App,
		private sourcePath: string
	) {
		this.el = parent.createDiv({ cls: "handwriting-images" });
	}

	setSourcePath(path: string): void {
		this.sourcePath = path;
	}

	setCamera(cam: CameraState): void {
		this.el.style.transform = `translate(${-cam.x * cam.zoom}px, ${-cam.y * cam.zoom}px) scale(${cam.zoom})`;
	}

	setAll(models: ImageModel[]): void {
		this.el.empty();
		this.items.clear();
		for (const m of models) this.upsert(m);
	}

	upsert(model: ImageModel): void {
		const existing = this.items.get(model.data.id);
		if (existing) {
			existing.model = model;
			this.applyGeometry(existing);
			if (existing.resolved !== model.target) this.applySource(existing);
			return;
		}
		const el = this.el.createDiv({ cls: "handwriting-image" });
		const img = el.createEl("img");
		img.draggable = false;
		const view: ImageView = { model, el, img, resolved: null };
		this.items.set(model.data.id, view);
		this.applyGeometry(view);
		this.applySource(view);
	}

	remove(id: string): void {
		const view = this.items.get(id);
		if (!view) return;
		view.el.remove();
		this.items.delete(id);
	}

	private applyGeometry(view: ImageView): void {
		const d = view.model.data;
		view.el.style.left = `${d.x}px`;
		view.el.style.top = `${d.y}px`;
		view.el.style.width = `${d.width}px`;
		view.el.style.height = `${d.height}px`;
		view.el.style.zIndex = String(d.z);
	}

	private applySource(view: ImageView): void {
		const target = view.model.target;
		view.resolved = target;
		const file = this.app.metadataCache.getFirstLinkpathDest(target, this.sourcePath);
		if (file instanceof TFile) {
			view.img.src = this.app.vault.getResourcePath(file);
			view.el.removeClass("is-missing");
			view.img.alt = file.name;
		} else {
			// The attachment is gone or not resolvable. Show the gap rather than
			// silently dropping the object. The geometry is still real, and the
			// embed is still in the Markdown for the user to fix.
			view.img.removeAttribute("src");
			view.el.addClass("is-missing");
			view.img.alt = target;
		}
	}

	/** World rect, straight from the model; images have an explicit size. */
	rectOf(id: string): BBox | null {
		const view = this.items.get(id);
		if (!view) return null;
		const d = view.model.data;
		return { x: d.x, y: d.y, width: d.width, height: d.height };
	}

	/** Topmost image containing a world point, or null. */
	hitTest(wx: number, wy: number): string | null {
		let best: string | null = null;
		let bestZ = -Infinity;
		for (const [id, view] of this.items) {
			const d = view.model.data;
			if (wx < d.x || wy < d.y || wx > d.x + d.width || wy > d.y + d.height) continue;
			if (d.z >= bestZ) {
				bestZ = d.z;
				best = id;
			}
		}
		return best;
	}

	/** Default placement size for a dropped image, preserving aspect. */
	static fitToDefault(
		naturalWidth: number,
		naturalHeight: number,
		maxWidth = 400
	): { width: number; height: number } {
		if (naturalWidth <= 0 || naturalHeight <= 0) {
			return { width: maxWidth, height: Math.round(maxWidth * 0.75) };
		}
		const scale = Math.min(1, maxWidth / naturalWidth);
		return {
			width: Math.round(naturalWidth * scale),
			height: Math.round(naturalHeight * scale),
		};
	}
}
