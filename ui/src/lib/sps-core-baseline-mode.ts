export function isSpsCoreBaselineModeEnabled(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('meta[name="sps-core-baseline-mode"]')?.getAttribute("content") === "true";
}
