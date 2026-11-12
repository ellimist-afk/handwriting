import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

// Audit low #145 (BuildRelease-3): a pinch zooms a note only with Infinite canvas on,
// so the feature lists must say so wherever they promise pinch to zoom. The README
// keeps its one promise. The landing page names "Pinch to zoom" only as a clip caption,
// a <span> whose <li> opens seven lines above it, so the `<li>pinch to zoom` pattern
// reads zero site lines and does not check that caption; it binds any future
// one-line <li> promise.
it("#145 README and site name Infinite canvas beside the pinch-to-zoom promise", () => {
	const readme = source("README.md").split(/\r?\n/).filter((l) => /^\* pinch to zoom/.test(l));
	const site = source("docs/index.html").split(/\r?\n/).filter((l) => /<li>pinch to zoom/i.test(l));
	expect(readme).toHaveLength(1);
	expect(readme[0]).toMatch(/infinite canvas/i);
	for (const line of site) expect(line).toMatch(/infinite canvas/i);
});
