/** DOM work uses its owning window; pure Node tests retain their native timers. */
export function timerHost(owner?: Window | null): Pick<Window, "setTimeout" | "clearTimeout"> {
	if (owner) return owner;
	if (typeof window !== "undefined") return window;
	return { setTimeout, clearTimeout };
}

/** Animation callbacks must be cancelled through the window that scheduled them. */
export function animationHost(owner?: Window | null): Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> {
	if (owner) return owner;
	if (typeof window !== "undefined") return window;
	return { requestAnimationFrame, cancelAnimationFrame };
}
