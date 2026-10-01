/**
 * The Eraser, Lasso, Insert space, Pan and Highlighter commands announce themselves with a toast on every
 * tap, on and off. That is a routine toast, so it belongs behind the developer switch like the pen's (audit 180).
 * Each command's block is sliced out of main.ts and every toast call in it must sit directly behind the gate.
 */
import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";

const source = mainSource.replace(/\r\n/g, "\n");

function commandBlock(id: string): string {
	const at = source.indexOf(`id: "${id}",`);
	expect(at, `${id} is registered`).toBeGreaterThan(0);
	const end = source.indexOf("\n\t\t});", at);
	expect(end).toBeGreaterThan(at);
	return source.slice(at, end);
}

const CASES: Array<[string, RegExp]> = [
	["inline-tool-eraser", /showEraserToggleNotice\(/g],
	["inline-tool-lasso", /showLassoToggleNotice\(/g],
	["inline-tool-space", /showSpaceToggleNotice\(/g],
	["inline-tool-pan", /showPanToggleNotice\(/g],
	["inline-tool-highlighter", /new Notice\(/g],
];

describe("tool toasts are routine (audit 180)", () => {
	for (const [id, call] of CASES) {
		it(`${id} shows its toast only behind routineNoticesVisible()`, () => {
			const block = commandBlock(id);
			const calls = [...block.matchAll(call)];
			expect(calls, "the command still announces").toHaveLength(1);
			const at = calls[0]?.index ?? 0;
			expect(block.slice(Math.max(0, at - 30), at)).toMatch(/if \(routineNoticesVisible\(\)\) $/);
		});
	}
});
