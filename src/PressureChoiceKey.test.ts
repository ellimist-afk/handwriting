/**
 * The pressure choice lives under a second key, `pressureChoice`, because a 1.4.20 build launching on a synced
 * vault pins `pressureSensitivity` back to true and saves (audit 133). This build reads the new key first,
 * the old one only when the new is absent, and every save writes both. The old key is never removed.
 */
import { describe, expect, it } from "vitest";
import HandwritingPlugin from "./main";
import mainSource from "./main.ts?raw";

type Settings = Record<string, unknown>;

/** The real settingsFrom, run on a bare instance: it reads only its argument. */
function settingsFrom(raw: unknown): Settings {
	const plugin = Object.create(HandwritingPlugin.prototype) as { settingsFrom: (r: unknown) => Settings };
	return plugin.settingsFrom(raw);
}

describe("pressure choice key", () => {
	it("the new key wins when the two differ (a 1.4.20 launch pinned the old one to true)", () => {
		const s = settingsFrom({ pressureSensitivity: true, pressureChoice: false });
		expect(s.pressureSensitivity).toBe(false);
		expect(s.pressureChoice).toBe(false);
	});

	it("the new key wins the other way round too", () => {
		const s = settingsFrom({ pressureSensitivity: false, pressureChoice: true });
		expect(s.pressureSensitivity).toBe(true);
		expect(s.pressureChoice).toBe(true);
	});

	it("falls back to the old key when the new is absent, and writes the new key from it", () => {
		const off = settingsFrom({ pressureSensitivity: false });
		expect(off.pressureSensitivity).toBe(false);
		expect(off.pressureChoice).toBe(false);
		const on = settingsFrom({ pressureSensitivity: true });
		expect(on.pressureChoice).toBe(true);
	});

	it("falls back to the retired inkShaping key when neither pressure key exists", () => {
		expect(settingsFrom({ inkShaping: false }).pressureChoice).toBe(false);
	});

	it("defaults on when neither key exists, and both keys are written", () => {
		const s = settingsFrom({});
		expect(s.pressureSensitivity).toBe(true);
		expect(s.pressureChoice).toBe(true);
		expect(settingsFrom(null).pressureChoice).toBe(true);
	});

	it("ignores a non-boolean new key and reads the old one", () => {
		const s = settingsFrom({ pressureSensitivity: false, pressureChoice: "yes" });
		expect(s.pressureSensitivity).toBe(false);
		expect(s.pressureChoice).toBe(false);
	});

	it("keeps the old key present on every read, never dropped", () => {
		expect("pressureSensitivity" in settingsFrom({ pressureChoice: false })).toBe(true);
	});

	it("the toggle writes both keys", () => {
		const source = mainSource.replace(/\r\n/g, "\n");
		const at = source.indexOf('case "pressureSensitivity":');
		expect(at).toBeGreaterThan(0);
		const block = source.slice(at, source.indexOf("break;", at));
		expect(block).toContain("s.pressureSensitivity = on;");
		expect(block).toContain("s.pressureChoice = on;");
	});
});
