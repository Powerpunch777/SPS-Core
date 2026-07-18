import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { projectService } from "../services/projects.ts";

describe("project service invalid references", () => {
  it("returns null for an unresolved project shortname without querying the database", async () => {
    const db = new Proxy({} as Db, {
      get() {
        throw new Error("database should not be queried");
      },
    });

    await expect(projectService(db).getById("deleted-project-shortname")).resolves.toBeNull();
  });
});
