/**
 * THE PLUGIN'S INLINE INK HOST PASSES THE TWO REOPEN CHECKS THROUGH TO THE APP.
 *
 * A note opened again takes another device's ink only when no save is queued
 * for the page and every pane on the note is quiet. The store asks its host for
 * both; the cells for the reopen itself drive the store through a test host.
 * This cell runs the host block main.ts builds in onload, read from its source
 * as the unload and identity cells do, and asks the host it attaches: the
 * queued-write answer comes from the page store, the pane answer from the panes
 * bound to that note only.
 */
import { expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";
import onloadSource from "./PluginOnload.ts?raw";
import type { InlineInkHost } from "./inline/InlineInkStore";

// The onload phases live in PluginOnload.ts, read here with main.ts.
const main = [mainSource, onloadSource].join("\n").replace(/\r\n/g, "\n");
const START = "\t\tinlineInk.attachHost({", END = "\n\t\t});";
const at = main.indexOf(START);
if (at < 0 || main.indexOf(START, at + 1) >= 0) throw new Error(`wiring marker not found exactly once: ${START}`);
const INLINE_WIRING = main.slice(at, main.indexOf(END, at) + END.length);

type Binding = { path: string; quiet: boolean };
const attachInlineHost = new Function(
	"inlineInk",
	"blockNotice",
	"inlineReloadBindings",
	transformSync(INLINE_WIRING, { loader: "ts", target: "es2022" }).code
) as (this: unknown, ink: { attachHost(h: InlineInkHost): void }, notice: (m: string) => void, bindings: () => Binding[]) => void;

function host(bindings: Binding[] = []): InlineInkHost {
	let attached: InlineInkHost | null = null;
	const plugin = { store: { hasQueuedWrite: (pageId: string) => pageId === "queued-page" } };
	attachInlineHost.call(plugin, { attachHost: (h) => { attached = h; } }, () => {}, () => bindings);
	if (!attached) throw new Error("the onload block attached no host");
	return attached;
}

it("the plugin's host answers whether a save is queued from the page store", () => {
	const h = host();
	expect(h.hasQueuedWrite?.("queued-page"), "a queued save was not seen").toBe(true);
	expect(h.hasQueuedWrite?.("idle-page"), "an idle page read as queued").toBe(false);
});

it("the plugin's host reads panes as busy only when a pane on that note is busy", () => {
	const h = host([{ path: "busy.md", quiet: false }, { path: "quiet.md", quiet: true }]);
	expect(h.panesQuiet?.("busy.md"), "a busy pane on the note read as quiet").toBe(false);
	expect(h.panesQuiet?.("quiet.md"), "a busy pane on another note made this one busy").toBe(true);
	expect(h.panesQuiet?.("closed.md"), "a note with no pane read as busy").toBe(true);
});
