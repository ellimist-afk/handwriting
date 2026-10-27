/**
 * Installs module functions on a class prototype as its methods, with the
 * descriptor a class method has: writable, configurable and not enumerable.
 * The prototype then looks as it would if the methods were written in the
 * class. Shared by every file split out of InkOverlay.ts.
 */
export function installMethods(proto: object, methods: Record<string, (...args: never[]) => unknown>): void {
	for (const [name, value] of Object.entries(methods))
		Object.defineProperty(proto, name, { value, writable: true, enumerable: false, configurable: true });
}
