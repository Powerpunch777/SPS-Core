import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("../config-file.js", () => ({
  readConfigFile: readConfigFileMock,
}));

vi.mock("../paths.js", () => ({
  resolvePaperclipEnvPath: () => "/tmp/sps-config-test-does-not-exist.env",
}));

vi.mock("../worktree-config.js", () => ({
  maybeRepairLegacyWorktreeConfigAndEnvFiles: vi.fn(),
}));

const ENV_KEYS = [
  "SPS_DEPLOYMENT_MODE",
  "SPS_DEPLOYMENT_EXPOSURE",
  "SPS_BIND",
  "SPS_BIND_HOST",
  "SPS_PUBLIC_URL",
  "SPS_AUTH_PUBLIC_BASE_URL",
  "SPS_AUTH_BASE_URL_MODE",
  "SPS_AUTH_GOOGLE_ONLY",
  "SPS_GOOGLE_CLIENT_ID",
  "SPS_GOOGLE_CLIENT_SECRET",
  "SPS_GOOGLE_HOSTED_DOMAIN",
  "SPS_ALLOWED_HOSTNAMES",
  "HOST",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_GOOGLE_CLIENT_ID",
  "PAPERCLIP_GOOGLE_CLIENT_SECRET",
  "PAPERCLIP_AUTH_GOOGLE_ONLY",
] as const;

function clearSpsAuthEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function configurePublicGoogleHub() {
  process.env.SPS_DEPLOYMENT_MODE = "authenticated";
  process.env.SPS_DEPLOYMENT_EXPOSURE = "public";
  process.env.SPS_BIND = "custom";
  process.env.SPS_BIND_HOST = "0.0.0.0";
  process.env.HOST = "0.0.0.0";
  process.env.SPS_PUBLIC_URL = "https://hub.sps.example";
  process.env.SPS_AUTH_GOOGLE_ONLY = "true";
  process.env.SPS_GOOGLE_CLIENT_ID = "sps-google-client";
  process.env.SPS_GOOGLE_CLIENT_SECRET = "sps-google-secret";
}

describe("SPS public Google auth configuration", () => {
  beforeEach(() => {
    clearSpsAuthEnv();
    readConfigFileMock.mockReturnValue(null);
  });

  afterEach(() => {
    clearSpsAuthEnv();
  });

  it("builds a Google-only public Hub configuration from SPS environment variables", async () => {
    configurePublicGoogleHub();
    process.env.SPS_GOOGLE_HOSTED_DOMAIN = "example.com";

    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    expect(config).toMatchObject({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      bind: "custom",
      host: "0.0.0.0",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://hub.sps.example",
      authGoogleOnly: true,
      authGoogleClientId: "sps-google-client",
      authGoogleClientSecret: "sps-google-secret",
      authGoogleHostedDomain: "example.com",
    });
    expect(config.allowedHostnames).toContain("hub.sps.example");
  });

  it("refuses Google-only mode until both Google credentials are configured", async () => {
    configurePublicGoogleHub();
    delete process.env.SPS_GOOGLE_CLIENT_SECRET;

    const { loadConfig } = await import("../config.js");

    expect(() => loadConfig()).toThrow(
      "SPS_AUTH_GOOGLE_ONLY=true requires SPS_GOOGLE_CLIENT_ID and SPS_GOOGLE_CLIENT_SECRET.",
    );
  });
});
