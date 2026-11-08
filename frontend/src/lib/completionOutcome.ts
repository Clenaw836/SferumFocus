/** Local persistence and server acknowledgement are different success boundaries. */
export type CompletionOutcome = { saved?: boolean; synced?: boolean };
export function completionDisposition(
  result: CompletionOutcome | void,
): "failed" | "pending" | "confirmed" {
  if (result?.saved === false) return "failed";
  return result?.synced === false ? "pending" : "confirmed";
}
