/**
 * gutterPanMode, the branches that read computed style.
 *
 * InkOverlayRegistryFanout.test.ts covers the two answers that need no style
 * at all (no sizer, and gutters the sizer does not hold, and the unit
 * environment with no computed style). The rest of the function reads
 * `getComputedStyle` and the Typed OM: whether the gutters are absolutely
 * positioned, whether anything between them and the scroller is positioned or
 * transformed, and which of `left` and `top` are set. Those branches choose
 * between a counter translate that keeps the line numbers still and no
 * counter at all, so each one is driven here with plain stand-ins.
 */
import { describe, expect, it } from "vitest";
import { gutterPanMode } from "./InkOverlay";

type Style = { position: string; transform?: string };
type El = { parentElement: El | null; style: Style };

/** An element chain: scroller > ...between > sizer > gutters, with the style each level computes to. */
function chain(opts: {
	gutters?: Partial<Style>;
	between?: Style[];
	sizerStyle?: Partial<Style>;
	left?: string;
	top?: string;
	offsets?: { left: number; top: number; clientLeft?: number; clientTop?: number };
	typedOm?: boolean;
	reachesScroller?: boolean;
}) {
	// An unreachable chain ends in a static, untransformed top element, so only the missing-ancestor check can answer none.
	const scroller: El = { parentElement: null, style: { position: opts.reachesScroller === false ? "static" : "relative", transform: "none" } };
	let parent: El = scroller;
	for (const style of (opts.between ?? []).slice().reverse()) parent = { parentElement: parent, style };
	const sizerNode: El = { parentElement: parent, style: { position: "static", transform: "translate(5px,0px)", ...opts.sizerStyle } };
	const guttersNode: El = { parentElement: sizerNode, style: { position: "absolute", transform: "none", ...opts.gutters } };
	const styles = new Map<unknown, Style>();
	for (let n: El | null = guttersNode; n; n = n.parentElement) styles.set(n, n.style);
	const win = { getComputedStyle: (el: unknown) => styles.get(el) };
	const o = opts.offsets ?? { left: 0, top: 0 };
	const sizer = Object.assign(sizerNode, {
		contains: (el: unknown) => el === guttersNode,
		offsetLeft: o.left,
		offsetTop: o.top,
		clientLeft: o.clientLeft ?? 0,
		clientTop: o.clientTop ?? 0,
	}) as unknown as HTMLElement;
	const map = new Map<string, string>([["left", opts.left ?? "auto"], ["top", opts.top ?? "auto"]]);
	const gutters = Object.assign(guttersNode, {
		ownerDocument: { defaultView: win },
		...(opts.typedOm === false ? {} : { computedStyleMap: () => ({ get: (k: string) => map.get(k) }) }),
	}) as unknown as HTMLElement;
	const scrollerEl = (opts.reachesScroller === false ? ({} as HTMLElement) : (scroller as unknown as HTMLElement));
	return { sizer, gutters, scroller: scrollerEl };
}

describe("gutterPanMode: computed-style branches", () => {
	it("is none without the Typed OM", () => {
		const c = chain({ typedOm: false });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "none" });
	});

	it("is none when the gutters are in flow or sticky inside the sizer", () => {
		for (const position of ["static", "relative", "sticky"]) {
			const c = chain({ gutters: { position } });
			expect(gutterPanMode(c.sizer, c.gutters, c.scroller), position).toEqual({ kind: "none" });
		}
	});

	it("counters the sizer's offset when the gutters are absolute against the scroller", () => {
		for (const position of ["absolute", "fixed"]) {
			const c = chain({ gutters: { position }, left: "0px", top: "32px", offsets: { left: 48, top: 10, clientLeft: 1, clientTop: 2 } });
			expect(gutterPanMode(c.sizer, c.gutters, c.scroller), position).toEqual({ kind: "counter", translate: "translate(-49px,-12px)" });
		}
	});

	it("counters only the axis whose offset is set", () => {
		const leftOnly = chain({ left: "0px", offsets: { left: 48, top: 10 } });
		expect(gutterPanMode(leftOnly.sizer, leftOnly.gutters, leftOnly.scroller)).toEqual({ kind: "counter", translate: "translate(-48px,0px)" });
		const topOnly = chain({ top: "0px", offsets: { left: 48, top: 10 } });
		expect(gutterPanMode(topOnly.sizer, topOnly.gutters, topOnly.scroller)).toEqual({ kind: "counter", translate: "translate(0px,-10px)" });
	});

	it("counters with an empty translate when the sizer has no offset or both sides are auto", () => {
		const zero = chain({ left: "0px", top: "0px", offsets: { left: 0, top: 0 } });
		expect(gutterPanMode(zero.sizer, zero.gutters, zero.scroller)).toEqual({ kind: "counter", translate: "" });
		const auto = chain({ offsets: { left: 48, top: 10 } });
		expect(gutterPanMode(auto.sizer, auto.gutters, auto.scroller)).toEqual({ kind: "counter", translate: "" });
	});

	it("ignores the sizer's own transform, which is the pan itself", () => {
		const c = chain({ left: "0px", top: "0px", offsets: { left: 4, top: 0 }, sizerStyle: { transform: "translate(120px,40px)" } });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "counter", translate: "translate(-4px,0px)" });
	});

	it("is none when an element between the sizer and the scroller is positioned", () => {
		const c = chain({ left: "0px", top: "0px", between: [{ position: "relative", transform: "none" }] });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "none" });
	});

	it("is none when an element between the sizer and the scroller is transformed", () => {
		const c = chain({ left: "0px", top: "0px", between: [{ position: "static", transform: "scale(1.5)" }] });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "none" });
	});

	it("still counters through static, untransformed elements between the sizer and the scroller", () => {
		const c = chain({ left: "0px", top: "0px", offsets: { left: 8, top: 0 }, between: [{ position: "static", transform: "none" }, { position: "static", transform: "none" }] });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "counter", translate: "translate(-8px,0px)" });
	});

	it("is none when the scroller is not an ancestor of the gutters", () => {
		const c = chain({ left: "0px", top: "0px", reachesScroller: false });
		expect(gutterPanMode(c.sizer, c.gutters, c.scroller)).toEqual({ kind: "none" });
	});
});
