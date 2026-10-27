/**
 * EXECUTE `blockNotice`'s fragment branch, rather than reading it.
 *
 * I named this as a liability myself: the branch that builds a DocumentFragment
 * had never been run. I established that Obsidian appends a fragment rather
 * than stringifying it by reading `Element.prototype.setText` out of
 * obsidian.asar, and reading is not running. `NoticeBlocks.test.ts` covers the
 * pure splitter; this covers the part that touches the DOM helpers.
 *
 * `blockNotice` was NOT exported from main.ts - which is how it stayed
 * unexecuted, and was the reason to slice it rather than widen main.ts's export
 * surface for a test. It moved, exported, to view/Notices.ts; the slice
 * stays and reads that file.
 * Same idiom as `LiveReloadTestHarness.ts`: take the real source, transpile it,
 * run it, and assert the extraction boundary so a moved function fails LOUDLY
 * instead of quietly testing nothing.
 */
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import noticesSource from "./view/Notices.ts?raw";

/** A minimal stand-in for Obsidian's element helpers, recording what it built. */
interface FakeNode {
	tag: string;
	text?: string;
	children: FakeNode[];
}

function fakeFragment(): FakeNode & { createDiv(opts: { text?: string }): FakeNode } {
	const node: FakeNode = { tag: "fragment", children: [] };
	return Object.assign(node, {
		createDiv(opts: { text?: string }): FakeNode {
			const child: FakeNode = { tag: "div", text: opts.text, children: [] };
			node.children.push(child);
			return child;
		},
	});
}

/** What the real function was handed, per constructed Notice. */
interface Built {
	message: unknown;
	durationMs: unknown;
}

const src = noticesSource.replace(/\r\n/g, "\n");
const START = "function blockNotice(message: string, durationMs?: number): Notice {";
const END = "\n}\n";

// Fail closed on BOTH boundaries: a renamed signature or a moved function must
// break this file rather than let it slice something else and pass.
expect(src.split(START), "blockNotice's signature changed or it is gone").toHaveLength(2);
const from = src.indexOf(START);
const to = src.indexOf(END, from);
expect(to, "no function end found after blockNotice").toBeGreaterThan(from);
const fn = src.slice(from, to + END.length);
// The body must still be the shape this test reasons about.
expect(fn.match(/noticeBlocks\(/g), "blockNotice no longer calls noticeBlocks").toHaveLength(1);
expect(fn.match(/createFragment\(/g), "blockNotice no longer builds a fragment").toHaveLength(1);
expect(fn.match(/new Notice\(/g), "blockNotice's Notice construction changed").toHaveLength(2);

const built: Built[] = [];
const run = new Function(
	"Notice",
	"createFragment",
	"noticeBlocks",
	`${transformSync(fn, { loader: "ts", target: "es2022" }).code}\nreturn blockNotice;`
)(
	class {
		constructor(message: unknown, durationMs: unknown) {
			built.push({ message, durationMs });
		}
	},
	(fill: (f: ReturnType<typeof fakeFragment>) => void) => {
		const f = fakeFragment();
		fill(f);
		return f;
	},
	// The real splitter, imported rather than restated - a second copy of the
	// rule here could drift from the one that ships.
	(message: string): string[] => message.split(/\n\s*\n/).filter((s) => s.length > 0)
) as (message: string, durationMs?: number) => unknown;

describe("blockNotice, executed", () => {
	it("builds ONE DIV PER BLOCK for a two-block message", () => {
		built.length = 0;
		run("ink not appearing on this device?\n\nyour ink is safe. still trying...");
		expect(built).toHaveLength(1);
		const frag = built[0]!.message as FakeNode;
		expect(frag.tag, "a two-block message did not become a fragment").toBe("fragment");
		expect(frag.children.map((c) => c.tag)).toEqual(["div", "div"]);
		expect(frag.children.map((c) => c.text)).toEqual([
			"ink not appearing on this device?",
			"your ink is safe. still trying...",
		]);
	});

	it("passes a one-block message through as a STRING, so it pays for no fragment", () => {
		built.length = 0;
		run("just the one line");
		expect(built).toHaveLength(1);
		expect(built[0]!.message).toBe("just the one line");
	});

	it("carries the duration through on both branches", () => {
		built.length = 0;
		run("one\n\ntwo", 8000);
		run("single", 8000);
		expect(built.map((b) => b.durationMs)).toEqual([8000, 8000]);
	});

	it("builds three divs for three blocks, so the boox and ipad hints are covered too", () => {
		built.length = 0;
		run("a\n\nb\n\nc");
		expect((built[0]!.message as FakeNode).children).toHaveLength(3);
	});
});
