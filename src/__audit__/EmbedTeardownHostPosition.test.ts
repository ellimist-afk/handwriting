import { afterEach, expect, it } from "vitest";
import { attachEmbedInk, teardownEmbedInk } from "../inline/EmbedInk";

afterEach(() => teardownEmbedInk());

it("C2-002 preserves a host-owned relative position when an empty ink layer is torn down", () => {
	const removed: string[] = [];
	const attrs = new Map<string, string>();
	const root = {
		isConnected: true,
		classList: { contains: () => false },
		style: {
			position: "relative",
			removeProperty(name: string) {
				removed.push(name);
				this.position = "";
			},
		},
		querySelector: () => null,
		getAttribute: (name: string) => attrs.get(name) ?? null,
		setAttribute: (name: string, value: string) => void attrs.set(name, value),
		removeAttribute: (name: string) => void attrs.delete(name),
		ownerDocument: {
			defaultView: { addEventListener() {}, removeEventListener() {} },
		},
	};

	// Empty ink returns before paint's position write. The relative value is
	// supplied by the host and must remain its property after teardown.
	attachEmbedInk(root as unknown as HTMLElement, "foreign-relative.md", []);
	expect(root.style.position).toBe("relative");
	try {
		teardownEmbedInk();
		expect(removed).not.toContain("position");
		expect(root.style.position).toBe("relative");
	} finally {
		teardownEmbedInk();
	}
});
