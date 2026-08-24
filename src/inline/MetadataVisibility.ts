/** Class used instead of a broad `:has()` selector in the shipped stylesheet. */
export const ID_ONLY_METADATA_CLASS = "handwriting-metadata-id-only";

/**
 * Hide a Properties block only when every row is Handwriting's page id.
 * A row without a key is treated as user content and keeps the block visible.
 */
export function updateMetadataVisibility(root: ParentNode): void {
	for (const container of root.querySelectorAll<HTMLElement>(".metadata-container")) {
		const rows = Array.from(
			container.querySelectorAll<HTMLElement>(".metadata-property")
		);
		const idOnly =
			rows.length > 0 &&
			rows.every((row) => row.getAttribute("data-property-key") === "handwriting-page-id");
		container.classList.toggle(ID_ONLY_METADATA_CLASS, idOnly);
	}
}

/** Remove presentation state when the editor overlay is unmounted. */
export function clearMetadataVisibility(root: ParentNode): void {
	for (const container of root.querySelectorAll<HTMLElement>(".metadata-container")) {
		container.classList.remove(ID_ONLY_METADATA_CLASS);
	}
}
