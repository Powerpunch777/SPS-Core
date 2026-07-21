export function isSpsBasicModeEnabled(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('meta[name="sps-basic-mode"]')?.getAttribute("content") === "true";
}
