/**
 * Cell for audit 171 (lane C1): clicking the Snap chip takes keyboard focus off the note, so Ctrl+Z
 * cannot undo the snap.
 *
 * Root cause read: the chip has tabindex -1, so a mouse press on it focuses it (a browser's default action of
 * mousedown), and the chip's guard only stops the pointerdown from reaching the pen router: it never cancels the
 * mousedown default. take() and dismiss() then remove the focused chip and focus falls to the body.
 *
 * The real SnapChip runs over a small fake element tree with a focus model of the browser's rule: a mousedown
 * whose default is not cancelled focuses the chip (it is focusable); removing the focused element puts focus on
 * the body. The editor holds focus when the chip is offered. Asserted: after a full press (pointerdown, mousedown,
 * mouseup, click) the editor still holds focus. It goes green when the chip cancels the mousedown default, on its
 * own element or on the guard root. A fix that instead hands focus back to the editor from the take callback is
 * not seen by this cell, which reads the chip alone.
 */
import { describe, expect, it } from "vitest";
import { SNAP_CHIP_CLASS, SnapChip, type ChipEvent } from "./SnapChip";

type Handler = (ev: ChipEvent & { preventDefault?: () => void }) => void;

class Node {
	readonly listeners = new Map<string, Handler[]>();
	readonly attrs = new Map<string, string>();
	readonly children: Node[] = [];
	parent: Node | null = null;
	constructor(readonly cls = "") {}
	createDiv(opts: { cls: string; text?: string }): Node {
		const el = new Node(opts.cls);
		el.parent = this;
		this.children.push(el);
		return el;
	}
	setCssStyles(): void {}
	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}
	addEventListener(type: string, fn: Handler): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: Handler): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
	}
	contains(node: unknown): boolean {
		return node === this || this.children.some((k) => k.contains(node));
	}
	remove(): void {
		if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
	}
	/** Run this node's own handlers; returns whether any of them cancelled the default. */
	dispatch(type: string, target: unknown): boolean {
		let prevented = false;
		const ev = { type, target, stopPropagation: () => {}, preventDefault: () => (prevented = true) };
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
		return prevented;
	}
}

describe("audit 171: the Snap chip keeps focus on the note", () => {
	it("after a full click on the chip the editor still holds keyboard focus", () => {
		const parent = new Node("overlay");
		const guardRoot = new Node("root");
		const scroller = new Node("scroller");
		const keyRoot = new Node("document");
		const editor = { name: "editor" };
		const body = { name: "body" };
		let focus: unknown = editor;
		let taken = 0;
		const clock = { setTimeout: () => 1, clearTimeout: () => {} };

		const chip = new SnapChip();
		chip.offer({ parent, guardRoot, scroller, keyRoot, pane: { width: 800, height: 600 }, clock }, 100, 100, () => {
			taken++;
		});
		const el = parent.children.find((k) => k.cls === SNAP_CHIP_CLASS);
		expect(el, "the offer put a chip in the overlay").toBeDefined();
		expect(el!.attrs.get("tabindex"), "the chip is focusable, which is the precondition of the bug").toBe("-1");

		// The press, in the browser's order. Capture-phase guard on the root first, then the chip.
		guardRoot.dispatch("pointerdown", el);
		el!.dispatch("pointerdown", el);
		const cancelledOnRoot = guardRoot.dispatch("mousedown", el);
		const cancelledOnChip = el!.dispatch("mousedown", el);
		if (!cancelledOnRoot && !cancelledOnChip) focus = el; // the default action: focus the pressed, focusable element
		el!.dispatch("mouseup", el);
		el!.dispatch("click", el);
		if (focus === el) focus = body; // the chip was taken down while focused

		expect(taken, "the click took the snap").toBe(1);
		expect(chip.showing, "the offer is gone after the click").toBe(false);
		expect(focus, "focus fell to the body, so Ctrl+Z reaches nothing").toBe(editor);
	});
});
