/**
 * Where a call's proposed tasks and Transcript button go in its channel's
 * timeline: under its call notes when that message is shown, otherwise at the
 * call's end event, so they stay reachable when the notes failed or when the
 * notes message has scrolled out of the loaded messages.
 */
export function callActionsPlace(
  call: { notesMessageId?: string | undefined; proposals: readonly unknown[]; hasTranscript: boolean },
  shownMessageIds: ReadonlySet<string>,
): "notes" | "end" | "none" {
  if (call.notesMessageId && shownMessageIds.has(call.notesMessageId)) return "notes";
  if (call.proposals.length > 0 || call.hasTranscript) return "end";
  return "none";
}
