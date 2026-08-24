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

/** Remove presentation state when the editor overlay is unmounted. */
export function clearMetadataVisibility(root: ParentNode): void {
	for (const container of root.querySelectorAll<HTMLElement>(".metadata-container")) {
		container.classList.remove(ID_ONLY_METADATA_CLASS);
	}
}
