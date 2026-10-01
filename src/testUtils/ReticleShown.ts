// Whether a test rig's pen reticle is showing, read from the style record its
// mocked setCssStyles merged into. The reticle is shown and hidden by opacity
// on its own layer (the element stays display: block), so this is the one place
// a test learns which property carries it; no test names the property itself.
export function reticleShown(style: Record<string, unknown>): boolean {
	const opacity = style.opacity;
	return opacity !== undefined && opacity !== "" && Number(opacity) > 0;
}

/** Put a rig's reticle out the way the overlay does, for a test that starts from a hidden ring. */
export function hideReticle(style: Record<string, unknown>): void {
	style.opacity = "0";
}

/** The same question for a real element in a browser page: its computed style. */
export function reticleVisible(style: { display: string; opacity: string }): boolean {
	return style.display !== "none" && Number(style.opacity) > 0;
}
