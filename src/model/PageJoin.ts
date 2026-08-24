import { MarkdownBlock, MarkdownImage } from "./MarkdownPage";
import { ImageData, TextBoxData } from "./PageData";

/**
 * Join the two halves of a page: text from the Markdown file, geometry from
 * the sidecar (handoff §17–§20).
 *
 * The rule that matters is asymmetric on purpose:
 *
 *   text without geometry  → keep the text, invent a position
 *   geometry without text  → drop the geometry
 *
 * Text is the thing a human wrote and the thing that survives if the plugin
 * vanishes; a position is trivially reconstructible. So a lost or stale
 * sidecar costs layout, never words.
 */

export interface JoinedBox {
	data: TextBoxData;
	text: string;
}

export interface JoinOptions {
	defaultWidth: number;
	/** Where orphaned text starts, and how far apart stacked orphans sit. */
	fallbackX?: number;
	fallbackY?: number;
	fallbackStep?: number;
}

export function joinPage(
	blocks: readonly MarkdownBlock[],
	geometry: readonly TextBoxData[],
	opts: JoinOptions
): { boxes: JoinedBox[]; orphanedText: number; droppedGeometry: number } {
	const byId = new Map(geometry.map((g) => [g.id, g]));
	const boxes: JoinedBox[] = [];
	let orphanedText = 0;
	let nextY = opts.fallbackY ?? 40;
	const step = opts.fallbackStep ?? 140;

	for (const block of blocks) {
		const geo = byId.get(block.id);
		if (geo) {
			boxes.push({ data: { ...geo }, text: block.text });
			byId.delete(block.id);
			continue;
		}
		orphanedText++;
		boxes.push({
			data: {
				id: block.id,
				x: opts.fallbackX ?? 40,
				y: nextY,
				width: opts.defaultWidth,
				z: boxes.length,
			},
			text: block.text,
		});
		nextY += step;
	}

	return { boxes, orphanedText, droppedGeometry: byId.size };
}


export interface JoinedImage {
	data: ImageData;
	target: string;
}

/**
 * The same asymmetric rule as text, for images: an embed with no saved
 * geometry keeps the picture and invents a position; geometry with no embed is
 * dropped. The user's content is in the vault either way; only the
 * arrangement is ours to lose.
 */
export function joinImages(
	embeds: readonly MarkdownImage[],
	geometry: readonly ImageData[],
	opts: JoinOptions
): { images: JoinedImage[]; orphanedImages: number; droppedGeometry: number } {
	const byId = new Map(geometry.map((g) => [g.id, g]));
	const images: JoinedImage[] = [];
	let orphanedImages = 0;
	let nextY = opts.fallbackY ?? 40;
	const step = opts.fallbackStep ?? 140;

	for (const embed of embeds) {
		const geo = byId.get(embed.id);
		if (geo) {
			images.push({ data: { ...geo }, target: embed.target });
			byId.delete(embed.id);
			continue;
		}
		orphanedImages++;
		images.push({
			data: {
				id: embed.id,
				x: opts.fallbackX ?? 40,
				y: nextY,
				width: opts.defaultWidth,
				height: Math.round(opts.defaultWidth * 0.75),
				z: images.length,
			},
			target: embed.target,
		});
		nextY += step;
	}
	return { images, orphanedImages, droppedGeometry: byId.size };
}
