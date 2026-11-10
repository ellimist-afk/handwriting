/**
 * The zoom bar's + and − are live only where a tap would move the note. At the
 * floor and the ceiling, and where Fit is unavailable, the step does nothing,
 * so the button is greyed. Read off the bar's own buttons, at the zoom values
 * where the old check let a dead button stay live.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { NoteZoomControls } from "./NoteZoomControls";

interface FakeButton {
	label: string;
	disabled: boolean;
	textContent: string;
	addEventListener(): void;
}

interface FakeEl {
	classes: Set<string>;
	createDiv(): FakeEl;
	createEl(tag: string, opts: { text?: string; attr?: Record<string, string> }): FakeButton;
	addEventListener(): void;
	toggleClass(cls: string, on: boolean): void;
	addClass(cls: string): void;
	removeClass(cls: string): void;
	hasClass(cls: string): boolean;
	setAttr(): void;
	remove(): void;
}

function bar(state: { zoom: number; busy: boolean; fitAvailable: boolean }) {
	const made: FakeButton[] = [];
	const element: FakeEl = {
		classes: new Set<string>(),
		createDiv() {
			return element;
		},
		createEl(_tag, opts) {
			const b: FakeButton = {
				label: opts.attr?.["aria-label"] ?? "",
				disabled: false,
				textContent: opts.text ?? "",
				addEventListener() {},
			};
			made.push(b);
			return b;
		},
		addEventListener() {},
		toggleClass(cls, on) {
			if (on) element.classes.add(cls);
			else element.classes.delete(cls);
		},
		addClass(cls) {
			element.classes.add(cls);
		},
		removeClass(cls) {
			element.classes.delete(cls);
		},
		hasClass(cls) {
			return element.classes.has(cls);
		},
		setAttr() {},
		remove() {},
	};
	const host = {
		noteViewport: {
			getNoteViewportState: () => state,
			zoomNoteBy: () => true,
			resetNoteZoom: () => true,
			fitHandwriting: () => "fit" as const,
		},
		notePath: () => "note.md",
	};
	const controls = new NoteZoomControls(element as unknown as HTMLElement, host as never);
	const byLabel = (label: string) => {
		const b = made.find((x) => x.label === label);
		if (!b) throw new Error(`no zoom bar button labelled ${label}`);
		return b;
	};
	return {
		minus: () => byLabel("Zoom out").disabled,
		plus: () => byLabel("Zoom in").disabled,
		controls,
	};
}

describe("zoom bar + and - are greyed where a tap does nothing", () => {
	it("at the floor, minus is greyed and plus is live", () => {
		const b = bar({ zoom: 0.1, busy: false, fitAvailable: true });
		expect(b.minus()).toBe(true);
		expect(b.plus()).toBe(false);
		b.controls.destroy();
	});

	it("below the floor, minus is greyed and plus is live", () => {
		const b = bar({ zoom: 0.07, busy: false, fitAvailable: true });
		expect(b.minus()).toBe(true);
		expect(b.plus()).toBe(false);
		b.controls.destroy();
	});

	it("at 5.98, next to the ceiling, plus is greyed and minus is live", () => {
		const b = bar({ zoom: 5.98, busy: false, fitAvailable: true });
		expect(b.plus()).toBe(true);
		expect(b.minus()).toBe(false);
		b.controls.destroy();
	});

	it("with Fit unavailable at 100 percent, plus and minus are both greyed", () => {
		const b = bar({ zoom: 1, busy: false, fitAvailable: false });
		expect(b.plus()).toBe(true);
		expect(b.minus()).toBe(true);
		b.controls.destroy();
	});

	it("at 100 percent with Fit available, plus and minus are both live", () => {
		const b = bar({ zoom: 1, busy: false, fitAvailable: true });
		expect(b.plus()).toBe(false);
		expect(b.minus()).toBe(false);
		b.controls.destroy();
	});
});
