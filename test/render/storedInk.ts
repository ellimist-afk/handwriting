/**
 * Stored strokes as a store-unchanged check compares them: every stroke without
 * its line anchor. The old-ink pass writes lineAnchor onto the stroke objects by
 * design and asks for no save (the anchor reaches the file at the next ordinary
 * save), so a cell that asserts the store unchanged drops that one field from
 * both sides and still sees every other change. Takes the strokes as an array or
 * as their JSON text and gives back the same shape; runs in node and in a page.
 */
export function withoutLineAnchor<T>(strokes: T): T {
	if (typeof strokes === "string") return JSON.stringify(withoutLineAnchor(JSON.parse(strokes))) as T;
	return (strokes as readonly Record<string, unknown>[]).map(({ lineAnchor: _line, ...stroke }) => stroke) as T;
}
