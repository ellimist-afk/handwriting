import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { InlineInkStore, type InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, type ParseResult } from "../model/PageData";
import { mountOverlay, type MountedOverlay } from "../inline/mountRig.test.util";
import { resetTipModeForTest } from "../inline/TipMode";

/** Issue 66 rows: the open note's ink read again from disk, and a note's ink record dropped when its id is gone. */
const rows = (type: string) =>
	formatInlinePenTrace()
		.split("\n")
		.filter((line) => new RegExp(`ms {2}${type} `).test(line));

class Host implements InlineInkHost {
	readPageId(path: string): string | null {
		return path === "pen66/declaimed.md" ? "p66" : null;
	}
	async claimId(_path: string, proposedId: string): Promise<{ pageId: string }> {
		return { pageId: proposedId };
	}
	async loadSidecar(pageId: string): Promise<ParseResult | null> {
		const p = emptyPage(pageId);
		p.surface = "inline";
		return { data: p, recovered: false, damaged: false } as ParseResult;
	}
	scheduleSidecar(): void {}
	notify(): void {}
}

beforeEach(() => {
	resetTipModeForTest();
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
});
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	resetTipModeForTest();
});

describe("issue 66 ink-reload row", () => {
	let m: MountedOverlay;
	beforeEach(() => {
		m = mountOverlay("pen66/open.md");
		clearInlinePenTrace();
	});
	afterEach(() => m.destroy());

	const reload = (path: string, strokesChanged?: boolean) =>
		(m.o as { noteExternallyReloaded(path: string, strokesChanged?: boolean): void }).noteExternallyReloaded(path, strokesChanged);

	it("the open note's ink read again writes one row saying whether its strokes changed, with no path", () => {
		reload("pen66/open.md");
		reload("pen66/open.md", false);
		const got = rows("ink-reload");
		expect(got).toHaveLength(2);
		expect(got[0]).toContain("ink reread from disk, strokes changed=yes");
		expect(got[1]).toContain("ink reread from disk, strokes changed=no");
		expect(got.join("\n"), "no path in the rows").not.toMatch(/pen66|open\.md/);
	});

	it("a reload for a note this editor does not show writes no row", () => {
		reload("pen66/elsewhere.md");
		expect(rows("ink-reload")).toHaveLength(0);
	});
});

describe("issue 66 ink-dropped row", () => {
	it("a note whose id is gone drops its ink record and writes one row", async () => {
		const store = new InlineInkStore();
		store.attachHost(new Host());
		await store.ensureLoaded("pen66/declaimed.md");
		clearInlinePenTrace();
		store.handleDeclaimed("pen66/declaimed.md");
		const got = rows("ink-dropped");
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("ink record dropped (page id gone), duplicate locked=no");
		expect(got[0], "no path or id").not.toMatch(/pen66|declaimed|p66/);
	});

	it("a note with no record, or none with an id, writes no row", async () => {
		const store = new InlineInkStore();
		store.attachHost(new Host());
		store.handleDeclaimed("pen66/never-loaded.md");
		await store.ensureLoaded("pen66/no-id.md");
		store.handleDeclaimed("pen66/no-id.md");
		expect(rows("ink-dropped")).toHaveLength(0);
	});
});
