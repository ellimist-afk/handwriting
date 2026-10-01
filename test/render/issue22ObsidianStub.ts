/** Issue22-only Windows seam. One real field identity for the owner and child. */
export * from "../obsidian-stub";
import { StateField } from "@codemirror/state";

export const issue22Notices: string[] = [];
export class Notice {
	constructor(message: string) { issue22Notices.push(message); }
}

export interface Issue22EditorOwner {
	app: { commands: { executeCommandById(id: string): unknown } };
	file: { path: string };
	editor: object;
}
export const editorInfoField = StateField.define<Issue22EditorOwner | undefined>({
	create: () => undefined,
	update: value => value,
});
