import { BBox, InkStroke } from "../ink/Stroke";
import { Point2 } from "../ink/Smoothing";
import { ImageData, TextBoxData } from "../model/PageData";
import { polygonBounds, rectInLasso, strokeInLasso, unionBounds } from "./Selection";

/**
 * What is selected, and how a lasso decides that.
 *
 * Deliberately DOM-free: it is handed the world-space rectangle of each text
 * container rather than reaching into the layer that renders them. That keeps
 * the whole selection rule testable, and keeps the coordinator from being the
 * only place this behaviour exists.
 *
 * The gesture itself (pen down, drag, release) stays in the view, because it
 * is input plumbing rather than selection semantics. This class answers "what
 * is selected and where is it", nothing else.
 */

/** World rect of a text container, or undefined if it is not laid out yet. */
export type RectProvider = (id: string) => BBox | null;

export class SelectionModel {
	private strokes = new Set<string>();
	private boxes = new Set<string>();
	// A third parallel set, mirroring boxes. Kept explicit rather than
	// generalised: when a fourth object type arrives, these three are the
	// evidence for what a shared abstraction actually needs.
	private images = new Set<string>();

	get strokeIds(): string[] {
		return [...this.strokes];
	}

	get boxIds(): string[] {
		return [...this.boxes];
	}

	get imageIds(): string[] {
		return [...this.images];
	}

	get size(): number {
		return this.strokes.size + this.boxes.size + this.images.size;
	}

	get isEmpty(): boolean {
		return this.size === 0;
	}

	hasStroke(id: string): boolean {
		return this.strokes.has(id);
	}

	hasBox(id: string): boolean {
		return this.boxes.has(id);
	}

	hasImage(id: string): boolean {
		return this.images.has(id);
	}

	clear(): boolean {
		if (this.isEmpty) return false;
		this.strokes.clear();
		this.boxes.clear();
		this.images.clear();
		return true;
	}

	/**
	 * Replace the selection with everything the lasso touches. A polygon with
	 * fewer than three points selects nothing; a tap is not a lasso.
	 */
	selectByLasso(
		polygon: readonly Point2[],
		allStrokes: readonly InkStroke[],
		allBoxes: readonly TextBoxData[],
		rectOf: RectProvider,
		allImages: readonly ImageData[] = [],
		imageRectOf: RectProvider = () => null
	): void {
		this.strokes.clear();
		this.boxes.clear();
		this.images.clear();
		if (polygon.length < 3) return;
		const bounds = polygonBounds(polygon);
		for (const stroke of allStrokes) {
			if (strokeInLasso(stroke, polygon, bounds)) this.strokes.add(stroke.id);
		}
		for (const box of allBoxes) {
			const rect = rectOf(box.id);
			if (rect && rectInLasso(rect, polygon, bounds)) this.boxes.add(box.id);
		}
		for (const image of allImages) {
			const rect = imageRectOf(image.id);
			if (rect && rectInLasso(rect, polygon, bounds)) this.images.add(image.id);
		}
	}

	/**
	 * Replace the selection with exactly these strokes (paste selects what
	 * it pasted, so the user can see it and move it immediately).
	 */
	selectExactly(strokeIds: readonly string[]): void {
		this.strokes = new Set(strokeIds);
		this.boxes.clear();
		this.images.clear();
	}

	/** World bounds of the whole selection, for the outline and the grab test. */
	bounds(
		allStrokes: readonly InkStroke[],
		rectOf: RectProvider,
		imageRectOf: RectProvider = () => null
	): BBox | null {
		const boxes: BBox[] = [];
		for (const stroke of allStrokes) {
			if (this.strokes.has(stroke.id)) boxes.push(stroke.bbox);
		}
		for (const id of this.boxes) {
			const r = rectOf(id);
			if (r) boxes.push(r);
		}
		for (const id of this.images) {
			const r = imageRectOf(id);
			if (r) boxes.push(r);
		}
		return unionBounds(boxes);
	}

	/**
	 * Forget objects that no longer exist, after an external edit removed
	 * containers, or an undo removed strokes. A selection holding dead ids
	 * would produce an outline around nothing.
	 */
	prune(
		liveStrokeIds: Set<string>,
		liveBoxIds: Set<string>,
		liveImageIds: Set<string> = new Set()
	): void {
		for (const id of [...this.strokes]) {
			if (!liveStrokeIds.has(id)) this.strokes.delete(id);
		}
		for (const id of [...this.boxes]) {
			if (!liveBoxIds.has(id)) this.boxes.delete(id);
		}
		for (const id of [...this.images]) {
			if (!liveImageIds.has(id)) this.images.delete(id);
		}
	}
}
