import { afterEach, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { holdKeyboardForEveryPen } from "./InlineFocus";
import { clearInlinePenTrace, formatInlinePenTrace } from "./InlinePenRouterTrace";

/**
 * Issue 30 trace row: with recording on, each pen-down arms one focusin
 * listener on the editor content and the first focusin writes one row. With
 * recording off, no listener is added and no row is written, by count.
 */
function rig() {
	const adds: string[] = [];
	const removes: string[] = [];
	const content = new EventTarget() as EventTarget & { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void; removeAttribute(n: string): void; ownerDocument: unknown };
	const attrs = new Map<string, string>();
	content.getAttribute = (n) => attrs.get(n) ?? null;
	content.setAttribute = (n, v) => void attrs.set(n, v);
	content.removeAttribute = (n) => void attrs.delete(n);
	content.ownerDocument = { activeElement: null, defaultView: null };
	const add = content.addEventListener.bind(content);
	const remove = content.removeEventListener.bind(content);
	content.addEventListener = ((type: string, fn: never, opts?: never) => {
		adds.push(type);
		add(type, fn, opts);
	}) as never;
	content.removeEventListener = ((type: string, fn: never, opts?: never) => {
		removes.push(type);
		remove(type, fn, opts);
	}) as never;
	const root = new EventTarget();
	const scroller = { scrollTop: 2000 };
	const view = { hasFocus: false, contentDOM: content as never, dom: root as never, scrollDOM: scroller as never };
	const release = holdKeyboardForEveryPen(view, () => null);
	const penDown = () => {
		const ev = new Event("pointerdown") as Event & Record<string, unknown>;
		Object.assign(ev, { pointerType: "pen", pointerId: 2, buttons: 1, button: 0, pressure: 0.5, clientX: 10, clientY: 20, tiltX: 0, tiltY: 0 });
		root.dispatchEvent(ev);
	};
	return { adds, removes, content, scroller, penDown, release };
}

const rows = () => formatInlinePenTrace().split("\n").filter((l) => l.includes("focusin after pen-down"));
const focusinAdds = (adds: string[]) => adds.filter((t) => t === "focusin").length;

afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
});

describe("issue 30 focusin row", () => {
	it("recording off: a pen-down and a focusin add no focusin listener and write no row", () => {
		setDiagnosticsEnabled(false);
		clearInlinePenTrace();
		const r = rig();
		const before = focusinAdds(r.adds);
		r.penDown();
		r.content.dispatchEvent(new Event("focusin"));
		expect(focusinAdds(r.adds) - before, "focusin listeners added with recording off").toBe(0);
		setDiagnosticsEnabled(true);
		expect(rows(), "rows written with recording off").toHaveLength(0);
		r.release();
	});

	it("recording on: one pen-down, one focusin, one row with scrollTop and stack, listener gone after", () => {
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		const r = rig();
		const before = focusinAdds(r.adds);
		r.penDown();
		expect(focusinAdds(r.adds) - before, "focusin listeners armed by one pen-down").toBe(1);
		r.scroller.scrollTop = 0;
		function pageScrollStandIn() {
			r.content.dispatchEvent(new Event("focusin"));
		}
		pageScrollStandIn();
		r.content.dispatchEvent(new Event("focusin"));
		const got = rows();
		expect(got, "rows for one pen-down and two focusins").toHaveLength(1);
		expect(got[0]).toContain("scrollTop at down=2000 at focusin=0");
		expect(got[0], "the row carries stack frames").toMatch(/stack: (?!\(none\))\S/);
		expect(r.removes.filter((t) => t === "focusin").length, "the focusin listener removed after it fired").toBe(1);
		r.release();
	});
});
