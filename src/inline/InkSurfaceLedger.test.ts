/**
 * The divergence ledger in `InkSurfaceRules.test.ts`, read as prose.
 *
 * That file's rows are the running account this codebase keeps of the defect
 * it exists for: a ruling that reached one ink surface and not another. A row
 * that opens "THE TENTH one-surface divergence" is making a claim about WHICH
 * one it is, and two rows made the same claim - the abandoned-stroke rule
 * (`17f917e`) and the reticle watchdog (`20ca0b5`), written forty minutes
 * apart, both numbered ELEVENTH and both calling themselves "the second this
 * registry was standing for". The ledger then read as eleven divergences with
 * no twelfth, and anybody counting them found one fewer than had happened.
 *
 * That is the failure the registry's own header names - a table nobody runs -
 * one level up, in the prose the table is annotated with. So the prose runs
 * too.
 *
 * WHY THIS IS ITS OWN FILE. `import.meta.glob` EXCLUDES the module that calls
 * it, so `InkSurfaceRules.test.ts` cannot reach its own text through the scan
 * it already runs over every other file: `ALL_TS` there has no key for it, and
 * a guard written inside it would have read an empty string and passed
 * vacuously - the exact shape of failure that file was built to refuse. A
 * neighbour can read it, so a neighbour does.
 *
 * WHAT THIS CANNOT ANSWER: whether the numbers are RIGHT. Nothing here knows
 * that the watchdog divergence is the twelfth; it knows that two rows must not
 * both be the eleventh, which is the mistake that actually happened and the
 * one a reader cannot see without counting the whole file.
 */

import { describe, expect, it } from "vitest";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const LEDGER = "/src/inline/InkSurfaceRules.test.ts";

/**
 * The ledger's comments as one line of prose.
 *
 * Comment markers off first, then whitespace collapsed: a claim that wraps
 * across two `//` lines is invisible to a match that does not, and this repo
 * is checked out CRLF on Windows and LF on CI, so a raw scan that keeps line
 * endings answers differently on the two machines.
 */
const prose = (ALL_TS[LEDGER] ?? "")
	.replace(/\r\n/g, "\n")
	.replace(/^[ \t]*(?:\*|\/\/)[ \t]?/gm, "")
	.replace(/\s+/g, " ");

describe("the ink-surface divergence ledger numbers each one once", () => {
	it("reads the ledger at all", () => {
		// Or every assertion below is a scan of an empty string - see the
		// glob note in this file's header for how that nearly happened.
		expect(prose, `${LEDGER} is not in the source scan`).not.toBe("");
	});

	it("gives every numbered divergence its own ordinal", () => {
		const claimed = [...prose.matchAll(/THE ([A-Z]+) one-surface divergence/g)].map(
			(m) => m[1]!
		);
		// Three rows carry a number today. Fewer means a row stopped saying
		// which divergence it is, which is how the collision hid: the second
		// ELEVENTH had dropped the words "one-surface divergence" and read
		// only "THE ELEVENTH, and the second this registry was standing for".
		expect(claimed.length, "a numbered row lost its number").toBeGreaterThanOrEqual(3);
		expect(
			new Set(claimed).size,
			`two rows claim the same divergence: ${claimed.join(", ")}`
		).toBe(claimed.length);
	});

	it("counts the ones the registry was standing for the same way", () => {
		// The other half of each claim, and the half that survives even when a
		// row abbreviates the first: a row is the Nth divergence AND the Mth
		// one this guard was already standing when it was found. Both were
		// "the second".
		const standing = [...prose.matchAll(/and the ([a-z]+) this registry was standing/g)].map(
			(m) => m[1]!
		);
		expect(standing.length, "a row stopped saying where it falls").toBeGreaterThanOrEqual(3);
		expect(
			new Set(standing).size,
			`two rows claim the same place in the registry's own run: ${standing.join(", ")}`
		).toBe(standing.length);
	});
});
