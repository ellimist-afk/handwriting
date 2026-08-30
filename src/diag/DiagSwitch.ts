/**
 * Master switch for Handwriting's investigation diagnostics (v0.13.0 cleanup).
 *
 * The dead-zone investigation left three instruments worth keeping: the
 * scroll trace, the pen trace, and the presentation capture. None of them
 * belongs in the hot path of ordinary writing. This switch makes them
 * explicitly invoked: OFF by default, every recording call returns
 * immediately (one boolean read), and the pixel readbacks and layout reads
 * that feed the richer trace rows are skipped entirely. Flip it with
 * `Diagnostics: begin recording`, reproduce, copy the trace.
 *
 * THE CALL-SITE RULE (RC4). A gate inside the recording function is not
 * enough, because the CALLER evaluates the arguments: `probe(el.scrollTop)`
 * still forces a layout flush, and ``tr(t, e, `n=${n}`)`` still builds a
 * string, before the callee can decline either. Diagnostic work therefore
 * sits behind `if (diagnosticsEnabled())` AT THE CALL SITE whenever the
 * arguments cost anything: layout or scroll reads, `composedPath()`,
 * `getCoalescedEvents()` that the ink does not already need, geometry or
 * hit-testing, scroller scans, string building. With the switch off those
 * sites perform the boolean read and nothing else. The gates inside the
 * recording functions stay as the second line of defence.
 *
 * Session-scoped on purpose: diagnostics are a deliberate act, not a
 * setting to forget on.
 */

let enabled = false;

export function diagnosticsEnabled(): boolean {
	return enabled;
}

export function setDiagnosticsEnabled(on: boolean): void {
	enabled = on;
}

/**
 * Showing a report ends the capture.
 *
 * The reporting flow is begin, reproduce, show, paste - and there is no
 * fourth step where anyone remembers to turn recording back off. Ending it
 * here means the command called "begin recording" only ever has to begin,
 * and nobody leaves a trace running for days because they filed their bug
 * and moved on. Returns whether it actually stopped anything, so the caller
 * can say so.
 */
export function endRecordingForReport(): boolean {
	if (!enabled) return false;
	enabled = false;
	return true;
}

/** One-line banner for trace outputs produced while the switch is off. */
export const DIAG_OFF_NOTE =
	"Handwriting diagnostics are off. Run 'Diagnostics: begin recording', reproduce, then copy again.";
