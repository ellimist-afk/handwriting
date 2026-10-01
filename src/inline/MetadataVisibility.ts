import { NOTE_CANVAS_KEY } from "./CanvasNoteOverride";

/** Limits the stylesheet's visibility check to confirmed internal-only blocks. */
export const ID_ONLY_METADATA_CLASS = "handwriting-metadata-id-only";

/** The same Properties container moves between the editor and reading view. */
function metadataRoot(root: ParentNode): ParentNode {
	const element = root as Element;
	return typeof element.closest === "function"
		? element.closest(".view-content") ?? root
		: root;
}

/**
 * `handwriting-canvas` (the per-note Infinite Canvas override, audit 196) is
 * internal the same way `handwriting-page-id` and `handwriting-paper` are:
 * the note's own choice, not something the id-only class should count
 * against it. Without this, toggling Infinite Canvas on an id-only note
 * un-hides its empty Properties block by adding exactly one more internal
 * key `isInternalProperty` did not recognise.
 */
function isInternalProperty(key: string | null): boolean {
	return key === "handwriting-page-id" || key === "handwriting-paper" || key === NOTE_CANVAS_KEY;
}

/**
 * Top-level keys of a leading frontmatter block, or null when the text has no
 * closed block (including a block the caller's slice truncated). Null means
 * "unknown", and unknown never hides anything.
 */
export function frontmatterPropertyKeys(text: string): string[] | null {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
	const lines = text.split(/\r?\n/);
	const keys: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line === "---") return keys;
		const match = /^([^\s:][^:]*):/.exec(line);
		if (match) keys.push(match[1]!.trim());
	}
	return null;
}

/**
 * Hide a Properties block only when every row is Handwriting's page id or paper.
 * A row without a key is treated as user content and keeps the block visible.
 *
 * A container with NO rows needs the file's help: the id row itself is
 * registered hidden, so on vaults that show properties in the document the
 * first stroke on a fresh note leaves a rowless shell behind (stock 1.13.7,
 * new vault). Hide that shell only when the caller can prove the note's
 * frontmatter holds nothing but those internal properties.
 */
export function updateMetadataVisibility(
	root: ParentNode,
	frontmatterKeys?: () => readonly string[] | null
): void {
	for (const container of metadataRoot(root).querySelectorAll<HTMLElement>(".metadata-container")) {
		const rows = Array.from(
			container.querySelectorAll<HTMLElement>(".metadata-property")
		);
		let idOnly: boolean;
		if (rows.length > 0) {
			idOnly = rows.every(
				(row) => isInternalProperty(row.getAttribute("data-property-key"))
			);
		} else {
			const keys = frontmatterKeys ? frontmatterKeys() : null;
			idOnly =
				keys !== null &&
				keys.length > 0 &&
				keys.every(isInternalProperty);
		}
		container.classList.toggle(ID_ONLY_METADATA_CLASS, idOnly);
	}
}

/** The Properties block Obsidian renders; the only thing above cares about. */
const METADATA_CONTAINER = ".metadata-container";

/** Element nodes only; a text node answers with the element holding it. */
function elementFor(node: Node | null): Element | null {
	if (!node) return null;
	if (node.nodeType === 1) return node as Element;
	return node.parentElement;
}

/** True when any element in the list IS, or contains, a Properties block. */
function touchesContainer(nodes: ArrayLike<Node>): boolean {
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (!node || node.nodeType !== 1) continue;
		const el = node as Element;
		if (el.matches(METADATA_CONTAINER)) return true;
		// The panel arrives inside a wrapper on some layouts, so an added
		// subtree counts as well as an added container.
		if (el.querySelector(METADATA_CONTAINER)) return true;
	}
	return false;
}

/**
 * Could this mutation have changed a Properties block?
 *
 * The overlay observes the view containing both the editor and reading view
 * with subtree childList, because the container moves between them. CodeMirror
 * recycles line DOM, and the reading view can redraw unrelated content. This is the
 * gate: a record survives when its target is inside or IS a container - the
 * rows and their `data-property-key` attributes - or when the container
 * itself is being added or removed, which is the case `closest` cannot see
 * because a removal's target is the parent, outside the container.
 */
export function isMetadataMutation(record: MutationRecord): boolean {
	if (elementFor(record.target)?.closest(METADATA_CONTAINER)) return true;
	return touchesContainer(record.addedNodes) || touchesContainer(record.removedNodes);
}

/** Remove presentation state when the editor overlay is unmounted. */
export function clearMetadataVisibility(root: ParentNode): void {
	for (const container of metadataRoot(root).querySelectorAll<HTMLElement>(".metadata-container")) {
		container.classList.remove(ID_ONLY_METADATA_CLASS);
	}
}
