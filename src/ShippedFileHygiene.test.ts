/**
 * NOTHING SHIPPED NAMES HOW IT WAS BUILT.
 *
 * Alan's rule, and it is absolute: no public-facing reference to the tooling or
 * the process anywhere a reader of this repository can reach. He found one in a
 * shipped build himself, which is one time too many for a rule a grep can hold.
 *
 * What this catches is mostly not credit lines. It is source comments citing
 * internal coordination files BY PATH as the authority for a user-facing
 * string: those leak the process, the file layout of a machine nobody else has,
 * and role names, into a repository people read. A decision and its date belong
 * in a comment; where it was written down does not.
 *
 * THE TERMS ARE ENCODED, and that is the point rather than an affectation. The
 * first version of this file spelled all of them in plaintext and then excluded
 * itself from its own walk - so the guard was simultaneously the largest
 * remaining instance of what it bans, and arranged not to see itself. Encoded
 * and decoded at runtime, the file is inert to its own pattern and no
 * self-exemption is needed: it is walked like everything else.
 *
 * WORD BOUNDARIES ON THE NAMES, deliberately. Without them one of them matches
 * inside `contrastRatio`, which occurs twenty-odd times in the ink theme and
 * snip code - the first run failed on exactly that and nothing else. The path
 * and phrase patterns stay unbounded, because they cannot occur inside an
 * innocent identifier.
 *
 * `docs/demo.js` is excluded: a build artefact, checked byte-for-byte by
 * `check:site`, never hand-edited.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Internal process terms, base64 so this file does not contain them. */
const NAMES_B64 = "Y2xhdWRlfGFudGhyb3BpY3xjb2RleHxvcHVzfHNvbm5ldHxmYWJsZXxhc3RyYXxsdW5hfGdwdA==";
/** Internal paths and phrases, same reason. */
const PHRASES_B64 = "XC5jbGF1ZGUvfGxlYWQtZW5naW5lZXJ8bWFpbGJveHxxdWV1ZVwubWR8Y28tYXV0aG9yZWQ=";
/** Positive controls: lines that MUST be caught. */
const POSITIVE_B64 =
	"Ly8gYXBwcm92ZWQgYnkgQXN0cmEgYXQgMTc6MjIKc2VlIH4vLmNsYXVkZS9tYWlsYm94L3F1ZXVlLm1kCkNvLUF1dGhvcmVkLUJ5OiBzb21lb25l";

/** Binary-rule controls, encoded for the same reason: a phrase and a bare name. */
const CO_AUTHORED_B64 = "Q28tQXV0aG9yZWQtQnk=";
const GPT_B64 = "R1BU";

/**
 * Decoded without `Buffer`: this project's tsconfig does not pull in node
 * types, and a test that needs a new dependency to express a hygiene rule is a
 * test that gets deleted. `atob` is available in every runtime the suite uses.
 */
declare const atob: (data: string) => string;
const decode = (b64: string): string => atob(b64);

const PATTERN = new RegExp(`\\b(${decode(NAMES_B64)})\\b|${decode(PHRASES_B64)}`, "i");
const PHRASE_PATTERN = new RegExp(decode(PHRASES_B64), "i");

/** git's rule: a NUL in the first 8000 bytes makes a file binary. */
const isBinary = (text: string): boolean => text.slice(0, 8000).includes(String.fromCharCode(0));
/**
 * Binary files hold short random runs that read as names, so they are checked
 * for the phrases only. Text files get both patterns.
 */
const patternFor = (text: string): RegExp => (isBinary(text) ? PHRASE_PATTERN : PATTERN);

/**
 * Two carve-outs, named one at a time with a reason each. Everything else that
 * git tracks is walked.
 *
 * A DIRECTORY ALLOW-LIST WAS THE FIRST SHAPE AND IT WAS WRONG: it named src,
 * docs and the manifests, and so left `test/` out entirely - a ruling
 * attribution sat in test/measure/TailClearBox.test.ts through a release this
 * very guard had declared clean. A deny-list of two is auditable; an allow-list
 * silently omits whatever directory is added next.
 *
 * Both measure ZERO today. They are excluded against what they may become, not
 * against what they contain.
 */
const CARVE_OUTS: Record<string, string> = {
	// A generated bundle, reproduced byte-for-byte by check:site from sources
	// that ARE scanned; a hand edit is already a gate failure.
	"docs/demo.js": "generated bundle, its sources are scanned",
	// Generated dependency graph. Third-party package names are not ours to
	// reword, and one of them containing a banned substring would stop the gate
	// on something nobody here can fix.
	"package-lock.json": "generated, third-party package names",
};

function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	return out
		.split(String.fromCharCode(10))
		.map(l => l.trim())
		.filter(l => l.length > 0 && !(l in CARVE_OUTS));
}


describe("nothing shipped names how it was built", () => {
	it("no tracked source, doc or manifest mentions the tooling or the coordination files", () => {
		const files = trackedFiles();
		// Without this a broken walk reports an empty list and passes.
		expect(files.length, "the tracked-file walk found nothing").toBeGreaterThan(0);
		// This file is walked like any other - no self-exemption. If it ever
		// trips its own pattern, the encoding above has been undone.
		expect(files.some(f => f.endsWith("ShippedFileHygiene.test.ts"))).toBe(true);

		const hits: string[] = [];
		for (const rel of files) {
			let text: string;
			try {
				text = readFileSync(`${ROOT}/${rel}`, "utf8");
			} catch {
				continue;
			}
			const pattern = patternFor(text);
			text.split(/\r?\n/).forEach((line, i) => {
				if (pattern.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
			});
		}
		expect(
			hits,
			`${hits.length} line(s) name the tooling or a coordination file:\n${hits.join("\n")}`
		).toEqual([]);
	});

	it("the pattern is live: it catches what it is for, and not ordinary code", () => {
		// Without these the walk above passes just as well with a broken regex.
		for (const line of decode(POSITIVE_B64).split("\n")) {
			expect(PATTERN.test(line), `missed: ${line}`).toBe(true);
		}
		// The false positive that failed the first version: a banned name is a
		// substring of `contrastRatio`, which is real code in InkTheme.ts.
		expect(PATTERN.test("const contrastRatio = fg / bg;")).toBe(false);
		expect(PATTERN.test("computeContrastRatio(a, b)")).toBe(false);
	});

	it("a binary file is checked for the phrases only: a phrase inside one is caught, a bare name is not", () => {
		const NUL = String.fromCharCode(0);
		const phraseInBinary = `${NUL}${NUL}${decode(CO_AUTHORED_B64)}${NUL}`;
		const nameInBinary = `${NUL}${NUL}${decode(GPT_B64)}${NUL}`;
		expect(isBinary(phraseInBinary)).toBe(true);
		expect(patternFor(phraseInBinary).test(phraseInBinary), "a phrase inside a binary was missed").toBe(true);
		expect(patternFor(nameInBinary).test(nameInBinary), "a bare name inside a binary was checked").toBe(false);
	});
});
