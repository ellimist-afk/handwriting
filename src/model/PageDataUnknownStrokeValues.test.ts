/**
 * A STROKE FIELD VALUE THIS BUILD DOES NOT KNOW SURVIVES A RE-SAVE.
 *
 * A newer build, or another device, may write a stroke whose tool, device or
 * widthMode holds a value this build has no meaning for. The stroke is drawn
 * with this build's default (a pen, a stylus, pressure width), which is the
 * best it can do. Saving the page again wrote that default back over the
 * value, so the build that wrote it read a different stroke from then on.
 * The pressure profile already keeps an unknown value through the field map;
 * the other three did not.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug. The
 * known values are the control: they round-trip as they always have.
 */
import { describe, expect, it } from "vitest";
import { parsePage, serializePage } from "./PageData";

function fileWith(stroke: Record<string, unknown>): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: "p1",
		surface: "inline",
		strokes: [
			{
				id: "s1",
				color: "#4b7bec",
				width: 2.2,
				createdAt: 1,
				pts: [0, 0, 0.5, 0, 10, 0, 0.5, 8],
				...stroke,
			},
		],
		textBoxes: [],
		images: [],
	});
}

/** The first stroke of a page as the saved JSON holds it. */
function savedStroke(text: string): Record<string, unknown> {
	return (JSON.parse(text) as { strokes: Record<string, unknown>[] }).strokes[0]!;
}

describe("unknown stroke field values are kept through a re-save", () => {
	it("control: known tool, device and widthMode values round-trip unchanged", () => {
		const parsed = parsePage(fileWith({ tool: "highlighter", device: "mouse", widthMode: "uniform" }), "p1");
		expect(parsed.damaged).toBeFalsy();
		const again = savedStroke(serializePage(parsed.data));
		expect([again.tool, again.device, again.widthMode]).toEqual(["highlighter", "mouse", "uniform"]);
	});

	it("an unknown tool is drawn as a pen and saved back as the tool it was", () => {
		const parsed = parsePage(fileWith({ tool: "marker" }), "p1");
		expect(parsed.data.strokes[0]!.tool, "precondition: this build draws it as a pen").toBe("pen");
		expect(savedStroke(serializePage(parsed.data)).tool, "a re-save wrote the default over the tool").toBe("marker");
	});

	it("an unknown device is saved back as the device it was", () => {
		const parsed = parsePage(fileWith({ tool: "pen", device: "stylus-2" }), "p1");
		expect(parsed.data.strokes[0]!.device, "precondition: this build reads no device it knows").toBeUndefined();
		expect(savedStroke(serializePage(parsed.data)).device, "a re-save dropped the device").toBe("stylus-2");
	});

	it("an unknown width mode is saved back as the width mode it was", () => {
		const parsed = parsePage(fileWith({ tool: "pen", widthMode: "tapered" }), "p1");
		expect(parsed.data.strokes[0]!.widthMode, "precondition: this build reads no width mode it knows").toBeUndefined();
		expect(savedStroke(serializePage(parsed.data)).widthMode, "a re-save dropped the width mode").toBe("tapered");
	});

	it("a second re-save keeps them too", () => {
		const once = serializePage(parsePage(fileWith({ tool: "marker", device: "stylus-2", widthMode: "tapered" }), "p1").data);
		const twice = savedStroke(serializePage(parsePage(once, "p1").data));
		expect([twice.tool, twice.device, twice.widthMode]).toEqual(["marker", "stylus-2", "tapered"]);
	});
});
