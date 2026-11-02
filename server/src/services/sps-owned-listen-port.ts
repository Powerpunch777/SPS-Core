/** Desktop launch authority and URLs bind one port; do not silently move it. */
export async function requireSpsOwnedListenPort(requestedPort: number, detectPort: (port: number) => Promise<number>): Promise<number> {
  const unavailable = () => Object.assign(new Error(
    "The configured SPS Desktop Host port is unavailable. Close the conflicting service or choose a different Host port before retrying.",
  ), { code: "SPS_DESKTOP_PORT_UNAVAILABLE" });
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535 || typeof detectPort !== "function") {
    throw unavailable();
  }
  const detected = await detectPort(requestedPort);
  if (detected !== requestedPort) throw unavailable();
  return requestedPort;
}
