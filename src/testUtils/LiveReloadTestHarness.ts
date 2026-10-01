import { expect } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";

// Execute the actual production registration and its real backoff closure.
// Fail closed if either extraction boundary or registration shape changes.
const source = mainSource.replace(/\r\n/g, "\n");
const startMarker = "\t\tlet reloadTickBusy = false;";
const endMarker = "\n\t\t// THE ONE PEN COMMAND";
expect(source.split(startMarker)).toHaveLength(2);
expect(source.split(endMarker)).toHaveLength(2);
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
expect(start).toBeGreaterThan(0);
expect(end).toBeGreaterThan(start);
const registration = source.slice(start, end);
expect(registration.match(/this\.registerInterval\(/g)).toHaveLength(1);
expect(registration.match(/window\.setInterval\(/g)).toHaveLength(1);
expect(registration.trimEnd().endsWith("}, 1000)\n\t\t);")).toBe(true);
const strideDeclaration = "function reloadStride(quietTicks: number): number {";
expect(source.split(strideDeclaration)).toHaveLength(2);
const strideStart = source.indexOf(strideDeclaration);
const strideEnd = source.indexOf("\n}", strideStart);
expect(strideEnd).toBeGreaterThan(strideStart);
const stride = source.slice(strideStart, strideEnd + 2);
const install = new Function(
	"window", "document", "runDetached", "inlineReloadCandidates", "inlineInk",
	"inkExternallyReloaded", "notifyInkChanged", "slidesReloadCandidate",
	"reloadSlidesExternal", "console", "captureInlineReloadAdmission",
	transformSync(`${stride}\n${registration}`, { loader: "ts", target: "es2022" }).code,
);
// The tick asks the plugin whether every window holding a pane is hidden
// (audit 56). A stand-in without that census gets the old answer, the
// `document` it was handed; a suite that measures popouts passes the real one.
export const installLiveReloadPoll = function (this: object, ...args: unknown[]): unknown {
	const self = this as { reloadPanesHidden?: (doc: { hidden: boolean }) => boolean };
	self.reloadPanesHidden ??= (doc) => doc.hidden;
	return install.apply(this, args);
};
// The same wrapper as one self-contained function source, for a suite that
// injects the poll into a browser page: the wrapper above calls `install`
// through a closure, and its toString() leaves that closure behind.
export const installLiveReloadPollScript = `function (...args) {
	this.reloadPanesHidden ??= (doc) => doc.hidden;
	return (${install.toString()}).apply(this, args);
}`;
