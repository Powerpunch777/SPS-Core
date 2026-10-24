import fs from "node:fs";
import path from "node:path";
import type { RequestHandler } from "express";
import { applyUiBranding } from "./ui-branding.js";

const RETRY_DELAYS_MS = [50, 100, 250] as const;
const TEMPORARILY_UNAVAILABLE_MESSAGE = "UI is temporarily unavailable. Please retry shortly.\n";

export type BrandedStaticIndexHandlerOptions = {
  readIndex?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
};

export function readBrandedStaticIndexHtml(uiDist: string): string {
  return applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientIndexReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EBUSY";
}

export function createBrandedStaticIndexHandler(
  uiDist: string,
  options: BrandedStaticIndexHandlerOptions = {},
): RequestHandler {
  const readIndex = options.readIndex ?? (() => readBrandedStaticIndexHtml(uiDist));
  const delay = options.delay ?? wait;

  return async (_req, res, next) => {
    for (let attempt = 0; ; attempt += 1) {
      let html: string;
      try {
        html = readIndex();
      } catch (error) {
        if (!isTransientIndexReadError(error)) {
          next(error);
          return;
        }

        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) {
          res
            .status(503)
            .set({
              "Cache-Control": "no-store",
              "Retry-After": "1",
              "Content-Type": "text/plain; charset=utf-8",
            })
            .end(TEMPORARILY_UNAVAILABLE_MESSAGE);
          return;
        }

        try {
          await delay(retryDelay);
        } catch (delayError) {
          next(delayError);
          return;
        }

        continue;
      }

      res
        .status(200)
        .set("Content-Type", "text/html")
        .set("Cache-Control", "no-cache")
        .end(html);
      return;
    }
  };
}
