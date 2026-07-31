import Ajv, { type ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";
import {
  marketplaceToolDeclarations,
  marketplaceToolHandlers,
  type MarketplaceSearchQuery,
} from "./sps-marketplace.js";

export interface MarketplaceToolContext {
  companyId: string;
  runId: string;
  agentId: string;
  userId: string;
}

export type MarketplaceToolName = (typeof marketplaceToolDeclarations)[number]["name"];

export interface MarketplaceToolBridge {
  readonly declarations: typeof marketplaceToolDeclarations;
  execute(
    toolName: string,
    input: unknown,
    context: MarketplaceToolContext,
  ): Promise<unknown>;
}

// AJV's CJS/ESM type shape differs across the server's runtime loaders.
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true, strict: false });
const validators = new Map<MarketplaceToolName, ValidateFunction>();
for (const declaration of marketplaceToolDeclarations) {
  validators.set(declaration.name, ajv.compile(declaration.inputSchema));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertContext(context: MarketplaceToolContext): void {
  if (!context || typeof context !== "object") {
    throw badRequest("Marketplace tool context is required");
  }
  const missing = (["companyId", "runId", "agentId", "userId"] as const)
    .filter((key) => !nonEmptyString(context[key]));
  if (missing.length > 0) {
    throw badRequest(`Marketplace tool context requires: ${missing.join(", ")}`);
  }
}

function assertKnownTool(toolName: string): asserts toolName is MarketplaceToolName {
  if (!validators.has(toolName as MarketplaceToolName)) {
    throw badRequest(`Unsupported marketplace tool: ${toolName}`);
  }
}

function assertInput(toolName: MarketplaceToolName, input: unknown): void {
  const validate = validators.get(toolName);
  if (!validate || !validate(input)) {
    throw badRequest(`Invalid input for marketplace tool: ${toolName}`, validate?.errors);
  }
}

export async function executeMarketplaceTool(
  toolName: string,
  input: unknown,
  context: MarketplaceToolContext,
): Promise<unknown> {
  assertContext(context);
  assertKnownTool(toolName);
  assertInput(toolName, input);

  // Context is authorization/audit metadata for the bridge, never marketplace input or output.
  if (toolName === "search_marketplace_plugins") {
    return marketplaceToolHandlers.search_marketplace_plugins(input as MarketplaceSearchQuery);
  }
  return marketplaceToolHandlers.get_marketplace_plugin((input as { pluginId: string }).pluginId);
}

export const marketplaceToolBridge: MarketplaceToolBridge = Object.freeze({
  declarations: marketplaceToolDeclarations,
  execute: executeMarketplaceTool,
});

export const coreMarketplaceToolBridge = marketplaceToolBridge;
