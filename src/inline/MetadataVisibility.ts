/** Class used instead of a broad `:has()` selector in the shipped stylesheet. */
export const ID_ONLY_METADATA_CLASS = "handwriting-metadata-id-only";

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
 * Hide a Properties block only when every row is Handwriting's page id.
 * A row without a key is treated as user content and keeps the block visible.
 *
 * A container with NO rows needs the file's help: the id row itself is
 * registered hidden, so on vaults that show properties in the document the
 * first stroke on a fresh note leaves a rowless shell behind (stock 1.13.7,
 * new vault). Hide that shell only when the caller can prove the note's
 * frontmatter holds nothing but the id.
 */
export function updateMetadataVisibility(
	root: ParentNode,
	frontmatterKeys?: () => readonly string[] | null
): void {
	for (const container of root.querySelectorAll<HTMLElement>(".metadata-container")) {
		const rows = Array.from(
			container.querySelectorAll<HTMLElement>(".metadata-property")
		);
		let idOnly: boolean;
		if (rows.length > 0) {
			idOnly = rows.every(
				(row) => row.getAttribute("data-property-key") === "handwriting-page-id"
			);
		} else {
			const keys = frontmatterKeys ? frontmatterKeys() : null;
			idOnly =
				keys !== null &&
				keys.length > 0 &&
				keys.every((key) => key === "handwriting-page-id");
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
 * The overlay observes the WHOLE `.markdown-source-view` with subtree
 * childList, because the container does not exist at mount and there is
 * nothing narrower to watch. CodeMirror recycles line DOM, so that observer
 * fires on every keystroke and every scroll to answer a question that only
 * changes when the properties panel does (audit doc §5g/G2). This is the
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
	for (const container of root.querySelectorAll<HTMLElement>(".metadata-container")) {
		container.classList.remove(ID_ONLY_METADATA_CLASS);
	}
}
