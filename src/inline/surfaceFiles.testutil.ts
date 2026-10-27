/**
 * The files that hold each ink surface's code, as the ink-surface ledger
 * (`INK_SURFACES`, InkSurfaces.ts) lists them.
 *
 * A test that means "every file of the note surface" asks here instead of
 * naming `/src/inline/InkOverlay.ts`. Splitting that file moves note-surface
 * code into more files, and every split commit updates the ledger entry to
 * list each of them, so a check keyed here follows the code to its new file
 * instead of going blind to it.
 *
 * An entry names its `file` and, once a split has moved code out of it, its
 * `parts`. This is the one place that reads both. `parts` is optional, so
 * `tsc` does not point here when an entry grows; InkSurfaceRules.test.ts
 * reads through this helper too, so the guards cannot read different lists.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 * Nothing that ships imports this module.
 */

import { codeOnly } from "../CodeOnly";
import { INK_SURFACES, inkSurface, type InkSurfaceId } from "./InkSurfaces";

/** Every file that holds `id`'s code, root-absolute ("/src/..."), as the glob keys them. */
export function surfaceFiles(id: InkSurfaceId): string[] {
	const surface = inkSurface(id);
	return [surface.file, ...(surface.parts ?? [])];
}

/** Every file of every ink surface in the ledger. */
export function allSurfaceFiles(): string[] {
	return INK_SURFACES.flatMap((s) => surfaceFiles(s.id));
}

/**
 * `id`'s code across every file the ledger lists for it, comments blanked
 * (`codeOnly`), line endings normalised to LF, files joined with a newline in
 * ledger order (`file` first, then `parts`). `scan` is the caller's own raw-text
 * scan keyed by root-absolute path (an eager `import.meta.glob` of `/src/**` +
 * `.ts` with `query: "?raw"`; the literal stays in each test because Vite needs
 * it per module, so this module reads no files and loads nothing new). Throws
 * on a listed file missing from the scan, rather than answering with less text
 * and letting a needle pass over a file it never read.
 */
export function surfaceCode(id: InkSurfaceId, scan: Readonly<Record<string, string>>): string {
	return surfaceFiles(id)
		.map((file) => {
			const text = scan[file];
			if (text === undefined) throw new Error(`${id} surface file not in the source scan: ${file}`);
			return codeOnly(text.replace(/\r\n/g, "\n"));
		})
		.join("\n");
}

/**
 * Held-to-the-tree helpers for InkSurfaceRules.test.ts ("the ledger's parts
 * are held to the tree"). Pure string functions, so the rule can be pinned
 * with fixtures that need no source file: a helper that returned an empty
 * answer would make the tree cells pass by doing nothing.
 */

/** "/src/a/b/../c.ts" as "/src/a/c.ts". Only the "." and ".." segments a relative import can carry. */
function normalizePath(path: string): string {
	const out: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return "/" + out.join("/");
}

/**
 * The files a surface's install lines name: every `installX(Anything.prototype)`
 * call in `code` (the surface file with comments already blanked), resolved
 * through that file's own relative imports to a root-absolute path. Sorted.
 * Throws on a call whose name is not imported from a relative path, rather than
 * skipping it, so a rewritten install cannot make the answer quietly smaller.
 */
export function installedParts(code: string, file: string): string[] {
	const dir = file.slice(0, file.lastIndexOf("/"));
	const imported = new Map<string, string>();
	for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(\.{1,2}\/[^"]+)"/g)) {
		for (const item of m[1]!.split(",")) {
			const local = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
			if (local) imported.set(local, m[2]!);
		}
	}
	const parts = new Set<string>();
	for (const m of code.matchAll(/\b(install\w*)\(\s*\w+\.prototype\s*[,)]/g)) {
		const spec = imported.get(m[1]!);
		if (spec === undefined) throw new Error(`${file}: ${m[1]}(...prototype) is not imported from a relative path`);
		parts.add(normalizePath(`${dir}/${spec}`.replace(/\.ts$/, "") + ".ts"));
	}
	return [...parts].sort();
}

/**
 * `derived` (what the install lines name) against the ledger's `parts`, both
 * ways. `missing` is installed and not listed; `ghost` is listed, no install
 * line names it, and `exceptions` (path -> reason) does not excuse it.
 */
export function ledgerDiff(
	derived: readonly string[],
	parts: readonly string[],
	exceptions: Readonly<Record<string, string>> = {}
): { missing: string[]; ghost: string[] } {
	return {
		missing: derived.filter((f) => !parts.includes(f)).sort(),
		ghost: parts.filter((f) => !derived.includes(f) && !(f in exceptions)).sort(),
	};
}

/**
 * Files in `tree` (root-absolute keys) that sit beside `file`, are named
 * `<file's stem>` plus letters or digits (InkOverlayX.ts beside InkOverlay.ts),
 * and are not in `listed`. Tests, testutils and declaration files carry a dot
 * before the extension, so the pattern leaves them out. Sorted.
 */
export function unlistedSiblings(tree: readonly string[], listed: readonly string[], file: string): string[] {
	const dir = file.slice(0, file.lastIndexOf("/") + 1);
	const stem = file.slice(dir.length).replace(/\.ts$/, "");
	return tree
		.filter((f) => f.startsWith(dir + stem) && /^[A-Za-z0-9]*\.ts$/.test(f.slice(dir.length + stem.length)))
		.filter((f) => !f.slice(dir.length).includes("/") && !listed.includes(f))
		.sort();
}
