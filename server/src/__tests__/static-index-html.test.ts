import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrandedStaticIndexHandler,
  readBrandedStaticIndexHtml,
  type BrandedStaticIndexHandlerOptions,
} from "../static-index-html.js";

function createStaticUiApp(
  uiDist: string,
  options: BrandedStaticIndexHandlerOptions = {},
) {
  const app = express();
  const sendBrandedStaticIndex = createBrandedStaticIndexHandler(uiDist, options);

  app.get(["/", "/index.html"], sendBrandedStaticIndex);
  app.use("/assets", express.static(path.join(uiDist, "assets")));
  app.use(express.static(uiDist));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/assets/")) {
      res.status(404).end();
      return;
    }
    sendBrandedStaticIndex(req, res, next);
  });

  return app;
}

function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("static SPA fallback HTML", () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sps-static-index-"));
    tempDirs.push(tempDir);
    return tempDir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from a transient missing index and serves the rebuilt file", async () => {
    const tempDir = createTempDir();
    const indexPath = path.join(tempDir, "index.html");
    const readIndex = vi.fn(() => readBrandedStaticIndexHtml(tempDir));
    readIndex.mockImplementationOnce(() => {
      throw fsError("ENOENT", `index temporarily missing: ${indexPath}`);
    });
    const delays: number[] = [];
    const app = createStaticUiApp(tempDir, {
      readIndex,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        fs.writeFileSync(
          indexPath,
          '<html><body><script type="module" src="/assets/index-rebuilt.js"></script></body></html>',
          "utf8",
        );
      },
    });

    const res = await request(app).get("/PAP/issues/PAP-9939");

    expect(res.status).toBe(200);
    expect(res.text).toContain("/assets/index-rebuilt.js");
    expect(readIndex).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([50]);
  });

  it("returns a path-free no-store 503 after bounded retries on root, index, and fallback", async () => {
    const tempDir = createTempDir();
    const indexPath = path.join(tempDir, "index.html");
    let readAttempt = 0;
    const readIndex = vi.fn(() => {
      readAttempt += 1;
      const code = readAttempt % 2 === 0 ? "EBUSY" : "ENOENT";
      throw fsError(code, `${code} while reading ${indexPath}`);
    });
    const delays: number[] = [];
    const app = createStaticUiApp(tempDir, {
      readIndex,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    for (const url of ["/", "/index.html", "/PAP/issues/PAP-9939"]) {
      const res = await request(app).get(url);

      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-type"]).toMatch(/^text\/plain; charset=utf-8$/);
      expect(res.text).toContain("temporarily unavailable");
      expect(res.text).not.toContain(tempDir);
      expect(res.text).not.toContain(indexPath);
    }

    expect(readIndex).toHaveBeenCalledTimes(12);
    expect(delays).toEqual([50, 100, 250, 50, 100, 250, 50, 100, 250]);
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      expect(delays.slice(requestIndex * 3, requestIndex * 3 + 3).reduce((sum, value) => sum + value, 0))
        .toBeLessThanOrEqual(2_000);
    }
  });

  it("serves the current index on each request instead of reusing stale asset hashes", async () => {
    const tempDir = createTempDir();
    const indexPath = path.join(tempDir, "index.html");
    const app = createStaticUiApp(tempDir);

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-old.js"></script></body></html>',
      "utf8",
    );
    const firstRes = await request(app).get("/PAP/issues/PAP-9939");
    expect(firstRes.text).toContain("/assets/index-old.js");

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-new.js"></script></body></html>',
      "utf8",
    );
    const secondRes = await request(app).get("/PAP/issues/PAP-9939");

    expect(secondRes.status).toBe(200);
    expect(secondRes.text).toContain("/assets/index-new.js");
    expect(secondRes.text).not.toContain("/assets/index-old.js");
  });

  it("forwards unexpected read errors to Express without retrying", async () => {
    const tempDir = createTempDir();
    const unexpectedError = fsError("EIO", `unexpected read failure at ${tempDir}`);
    const readIndex = vi.fn(() => {
      throw unexpectedError;
    });
    const delay = vi.fn(async () => {});
    const app = createStaticUiApp(tempDir, { readIndex, delay });
    let forwardedError: unknown;
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      forwardedError = error;
      res.status(500).send("handled by Express");
    });

    const res = await request(app).get("/PAP/issues/PAP-9939");

    expect(res.status).toBe(500);
    expect(res.text).toBe("handled by Express");
    expect(forwardedError).toBe(unexpectedError);
    expect(readIndex).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("keeps missing assets as 404 responses instead of serving the SPA shell", async () => {
    const tempDir = createTempDir();
    fs.writeFileSync(path.join(tempDir, "index.html"), "<html>app shell</html>", "utf8");
    const app = createStaticUiApp(tempDir);

    const res = await request(app).get("/assets/missing.js");

    expect(res.status).toBe(404);
    expect(res.text).not.toContain("app shell");
  });

  it("reproduces the previous synchronous missing-index request as an HTTP 500", async () => {
    const tempDir = createTempDir();
    const app = express();
    app.get("/", (_req, res) => res.end(readBrandedStaticIndexHtml(tempDir)));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      res.status(500).send("Internal Server Error");
    });

    const res = await request(app).get("/");

    expect(res.status).toBe(500);
    expect(res.text).toBe("Internal Server Error");
  });
});
