import { describe, expect, it } from "vitest";
import { isSpsSessionDispatchContext } from "../services/sps-session-dispatch-context.js";

describe("durable session scheduling context", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const context = { taskKey: "plugin:sps.example:session:lead", spsPluginConversation: { pluginKey: "sps.example", sessionId, requestId } };
  it("only excludes durable plugin turns from legacy run coalescing", () => {
    expect(isSpsSessionDispatchContext(context, `sps-session:plugin-id:${requestId}`)).toBe(true);
    for (const key of [null, "legacy", `sps-session:plugin-id:${sessionId}`]) expect(isSpsSessionDispatchContext(context, key)).toBe(false);
    for (const patch of [{ taskKey: "issue:one" }, { spsPluginConversation: null },
      { spsPluginConversation: { ...context.spsPluginConversation, pluginKey: "other" } },
      { spsPluginConversation: { ...context.spsPluginConversation, requestId: "not-a-uuid" } }]) {
      expect(isSpsSessionDispatchContext({ ...context, ...patch }, `sps-session:plugin-id:${requestId}`)).toBe(false);
    }
  });
});
