import { matchingCharacters } from "./speech-text";

export interface VisualEvidenceNote {
  t: number;
  energy: number;
  note: string;
  visibleText?: string[];
}

export interface VisualEvidenceHit extends VisualEvidenceNote {
  /** Stable key for React lists; timestamp is rounded to avoid float noise. */
  id: string;
  /** Which part of the note matched the query. */
  match: "description" | "screen-text";
}

/** Search only confirmed visual descriptions/screen text; never infer labels. */
export function searchVisualEvidence(
  notes: readonly VisualEvidenceNote[] | undefined,
  query: string,
  limit = 200
): VisualEvidenceHit[] {
  const needle = matchingCharacters(query.trim().slice(0, 500)).join("");
  if (!needle || !notes?.length || limit <= 0) return [];
  const out: VisualEvidenceHit[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    if (!note || typeof note !== "object" || !Number.isFinite(note.t) || note.t < 0 || typeof note.note !== "string") continue;
    const visibleText = Array.isArray(note.visibleText)
      ? note.visibleText.filter((text): text is string => typeof text === "string")
      : [];
    const description = matchingCharacters(note.note).join("");
    const screen = visibleText.map((text) => matchingCharacters(text).join("")).join(" ");
    const match = description.includes(needle) ? "description" : screen.includes(needle) ? "screen-text" : null;
    if (!match) continue;
    const id = `${Math.round(note.t * 1000)}:${match}:${note.note.slice(0, 24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...note, visibleText, id, match });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.t - b.t);
}
