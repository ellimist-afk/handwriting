/**
 * Vite/vitest `?raw` imports: a file's text as a string. Used only by tests
 * that assert on styles.css; never reached by the esbuild bundle (no runtime
 * module imports it).
 */
declare module "*?raw" {
	const content: string;
	export default content;
}
