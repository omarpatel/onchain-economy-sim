/**
 * Display-name sanitizer shared by the sim (`rename_company`, `joinPlayer`) and
 * the server (player names): strips C0/C1 control characters, DEL and Unicode
 * bidi/format controls, collapses runs of whitespace to one space, trims and
 * caps the length. Returns "" when nothing printable is left; callers decide
 * the fallback.
 */
export function cleanName(raw: unknown, max = 32): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
