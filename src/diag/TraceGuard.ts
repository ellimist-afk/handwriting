/**
 * What an empty pen-trace guard should do before a bug-report viewer opens.
 *
 * "Bug report: send" computed this decision inline; "Bug report: show as
 * text" had no guard at all, so opening the text viewer on an empty trace
 * could stop a live recording before the tester ever reproduced the bug
 * (1.4.6-design.md §5g, Y1). Pulled out here as a pure function of the only
 * two inputs that matter, so both commands agree without duplicating the
 * branch — the Notice text and the DOM/state changes stay in main.ts.
 */
export type TraceGuardVerdict = "reproduce" | "record-first" | "proceed";

export function traceGuardVerdict(eventsLength: number, recordingOn: boolean): TraceGuardVerdict {
	if (eventsLength > 0) return "proceed";
	return recordingOn ? "reproduce" : "record-first";
}
