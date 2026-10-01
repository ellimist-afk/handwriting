/**
 * Whether a vault path is a markdown note. Obsidian lower-cases `file.extension`, so `README.MD` is a note;
 * a test or strip that compares ".md" case-sensitively drops such a note's ink from reading view, embeds and exports.
 */
const MARKDOWN_EXTENSION = /\.md$/i;

export function isMarkdownPath(path: string): boolean {
	return MARKDOWN_EXTENSION.test(path);
}

export function stripMarkdownExtension(path: string): string {
	return path.replace(MARKDOWN_EXTENSION, "");
}
