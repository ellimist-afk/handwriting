/**
 * Delete all ink backs the page up first. When that backup fails only because the ink folder is
 * mid-move, the notice must say try again, not blame the disk (audit 202).
 */
import { describe, expect, it } from "vitest";
import mainSource from "../main.ts?raw";
import storeSource from "../persistence/PageStore.ts?raw";
import { deleteAllBackupFailureText, INK_FOLDER_MOVING_TEXT } from "./DeleteAllBackupNotice";

describe("delete-all backup failure text", () => {
	it("passes the store's still-moving message through for a note and a PDF", () => {
		const err = new Error(INK_FOLDER_MOVING_TEXT);
		expect(deleteAllBackupFailureText(err, "note")).toBe(INK_FOLDER_MOVING_TEXT);
		expect(deleteAllBackupFailureText(err, "PDF")).toBe(INK_FOLDER_MOVING_TEXT);
	});
	it("keeps the disk-error sentence for any other failure", () => {
		expect(deleteAllBackupFailureText(new Error("EIO"), "note")).toBe(
			"Handwriting: could not copy this note's ink to the trash (disk error). Nothing was deleted."
		);
		expect(deleteAllBackupFailureText("boom", "PDF")).toBe(
			"Handwriting: could not copy this PDF's ink to the trash (disk error). Nothing was deleted."
		);
	});
	it("is the text the store throws, and both delete-all catches use the helper", () => {
		expect(storeSource).toContain("INK_FOLDER_MOVING_TEXT");
		const source = mainSource.replace(/\r\n/g, "\n");
		expect(source.match(/deleteAllBackupFailureText\(err, /g)?.length).toBe(2);
		expect(source).not.toContain("to the trash (disk error)");
	});
});
