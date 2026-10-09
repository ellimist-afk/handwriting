/**
 * The note check reads a deck of short numbered lists, and lines that end in
 * a block id, as the presenter shows them.
 *
 * The rendered slide shows an ordered list's items and never their numbers
 * (the browser draws the number, it is not text of the slide), and it shows no
 * block id (`^abc`) at the end of a block. A deck whose slides are short
 * numbered lists failed the note check on its own note: the digits of the
 * list markers cost the 3 in 4 coverage, so saved ink was not loaded and new
 * ink was not saved.
 */
import { describe, expect, it } from "vitest";
import { noteMatchesDeck } from "./SlidesInkSurface";

/** Each pair is [the note's section, the slide's text as rendered]. */
type Slide = readonly [string, string];

const check = (slides: readonly Slide[]): boolean =>
	noteMatchesDeck(
		slides.map(([note]) => note),
		slides.map(([, rendered]) => rendered)
	);

const NUMBERED_DECK: readonly Slide[] = [
	["# Agenda\n\n1. Welcome\n2. Budget\n3. Hiring", "AgendaWelcomeBudgetHiring"],
	["1. Open issues\n2. Owners", "Open issuesOwners"],
	["1. Risks\n2. Mitigations\n3. Dates", "RisksMitigationsDates"],
	["1. Demo\n2. Questions", "DemoQuestions"],
	["1. Thanks\n2. Contact", "ThanksContact"],
];

describe("the note check against numbered lists", () => {
	it("a deck of short numbered-list slides matches its own note", () => {
		expect(check(NUMBERED_DECK)).toBe(true);
	});

	it("a list numbered with a closing parenthesis", () => {
		expect(
			check([
				["1) Open issues\n2) Owners", "Open issuesOwners"],
				["1) Risks\n2) Mitigations", "RisksMitigations"],
				["1) Demo\n2) Questions", "DemoQuestions"],
			])
		).toBe(true);
	});

	it("a two-digit number and a list that starts above one", () => {
		expect(
			check([
				["10. Open issues\n11. Owners", "Open issuesOwners"],
				["7. Risks\n8. Mitigations", "RisksMitigations"],
				["12. Demo\n13. Questions", "DemoQuestions"],
			])
		).toBe(true);
	});

	it("an indented sub-list", () => {
		expect(
			check([
				["1. Plan\n   1. Scope\n   2. Dates", "PlanScopeDates"],
				["1. Risks\n   1. Weather\n   2. Staffing", "RisksWeatherStaffing"],
				["1. Demo\n   1. Login\n   2. Export", "DemoLoginExport"],
			])
		).toBe(true);
	});

	it("a numbered list inside a callout or a quote", () => {
		expect(
			check([
				["> [!note] Plan\n> 1. Open issues\n> 2. Owners", "PlanOpen issuesOwners"],
				["> 1. Risks\n> 2. Mitigations", "RisksMitigations"],
				[">> 1. Demo\n>> 2. Questions", "DemoQuestions"],
			])
		).toBe(true);
	});

	it("a numbered task item", () => {
		expect(
			check([
				["1. [ ] Open issues\n2. [x] Owners", "Open issuesOwners"],
				["1. [ ] Risks\n2. [ ] Mitigations", "RisksMitigations"],
				["1. [x] Demo\n2. [ ] Questions", "DemoQuestions"],
			])
		).toBe(true);
	});
});

describe("the note check against block ids", () => {
	it("a deck of short slides that each end in a block id", () => {
		expect(
			check([
				["Revenue plan ^rev", "Revenue plan"],
				["Hiring plan ^hire", "Hiring plan"],
				["Launch dates ^dates", "Launch dates"],
				["Open risks ^risks", "Open risks"],
			])
		).toBe(true);
	});

	it("a block id alone on its own line", () => {
		expect(
			check([
				["| a | b |\n| - | - |\n| one | two |\n\n^table-one", "abonetwo"],
				["Revenue plan\n\n^rev", "Revenue plan"],
				["Hiring plan\n\n^hire", "Hiring plan"],
			])
		).toBe(true);
	});

	it("a numbered item that ends in a block id", () => {
		expect(
			check([
				["1. Open issues ^a1\n2. Owners ^a2", "Open issuesOwners"],
				["1. Risks ^b1\n2. Mitigations ^b2", "RisksMitigations"],
				["1. Demo ^c1\n2. Questions ^c2", "DemoQuestions"],
			])
		).toBe(true);
	});
});

describe("the note check keeps what the slide does show", () => {
	it("a number inside a sentence stays text", () => {
		expect(
			check([
				["Version 2. Next steps follow", "Version 2. Next steps follow"],
				["Room 14) is booked", "Room 14) is booked"],
			])
		).toBe(true);
		// The digit is part of the slide here, so a slide without it covers less.
		expect(
			check([
				["Version 2. Next", "Version Next"],
				["Room 14) is", "Room is"],
			])
		).toBe(false);
	});

	it("a numbered list inside a code fence keeps its digits", () => {
		expect(check([["```\n1. one\n2. two\n```", "1. one\n2. two\n"]])).toBe(true);
		expect(check([["```\n1. one\n2. two\n```", "onetwo"]])).toBe(false);
	});

	it("a caret inside a sentence stays text", () => {
		expect(
			check([
				["Raise x^2 for each slide", "Raise x^2 for each slide"],
				["Raise y^3 as well", "Raise y^3 as well"],
			])
		).toBe(true);
	});

	it("a caret at the end of a line inside text is not a block id", () => {
		// "x^2" ends its line but the caret has no space or line start before
		// it, so it is part of the text and the slide shows it.
		expect(check([["a^1\nb^2\nc^3", "a^1b^2c^3"]])).toBe(true);
		expect(check([["a^1\nb^2\nc^3", "abc"]])).toBe(false);
	});
});

describe("the note check still refuses a different deck", () => {
	it("the same list numbers over different words fail", () => {
		expect(
			check(
				NUMBERED_DECK.map(([note], i) => [
					note,
					[
						"Shopping list milk eggs flour",
						"Garden beds tomatoes beans",
						"Weekend trip packing and maps",
						"Birthday cake and candles",
						"Dinner reservations tonight",
					][i] ?? "",
				])
			)
		).toBe(false);
	});

	it("a deck with a different number of slides fails", () => {
		expect(
			noteMatchesDeck(
				NUMBERED_DECK.map(([note]) => note),
				NUMBERED_DECK.slice(0, 4).map(([, rendered]) => rendered)
			)
		).toBe(false);
	});
});
