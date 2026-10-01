/**
 * Delete-all on a note whose ink file has not been read yet.
 *
 * A read that threw leaves the note locked but not damaged: the file may be
 * healthy. Delete-all used to take the damaged-file branch there, which clears
 * the session's strokes and reports a result. It now refuses, clears nothing,
 * writes nothing, and says the same plain sentence the note itself gives:
 * the ink file could not be read yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { emptyPage } from "../model/PageData";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
const modals = vi.hoisted(() => ({ list: [] as Array<{ onConfirm?: () => void }> }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.list.push(message);
			}
			hide(): void {
				/* no-op */
			}
		},
		Modal: class {
			constructor(_app: unknown) {
				modals.list.push(this as { onConfirm?: () => void });
			}
			open(): void {
				/* not painted */
			}
			close(): void {
				/* no-op */
			}
		},
	};
});

import HandwritingPlugin, { DELETE_ALL_REFUSED } from "../main";

const TRANSIENT =
	"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.";
const PATH = "transient-delete-all.md";
const PAGE_ID = "transient-delete-all-id";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 0,
	};
}

const file = { path: PATH, extension: "md" };
let writes = 0;
let preserveCalls = 0;
const hostNotices: string[] = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	notices.list.length = 0;
	modals.list.length = 0;
	hostNotices.length = 0;
	writes = 0;
	preserveCalls = 0;
	const host: InlineInkHost = {
		readPageId: (p) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p, pageId) => ({ pageId }),
		// The read threw: what PageStore.load returns for a transient read.
		loadSidecar: async (id) => ({
			data: emptyPage(id),
			recovered: true,
			damaged: true,
			transient: true,
			problem: "Error: EIO injected read",
			damagedPath: `.handwriting/${id}.json`,
		}),
		scheduleSidecar: () => {
			writes++;
		},
		scheduleSidecarNow: async () => {
			writes++;
		},
		notify: (message) => void hostNotices.push(message),
	};
	inlineInk.attachHost(host);
});

afterEach(() => {
	inlineInk.handleDelete(PATH);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function plugin(): unknown {
	return Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
		unloaded: false,
		store: {
			preserve: async () => {
				preserveCalls++;
				return ".handwriting/.trash/should-not-exist.json";
			},
		},
		app: {
			vault: {
				getFileByPath: (p: string) => (p === PATH ? file : null),
				getAbstractFileByPath: (p: string) => (p === PATH ? file : null),
				adapter: { read: async () => "" },
			},
			metadataCache: { getFileCache: () => ({ frontmatter: { "handwriting-page-id": PAGE_ID } }) },
		},
	});
}

describe("delete-all on a note whose ink file could not be read yet", () => {
	it("cell 12: refuses with the not-read-yet sentence, clears nothing, writes nothing", async () => {
		await inlineInk.ensureLoaded(PATH);
		expect(hostNotices).toEqual([]);
		inlineInk.commit(PATH, stroke("drawn-while-unread"));
		expect(hostNotices).toEqual([TRANSIENT]);
		expect(inlineInk.deleteAllReadiness(PATH)).toEqual({ kind: "blocked", lock: "transient" });

		await (HandwritingPlugin.prototype as unknown as { deleteAllInk(target: unknown): Promise<void> }).deleteAllInk.call(
			plugin(),
			{ file, path: PATH }
		);

		expect(notices.list).toEqual([TRANSIENT]);
		expect(notices.list).not.toContain(DELETE_ALL_REFUSED);
		expect(inlineInk.strokes(PATH).map((s) => s.id)).toEqual(["drawn-while-unread"]);
		expect(preserveCalls).toBe(0);
		expect(writes).toBe(0);
	});
});
