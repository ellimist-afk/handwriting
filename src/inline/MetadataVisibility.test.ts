import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import {
	frontmatterPropertyKeys,
	ID_ONLY_METADATA_CLASS,
	clearMetadataVisibility,
	updateMetadataVisibility,
} from "./MetadataVisibility";

function property(key: string | null): HTMLElement {
	return {
		getAttribute: (name: string) => (name === "data-property-key" ? key : null),
	} as unknown as HTMLElement;
}

function metadataContainer(keys: Array<string | null>): {
	element: HTMLElement;
	hasClass(): boolean;
} {
	let marked = false;
	const element = {
		querySelectorAll: () => keys.map(property),
		classList: {
			toggle: (name: string, force?: boolean) => {
				if (name === ID_ONLY_METADATA_CLASS) marked = force ?? !marked;
				return marked;
			},
			remove: (name: string) => {
				if (name === ID_ONLY_METADATA_CLASS) marked = false;
			},
		},
	} as unknown as HTMLElement;
	return { element, hasClass: () => marked };
}

function root(...containers: HTMLElement[]): ParentNode {
	return { querySelectorAll: () => containers } as unknown as ParentNode;
}

describe("metadata visibility", () => {
	it("uses a maintained class instead of relational selectors", () => {
		expect(css).toContain(`.metadata-container.${ID_ONLY_METADATA_CLASS}`);
		expect(css).not.toContain(":has(");
	});

	it("marks a container whose only row is the Handwriting page id", () => {
		const container = metadataContainer(["handwriting-page-id"]);
		updateMetadataVisibility(root(container.element));
		expect(container.hasClass()).toBe(true);
	});

	it("keeps a container visible when it has a user property", () => {
		const container = metadataContainer(["handwriting-page-id", "aliases"]);
		updateMetadataVisibility(root(container.element));
		expect(container.hasClass()).toBe(false);
	});

	it("keeps empty and not-yet-keyed rows visible", () => {
		const empty = metadataContainer([]);
		const editing = metadataContainer(["handwriting-page-id", null]);
		updateMetadataVisibility(root(empty.element, editing.element));
		expect(empty.hasClass()).toBe(false);
		expect(editing.hasClass()).toBe(false);
	});

	it("removes stale presentation state when the overlay unmounts", () => {
		const container = metadataContainer(["handwriting-page-id"]);
		const host = root(container.element);
		updateMetadataVisibility(host);
		clearMetadataVisibility(host);
		expect(container.hasClass()).toBe(false);
	});
});

describe("the empty shell a hidden id row leaves behind", () => {
	// Obsidian hides the id ROW itself (the property is registered hidden),
	// so on vaults that show properties in the document the container renders
	// with zero rows. Reproduced on stock 1.13.7 in a fresh vault, first
	// stroke on a new note: a hollow Properties block appears and stays.
	it("hides a rowless container when the note's only frontmatter key is the id", () => {
		const empty = metadataContainer([]);
		updateMetadataVisibility(root(empty.element), () => ["handwriting-page-id"]);
		expect(empty.hasClass()).toBe(true);
	});

	it("keeps a rowless container when the note has any other key", () => {
		const empty = metadataContainer([]);
		updateMetadataVisibility(root(empty.element), () => ["handwriting-page-id", "tags"]);
		expect(empty.hasClass()).toBe(false);
	});

	it("keeps a rowless container when the frontmatter cannot be read", () => {
		const empty = metadataContainer([]);
		updateMetadataVisibility(root(empty.element), () => null);
		expect(empty.hasClass()).toBe(false);
	});
});

describe("frontmatterPropertyKeys", () => {
	it("reads top-level keys from a closed frontmatter block", () => {
		expect(frontmatterPropertyKeys("---\nhandwriting-page-id: 3f2a\n---\ntext")).toEqual([
			"handwriting-page-id",
		]);
		expect(frontmatterPropertyKeys("---\ntags:\n  - a\nhandwriting-page-id: x\n---\n")).toEqual([
			"tags",
			"handwriting-page-id",
		]);
	});

	it("returns null when there is no frontmatter or the fence never closes", () => {
		expect(frontmatterPropertyKeys("plain text")).toBeNull();
		expect(frontmatterPropertyKeys("---\nhandwriting-page-id: x\ntruncated")).toBeNull();
	});
});
