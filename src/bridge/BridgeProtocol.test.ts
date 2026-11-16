/**
 * The wire format, held to the fixture files the companion app's own tests
 * read. The two JSON files here are copies of the ones in the companion's
 * repository; a message one end writes and the other cannot read fails on
 * whichever side changed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeBridge, encodeBridge, isBridgeToken, newBridgeToken, sameGeometry, type BridgeGeometry, type BridgeOut } from "./BridgeProtocol";

const fixture = (name: string): unknown[] =>
	JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}.fixture.json`, import.meta.url)), "utf8")) as unknown[];

describe("BridgeProtocol", () => {
	it("decodes every message the companion sends", () => {
		const decoded = fixture("CompanionToPlugin").map((m) => decodeBridge(JSON.stringify(m)));
		expect(decoded.map((m) => m?.type)).toEqual(["welcome", "stroke-begin", "stroke", "stroke-cancel", "denied"]);
		const stroke = decoded[2];
		expect(stroke?.type === "stroke" && stroke.points[1]).toEqual({ x: 314.1, y: 489.9, pressure: 0.31, t: 4 });
	});

	it("encodes every message the plugin sends exactly as the fixture spells it", () => {
		for (const m of fixture("PluginToCompanion")) {
			expect(JSON.parse(encodeBridge(m as BridgeOut))).toEqual(m);
		}
	});

	it("answers null for what it does not understand, without throwing", () => {
		expect(decodeBridge("not json")).toBeNull();
		expect(decodeBridge("[]")).toBeNull();
		expect(decodeBridge('{"type":"from-the-future","x":1}')).toBeNull();
		expect(decodeBridge('{"type":"stroke-begin","id":"1","rev":1}')).toBeNull();
	});

	it("refuses a stroke with a bad point whole", () => {
		expect(decodeBridge('{"type":"stroke","id":1,"rev":1,"points":[[1,2,0.5,0],[3,null,0.5,4]]}')).toBeNull();
		expect(decodeBridge('{"type":"stroke","id":1,"rev":1,"points":[]}')).toBeNull();
	});

	it("clamps pressure into 0..1", () => {
		const m = decodeBridge('{"type":"stroke","id":1,"rev":1,"points":[[1,2,1.7,0],[3,4,-0.2,4]]}');
		expect(m?.type === "stroke" && m.points.map((p) => p.pressure)).toEqual([1, 0]);
	});

	it("makes a pairing secret the companion's rule accepts, from the bytes it is given", () => {
		let seed = 0;
		const token = newBridgeToken((bytes) => bytes.forEach((_, i) => (bytes[i] = (seed += 37) & 255)));
		expect(token).toHaveLength(32);
		expect(isBridgeToken(token)).toBe(true);
		expect(newBridgeToken((bytes) => bytes.fill(7))).not.toBe(token);
		expect(isBridgeToken("short")).toBe(false);
		expect(isBridgeToken("has a space in it, which the companion refuses")).toBe(false);
		expect(isBridgeToken(undefined)).toBe(false);
	});

	it("compares geometry by value", () => {
		const g: BridgeGeometry = { kind: "note", rect: { x: 0, y: 10, w: 700, h: 500 }, exclude: [{ x: 1, y: 2, w: 3, h: 4 }], viewport: { w: 768, h: 1024 }, dpr: 2 };
		expect(sameGeometry(g, structuredClone(g))).toBe(true);
		expect(sameGeometry(g, { ...g, rect: { ...g.rect, y: 11 } })).toBe(false);
		expect(sameGeometry(g, { ...g, exclude: [] })).toBe(false);
	});
});
