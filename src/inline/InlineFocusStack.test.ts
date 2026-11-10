import { afterEach, describe, it, expect } from "vitest";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { focusStackNote, holdKeyboardForEveryPen } from "./InlineFocus";
import { clearInlinePenTrace, formatInlinePenTrace } from "./InlinePenRouterTrace";

/** A V8 stack as the browser reports it: the header line, then one line per frame. */
function stackOf(...frames: string[]): string {
	return ["Error", ...frames.map((frame) => `    at ${frame}`)].join("\n");
}

describe("focusin row stack note", () => {
	it("keeps the function name and the origin of each frame, and drops the location", () => {
		const stack = stackOf(
			"listener (file:///C:/Users/x/vault/.obsidian/plugins/p/main.js:9:9)",
			"fn (file:///C:/Users/x/vault/.obsidian/plugins/p/main.js:12:3)",
			"fn (app://obsidian.md/app.js:1:2)",
			"fn (plugin:page-scroll:44:9)",
			"fn (file:///C:/Users/x/vault/main.js:5:5)"
		);
		expect(focusStackNote(stack)).toBe("fn (script) | fn app://obsidian.md | fn plugin:page-scroll");
	});

	it("names an anonymous frame by its origin alone", () => {
		const stack = stackOf(
			"listener (x)",
			"file:///C:/Users/x/vault/main.js:1:1",
			"app://obsidian.md/app.js:9:9",
			"plugin:x:2:3"
		);
		expect(focusStackNote(stack)).toBe("(script) | app://obsidian.md | plugin:x");
	});

	it("drops the query string and hash after the origin", () => {
		const stack = stackOf(
			"listener (x)",
			"fn (app://obsidian.md/app.js?v=3#frag:1:2)",
			"fn (plugin:page-scroll?id=1:44:9)",
			"fn (file:///a/b.js?q=1:2:3)"
		);
		expect(focusStackNote(stack)).toBe("fn app://obsidian.md | fn plugin:page-scroll | fn (script)");
	});

	it("reduces a Windows backslash path to the script origin", () => {
		const stack = stackOf("listener (x)", "fn (C:\\Users\\x\\vault\\.obsidian\\main.js:12:3)", "g (x)", "h (x)");
		expect(focusStackNote(stack)).toBe("fn (script) | g (script) | h (script)");
	});

	it("never carries a file name with spaces from a script URL", () => {
		const stack = stackOf("listener (x)", "fn (file:///C:/Users/x/vault/notes/My Secret Note.md)", "g (x)", "h (x)");
		const note = focusStackNote(stack);
		expect(note).not.toContain("Secret");
		expect(note).not.toContain("Note.md");
	});

	it("gives an empty note when the stack has no frames below the listener", () => {
		expect(focusStackNote("Error")).toBe("");
		expect(focusStackNote(stackOf("listener (x)"))).toBe("");
	});

	it("leaves no path tokens in the note for the stack from the cells above", () => {
		const stack = stackOf(
			"listener (x)",
			"fn (file:///C:/Users/x/vault/.obsidian/plugins/p/main.js:12:3)",
			"fn (app://obsidian.md/app.js:1:2)",
			"fn (plugin:page-scroll:44:9)"
		);
		const note = focusStackNote(stack).replace("app://obsidian.md", "");
		expect(note).not.toMatch(/[/\\]/);
		expect(note).not.toMatch(/:\d/);
		expect(note).not.toMatch(/\.js/);
	});
});

/**
 * The row as the trace holds it: a pen-down through the editor's own hold, one focusin, then the row text.
 * The helper cells above never reach the row's call site; this cell does.
 */
describe("focusin row as written to the trace", () => {
	afterEach(() => {
		setDiagnosticsEnabled(false);
		clearInlinePenTrace();
	});

	it("the stack in the written row has no path, file name, line or column", () => {
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		const attrs = new Map<string, string>();
		const content = Object.assign(new EventTarget(), {
			getAttribute: (n: string) => attrs.get(n) ?? null,
			setAttribute: (n: string, v: string) => void attrs.set(n, v),
			removeAttribute: (n: string) => void attrs.delete(n),
			ownerDocument: { activeElement: null, defaultView: null },
		});
		const root = new EventTarget();
		const release = holdKeyboardForEveryPen(
			{ hasFocus: false, contentDOM: content as never, dom: root as never, scrollDOM: { scrollTop: 0 } as never },
			() => null
		);
		root.dispatchEvent(
			Object.assign(new Event("pointerdown"), { pointerType: "pen", pointerId: 2, buttons: 1, button: 0, pressure: 0.5, clientX: 10, clientY: 20, tiltX: 0, tiltY: 0 })
		);
		content.dispatchEvent(new Event("focusin"));
		release();

		const row = formatInlinePenTrace().split("\n").find((l) => l.includes("focusin after pen-down"));
		expect(row, "one focusin row written").toBeDefined();
		const stack = (row ?? "").split("stack: ")[1] ?? "";
		expect(stack, "stack note in the row").toMatch(/\(script\)/);
		expect(stack).not.toMatch(/[/\\]/);
		expect(stack).not.toMatch(/:\d/);
		expect(stack).not.toMatch(/\.js/);
	});
});

/** The first note element for one frame, so each cell names the frame it tests. */
describe("frame paths that carry an @", () => {
	const noteOf = (frame: string) => focusStackNote(stackOf("listener (x)", frame, "listener (x)", "listener (x)")).split(" | ")[0];

	it("a scoped package path under node_modules gives (script)", () => {
		expect(noteOf("file:///C:/Users/x/vault/.obsidian/plugins/p/node_modules/@scope/pkg/index.js:1:2")).toBe("(script)");
	});

	it("a Windows path with an @ folder gives (script)", () => {
		expect(noteOf("C:\\Users\\x\\vault\\node_modules\\@scope\\pkg\\index.js:1:2")).toBe("(script)");
	});

	it("an @ inside a folder name gives (script)", () => {
		expect(noteOf("file:///C:/Users/x/Notes@Work/main.js:3:4")).toBe("(script)");
	});

	it("a V8 frame with no parentheses never takes the @ form", () => {
		expect(noteOf("fn@capacitor://localhost/app.js:1:2")).toBe("(script)");
	});
});

/** The stack as a JavaScriptCore engine writes it: frame lines carry no "at " prefix. */
describe("JavaScriptCore frames", () => {
	const rawNoteOf = (frame: string) => focusStackNote(["Error", "listener (x)", frame, "listener (x)", "listener (x)"].join("\n")).split(" | ")[0];

	it("a raw frame with an @ in its path gives (script)", () => {
		expect(rawNoteOf("capacitor://localhost/x/Notes@Work/main.js:1:2")).toBe("(script)");
	});

	it("a raw fn@location frame keeps the name and gives (script)", () => {
		expect(rawNoteOf("fn@capacitor://localhost/app.js:1:2")).toBe("fn (script)");
	});
});
