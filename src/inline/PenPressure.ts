/**
 * Keep a real zero from pen hardware. It is useful release evidence and must
 * not become a synthetic half-pressure contact. A non-finite value still gets
 * the Pointer Events fallback pressure.
 */
export function normalizeInlinePenPressure(pressure: number): number {
	if (!Number.isFinite(pressure)) return 0.5;
	return Math.max(0, Math.min(1, pressure));
}
