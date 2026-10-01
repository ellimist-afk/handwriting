import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

it("R1-21-F1 does not label ordinary successful camera assertions as expected failures", () => {
	const test = source("test/render/MinimalCameraScale.test.ts");
	expect(test).toContain('it("syncCamera alone keeps ink on its word');
	expect(test).toContain("expect(Math.abs(stale.error)).toBeLessThan(SUBPIXEL)");
	expect(test.includes("CONFIRMED DEFECT, not fixed on this branch")).toBe(false);
});

it("R2-002 privacy documentation describes the explicit diagnostic upload and its payload scope", () => {
	const main = source("src/main.ts");
	const security = source("SECURITY.md");
	const readme = source("README.md");
	expect(main).toContain('method: "POST"');
	expect(readme).toContain("unless you press `Upload` button");
	expect.soft(security.includes("Handwriting makes no network requests")).toBe(false);
	expect.soft(readme.includes("coordinates and timings- nothing else")).toBe(false);
});

it("R2-003 contributor prerequisites and test-scope copy match the actual toolchain", () => {
	const contributing = source("CONTRIBUTING.md");
	const manual = source("docs/manual.md");
	const pkg = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
	expect(pkg.scripts["test:render"]).toContain("vitest run");
	expect(pkg.scripts.gate).toContain("test:render");
	expect.soft(contributing.includes("Node 18+")).toBe(false);
	expect.soft(manual.includes("npm test          # the full test suite")).toBe(false);
});

it("R2-004 site and manual diagnostic instructions use the registered commands and Copy ID control", () => {
	const main = source("src/main.ts");
	const site = source("docs/index.html");
	const manual = source("docs/manual.md");
	expect(main).toContain('name: "Bug report: record"');
	expect(main).toContain('name: "Bug report: send"');
	expect.soft(site.includes("Diagnostics: begin recording")).toBe(false);
	expect.soft(site.includes("Diagnostics: show pen trace")).toBe(false);
	expect.soft(manual.includes("in the modal, tap-to-select")).toBe(false);
});
