/**
 * Obsidian Sync skips .json files unless "Sync all other types" is on, and ink is stored as .json sidecars, so a
 * user who follows the sync instructions alone still gets blank inked notes on their other devices (audit #16).
 * Text only for now: the settings row, the notice after the ink folder moves somewhere that syncs, and the README
 * all say to turn it on. Detecting sidecars that did not arrive is later work.
 */
import { describe, expect, it } from "vitest";
import mainSource from "./main.ts?raw";
import readme from "../README.md?raw";
import { SYNC_ALL_TYPES_HINT } from "./main";
import { codeOnly } from "./CodeOnly";

const PHRASE = '"Sync all other types"';

describe("the Obsidian Sync file-type hint", () => {
	it("names the Obsidian Sync option", () => {
		expect(SYNC_ALL_TYPES_HINT).toContain(PHRASE);
		expect(SYNC_ALL_TYPES_HINT).toContain("Obsidian Sync");
	});

	it("is the sync row's description", () => {
		const code = codeOnly(mainSource).replace(/\r\n/g, "\n");
		expect(code).toMatch(/name: "Compatibility with Obsidian Sync, iCloud and Dropbox",\n\t+desc: SYNC_ALL_TYPES_HINT,/);
	});

	it("follows the move notice when the new folder syncs", () => {
		const code = codeOnly(mainSource);
		expect(code).toContain("(inkFolderSyncs(next) ? ` ${SYNC_ALL_TYPES_HINT}` :");
	});

	it("is in the README's sync notes", () => {
		expect(readme).toContain("**Sync all other types**");
	});
});
