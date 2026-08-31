const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/?]+[\\/][^\\/?]+[\\/]/;

/** Browser-safe structural check for persisted local file paths. */
export function isAbsoluteLocalMediaPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("?") ||
    value.startsWith("//") ||
    value === "/api" ||
    value.startsWith("/api/") ||
    value.endsWith("/") ||
    value.endsWith("\\")
  ) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH.test(value)) return value.length > 3;
  if (WINDOWS_UNC_PATH.test(value)) return true;
  return value.startsWith("/") && value.length > 1;
}
