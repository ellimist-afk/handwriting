/**
 * The note check reads a first slide that opens with a callout or a fenced
 * code block as the presenter shows it.
 *
 * The rendered slide shows a callout's title (or, with none, its type as a
 * word) and never the `[!type]` marker; it shows a code block's code and never
 * the fence or its language tag (the copy button is an icon, no text). The
 * note's Markdown is reduced the same way before the two are compared.
 */
import { describe, expect, it } from "vitest";
import { noteMatchesDeck } from "./SlidesInkSurface";

const SECOND = "\n\n---\n\n# Two";
const check = (first: string, rendered: string): boolean =>
	noteMatchesDeck([first, "# Two"], [rendered, "Two"]);

describe("the note check against callouts and code blocks on the first slide", () => {
	it("a callout with a title", () => {
		expect(check("> [!note] Heads up\n> Read this first.", "Heads upRead this first.")).toBe(true);
	});

	it("a callout with no title (the slide shows its type as a word)", () => {
		expect(check("> [!warning]\n> Mind the gap.", "WarningMind the gap.")).toBe(true);
	});

	it("a folding callout", () => {
		expect(check("> [!tip]- Quick one\n> Hidden body.", "Quick oneHidden body.")).toBe(true);
	});

	it("a fenced code block with a language tag", () => {
		expect(check("```js\nconst a = 1;\n```\n\nAfter.", "const a = 1;\nAfter.")).toBe(true);
	});

	it("a tilde fence with a language tag", () => {
		expect(check("~~~python\nprint(1)\n~~~", "print(1)\n")).toBe(true);
	});

	it("control: a different first slide still fails", () => {
		expect(check("> [!note] Heads up\n> Read this first.", "Something else entirely")).toBe(false);
		void SECOND;
	});
});

describe("the note check reads a slide past something the reduction does not know", () => {
	const body = "The quarterly numbers came in above the plan for every region this year.";

	it("a first slide opening with something the reduction does not know still matches on the text after it", () => {
		// Inline HTML: the slide shows none of the tag's letters. The reduction
		// drops tags; keeping them, this slide covers less than 3 in 4.
		expect(check(`<span class="big">Welcome</span> ${body}`, `Welcome ${body}`)).toBe(true);
	});

	it("a different note with the same number of slides still fails", () => {
		expect(
			check(
				`# Plan\n\n${body}`,
				"PlanShopping list: milk, eggs, flour and a bag of apples for the weekend."
			)
		).toBe(false);
	});
});

// Every section counts, and the note is the deck's when at least 3 in 4 of the
// letters of every section's opening turn up on its slide, in 20-letter runs.
// Each name carries the case's coverage of its own first slide.
describe("the note check needs most of every slide's opening on the slide", () => {
	it("a different note from the same template (53 shared letters, 61.6%) fails", () => {
		expect(
			check(
				"# Weekly team review\n\nAgenda for this week and owners listed below.\n\nSales numbers are up in the north region.",
				"Weekly team review\nAgenda for this week and owners listed below.\nHiring plan for the new design team."
			)
		).toBe(false);
	});

	it("a different note sharing one 45-letter line mid-slide (57.3%) fails", () => {
		expect(
			check(
				"# Budget\n\nNumbers below. Please keep this deck inside the team only thank you.\n\nQ3 spend was flat.",
				"Roadmap\nPlease keep this deck inside the team only thank you.\nWe ship in May."
			)
		).toBe(false);
	});

	it("the note's own slide with inline math the slide shows no letters of (81.7%) matches", () => {
		expect(
			check(
				"# Energy\n\nThe whole mass relation $\\frac{a}{b}+\\sqrt{x}$ holds for every body at rest.",
				"Energy\nThe whole mass relation  holds for every body at rest."
			)
		).toBe(true);
	});

	it("the note's own slide with inline math and only 19 letters after it matches", () => {
		expect(
			check(
				"# Energy\n\nThe mass relation $\\frac{a}{b}+\\sqrt{x}$ holds for a body at rest.",
				"Energy\nThe mass relation  holds for a body at rest."
			)
		).toBe(true);
	});

	it("the note's own slide with inline math straight after a 6-letter title matches", () => {
		expect(
			check(
				"# Energy\n\n$\\frac{a}{b}+\\sqrt{x}$ is the mass relation that holds for a body at rest.",
				"Energy\n is the mass relation that holds for a body at rest."
			)
		).toBe(true);
	});

	it("the note's own slide with a display math block matches", () => {
		expect(
			check(
				"# Energy\n\n$$\nE = mc^2 \\quad \\text{for a body at rest}\n$$\n\nThe mass relation.",
				"Energy\nThe mass relation."
			)
		).toBe(true);
	});

	it("a title-only slide whose math is dropped matches on the title found whole", () => {
		expect(check("# Energy $\\sqrt{x}$", "Energy ")).toBe(true);
	});

	it("control: dollar amounts are not math, and a different note that has them still fails", () => {
		expect(
			check(
				"# Prices\n\nApples cost $5 and pears cost $6 at the market this week.",
				"Prices\nBananas are on sale at the corner shop on Fridays."
			)
		).toBe(false);
		expect(
			check(
				"# Prices\n\nApples cost $5 and pears cost $6 at the market this week.",
				"Prices\nApples cost $5 and pears cost $6 at the market this week."
			)
		).toBe(true);
	});

	it("a note whose first slide matches but whose later slide says something else fails", () => {
		expect(
			noteMatchesDeck(
				["# One\n\nSame opening text for both decks here.", "# Two\n\nThis second slide says one thing entirely."],
				["OneSame opening text for both decks here.", "TwoA different second slide with other words."]
			)
		).toBe(false);
	});
});

describe("the note check keeps a plain < or > as text; only a tag is dropped", () => {
	for (const [label, note, slide] of [
		[
			"a comparison, a < b ... c > d",
			"# Limits\n\nKeep the load a < 10 on every node, and alert when latency > 200 ms for a minute.",
			"Limits\nKeep the load a < 10 on every node, and alert when latency > 200 ms for a minute.",
		],
		[
			"arrows <- and ->",
			"# Flow\n\nThe client <- sends the request to the gateway, then the gateway -> forwards it on.",
			"Flow\nThe client <- sends the request to the gateway, then the gateway -> forwards it on.",
		],
		[
			"a < with a callout later on the slide",
			"# Plan\n\nKeep the cost per unit < 5 for the pilot run.\n\n> [!note] Owner\n> Sam signs off on the pilot budget.",
			"Plan\nKeep the cost per unit < 5 for the pilot run.\nOwner\nSam signs off on the pilot budget.",
		],
		[
			"<= and >= on one line",
			"# Rules\n\nAccept when score >= 3 and reject when score <= 1, review the rest by hand.",
			"Rules\nAccept when score >= 3 and reject when score <= 1, review the rest by hand.",
		],
	] as const) {
		it(`matches: ${label}`, () => {
			expect(noteMatchesDeck([note, "# Two"], [slide, "Two"])).toBe(true);
		});
	}

	it("control: a tag is still dropped and its text kept", () => {
		expect(
			check(
				"# Notes\n\nThe <b>bold</b> part and a line<br/>break and <span class=\"x\">a span</span> stay.",
				"Notes\nThe bold part and a line\nbreak and a span stay."
			)
		).toBe(true);
	});
});

// Code shows its text literally: a `<span>` or a `$x$` inside a fence or a code
// span is on the slide, so it stays on the note side. Tags and math outside
// code are still dropped. Each note is short, so one missing run fails the check.
describe("the note check keeps tag-like and math-like text inside code", () => {
	it("a fenced <span> stays on the note side", () => {
		expect(check("# Use\n\n```\n<span>\n```\n\nhere", "Use<span>here")).toBe(true);
	});

	it("a fenced $x$ and an inline-code $x$ stay on the note side", () => {
		expect(check("# Use\n\n```\n$x$\n```\n\nhere", "Use$x$here")).toBe(true);
		expect(check("# Use `$x$` here", "Use $x$ here")).toBe(true);
	});

	it("control: a real tag outside code is still dropped, its text kept", () => {
		expect(check("# Use <span>this</span> here", "Use this here")).toBe(true);
	});
});
