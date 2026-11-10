import { describe, expect, it, vi } from "vitest";
import { HandwritingSettingTab } from "./HandwritingSettingTab";

// The Colors group (1.5.0): the two palette rows move out of Pen into their
// own group after it, and the palette control lays its pickers out as a grid
// with each reset icon under its picker and Reset all outside the grid.
// The DOM is a small fake tree: the obsidian components are swapped for
// recorders so a test can see which control sits in which cell.

const dom = vi.hoisted(() => {
	class Control {
		readonly calls: Record<string, unknown> = {};
		constructor(readonly kind: string, container: Box) {
			container.controls.push(this);
		}
		setValue(v: unknown): this {
			this.calls.setValue = v;
			return this;
		}
		onChange(f: unknown): this {
			this.calls.onChange = f;
			return this;
		}
		setIcon(v: unknown): this {
			this.calls.setIcon = v;
			return this;
		}
		setTooltip(v: unknown): this {
			this.calls.setTooltip = v;
			return this;
		}
		setButtonText(v: unknown): this {
			this.calls.setButtonText = v;
			return this;
		}
		onClick(f: unknown): this {
			this.calls.onClick = f;
			return this;
		}
	}
	class Box {
		readonly kids: Box[] = [];
		readonly controls: Control[] = [];
		readonly classes: string[] = [];
		empty(): void {
			this.kids.length = 0;
			this.controls.length = 0;
		}
		addClass(c: string): void {
			this.classes.push(c);
		}
		createDiv(o: { cls?: string } = {}): Box {
			const b = new Box();
			b.classes.push(...(o.cls ?? "").split(" ").filter(Boolean));
			this.kids.push(b);
			return b;
		}
	}
	return { Box, Control };
});

vi.mock("obsidian", async (importOriginal) => {
	const real = await importOriginal<Record<string, unknown>>();
	return {
		...real,
		ColorComponent: class extends dom.Control {
			constructor(c: InstanceType<typeof dom.Box>) {
				super("color", c);
			}
		},
		ExtraButtonComponent: class extends dom.Control {
			constructor(c: InstanceType<typeof dom.Box>) {
				super("extra", c);
			}
		},
		ButtonComponent: class extends dom.Control {
			constructor(c: InstanceType<typeof dom.Box>) {
				super("button", c);
			}
		},
	};
});

type Def = {
	type?: string;
	heading?: string;
	name?: string;
	desc?: string;
	aliases?: string[];
	items?: Def[];
};

function tab(): HandwritingSettingTab {
	const t = Object.create(HandwritingSettingTab.prototype) as HandwritingSettingTab;
	(t as unknown as { plugin: unknown }).plugin = {
		settings: { booxMode: false },
		manifest: { version: "test" },
		gatedCommandRemovalAvailable: () => true,
		saveSettingsNow: vi.fn(),
		refreshSettingSurfaces: vi.fn(),
		refreshColourCommandNames: vi.fn(),
	};
	return t;
}

function paletteControl(tool: "pen" | "highlighter"): { root: InstanceType<typeof dom.Box> } {
	const t = tab() as unknown as { renderPalette(s: unknown, tool: string): void };
	const root = new dom.Box();
	t.renderPalette({ controlEl: root }, tool);
	return { root };
}

describe("the Colors group", () => {
	it("sits after Pen and before Commands and holds the two palette rows", () => {
		const defs = tab().getSettingDefinitions() as Def[];
		const headings = defs.filter((d) => d.type === "group").map((d) => d.heading);
		const at = headings.indexOf("Colors");
		expect(at).toBe(headings.indexOf("Pen") + 1);
		expect(headings[at + 1]).toBe("Commands");
		const colors = defs.find((d) => d.heading === "Colors");
		expect(colors?.items?.map((i) => i.name)).toEqual(["Pen colors", "Highlighter colors"]);
	});

	it("Pen no longer holds the palette rows", () => {
		const defs = tab().getSettingDefinitions() as Def[];
		const pen = defs.find((d) => d.heading === "Pen");
		const names = pen?.items?.map((i) => i.name) ?? [];
		expect(names).not.toContain("Pen colors");
		expect(names).not.toContain("Highlighter colors");
	});

	it("both rows keep the pen alias, and their descriptions drop the written-ink sentence", () => {
		const defs = tab().getSettingDefinitions() as Def[];
		const rows = defs.find((d) => d.heading === "Colors")?.items ?? [];
		for (const row of rows) expect(row.aliases).toContain("pen");
		expect(rows[0]?.desc).toBe("Change any of the eight pen colors.");
		expect(rows[1]?.desc).toBe("Change any of the five highlighter colors.");
	});
});

describe("the palette control layout", () => {
	it("pen: eight cells in one grid, each a picker with its reset icon under it, Reset all outside the grid", () => {
		const { root } = paletteControl("pen");
		expect(root.kids).toHaveLength(1);
		const grid = root.kids[0]!;
		expect(grid.classes).toContain("handwriting-palette-grid");
		expect(grid.classes).toContain("is-pen");
		expect(grid.kids).toHaveLength(8);
		for (const cell of grid.kids) {
			expect(cell.classes).toContain("handwriting-palette-cell");
			expect(cell.controls.map((c) => c.kind)).toEqual(["color", "extra"]);
			expect(cell.controls[1]!.calls.setIcon).toBe("rotate-ccw");
		}
		expect(grid.controls).toHaveLength(0);
		expect(root.controls.map((c) => c.kind)).toEqual(["button"]);
		expect(root.controls[0]!.calls.setButtonText).toBe("Reset all");
	});

	it("highlighter: five cells in one grid, same cell shape, Reset all outside the grid", () => {
		const { root } = paletteControl("highlighter");
		const grid = root.kids[0]!;
		expect(grid.classes).toContain("is-highlighter");
		expect(grid.kids).toHaveLength(5);
		for (const cell of grid.kids) {
			expect(cell.controls.map((c) => c.kind)).toEqual(["color", "extra"]);
		}
		expect(root.controls.map((c) => c.kind)).toEqual(["button"]);
	});
});
