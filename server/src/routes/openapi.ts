import { Router } from "express";
import { z } from "zod";
import {
  // Agent
  createAgentSchema,
  createAgentHireSchema,
  updateAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  createAgentKeySchema,
  builtInAgentEmptyMutationSchema,
  builtInAgentProvisionSchema,
  wakeAgentSchema,
  resetAgentSessionSchema,
  agentSkillSyncSchema,
  testAdapterEnvironmentSchema,
  // Issue
  createIssueSchema,
  updateIssueSchema,
  createIssueLabelSchema,
  addIssueCommentSchema,
  submitIssueReportSchema,
  checkoutIssueSchema,
  linkIssueApprovalSchema,
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  restoreIssueDocumentRevisionSchema,
  upsertIssueFeedbackVoteSchema,
  upsertIssueWatchdogSchema,
  // Project
  createProjectSchema,
  updateProjectAccessPolicySchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectWorkspaceSchema,
  // Company
  createCompanySchema,
  updateCompanySchema,
  updateCompanyBrandingSchema,
  companyArtifactsQuerySchema,
  companyArtifactsResponseSchema,
  // Routine
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  // Goal
  createGoalSchema,
  updateGoalSchema,
  // Secret
  createSecretSchema,
  updateSecretSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  createUserSecretDefinitionSchema,
  updateUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  updateUserSecretValueSchema,
  // Approval
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
  // Cost / budget
  createCostEventSchema,
  createFinanceEventSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
  // Sidebar
  upsertSidebarOrderPreferenceSchema,
  // Execution workspaces
  reconcileExecutionWorkspaceBranchSchema,
  updateExecutionWorkspaceSchema,
  workspaceOverviewQuerySchema,
  workspaceRuntimeControlTargetSchema,
  // Environments
  createEnvironmentSchema,
  cancelEnvironmentCustomImageSetupSessionSchema,
  createEnvironmentCustomImageTerminalSessionTokenSchema,
  environmentCustomImageSetupSessionSchema,
  environmentCustomImageTerminalSessionTokenSchema,
  environmentCustomImageTemplateSchema,
  finishEnvironmentCustomImageSetupSessionSchema,
  updateEnvironmentSchema,
  probeEnvironmentConfigSchema,
  startEnvironmentCustomImageSetupSessionSchema,
  // Company skills
  companySkillCreateSchema,
  companySkillFileDeleteSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillProjectScanRequestSchema,
  companySkillTestInputCreateSchema,
  companySkillTestInputUpdateSchema,
  companySkillTestRunCreateSchema,
  companySkillTestRunListQuerySchema,
  companySkillTestRunTemplateCreateSchema,
  companySkillTestRunTemplateUpdateSchema,
  // Issue tree
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
  // Issue interactions
  createIssueThreadInteractionSchema,
  createChildIssueSchema,
  acceptIssueThreadInteractionSchema,
  rejectIssueThreadInteractionSchema,
  respondIssueThreadInteractionSchema,
  submitIssueThreadInteractionVerdictsSchema,
  // Auth / profile
  updateCurrentUserProfileSchema,
  // Company portability (legacy routes)
  companyPortabilityExportSchema,
  companyPortabilityPreviewSchema,
  companyPortabilityImportSchema,
  // Access / membership
  acceptInviteSchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  claimJoinRequestApiKeySchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  createBoardApiKeySchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  archiveCompanyMemberSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  // Instance settings
  patchInstanceGeneralSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceSettingsSchema,
  issueGraphLivenessAutoRecoveryRequestSchema,
  // Resource memberships
  updateResourceMembershipSchema,
  // Document annotations
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  updateDocumentAnnotationThreadSchema,
  // Issue recovery and decomposition
  createAcceptedPlanDecompositionSchema,
  resolveIssueRecoveryActionSchema,
  cancelIssueThreadInteractionSchema,
  // Secret provider configs and remote import
  createSecretProviderConfigSchema,
  updateSecretProviderConfigSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  workspaceFileListQuerySchema,
  workspaceFileResourceQuerySchema,
  createSpsModelConnectionSchema,
  updateSpsModelConnectionStatusSchema,
  grantSpsModelConnectionSchema,
  createSpsMemberDeviceRequestSchema,
} from "@paperclipai/shared";

type JsonSchema = Record<string, unknown>;
type OpenApiResponse = Record<string, unknown>;
type OpenApiPathRegistration = {
  method: string;
  path: string;
  request?: {
    params?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    body?: {
      content: Record<string, { schema: unknown }>;
      required?: boolean;
    };
  };
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
};

const zodTypeName = (schema: z.ZodTypeAny) => schema._def.typeName as string;

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const typeName = zodTypeName(schema);
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
    return unwrapSchema(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const typeName = zodTypeName(schema);
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
    return true;
  }
  if (typeName === "ZodEffects") {
    return isOptionalSchema(schema._def.schema);
  }
  if (typeName === "ZodNullable") {
    return isOptionalSchema(schema._def.innerType);
  }
  return false;
}

function applyStringChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
  for (const check of checks) {
    if (check.kind === "min") jsonSchema.minLength = check.value;
    if (check.kind === "max") jsonSchema.maxLength = check.value;
    if (check.kind === "email") jsonSchema.format = "email";
    if (check.kind === "url") jsonSchema.format = "uri";
    if (check.kind === "uuid") jsonSchema.format = "uuid";
    if (check.kind === "datetime") jsonSchema.format = "date-time";
    if (check.kind === "regex" && check.regex instanceof RegExp) {
      jsonSchema.pattern = check.regex.source;
    }
  }
}

function applyNumberChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
  for (const check of checks) {
    if (check.kind === "int") jsonSchema.type = "integer";
    if (check.kind === "min") {
      jsonSchema.minimum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMinimum = true;
    }
    if (check.kind === "max") {
      jsonSchema.maximum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMaximum = true;
    }
  }
}

function zodToOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrapSchema(schema);
  const typeName = zodTypeName(unwrapped);

  if (typeName === "ZodString") {
    const jsonSchema: JsonSchema = { type: "string" };
    applyStringChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodNumber") {
    const jsonSchema: JsonSchema = { type: "number" };
    applyNumberChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodDate") return { type: "string", format: "date-time" };
  if (typeName === "ZodAny" || typeName === "ZodUnknown") return {};

  if (typeName === "ZodLiteral") {
    const value = unwrapped._def.value;
    return { type: typeof value, enum: [value] };
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: unwrapped._def.values };
  }

  if (typeName === "ZodNativeEnum") {
    const values = Object.values(unwrapped._def.values).filter(
      (value) => typeof value === "string" || typeof value === "number",
    );
    return { enum: Array.from(new Set(values)) };
  }

  if (typeName === "ZodArray") {
    return { type: "array", items: zodToOpenApiSchema(unwrapped._def.type) };
  }

  if (typeName === "ZodRecord") {
    return {
      type: "object",
      additionalProperties: zodToOpenApiSchema(unwrapped._def.valueType),
    };
  }

  if (typeName === "ZodNullable") {
    return { ...zodToOpenApiSchema(unwrapped._def.innerType), nullable: true };
  }

  if (typeName === "ZodUnion") {
    return { oneOf: unwrapped._def.options.map((option: z.ZodTypeAny) => zodToOpenApiSchema(option)) };
  }

  if (typeName === "ZodDiscriminatedUnion") {
    return {
      oneOf: Array.from(unwrapped._def.options.values()).map((option) =>
        zodToOpenApiSchema(option as z.ZodTypeAny),
      ),
    };
  }

  if (typeName === "ZodIntersection") {
    return {
      allOf: [
        zodToOpenApiSchema(unwrapped._def.left),
        zodToOpenApiSchema(unwrapped._def.right),
      ],
    };
  }

  if (typeName === "ZodObject") {
    const shape = unwrapped._def.shape();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const propertySchema = value as z.ZodTypeAny;
      properties[key] = zodToOpenApiSchema(propertySchema);
      if (!isOptionalSchema(propertySchema)) required.push(key);
    }
    const jsonSchema: JsonSchema = { type: "object", properties };
    if (required.length > 0) jsonSchema.required = required;
    if (unwrapped._def.unknownKeys === "strict") jsonSchema.additionalProperties = false;
    return jsonSchema;
  }

  return {};
}

function normalizeContent(content: Record<string, { schema: unknown }>) {
  return Object.fromEntries(
    Object.entries(content).map(([contentType, media]) => [
      contentType,
      {
        ...media,
        schema: isZodSchema(media.schema)
          ? zodToOpenApiSchema(media.schema)
          : media.schema,
      },
    ]),
  );
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return Boolean(
    value &&
      typeof value === "object" &&
      "_def" in value &&
      typeof (value as z.ZodTypeAny).safeParse === "function",
  );
}

function normalizeResponses(responses: Record<string, OpenApiResponse> = {}) {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const content = response.content as Record<string, { schema: unknown }> | undefined;
      return [
        status,
        content
          ? {
              ...response,
              content: normalizeContent(content),
            }
          : response,
      ];
    }),
  );
}

function parametersFromSchema(schema: z.ZodTypeAny, location: "path" | "query") {
  const objectSchema = unwrapSchema(schema);
  if (zodTypeName(objectSchema) !== "ZodObject") return [];
  const shape = objectSchema._def.shape();
  return Object.entries(shape).map(([name, value]) => ({
    name,
    in: location,
    required: location === "path" ? true : !isOptionalSchema(value as z.ZodTypeAny),
    schema: zodToOpenApiSchema(value as z.ZodTypeAny),
  }));
}

class OpenAPIRegistry {
  private readonly schemas: Record<string, JsonSchema> = {};
  private readonly paths: Array<OpenApiPathRegistration> = [];

  register(name: string, schema: z.ZodTypeAny) {
    this.schemas[name] = zodToOpenApiSchema(schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  registerPath(pathRegistration: OpenApiPathRegistration) {
    this.paths.push(pathRegistration);
  }

  buildPaths() {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const { method, path, request, responses, ...operation } of this.paths) {
      const normalizedOperation: Record<string, unknown> = {
        ...operation,
        responses: normalizeResponses(responses),
      };
      if (request?.params) {
        normalizedOperation.parameters = parametersFromSchema(request.params, "path");
      }
      if (request?.query) {
        normalizedOperation.parameters = [
          ...((normalizedOperation.parameters as unknown[]) ?? []),
          ...parametersFromSchema(request.query, "query"),
        ];
      }
      if (request?.body) {
        normalizedOperation.requestBody = {
          ...request.body,
          content: normalizeContent(request.body.content),
        };
      }
      paths[path] ??= {};
      paths[path][method] = normalizedOperation;
    }
    return paths;
  }

  buildComponents() {
    return { schemas: this.schemas };
  }
}

const registry = new OpenAPIRegistry();

// ─── Common schemas ──────────────────────────────────────────────────────────

const ErrorSchema = registry.register(
  "Error",
  z.object({ error: z.string() }),
);

const responses = {
  ok: (schema: z.ZodTypeAny = z.record(z.unknown())) => ({
    description: "Success",
    content: { "application/json": { schema } },
  }),
  noContent: { description: "No content" },
  badRequest: {
    description: "Bad request",
    content: { "application/json": { schema: ErrorSchema } },
  },
  unauthorized: {
    description: "Unauthorized",
    content: { "application/json": { schema: ErrorSchema } },
  },
  forbidden: {
    description: "Forbidden",
    content: { "application/json": { schema: ErrorSchema } },
  },
  notFound: {
    description: "Not found",
    content: { "application/json": { schema: ErrorSchema } },
  },
  conflict: {
    description: "Conflict",
    content: { "application/json": { schema: ErrorSchema } },
  },
  unprocessable: {
    description: "Unprocessable entity",
    content: { "application/json": { schema: ErrorSchema } },
  },
  serverError: {
    description: "Internal server error",
    content: { "application/json": { schema: ErrorSchema } },
  },
  tooManyRequests: {
    description: "Too many requests",
    content: { "application/json": { schema: ErrorSchema } },
  },
};

const jsonBody = (schema: z.ZodTypeAny) => ({
  content: { "application/json": { schema } },
  required: true as const,
});

const r = responses;

const externalObjectSummariesBodySchema = z.object({
  issueIds: z.array(z.string().uuid()).max(1000),
}).strict();

const refreshExternalObjectsBodySchema = z.object({
  objectIds: z.array(z.string().uuid()).max(50).optional(),
}).strict();

const environmentCustomImageCompanyQuerySchema = z.object({
  companyId: z.string().optional(),
}).strict();

const disableEnvironmentCustomImageTemplateQuerySchema =
  environmentCustomImageCompanyQuerySchema.extend({
    deleteProviderTemplate: z.enum(["true", "false"]).optional(),
  });

const environmentCustomImageOverviewSchema = z.object({
  activeTemplate: environmentCustomImageTemplateSchema.nullable(),
  activeSession: environmentCustomImageSetupSessionSchema.nullable(),
  latestSession: environmentCustomImageSetupSessionSchema.nullable(),
}).strict();

const environmentCustomImageSetupSessionResultSchema = z.object({
  session: environmentCustomImageSetupSessionSchema,
  connectionPayload: z.record(z.string(), z.unknown()).nullable(),
}).strict();

const environmentCustomImageSetupSessionFinishResultSchema =
  environmentCustomImageSetupSessionResultSchema.extend({
    template: environmentCustomImageTemplateSchema,
  });

const environmentCustomImageTemplateRollbackResultSchema = z.object({
  activeTemplate: environmentCustomImageTemplateSchema,
  supersededTemplate: environmentCustomImageTemplateSchema,
}).strict();

const workTimelineQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  goalId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
}).strict();

const workTimelineResponseSchema = z.object({
  actors: z.array(z.object({
    id: z.string(),
    type: z.enum(["agent", "user", "system", "plugin"]),
    name: z.string(),
    avatar: z.string().nullable().optional(),
  }).strict()),
  spans: z.array(z.object({
    actorId: z.string(),
    laneHint: z.string().nullable(),
    runId: z.string(),
    issueId: z.string(),
    issueIdentifier: z.string().nullable(),
    start: z.string(),
    end: z.string().nullable(),
    status: z.string(),
    retryOfRunId: z.string().nullable().optional(),
    continuationAttempt: z.number().optional(),
    invocationSource: z.string().nullable().optional(),
  }).strict()),
  events: z.array(z.object({
    actorId: z.string(),
    kind: z.enum(["created", "commented", "approved", "delegated", "assigned"]),
    issueId: z.string(),
    at: z.string(),
  }).strict()),
  edges: z.array(z.object({
    fromActorId: z.string(),
    toActorId: z.string(),
    issueId: z.string(),
    at: z.string(),
    kind: z.enum(["delegation", "assignment", "mention"]),
  }).strict()),
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    totalIssues: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).strict(),
  window: z.object({
    from: z.string(),
    to: z.string(),
    capped: z.boolean(),
  }).strict(),
}).strict();

function paramsSchemaFromPath(routePath: string): z.ZodObject<z.ZodRawShape> | undefined {
  const names = [...routePath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  if (names.length === 0) return undefined;
  const shape: z.ZodRawShape = {};
  for (const name of names) {
    shape[name] = z.string();
  }
  return z.object(shape);
}

function registerCurrentRoute(input: {
  method: string;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  responses?: Record<string, OpenApiResponse>;
}) {
  const params = input.params ?? paramsSchemaFromPath(input.path);
  const request = params || input.query || input.body
    ? {
        ...(params ? { params } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.body ? { body: jsonBody(input.body) } : {}),
      }
    : undefined;
  registry.registerPath({
    method: input.method,
    path: input.path,
    tags: input.tags,
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    ...(request ? { request } : {}),
    responses: input.responses ?? { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
  });
}

type OpenApiAuthLevel =
  | "public"
  | "authenticated"
  | "board"
  | "sps_host"
  | "native_host"
  | "user_session"
  | "instance_admin";

const BOARD_SESSION_AUTH_SCHEME = "BoardSessionAuth";
const BOARD_API_KEY_AUTH_SCHEME = "BoardApiKeyAuth";
const AGENT_BEARER_AUTH_SCHEME = "AgentBearerAuth";
const SPS_DESKTOP_ACCESS_AUTH_SCHEME = "SpsDesktopAccessAuth";
const SPS_DESKTOP_HOST_PROOF_AUTH_SCHEME = "SpsDesktopOwnerBootstrapAuth";
const SPS_IDENTITY_SESSION_AUTH_SCHEME = "SpsIdentitySessionAuth";
const USER_SESSION_SECURITY = [
  { [SPS_IDENTITY_SESSION_AUTH_SCHEME]: [] },
  { [BOARD_SESSION_AUTH_SCHEME]: [] },
];
const NATIVE_HOST_OPERATIONS = new Set([
  "GET /api/sps/member-devices",
  "GET /api/sps/member-devices/status",
  "GET /api/sps/member-devices/{deviceId}/events",
  "POST /api/sps/member-devices/{deviceId}/approve",
  "POST /api/sps/member-devices/{deviceId}/revoke",
]);
const NATIVE_USER_OPERATIONS = new Set([
  "GET /api/companies/{companyId}/sps-member-device-requests",
  "POST /api/companies/{companyId}/sps-member-device-requests",
]);

function securityRequirement(name: string): Record<string, string[]> {
  return { [name]: [] };
}

const BOARD_SECURITY: Array<Record<string, string[]>> = [
  securityRequirement(BOARD_SESSION_AUTH_SCHEME),
  securityRequirement(BOARD_API_KEY_AUTH_SCHEME),
];

const AUTHENTICATED_SECURITY: Array<Record<string, string[]>> = [
  ...BOARD_SECURITY,
  securityRequirement(AGENT_BEARER_AUTH_SCHEME),
];

const SPS_HOST_SECURITY = BOARD_SECURITY.map((authentication) => ({
  ...authentication,
  [SPS_DESKTOP_ACCESS_AUTH_SCHEME]: [],
  [SPS_DESKTOP_HOST_PROOF_AUTH_SCHEME]: [],
}));
const SPS_HOST_AUTH_DESCRIPTION = "Host-only Core infrastructure endpoint. In the SPS Core baseline, a Board actor must use direct loopback transport with both per-launch Desktop access and separate owner-bootstrap Host proofs. A Board session or API key alone is not Host authority. Workspace access is checked separately. Existing local_implicit development authority and non-baseline instance-admin compatibility remain unchanged; this is not the Plugin capability API.";
const SPS_HOST_OPERATIONS = new Set([
  "GET /api/companies/{companyId}/sps-executions",
  "GET /api/companies/{companyId}/sps-executions/summary",
  "GET /api/companies/{companyId}/sps-executions/{lane}/{runId}",
  "GET /api/companies/{companyId}/sps-model-connections",
  "POST /api/companies/{companyId}/sps-model-connections",
  "PATCH /api/companies/{companyId}/sps-model-connections/{connectionId}",
  "GET /api/companies/{companyId}/sps-model-connections/{connectionId}/grants",
  "POST /api/companies/{companyId}/sps-model-connections/{connectionId}/grants",
  "POST /api/companies/{companyId}/sps-model-grants/{grantId}/revoke",
]);

const PUBLIC_OPERATIONS = new Set([
  "GET /api/health",
  "GET /api/openapi.json",
  "GET /api/board-claim/{token}",
  "POST /api/cli-auth/challenges",
  "GET /api/cli-auth/challenges/{id}",
  "POST /api/cli-auth/challenges/{id}/cancel",
  "GET /api/invites/{token}",
  "GET /api/invites/{token}/logo",
  "GET /api/invites/{token}/onboarding",
  "GET /api/invites/{token}/onboarding.txt",
  "GET /api/invites/{token}/skills/index",
  "GET /api/invites/{token}/skills/{skillName}",
  "GET /api/invites/{token}/test-resolution",
  "POST /api/invites/{token}/accept",
  "POST /api/join-requests/{requestId}/claim-api-key",
]);

const BOARD_ONLY_PREFIXES = [
  "/api/auth/",
  "/api/admin/",
  "/api/cloud-upstreams",
  "/api/plugins",
  "/api/instance/",
];

const BOARD_ONLY_OPERATIONS = new Set([
  "GET /api/companies",
  "POST /api/companies",
  "GET /api/companies/stats",
  "GET /api/companies/issues",
  "POST /api/board-claim/{token}/claim",
  "GET /api/cli-auth/me",
  "POST /api/companies/{companyId}/invites",
  "GET /api/companies/{companyId}/invites",
  "POST /api/companies/{companyId}/openclaw/invite-prompt",
  "GET /api/companies/{companyId}/join-requests",
  "POST /api/companies/{companyId}/join-requests/{requestId}/approve",
  "POST /api/companies/{companyId}/join-requests/{requestId}/reject",
  "GET /api/companies/{companyId}/members",
  "PATCH /api/companies/{companyId}/members/{memberId}",
  "PATCH /api/companies/{companyId}/members/{memberId}/role-and-grants",
  "POST /api/companies/{companyId}/members/{memberId}/archive",
  "PATCH /api/companies/{companyId}/members/{memberId}/permissions",
  "GET /api/companies/{companyId}/user-directory",
  "POST /api/execution-workspaces/{id}/reconcile-branch",
  "GET /api/board-api-keys",
  "POST /api/board-api-keys",
  "DELETE /api/board-api-keys/{keyId}",
  "POST /api/bootstrap/claim",
  "GET /api/companies/{companyId}/resource-memberships/me",
  "PUT /api/companies/{companyId}/resource-memberships/me/agents/{agentId}",
  "PUT /api/companies/{companyId}/resource-memberships/me/projects/{projectId}",
  "GET /api/companies/{companyId}/secret-provider-configs",
  "POST /api/companies/{companyId}/secret-provider-configs",
  "GET /api/companies/{companyId}/secret-providers/health",
  "POST /api/companies/{companyId}/secret-provider-configs/discovery/preview",
  "GET /api/secret-provider-configs/{id}",
  "PATCH /api/secret-provider-configs/{id}",
  "DELETE /api/secret-provider-configs/{id}",
  "POST /api/secret-provider-configs/{id}/default",
  "POST /api/secret-provider-configs/{id}/health",
  "GET /api/companies/{companyId}/user-secret-definitions",
  "POST /api/companies/{companyId}/user-secret-definitions",
  "PATCH /api/companies/{companyId}/user-secret-definitions/{definitionId}",
  "DELETE /api/companies/{companyId}/user-secret-definitions/{definitionId}",
  "GET /api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage",
  "GET /api/companies/{companyId}/me/user-secrets",
  "POST /api/companies/{companyId}/me/user-secrets",
  "PATCH /api/companies/{companyId}/me/user-secrets/{secretId}",
  "POST /api/companies/{companyId}/me/user-secrets/{secretId}/rotate",
  "DELETE /api/companies/{companyId}/me/user-secrets/{secretId}",
  "POST /api/companies/{companyId}/secrets/remote-import",
  "POST /api/companies/{companyId}/secrets/remote-import/preview",
  "GET /api/secrets/{id}/usage",
  "GET /api/secrets/{id}/access-events",
  "POST /api/health/dev-server/restart",
  "GET /api/issues/{issueId}/file-resources/content",
  "GET /api/issues/{issueId}/file-resources/list",
  "GET /api/issues/{issueId}/file-resources/resolve",
  "POST /api/issues/{id}/interactions/{interactionId}/accept",
  "POST /api/issues/{id}/interactions/{interactionId}/reject",
  "POST /api/issues/{id}/interactions/{interactionId}/respond",
]);

const INSTANCE_ADMIN_OPERATIONS = new Set([
  "POST /api/companies",
  "POST /api/plugins/install",
  "POST /api/instance/database-backups",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/admin/users/{userId}/demote-instance-admin",
  "PUT /api/admin/users/{userId}/company-access",
]);

const CREATED_OPERATIONS = new Set([
  "POST /api/adapters/install",
  "POST /api/companies/{companyId}/agent-hires",
  "POST /api/companies/{companyId}/agents",
  "POST /api/agents/{id}/keys",
  "POST /api/companies/{companyId}/approvals",
  "POST /api/approvals/{id}/comments",
  "POST /api/companies/{companyId}/assets/images",
  "POST /api/companies/{companyId}/logo",
  "POST /api/cli-auth/challenges",
  "POST /api/board-api-keys",
  "POST /api/companies",
  "POST /api/companies/{companyId}/invites",
  "POST /api/companies/{companyId}/openclaw/invite-prompt",
  "POST /api/companies/{companyId}/cost-events",
  "POST /api/companies/{companyId}/finance-events",
  "POST /api/companies/{companyId}/secret-provider-configs",
  "POST /api/companies/{companyId}/environments",
  "POST /api/environments/{environmentId}/custom-image-setup-sessions",
  "POST /api/companies/{companyId}/goals",
  "POST /api/companies/{companyId}/labels",
  "POST /api/issues/{id}/documents/{key}/annotations",
  "POST /api/issues/{id}/documents/{key}/annotations/{threadId}/comments",
  "POST /api/routines/{id}/description/annotations",
  "POST /api/routines/{id}/description/annotations/{threadId}/comments",
  "POST /api/issues/{id}/work-products",
  "POST /api/issues/{id}/low-trust/promotions",
  "POST /api/issues/{id}/approvals",
  "POST /api/companies/{companyId}/issues",
  "POST /api/issues/{id}/children",
  "POST /api/issues/{id}/interactions",
  "POST /api/issues/{id}/comments",
  "POST /api/issues/{id}/reports",
  "POST /api/companies/{companyId}/issues/{issueId}/attachments",
  "POST /api/companies/{companyId}/projects",
  "POST /api/projects/{id}/workspaces",
  "POST /api/companies/{companyId}/routines",
  "POST /api/routines/{id}/triggers",
  "POST /api/companies/{companyId}/secrets",
  "POST /api/companies/{companyId}/user-secret-definitions",
  "POST /api/companies/{companyId}/me/user-secrets",
  "POST /api/companies/{companyId}/skills",
  "POST /api/companies/{companyId}/skills/import",
  "POST /api/join-requests/{requestId}/claim-api-key",
  "POST /api/admin/users/{userId}/promote-instance-admin",
  "POST /api/plugins/install",
  "POST /api/instance/database-backups",
]);

const ACCEPTED_OPERATIONS = new Set([
  "POST /api/companies/import",
  "POST /api/health/dev-server/restart",
  "POST /api/invites/{token}/accept",
]);

const FORBIDDEN_RESPONSE = {
  description: "Forbidden",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

function operationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function isBoardOnlyOperation(method: string, path: string) {
  const key = operationKey(method, path);
  if (BOARD_ONLY_OPERATIONS.has(key)) return true;
  return BOARD_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function resolveOperationAuthLevel(method: string, path: string): OpenApiAuthLevel {
  const key = operationKey(method, path);
  if (PUBLIC_OPERATIONS.has(key)) return "public";
  if (NATIVE_HOST_OPERATIONS.has(key)) return "native_host";
  if (NATIVE_USER_OPERATIONS.has(key)) return "user_session";
  if (SPS_HOST_OPERATIONS.has(key)) return "sps_host";
  if (INSTANCE_ADMIN_OPERATIONS.has(key)) return "instance_admin";
  if (isBoardOnlyOperation(method, path)) return "board";
  return "authenticated";
}

function applyOperationStatusOverride(
  operation: Record<string, unknown>,
  fromStatus: string,
  toStatus: string,
) {
  const responses = operation.responses as Record<string, unknown> | undefined;
  if (!responses || !responses[fromStatus] || responses[toStatus]) return;
  responses[toStatus] = responses[fromStatus];
  delete responses[fromStatus];
}

function applyDocumentFixups(document: any): any {
  document.components ??= {};
  document.components.securitySchemes = {
    [SPS_IDENTITY_SESSION_AUTH_SCHEME]: {
      type: "apiKey", in: "cookie", name: "sps_identity_session",
      description: "Authenticated SPS Identity user session; not an API key, Agent credential or device approval.",
    },
    [BOARD_SESSION_AUTH_SCHEME]: {
      type: "apiKey",
      in: "cookie",
      name: "paperclip_session",
      description:
        "Board session cookie in authenticated mode. Paperclip uses Better Auth; cookie transport may vary by deployment.",
    },
    [BOARD_API_KEY_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Board API Key",
      description: "Board API key presented in the Authorization bearer header.",
    },
    [AGENT_BEARER_AUTH_SCHEME]: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Agent API Key or Agent JWT",
      description:
        "Agent API key or Paperclip-issued local agent JWT presented in the Authorization bearer header.",
    },
    [SPS_DESKTOP_ACCESS_AUTH_SCHEME]: {
      type: "apiKey",
      in: "header",
      name: "x-sps-desktop-access",
      description: "Per-launch SPS Desktop local transport proof. This header alone does not grant Core Host authority.",
    },
    [SPS_DESKTOP_HOST_PROOF_AUTH_SCHEME]: {
      type: "apiKey",
      in: "header",
      name: "x-sps-desktop-owner-bootstrap",
      description: "Separate per-launch Core Host proof, checked together with Desktop access on direct loopback transport and an authenticated Board actor. Workspace access remains required.",
    },
  };
  document.security = AUTHENTICATED_SECURITY;

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      const authLevel = resolveOperationAuthLevel(method, path);
      if (authLevel === "public") {
        operation.security = [];
      } else if (authLevel === "authenticated") {
        operation.security = AUTHENTICATED_SECURITY;
      } else if (authLevel === "sps_host") {
        operation.security = SPS_HOST_SECURITY;
        operation.description = [operation.description, SPS_HOST_AUTH_DESCRIPTION].filter(Boolean).join("\n\n");
      } else if (authLevel === "native_host") {
        const sessions = path === "/api/sps/member-devices/status"
          ? [{ [SPS_IDENTITY_SESSION_AUTH_SCHEME]: [] }] : USER_SESSION_SECURITY;
        operation.security = sessions.map(auth => ({
          ...auth, [SPS_DESKTOP_ACCESS_AUTH_SCHEME]: [], [SPS_DESKTOP_HOST_PROOF_AUTH_SCHEME]: [],
        }));
        operation["x-sps-authorization"] = { actor: "user_session", localDesktopHost: true, hostScoped: true };
      } else if (authLevel === "user_session") {
        operation.security = USER_SESSION_SECURITY;
        operation["x-sps-authorization"] = { actor: "user_session", currentWorkspaceMembership: true, pendingOnly: true };
      } else {
        operation.security = BOARD_SECURITY;
      }

      operation["x-paperclip-authorization"] =
        authLevel === "native_host"
          ? { actor: "board", spsCoreHost: true, workspaceAccess: false, sessionOnly: true }
          : authLevel === "user_session"
          ? { actor: "board", workspaceAccess: true, sessionOnly: true }
          : authLevel === "sps_host"
          ? { actor: "board", spsCoreHost: true, workspaceAccess: true }
          : authLevel === "instance_admin"
          ? { actor: "board", instanceAdmin: true }
          : authLevel === "board"
            ? { actor: "board" }
            : authLevel === "authenticated"
              ? { actor: "board_or_agent" }
              : { actor: "public" };

      const key = operationKey(method, path);
      if (authLevel !== "public") {
        const responses = (operation.responses ??= {}) as Record<string, unknown>;
        if (!responses["403"]) {
          responses["403"] = FORBIDDEN_RESPONSE;
        }
      }
      if (CREATED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "201");
      }
      if (ACCEPTED_OPERATIONS.has(key)) {
        applyOperationStatusOverride(operation, "200", "202");
      }
    }
  }

  return document;
}

// ─── Health ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/health",
  tags: ["health"],
  summary: "Health check",
  responses: {
    200: r.ok(z.object({
      status: z.enum(["ok", "unhealthy"]),
      version: z.string().optional(),
      deploymentMode: z.string().optional(),
      bootstrapStatus: z.enum(["ready", "bootstrap_pending"]).optional(),
      bootstrapInviteActive: z.boolean().optional(),
      databaseBackup: z.object({
        enabled: z.boolean(),
        status: z.enum(["ok", "warning"]),
        backupDir: z.string().optional(),
        maxAgeHours: z.number().optional(),
        latestBackup: z.object({
          name: z.string(),
          path: z.string(),
          mtime: z.string().datetime(),
          ageHours: z.number(),
          sizeBytes: z.number(),
        }).nullable().optional(),
        lastFailure: z.object({
          path: z.string(),
          mtime: z.string().datetime(),
          message: z.string(),
        }).nullable().optional(),
        warnings: z.array(z.object({
          code: z.enum([
            "database_backup_check_failed",
            "database_backup_last_failure",
            "database_backup_missing",
            "database_backup_stale",
          ]),
          message: z.string(),
        })),
      }).optional(),
      warnings: z.array(z.object({
        code: z.string(),
        message: z.string(),
      })).optional(),
      serverInfo: z.object({
        processStartedAt: z.string().datetime(),
        git: z.union([
          z.object({
            available: z.literal(true),
            fullSha: z.string(),
            shortSha: z.string(),
            subject: z.string(),
            committedAt: z.string().datetime().nullable(),
            localChanges: z.union([
              z.object({
                available: z.literal(true),
                hasLocalChanges: z.boolean(),
                stagedFileCount: z.number().int().nonnegative(),
                unstagedFileCount: z.number().int().nonnegative(),
                untrackedFileCount: z.number().int().nonnegative(),
              }).strict(),
              z.object({
                available: z.literal(false),
                unavailableReason: z.enum(["git_status_unavailable"]),
              }).strict(),
            ]),
          }).strict(),
          z.object({
            available: z.literal(false),
            unavailableReason: z.enum(["git_unavailable", "invalid_git_metadata"]),
          }).strict(),
        ]),
      }).strict().optional(),
    })),
    503: { description: "Service unavailable", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/openapi.json",
  tags: ["health"],
  summary: "Get the generated OpenAPI document",
  responses: { 200: r.ok() },
});

// ─── Companies ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies",
  tags: ["companies"],
  summary: "List companies",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies",
  tags: ["companies"],
  summary: "Create a company",
  request: { body: jsonBody(createCompanySchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/stats",
  tags: ["companies"],
  summary: "Company stats",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Get a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/artifacts",
  tags: ["companies"],
  summary: "List company artifacts",
  request: {
    params: z.object({ companyId: z.string() }),
    query: companyArtifactsQuerySchema,
  },
  responses: {
    200: {
      description: "Company artifact projection",
      content: {
        "application/json": {
          schema: companyArtifactsResponseSchema,
        },
      },
    },
    401: r.unauthorized,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/timeline",
  tags: ["companies"],
  summary: "Get company work timeline",
  request: {
    params: z.object({ companyId: z.string() }),
    query: workTimelineQuerySchema,
  },
  responses: {
    200: r.ok(workTimelineResponseSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Update a company",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanySchema.partial()),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/branding",
  tags: ["companies"],
  summary: "Update company branding",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateCompanyBrandingSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/archive",
  tags: ["companies"],
  summary: "Archive a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}",
  tags: ["companies"],
  summary: "Delete a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/feedback-traces",
  tags: ["companies"],
  summary: "List company feedback traces",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports",
  tags: ["companies"],
  summary: "Export company data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/exports/preview",
  tags: ["companies"],
  summary: "Preview company export",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/preview",
  tags: ["companies"],
  summary: "Preview company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/imports/apply",
  tags: ["companies"],
  summary: "Apply company import",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Teams Catalog ──────────────────────────────────────────────────────────

for (const route of [
  ["get", "/api/teams/catalog", "List catalog teams"],
  ["get", "/api/teams/catalog/{catalogId}/files", "Get catalog team file"],
  ["get", "/api/teams/catalog/{catalogId}", "Get catalog team"],
  ["get", "/api/companies/{companyId}/teams/catalog/installed", "List installed catalog teams"],
  ["post", "/api/companies/{companyId}/teams/catalog/{catalogId}/preview", "Preview catalog team install"],
  ["post", "/api/companies/{companyId}/teams/catalog/{catalogId}/install", "Install catalog team"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["teams"],
    summary: route[2],
  });
}

// ─── Agents ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/built-in-agents",
  tags: ["agents"],
  summary: "List built-in agent provisioning state",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/built-in-agents/{key}/status",
  tags: ["agents"],
  summary: "Get built-in agent bundle status",
  request: { params: z.object({ companyId: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/built-in-agents/{key}/reconcile",
  tags: ["agents"],
  summary: "Reconcile built-in agent managed resources",
  request: {
    params: z.object({ companyId: z.string(), key: z.string() }),
    body: jsonBody(builtInAgentEmptyMutationSchema),
  },
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/built-in-agents/{key}/provision",
  tags: ["agents"],
  summary: "Provision a built-in agent",
  request: {
    params: z.object({ companyId: z.string(), key: z.string() }),
    body: jsonBody(builtInAgentProvisionSchema),
  },
  responses: {
    200: r.ok(),
    202: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/built-in-agents/{key}/reset",
  tags: ["agents"],
  summary: "Reset a built-in agent",
  request: { params: z.object({ companyId: z.string(), key: z.string() }) },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

for (const route of [
  ["enable", "Enable a built-in routine schedule", 200],
  ["disable", "Disable a built-in routine schedule", 200],
  ["run", "Run a built-in routine once", 202],
] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/companies/{companyId}/built-in-agents/{key}/routines/{routineKey}/${route[0]}`,
    tags: ["agents"],
    summary: route[1],
    request: {
      params: z.object({ companyId: z.string(), key: z.string(), routineKey: z.string() }),
      body: jsonBody(builtInAgentEmptyMutationSchema),
    },
    responses: {
      [route[2]]: r.ok(),
      400: r.badRequest,
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
      409: r.conflict,
      422: r.unprocessable,
    },
  });
}

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agents",
  tags: ["agents"],
  summary: "List agents in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/agents",
  tags: ["agents"],
  summary: "Create an agent",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createAgentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/agent-hires",
  tags: ["agents"],
  summary: "Hire an agent",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createAgentHireSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/agent-configurations",
  tags: ["agents"],
  summary: "List agent configurations for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org",
  tags: ["agents"],
  summary: "Get org chart data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me",
  tags: ["agents"],
  summary: "Get the current agent",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me/inbox-lite",
  tags: ["agents"],
  summary: "Get current agent inbox (lite)",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/me/inbox/mine",
  tags: ["agents"],
  summary: "Get current agent assigned inbox items",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Get an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Update an agent",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentSchema.omit({ permissions: true })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}",
  tags: ["agents"],
  summary: "Delete an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/permissions",
  tags: ["agents"],
  summary: "Update agent permissions",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/instructions-path",
  tags: ["agents"],
  summary: "Update agent instructions path",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentInstructionsPathSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/instructions-bundle",
  tags: ["agents"],
  summary: "Get agent instructions bundle",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{id}/instructions-bundle",
  tags: ["agents"],
  summary: "Update agent instructions bundle",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateAgentInstructionsBundleSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Get agent instructions file",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Upsert agent instructions file",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(upsertAgentInstructionsFileSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}/instructions-bundle/file",
  tags: ["agents"],
  summary: "Delete agent instructions file",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/configuration",
  tags: ["agents"],
  summary: "Get agent configuration",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions",
  tags: ["agents"],
  summary: "List agent config revisions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/config-revisions/{revisionId}",
  tags: ["agents"],
  summary: "Get an agent config revision",
  request: { params: z.object({ id: z.string(), revisionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/config-revisions/{revisionId}/rollback",
  tags: ["agents"],
  summary: "Roll back to a config revision",
  request: { params: z.object({ id: z.string(), revisionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/runtime-state",
  tags: ["agents"],
  summary: "Get agent runtime state",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/runtime-state/reset-session",
  tags: ["agents"],
  summary: "Reset agent session",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resetAgentSessionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/task-sessions",
  tags: ["agents"],
  summary: "List agent task sessions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/skills",
  tags: ["agents"],
  summary: "List agent skills",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/skills/sync",
  tags: ["agents"],
  summary: "Sync desired skills onto an agent configuration",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(agentSkillSyncSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/keys",
  tags: ["agents"],
  summary: "List agent API keys",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/keys",
  tags: ["agents"],
  summary: "Create an agent API key",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createAgentKeySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}/keys/{keyId}",
  tags: ["agents"],
  summary: "Delete an agent API key",
  request: { params: z.object({ id: z.string(), keyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/wakeup",
  tags: ["agents"],
  summary: "Wake up an agent",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(wakeAgentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/pause",
  tags: ["agents"],
  summary: "Pause an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/resume",
  tags: ["agents"],
  summary: "Resume an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/clear-error",
  tags: ["agents"],
  summary: "Clear an agent error",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/terminate",
  tags: ["agents"],
  summary: "Terminate an agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/instance/scheduler-heartbeats",
  tags: ["agents"],
  summary: "List scheduler heartbeats",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Adapters ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/models",
  tags: ["adapters"],
  summary: "List models for an adapter type",
  request: { params: z.object({ companyId: z.string(), type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/detect-model",
  tags: ["adapters"],
  summary: "Detect active model for an adapter",
  request: { params: z.object({ companyId: z.string(), type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/adapters/{type}/test-environment",
  tags: ["adapters"],
  summary: "Validate adapter environment access for a company",
  request: {
    params: z.object({ companyId: z.string(), type: z.string() }),
    body: jsonBody(testAdapterEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Issues ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "List issues in a company",
  description: "Use `view=compact` for the board issue-list row contract. The default response remains the broad compatibility contract.",
  request: {
    params: z.object({ companyId: z.string() }),
    query: z.object({ view: z.enum(["compact"]).optional() }).passthrough(),
  },
  responses: { 200: r.ok(), 304: { description: "Not Modified" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues",
  tags: ["issues"],
  summary: "Create an issue",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Get an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Update an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueSchema.partial()),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}",
  tags: ["issues"],
  summary: "Delete an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/heartbeat-context",
  tags: ["issues"],
  summary: "Get issue heartbeat context",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/watchdog",
  tags: ["issues"],
  summary: "Get active issue watchdog",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/issues/{id}/watchdog",
  tags: ["issues"],
  summary: "Create or update an issue watchdog",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(upsertIssueWatchdogSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/watchdog",
  tags: ["issues"],
  summary: "Disable an issue watchdog",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "List issue work products",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/work-products",
  tags: ["issues"],
  summary: "Create an issue work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Update a work product",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateIssueWorkProductSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/work-products/{id}",
  tags: ["issues"],
  summary: "Delete a work product",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents",
  tags: ["issues"],
  summary: "List issue documents",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Get an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Upsert an issue document",
  request: {
    params: z.object({ id: z.string(), key: z.string() }),
    body: jsonBody(upsertIssueDocumentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/documents/{key}",
  tags: ["issues"],
  summary: "Delete an issue document",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/documents/{key}/revisions",
  tags: ["issues"],
  summary: "List issue document revisions",
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/revisions/{revisionId}/restore",
  tags: ["issues"],
  summary: "Restore a document revision",
  request: {
    params: z.object({ id: z.string(), key: z.string(), revisionId: z.string() }),
    body: jsonBody(restoreIssueDocumentRevisionSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "List issue comments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/comments",
  tags: ["issues"],
  summary: "Add a comment to an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(addIssueCommentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}/access-policy",
  tags: ["projects"],
  summary: "Read a Project access policy",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "put",
  path: "/api/projects/{id}/access-policy",
  tags: ["projects"],
  summary: "Replace a Project access policy",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateProjectAccessPolicySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/reports",
  tags: ["issues"],
  summary: "Atomically submit a terminal report for the current agent run",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(submitIssueReportSchema),
  },
  responses: {
    200: r.ok(),
    201: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: FORBIDDEN_RESPONSE,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/comments/{commentId}",
  tags: ["issues"],
  summary: "Delete an issue comment",
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "List issue approvals",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/approvals",
  tags: ["issues"],
  summary: "Link an approval to an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(linkIssueApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/approvals/{approvalId}",
  tags: ["issues"],
  summary: "Unlink an approval from an issue",
  request: { params: z.object({ id: z.string(), approvalId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/checkout",
  tags: ["issues"],
  summary: "Check out an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(checkoutIssueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/release",
  tags: ["issues"],
  summary: "Release an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as read",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/read",
  tags: ["issues"],
  summary: "Mark an issue as unread",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Archive issue from inbox",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/issues/{id}/inbox-archive",
  tags: ["issues"],
  summary: "Un-archive issue from inbox",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/feedback-votes",
  tags: ["issues"],
  summary: "List issue feedback votes",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/feedback-votes",
  tags: ["issues"],
  summary: "Upsert a feedback vote",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(upsertIssueFeedbackVoteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/feedback-traces",
  tags: ["issues"],
  summary: "List issue feedback traces",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/feedback-traces/{traceId}",
  tags: ["issues"],
  summary: "Get a feedback trace",
  request: { params: z.object({ traceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/feedback-traces/{traceId}/bundle",
  tags: ["issues"],
  summary: "Get a feedback trace bundle",
  request: { params: z.object({ traceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/file-resources/list",
  tags: ["issues"],
  summary: "List workspace files for an issue",
  request: {
    params: z.object({ issueId: z.string() }),
    query: workspaceFileListQuerySchema,
  },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    404: r.notFound,
    422: r.unprocessable,
    429: r.tooManyRequests,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/file-resources/resolve",
  tags: ["issues"],
  summary: "Resolve an issue workspace file",
  request: {
    params: z.object({ issueId: z.string() }),
    query: workspaceFileResourceQuerySchema,
  },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    404: r.notFound,
    422: r.unprocessable,
    429: r.tooManyRequests,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/file-resources/content",
  tags: ["issues"],
  summary: "Read issue workspace file content",
  request: {
    params: z.object({ issueId: z.string() }),
    query: workspaceFileResourceQuerySchema,
  },
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    404: r.notFound,
    422: r.unprocessable,
    429: r.tooManyRequests,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/attachments",
  tags: ["issues"],
  summary: "List issue attachments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "List labels in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/labels",
  tags: ["issues"],
  summary: "Create a label",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createIssueLabelSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/labels/{labelId}",
  tags: ["issues"],
  summary: "Delete a label",
  request: { params: z.object({ labelId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Projects ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "List projects in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/projects",
  tags: ["projects"],
  summary: "Create a project",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createProjectSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Get a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Update a project",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateProjectSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/projects/{id}",
  tags: ["projects"],
  summary: "Delete a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}/workspaces",
  tags: ["projects"],
  summary: "List project workspaces",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces",
  tags: ["projects"],
  summary: "Create a project workspace",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createProjectWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/projects/{id}/workspaces/{workspaceId}",
  tags: ["projects"],
  summary: "Update a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string() }),
    body: jsonBody(updateProjectWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/projects/{id}/workspaces/{workspaceId}",
  tags: ["projects"],
  summary: "Delete a project workspace",
  request: { params: z.object({ id: z.string(), workspaceId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Routines ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "List routines in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/routines",
  tags: ["routines"],
  summary: "Create a routine",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Get a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/routines/{id}",
  tags: ["routines"],
  summary: "Update a routine",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/routines/{id}/runs",
  tags: ["routines"],
  summary: "List runs for a routine",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routines/{id}/run",
  tags: ["routines"],
  summary: "Manually run a routine",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(runRoutineSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routines/{id}/triggers",
  tags: ["routines"],
  summary: "Create a routine trigger",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createRoutineTriggerSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/routine-triggers/{id}",
  tags: ["routines"],
  summary: "Update a routine trigger",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateRoutineTriggerSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/routine-triggers/{id}",
  tags: ["routines"],
  summary: "Delete a routine trigger",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/routine-triggers/{id}/rotate-secret",
  tags: ["routines"],
  summary: "Rotate a routine trigger secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateRoutineTriggerSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/routine-triggers/public/{publicId}/fire",
  tags: ["routines"],
  summary: "Fire a public routine trigger",
  request: { params: z.object({ publicId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Goals ───────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/goals",
  tags: ["goals"],
  summary: "List goals in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/goals",
  tags: ["goals"],
  summary: "Create a goal",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Get a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Update a goal",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateGoalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/goals/{id}",
  tags: ["goals"],
  summary: "Delete a goal",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secret-providers",
  tags: ["secrets"],
  summary: "List secret providers",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "List secrets in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/secrets",
  tags: ["secrets"],
  summary: "Create a secret",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/secrets/{id}",
  tags: ["secrets"],
  summary: "Update a secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/secrets/{id}/rotate",
  tags: ["secrets"],
  summary: "Rotate a secret",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(rotateSecretSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/secrets/{id}",
  tags: ["secrets"],
  summary: "Delete a secret",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-secret-definitions",
  tags: ["secrets"],
  summary: "List user secret definitions",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/user-secret-definitions",
  tags: ["secrets"],
  summary: "Create a user secret definition",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createUserSecretDefinitionSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
  tags: ["secrets"],
  summary: "Update a user secret definition",
  request: {
    params: z.object({ companyId: z.string(), definitionId: z.string() }),
    body: jsonBody(updateUserSecretDefinitionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}",
  tags: ["secrets"],
  summary: "Delete a user secret definition",
  request: { params: z.object({ companyId: z.string(), definitionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-secret-definitions/{definitionId}/coverage",
  tags: ["secrets"],
  summary: "Get user secret definition coverage",
  request: { params: z.object({ companyId: z.string(), definitionId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/me/user-secrets",
  tags: ["secrets"],
  summary: "List my user secret values",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/me/user-secrets",
  tags: ["secrets"],
  summary: "Create my user secret value",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createUserSecretValueSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}",
  tags: ["secrets"],
  summary: "Update my user secret value",
  request: {
    params: z.object({ companyId: z.string(), secretId: z.string() }),
    body: jsonBody(updateUserSecretValueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}/rotate",
  tags: ["secrets"],
  summary: "Rotate my user secret value",
  request: {
    params: z.object({ companyId: z.string(), secretId: z.string() }),
    body: jsonBody(rotateUserSecretValueSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/me/user-secrets/{secretId}",
  tags: ["secrets"],
  summary: "Delete my user secret value",
  request: { params: z.object({ companyId: z.string(), secretId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Approvals ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "List approvals in a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/approvals",
  tags: ["approvals"],
  summary: "Create an approval",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}",
  tags: ["approvals"],
  summary: "Get an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/issues",
  tags: ["approvals"],
  summary: "List issues linked to an approval",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/approve",
  tags: ["approvals"],
  summary: "Approve an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/reject",
  tags: ["approvals"],
  summary: "Reject an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/request-revision",
  tags: ["approvals"],
  summary: "Request revision on an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(requestApprovalRevisionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/resubmit",
  tags: ["approvals"],
  summary: "Resubmit an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resubmitApprovalSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "List approval comments",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/approvals/{id}/comments",
  tags: ["approvals"],
  summary: "Add a comment to an approval",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(addApprovalCommentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Costs ───────────────────────────────────────────────────────────────────

const costSummaryPaths = [
  "summary", "by-agent", "by-agent-model", "by-provider",
  "by-biller", "by-project", "finance-summary", "finance-by-biller",
  "finance-by-kind", "finance-events", "window-spend", "quota-windows",
] as const;

for (const segment of costSummaryPaths) {
  registry.registerPath({
    method: "get",
    path: `/api/companies/{companyId}/costs/${segment}`,
    tags: ["costs"],
    summary: `Cost report: ${segment}`,
    request: { params: z.object({ companyId: z.string() }) },
    responses: { 200: r.ok(), 401: r.unauthorized },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/cost-events",
  tags: ["costs"],
  summary: "Record a cost event",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createCostEventSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/finance-events",
  tags: ["costs"],
  summary: "Record a finance event",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createFinanceEventSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/budgets/policies",
  tags: ["costs"],
  summary: "Create or update a budget policy",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(upsertBudgetPolicySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  tags: ["costs"],
  summary: "Resolve a budget incident",
  request: {
    params: z.object({ companyId: z.string(), incidentId: z.string() }),
    body: jsonBody(resolveBudgetIncidentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/budgets/overview",
  tags: ["costs"],
  summary: "Get budget overview",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/budgets",
  tags: ["costs"],
  summary: "Update company budget",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(updateBudgetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/agents/{agentId}/budgets",
  tags: ["costs"],
  summary: "Update agent budget",
  request: {
    params: z.object({ agentId: z.string() }),
    body: jsonBody(updateBudgetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Activity ────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "List company activity",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/activity",
  tags: ["activity"],
  summary: "Create an activity entry",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.object({
      actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
      actorId: z.string().min(1),
      action: z.string().min(1),
      entityType: z.string().min(1),
      entityId: z.string().min(1),
      agentId: z.string().uuid().optional().nullable(),
      details: z.record(z.unknown()).optional().nullable(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/activity",
  tags: ["activity"],
  summary: "List activity for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/runs",
  tags: ["activity"],
  summary: "List runs for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/issues",
  tags: ["activity"],
  summary: "List issues for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/dashboard",
  tags: ["dashboard"],
  summary: "Get dashboard data",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Sidebar ─────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-badges",
  tags: ["sidebar"],
  summary: "Get sidebar badge counts",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/attention",
  tags: ["inbox"],
  summary: "List decision-only attention feed items",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get current user sidebar preferences",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update current user sidebar preferences",
  request: { body: jsonBody(upsertSidebarOrderPreferenceSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Get sidebar preferences for company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "put",
  path: "/api/companies/{companyId}/sidebar-preferences/me",
  tags: ["sidebar"],
  summary: "Update sidebar preferences for company",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(upsertSidebarOrderPreferenceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Inbox dismissals ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/inbox-dismissals",
  tags: ["inbox"],
  summary: "List inbox dismissals",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/inbox-dismissals",
  tags: ["inbox"],
  summary: "Create an inbox dismissal or snooze",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(z.object({
      itemKey: z.string().trim().min(1).regex(/^(approval|join|run|attention):.+$/, "Unsupported inbox item key"),
      kind: z.enum(["dismiss", "snooze"]).optional(),
      snoozedUntil: z.string().datetime().optional(),
    })),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/inbox-dismissals/{itemKey}",
  tags: ["inbox"],
  summary: "Restore an inbox dismissal or snooze",
  request: { params: z.object({ companyId: z.string(), itemKey: z.string() }) },
  responses: { 204: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Instance settings ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/instance/settings",
  tags: ["instance"],
  summary: "Get instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/instance/settings",
  tags: ["instance"],
  summary: "Update instance settings",
  request: { body: jsonBody(patchInstanceSettingsSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/instance/settings/general",
  tags: ["instance"],
  summary: "Get general instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/instance/settings/general",
  tags: ["instance"],
  summary: "Update general instance settings",
  request: { body: jsonBody(patchInstanceGeneralSettingsSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/instance/settings/experimental",
  tags: ["instance"],
  summary: "Get experimental instance settings",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/instance/settings/experimental",
  tags: ["instance"],
  summary: "Update experimental instance settings",
  request: { body: jsonBody(patchInstanceExperimentalSettingsSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Board chat (Conference Room Chat, experimental) ──────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/board/chat/stream",
  tags: ["instance"],
  summary: "Stream a board-level chat response (requires enableConferenceRoomChat)",
  request: {
    body: jsonBody(
      z.object({
        companyId: z.string(),
        message: z.string(),
        taskId: z.string().optional(),
      }),
    ),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

// ─── Access / invites / members ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "List company invites",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/invites",
  tags: ["access"],
  summary: "Create a company invite",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createCompanyInviteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/join-requests",
  tags: ["access"],
  summary: "List company join requests",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/join-requests/{requestId}/approve",
  tags: ["access"],
  summary: "Approve a company join request",
  request: { params: z.object({ companyId: z.string(), requestId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/join-requests/{requestId}/reject",
  tags: ["access"],
  summary: "Reject a company join request",
  request: { params: z.object({ companyId: z.string(), requestId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/invites/{inviteId}/revoke",
  tags: ["access"],
  summary: "Revoke an invite",
  request: { params: z.object({ inviteId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}",
  tags: ["access"],
  summary: "Get an invite by token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/invites/{token}/accept",
  tags: ["access"],
  summary: "Accept an invite and create or replay a join request",
  request: {
    params: z.object({ token: z.string() }),
    body: jsonBody(acceptInviteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/members",
  tags: ["access"],
  summary: "List company members",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}",
  tags: ["access"],
  summary: "Update a company member status or role",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/role-and-grants",
  tags: ["access"],
  summary: "Update a company member role and explicit grants",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateCompanyMemberWithPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/members/{memberId}/archive",
  tags: ["access"],
  summary: "Archive a company member",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(archiveCompanyMemberSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/members/{memberId}/permissions",
  tags: ["access"],
  summary: "Update explicit company member permissions",
  request: {
    params: z.object({ companyId: z.string(), memberId: z.string() }),
    body: jsonBody(updateMemberPermissionsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/user-directory",
  tags: ["access"],
  summary: "Get company user directory",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/me",
  tags: ["access"],
  summary: "Get current CLI auth session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/openclaw/invite-prompt",
  tags: ["access"],
  summary: "Create an OpenClaw invite prompt bundle",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createOpenClawInvitePromptSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges",
  tags: ["access"],
  summary: "Create a CLI auth challenge",
  request: { body: jsonBody(createCliAuthChallengeSchema) },
  responses: { 200: r.ok(), 400: r.badRequest },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges/{id}/approve",
  tags: ["access"],
  summary: "Approve a CLI auth challenge",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveCliAuthChallengeSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/challenges/{id}/cancel",
  tags: ["access"],
  summary: "Cancel a CLI auth challenge",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(resolveCliAuthChallengeSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/cli-auth/revoke-current",
  tags: ["access"],
  summary: "Revoke current CLI auth session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/available",
  tags: ["access"],
  summary: "List available skills",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/index",
  tags: ["access"],
  summary: "Get skills index",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/skills/{skillName}",
  tags: ["access"],
  summary: "Get a skill by name",
  request: { params: z.object({ skillName: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/join-requests/{requestId}/claim-api-key",
  tags: ["access"],
  summary: "Claim the initial API key for an approved agent join request",
  request: {
    params: z.object({ requestId: z.string() }),
    body: jsonBody(claimJoinRequestApiKeySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/users",
  tags: ["admin"],
  summary: "List all users (admin)",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── Auth / profile ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/auth/get-session",
  tags: ["auth"],
  summary: "Get current session",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/profile",
  tags: ["auth"],
  summary: "Get current user profile",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/auth/profile",
  tags: ["auth"],
  summary: "Update current user profile",
  request: { body: jsonBody(updateCurrentUserProfileSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/users/{userSlug}/profile",
  tags: ["auth"],
  summary: "Get a user profile within a company",
  request: { params: z.object({ companyId: z.string(), userSlug: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

// ─── Heartbeat runs ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/heartbeat-runs",
  tags: ["runs"],
  summary: "List heartbeat runs for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/live-runs",
  tags: ["runs"],
  summary: "List live runs for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/live-runs",
  tags: ["runs"],
  summary: "List live runs for an issue",
  request: { params: z.object({ issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{issueId}/active-run",
  tags: ["runs"],
  summary: "Get active run for an issue",
  request: { params: z.object({ issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}",
  tags: ["runs"],
  summary: "Get a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/heartbeat-runs/{runId}/cancel",
  tags: ["runs"],
  summary: "Cancel a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/heartbeat-runs/{runId}/watchdog-decisions",
  tags: ["runs"],
  summary: "Submit watchdog decisions for a run",
  request: {
    params: z.object({ runId: z.string() }),
    body: jsonBody(z.object({
      decision: z.enum(["snooze", "continue", "dismissed_false_positive"]),
      evaluationIssueId: z.string().optional().nullable(),
      reason: z.string().optional().nullable(),
      snoozedUntil: z.string().datetime().optional().nullable(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/events",
  tags: ["runs"],
  summary: "Get events for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/log",
  tags: ["runs"],
  summary: "Get log for a heartbeat run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/heartbeat-runs/{runId}/workspace-operations",
  tags: ["runs"],
  summary: "List workspace operations for a run",
  request: { params: z.object({ runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/workspace-operations/{operationId}/log",
  tags: ["runs"],
  summary: "Get log for a workspace operation",
  request: { params: z.object({ operationId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Agent runs & heartbeat ───────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/approve",
  tags: ["agents"],
  summary: "Approve a pending agent action",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/heartbeat/invoke",
  tags: ["agents"],
  summary: "Invoke agent heartbeat",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/claude-login",
  tags: ["agents"],
  summary: "Trigger Claude login for agent",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Issue interactions & tree ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/interactions",
  tags: ["issues"],
  summary: "List issue thread interactions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions",
  tags: ["issues"],
  summary: "Create an issue thread interaction",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/accept",
  tags: ["issues"],
  summary: "Accept an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(acceptIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/reject",
  tags: ["issues"],
  summary: "Reject an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(rejectIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/respond",
  tags: ["issues"],
  summary: "Answer questions on an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(respondIssueThreadInteractionSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/verdicts",
  tags: ["issues"],
  summary: "Submit item verdicts on an issue thread interaction",
  request: {
    params: z.object({ id: z.string(), interactionId: z.string() }),
    body: jsonBody(submitIssueThreadInteractionVerdictsSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/children",
  tags: ["issues"],
  summary: "Create child issues",
  request: { params: z.object({ id: z.string() }), body: jsonBody(createChildIssueSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/admin/force-release",
  tags: ["issues"],
  summary: "Force-release an issue (admin)",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-control/state",
  tags: ["issues"],
  summary: "Get issue tree control state",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-control/preview",
  tags: ["issues"],
  summary: "Preview issue tree control changes",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(previewIssueTreeControlSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "List issue tree holds",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds",
  tags: ["issues"],
  summary: "Create an issue tree hold",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(createIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/tree-holds/{holdId}",
  tags: ["issues"],
  summary: "Get an issue tree hold",
  request: { params: z.object({ id: z.string(), holdId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/tree-holds/{holdId}/release",
  tags: ["issues"],
  summary: "Release an issue tree hold",
  request: {
    params: z.object({ id: z.string(), holdId: z.string() }),
    body: jsonBody(releaseIssueTreeHoldSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Attachments ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues/{issueId}/attachments",
  tags: ["assets"],
  summary: "Upload an attachment to an issue",
  request: { params: z.object({ companyId: z.string(), issueId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/attachments/{attachmentId}/content",
  tags: ["assets"],
  summary: "Download attachment content",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/attachments/{attachmentId}",
  tags: ["assets"],
  summary: "Delete an attachment",
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Assets ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/assets/images",
  tags: ["assets"],
  summary: "Upload an image asset",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/logo",
  tags: ["assets"],
  summary: "Upload company logo",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/assets/{assetId}/content",
  tags: ["assets"],
  summary: "Download asset content",
  request: { params: z.object({ assetId: z.string() }) },
  responses: { 200: { description: "File content" }, 401: r.unauthorized, 404: r.notFound },
});

// ─── Company skills ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "List skills for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Get a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/update-status",
  tags: ["skills"],
  summary: "Get skill update status",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "List skill files",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills",
  tags: ["skills"],
  summary: "Create a company skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillCreateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "Update a skill file",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillFileUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/files",
  tags: ["skills"],
  summary: "Delete a skill file or folder",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillFileDeleteSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs",
  tags: ["skills"],
  summary: "List skill test inputs",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs",
  tags: ["skills"],
  summary: "Create a skill test input",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillTestInputCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs/{inputId}",
  tags: ["skills"],
  summary: "Update a skill test input",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string(), inputId: z.string() }),
    body: jsonBody(companySkillTestInputUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/test-inputs/{inputId}",
  tags: ["skills"],
  summary: "Delete a skill test input",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), inputId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skill-test-run-templates",
  tags: ["skills"],
  summary: "List skill test-run templates",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skill-test-run-templates",
  tags: ["skills"],
  summary: "Create a skill test-run template",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillTestRunTemplateCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{companyId}/skill-test-run-templates/{templateId}",
  tags: ["skills"],
  summary: "Update a skill test-run template",
  request: {
    params: z.object({ companyId: z.string(), templateId: z.string() }),
    body: jsonBody(companySkillTestRunTemplateUpdateSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skill-test-run-templates/{templateId}",
  tags: ["skills"],
  summary: "Delete a skill test-run template",
  request: { params: z.object({ companyId: z.string(), templateId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs",
  tags: ["skills"],
  summary: "List skill test runs",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    query: companySkillTestRunListQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 422: r.unprocessable },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}",
  tags: ["skills"],
  summary: "Get a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs",
  tags: ["skills"],
  summary: "Create a skill test run",
  request: {
    params: z.object({ companyId: z.string(), skillId: z.string() }),
    body: jsonBody(companySkillTestRunCreateSchema),
  },
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}/cancel",
  tags: ["skills"],
  summary: "Cancel a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}/test-runs/{runId}",
  tags: ["skills"],
  summary: "Delete a skill test run",
  request: { params: z.object({ companyId: z.string(), skillId: z.string(), runId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/import",
  tags: ["skills"],
  summary: "Import a skill",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillImportSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/scan-projects",
  tags: ["skills"],
  summary: "Scan project for skills",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companySkillProjectScanRequestSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/skills/{skillId}/install-update",
  tags: ["skills"],
  summary: "Install a skill update",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/companies/{companyId}/skills/{skillId}",
  tags: ["skills"],
  summary: "Delete a company skill",
  request: { params: z.object({ companyId: z.string(), skillId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Execution workspaces ─────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/execution-workspaces",
  tags: ["execution-workspaces"],
  summary: "List execution workspaces for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/workspace-overview",
  tags: ["execution-workspaces"],
  summary: "List bounded execution workspace overview rows for a company",
  request: {
    params: z.object({ companyId: z.string() }),
    query: workspaceOverviewQuerySchema,
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 422: r.unprocessable },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}",
  tags: ["execution-workspaces"],
  summary: "Get an execution workspace",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}/close-readiness",
  tags: ["execution-workspaces"],
  summary: "Check close-readiness of a workspace",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/execution-workspaces/{id}/workspace-operations",
  tags: ["execution-workspaces"],
  summary: "List workspace operations",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/execution-workspaces/{id}",
  tags: ["execution-workspaces"],
  summary: "Update an execution workspace",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateExecutionWorkspaceSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/execution-workspaces/{id}/reconcile-branch",
  tags: ["execution-workspaces"],
  summary: "Reconcile an execution workspace branch record",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(reconcileExecutionWorkspaceBranchSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 422: r.unprocessable },
});

registry.registerPath({
  method: "post",
  path: "/api/execution-workspaces/{id}/runtime-services/{action}",
  tags: ["execution-workspaces"],
  summary: "Control a runtime service in a workspace",
  request: {
    params: z.object({ id: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/execution-workspaces/{id}/runtime-commands/{action}",
  tags: ["execution-workspaces"],
  summary: "Run a runtime command in a workspace",
  request: {
    params: z.object({ id: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Environments ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/environments",
  tags: ["environments"],
  summary: "List environments for a company",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/environments/capabilities",
  tags: ["environments"],
  summary: "Get environment capabilities",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/environments",
  tags: ["environments"],
  summary: "Create an environment",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(createEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Get an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{id}/delete-blast-radius",
  tags: ["environments"],
  summary: "Get environment delete blast radius",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{id}/leases",
  tags: ["environments"],
  summary: "List leases for an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/environment-leases/{leaseId}",
  tags: ["environments"],
  summary: "Get an environment lease",
  request: { params: z.object({ leaseId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "patch",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Update an environment",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(updateEnvironmentSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/environments/{id}",
  tags: ["environments"],
  summary: "Delete an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
});

registry.registerPath({
  method: "post",
  path: "/api/environments/{id}/probe",
  tags: ["environments"],
  summary: "Probe an environment",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/environments/probe-config",
  tags: ["environments"],
  summary: "Probe environment config",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(probeEnvironmentConfigSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/environments/{environmentId}/custom-image-template",
  tags: ["environments"],
  summary: "Get the active customImage template and setup status for an environment",
  request: {
    params: z.object({ environmentId: z.string() }),
    query: environmentCustomImageCompanyQuerySchema,
  },
  responses: { 200: r.ok(environmentCustomImageOverviewSchema), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/environments/{environmentId}/custom-image-setup-sessions",
  tags: ["environments"],
  summary: "Start an interactive environment customImage setup session",
  request: {
    params: z.object({ environmentId: z.string() }),
    query: environmentCustomImageCompanyQuerySchema,
    body: jsonBody(startEnvironmentCustomImageSetupSessionSchema),
  },
  responses: {
    201: r.ok(environmentCustomImageSetupSessionResultSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    409: r.conflict,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/environment-custom-image-setup-sessions/{sessionId}",
  tags: ["environments"],
  summary: "Get and refresh an environment customImage setup session",
  request: { params: z.object({ sessionId: z.string() }) },
  responses: {
    200: r.ok(environmentCustomImageSetupSessionResultSchema),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/environment-custom-image-setup-sessions/{sessionId}/terminal-session-token",
  tags: ["environments"],
  summary: "Mint a short-lived terminal websocket token for a customImage SSH setup session",
  request: {
    params: z.object({ sessionId: z.string() }),
    body: jsonBody(createEnvironmentCustomImageTerminalSessionTokenSchema),
  },
  responses: {
    201: r.ok(environmentCustomImageTerminalSessionTokenSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
    422: r.unprocessable,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/environment-custom-image-setup-sessions/{sessionId}/finish",
  tags: ["environments"],
  summary: "Capture and promote an environment customImage setup session",
  request: {
    params: z.object({ sessionId: z.string() }),
    body: jsonBody(finishEnvironmentCustomImageSetupSessionSchema),
  },
  responses: {
    200: r.ok(environmentCustomImageSetupSessionFinishResultSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/environment-custom-image-setup-sessions/{sessionId}/cancel",
  tags: ["environments"],
  summary: "Cancel an environment customImage setup session",
  request: {
    params: z.object({ sessionId: z.string() }),
    body: jsonBody(cancelEnvironmentCustomImageSetupSessionSchema),
  },
  responses: {
    200: r.ok(environmentCustomImageSetupSessionSchema),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/environments/{environmentId}/custom-image-template/rollback",
  tags: ["environments"],
  summary: "Roll back an environment customImage template to the previous captured template",
  request: {
    params: z.object({ environmentId: z.string() }),
    query: environmentCustomImageCompanyQuerySchema,
  },
  responses: {
    200: r.ok(environmentCustomImageTemplateRollbackResultSchema),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/environments/{environmentId}/custom-image-template",
  tags: ["environments"],
  summary: "Disable the active environment customImage template",
  request: {
    params: z.object({ environmentId: z.string() }),
    query: disableEnvironmentCustomImageTemplateQuerySchema,
  },
  responses: {
    200: r.ok(environmentCustomImageTemplateSchema),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
  },
});

// ─── Adapters (full) ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/adapters",
  tags: ["adapters"],
  summary: "List all adapters",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/install",
  tags: ["adapters"],
  summary: "Install an adapter",
  request: {
    body: jsonBody(z.object({
      packageName: z.string(),
      isLocalPath: z.boolean().optional(),
      version: z.string().optional(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Enable or disable an adapter",
  request: {
    params: z.object({ type: z.string() }),
    body: jsonBody(z.object({ disabled: z.boolean() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "patch",
  path: "/api/adapters/{type}/override",
  tags: ["adapters"],
  summary: "Pause or resume an adapter's override of a builtin",
  request: {
    params: z.object({ type: z.string() }),
    body: jsonBody(z.object({ paused: z.boolean() })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "delete",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Delete an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reload",
  tags: ["adapters"],
  summary: "Reload an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/adapters/{type}/reinstall",
  tags: ["adapters"],
  summary: "Reinstall an adapter",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/adapters/{type}/config-schema",
  tags: ["adapters"],
  summary: "Get adapter config schema",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/plugins",
  tags: ["plugins"],
  summary: "List installed plugins",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/examples",
  tags: ["plugins"],
  summary: "List example plugins",
  responses: { 200: r.ok() },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/ui-contributions",
  tags: ["plugins"],
  summary: "List plugin UI contributions",
  request: {
    query: z.object({ companyId: z.string().optional() }).passthrough(),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/companies/{companyId}",
  tags: ["plugins"],
  summary: "List installed plugins with Company activation state",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/plugins/{pluginId}/companies/{companyId}/activation",
  tags: ["plugins"],
  summary: "Set a Company plugin activation override",
  request: {
    params: z.object({ pluginId: z.string(), companyId: z.string() }),
    body: jsonBody(z.object({ enabled: z.boolean() })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/tools",
  tags: ["plugins"],
  summary: "List plugin tools",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/tools/execute",
  tags: ["plugins"],
  summary: "Execute a plugin tool",
  request: {
    body: jsonBody(z.object({
      tool: z.string(),
      parameters: z.record(z.unknown()).optional(),
      runContext: z.object({
        agentId: z.string(),
        runId: z.string(),
        companyId: z.string(),
        projectId: z.string(),
      }),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/install",
  tags: ["plugins"],
  summary: "Install a plugin",
  request: {
    body: jsonBody(z.object({
      packageName: z.string(),
      version: z.string().optional(),
      isLocalPath: z.boolean().optional(),
    })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}",
  tags: ["plugins"],
  summary: "Get a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "delete",
  path: "/api/plugins/{pluginId}",
  tags: ["plugins"],
  summary: "Delete a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/enable",
  tags: ["plugins"],
  summary: "Enable a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/disable",
  tags: ["plugins"],
  summary: "Disable a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/health",
  tags: ["plugins"],
  summary: "Get plugin health",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/logs",
  tags: ["plugins"],
  summary: "Get plugin logs",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/upgrade",
  tags: ["plugins"],
  summary: "Upgrade a plugin",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Get plugin config",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config",
  tags: ["plugins"],
  summary: "Set plugin config",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({ configJson: z.record(z.unknown()) })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/config/test",
  tags: ["plugins"],
  summary: "Test plugin config",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({ configJson: z.record(z.unknown()) })),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs",
  tags: ["plugins"],
  summary: "List plugin jobs",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/runs",
  tags: ["plugins"],
  summary: "List runs for a plugin job",
  request: { params: z.object({ pluginId: z.string(), jobId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/trigger",
  tags: ["plugins"],
  summary: "Trigger a plugin job",
  request: { params: z.object({ pluginId: z.string(), jobId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/webhooks/{endpointKey}",
  tags: ["plugins"],
  summary: "Deliver an external webhook payload to a plugin",
  request: {
    params: z.object({ pluginId: z.string(), endpointKey: z.string() }),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/dashboard",
  tags: ["plugins"],
  summary: "Get plugin dashboard data",
  request: { params: z.object({ pluginId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/bridge/data",
  tags: ["plugins"],
  summary: "Send data via plugin bridge",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({
      key: z.string(),
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/bridge/action",
  tags: ["plugins"],
  summary: "Send action via plugin bridge",
  request: {
    params: z.object({ pluginId: z.string() }),
    body: jsonBody(z.object({
      key: z.string(),
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/data/{key}",
  tags: ["plugins"],
  summary: "Get plugin data by key (URL-keyed bridge)",
  request: {
    params: z.object({ pluginId: z.string(), key: z.string() }),
    body: jsonBody(z.object({
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/plugins/{pluginId}/actions/{key}",
  tags: ["plugins"],
  summary: "Invoke a plugin action (URL-keyed bridge)",
  request: {
    params: z.object({ pluginId: z.string(), key: z.string() }),
    body: jsonBody(z.object({
      companyId: z.string().optional(),
      params: z.record(z.unknown()).optional(),
    })),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

// ─── Instance database backups ────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/instance/database-backups",
  tags: ["instance"],
  summary: "Trigger a database backup",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

// ─── LLM text endpoints ───────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration.txt",
  tags: ["llms"],
  summary: "Get agent configuration as plain text (for LLM context)",
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-configuration/{adapterType}.txt",
  tags: ["llms"],
  summary: "Get agent configuration for a specific adapter type",
  request: { params: z.object({ adapterType: z.string() }) },
  responses: { 200: { description: "Plain text agent configuration" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/llms/agent-icons.txt",
  tags: ["llms"],
  summary: "Get agent icon names as plain text",
  responses: { 200: { description: "Plain text icon list" }, 401: r.unauthorized },
});

// ─── Issues (legacy / misc) ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/issues",
  tags: ["issues"],
  summary: "Legacy — returns error directing to /api/companies/{companyId}/issues",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/comments/{commentId}",
  tags: ["issues"],
  summary: "Get a single issue comment",
  request: { params: z.object({ id: z.string(), commentId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/external-objects",
  tags: ["issues"],
  summary: "List external objects mentioned by an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/issues/{id}/external-object-summary",
  tags: ["issues"],
  summary: "Get external object status summary for an issue",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/issues/external-object-summaries",
  tags: ["issues"],
  summary: "Get external object status summaries for issues",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(externalObjectSummariesBodySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/issues/{id}/external-objects/refresh",
  tags: ["issues"],
  summary: "Refresh external objects mentioned by an issue",
  request: {
    params: z.object({ id: z.string() }),
    body: jsonBody(refreshExternalObjectsBodySchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/projects/{id}/external-object-summary",
  tags: ["projects"],
  summary: "Get external object status summary for a project",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Org chart images ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.svg",
  tags: ["companies"],
  summary: "Get org chart as SVG",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "SVG image" }, 401: r.unauthorized },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{companyId}/org.png",
  tags: ["companies"],
  summary: "Get org chart as PNG",
  request: { params: z.object({ companyId: z.string() }) },
  responses: { 200: { description: "PNG image" }, 401: r.unauthorized },
});

// ─── Company portability (legacy routes) ─────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/issues",
  tags: ["companies"],
  summary: "Legacy — returns error directing to correct issues path",
  responses: { 400: r.badRequest },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{companyId}/export",
  tags: ["companies"],
  summary: "Export a company (legacy singular form)",
  request: {
    params: z.object({ companyId: z.string() }),
    body: jsonBody(companyPortabilityExportSchema),
  },
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import/preview",
  tags: ["companies"],
  summary: "Preview a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityPreviewSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/import",
  tags: ["companies"],
  summary: "Apply a company import (legacy route)",
  request: { body: jsonBody(companyPortabilityImportSchema) },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Board claim & CLI auth ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/board-claim/{token}",
  tags: ["access"],
  summary: "Get board claim details by token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/board-claim/{token}/claim",
  tags: ["access"],
  summary: "Claim a board token",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/cli-auth/challenges/{id}",
  tags: ["access"],
  summary: "Get a CLI auth challenge",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Invite onboarding ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/logo",
  tags: ["access"],
  summary: "Get company logo for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Image file" }, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding",
  tags: ["access"],
  summary: "Get onboarding data for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/onboarding.txt",
  tags: ["access"],
  summary: "Get onboarding instructions as plain text",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: { description: "Plain text onboarding instructions" }, 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/skills/index",
  tags: ["access"],
  summary: "Get skills index for an invite",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/skills/{skillName}",
  tags: ["access"],
  summary: "Get a skill by name for an invite",
  request: { params: z.object({ token: z.string(), skillName: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

registry.registerPath({
  method: "get",
  path: "/api/invites/{token}/test-resolution",
  tags: ["access"],
  summary: "Test invite token resolution",
  request: { params: z.object({ token: z.string() }) },
  responses: { 200: r.ok(), 404: r.notFound },
});

// ─── Admin ────────────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Get company access for a user (admin)",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "put",
  path: "/api/admin/users/{userId}/company-access",
  tags: ["admin"],
  summary: "Set company access for a user (admin)",
  request: {
    params: z.object({ userId: z.string() }),
    body: jsonBody(updateUserCompanyAccessSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/promote-instance-admin",
  tags: ["admin"],
  summary: "Promote a user to instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registry.registerPath({
  method: "post",
  path: "/api/admin/users/{userId}/demote-instance-admin",
  tags: ["admin"],
  summary: "Demote a user from instance admin",
  request: { params: z.object({ userId: z.string() }) },
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

// ─── Project workspace runtime ────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces/{workspaceId}/runtime-services/{action}",
  tags: ["projects"],
  summary: "Control a runtime service in a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registry.registerPath({
  method: "post",
  path: "/api/projects/{id}/workspaces/{workspaceId}/runtime-commands/{action}",
  tags: ["projects"],
  summary: "Run a runtime command in a project workspace",
  request: {
    params: z.object({ id: z.string(), workspaceId: z.string(), action: z.string() }),
    body: jsonBody(workspaceRuntimeControlTargetSchema),
  },
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

// ─── Plugin bridge stream ─────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/plugins/{pluginId}/bridge/stream/{channel}",
  tags: ["plugins"],
  summary: "Subscribe to a plugin bridge SSE stream",
  request: { params: z.object({ pluginId: z.string(), channel: z.string() }) },
  responses: {
    200: { description: "Server-sent event stream (text/event-stream)" },
    401: r.unauthorized,
  },
});

// ─── Plugin UI static ─────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/_plugins/{pluginId}/ui/{filePath}",
  tags: ["plugins"],
  summary: "Serve plugin UI static file",
  request: { params: z.object({ pluginId: z.string(), filePath: z.string() }) },
  responses: { 200: { description: "Static file content" }, 404: r.notFound },
});

// ─── Adapter UI parser ────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/adapters/{type}/ui-parser.js",
  tags: ["adapters"],
  summary: "Get adapter UI parser script",
  request: { params: z.object({ type: z.string() }) },
  responses: { 200: { description: "JavaScript file" }, 404: r.notFound },
});

// ─── Current route coverage ─────────────────────────────────────────────────

registerCurrentRoute({
  method: "get",
  path: "/api/adapters/{type}",
  tags: ["adapters"],
  summary: "Get adapter registration details",
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/adapters/{type}/model-profiles",
  tags: ["adapters"],
  summary: "List adapter model profiles for a company",
});

registerCurrentRoute({
  method: "post",
  path: "/api/health/dev-server/restart",
  tags: ["health"],
  summary: "Request a managed dev-server restart",
  responses: { 202: r.ok(), 403: r.forbidden, 404: r.notFound, 409: { description: "Restart is not required" } },
});

registerCurrentRoute({
  method: "post",
  path: "/api/bootstrap/claim",
  tags: ["access"],
  summary: "Claim first instance admin from a browser session",
  responses: { 200: r.ok(), 401: r.unauthorized, 404: r.notFound, 409: { description: "Instance admin already claimed" } },
});

registerCurrentRoute({
  method: "get",
  path: "/api/board-api-keys",
  tags: ["access"],
  summary: "List board API keys",
  responses: { 200: r.ok(), 401: r.unauthorized },
});

registerCurrentRoute({
  method: "post",
  path: "/api/board-api-keys",
  tags: ["access"],
  summary: "Create a named board API key",
  body: createBoardApiKeySchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized },
});

registerCurrentRoute({
  method: "delete",
  path: "/api/board-api-keys/{keyId}",
  tags: ["access"],
  summary: "Revoke a board API key",
});

for (const route of [
  ["get", "/api/companies/import/jobs/{jobId}", "Get company import job status"],
  ["get", "/api/companies/{companyId}/search", "Search company data"],
  ["get", "/api/companies/{companyId}/issues/count", "Count issues in a company"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["companies"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/cost-summary",
  tags: ["costs"],
  summary: "Get issue cost summary",
});

for (const route of [
  ["get", "/api/companies/{companyId}/resource-memberships/me", "List current user's resource memberships"],
  ["put", "/api/companies/{companyId}/resource-memberships/me/agents/{agentId}", "Join or leave an agent resource"],
  ["put", "/api/companies/{companyId}/resource-memberships/me/projects/{projectId}", "Join or leave a project resource"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["resource-memberships"],
    summary: route[2],
    ...(route[0] === "put" ? { body: updateResourceMembershipSchema } : {}),
  });
}

const cloudCompanyQuerySchema = z.object({
  companyId: z.string().min(1),
});
const cloudCompanyBodySchema = z.object({
  companyId: z.string().min(1),
});
const cloudConnectStartSchema = z.object({
  companyId: z.string().min(1),
  remoteUrl: z.string().min(1),
  redirectUri: z.string().min(1),
});
const cloudConnectFinishSchema = z.object({
  pendingConnectionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().min(1),
});
const cloudPushRunSchema = cloudCompanyBodySchema.extend({
  retryOfRunId: z.string().optional(),
});
const cloudPushRunActivationSchema = cloudCompanyBodySchema.extend({
  entityType: z.enum(["agents", "routines", "monitors"]),
});

registerCurrentRoute({
  method: "get",
  path: "/api/cloud-upstreams",
  tags: ["cloud-upstreams"],
  summary: "List cloud upstream connections",
  query: cloudCompanyQuerySchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/connect/start",
  tags: ["cloud-upstreams"],
  summary: "Start a cloud upstream connection",
  body: cloudConnectStartSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/connect/finish",
  tags: ["cloud-upstreams"],
  summary: "Finish a cloud upstream connection",
  body: cloudConnectFinishSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/{connectionId}/push-runs/preview",
  tags: ["cloud-upstreams"],
  summary: "Preview a cloud upstream push run",
  body: cloudCompanyBodySchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/{connectionId}/push-runs",
  tags: ["cloud-upstreams"],
  summary: "Create a cloud upstream push run",
  body: cloudPushRunSchema,
});

registerCurrentRoute({
  method: "get",
  path: "/api/cloud-upstreams/{connectionId}/push-runs/{runId}",
  tags: ["cloud-upstreams"],
  summary: "Get a cloud upstream push run",
  query: cloudCompanyQuerySchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/{connectionId}/push-runs/{runId}/cancel",
  tags: ["cloud-upstreams"],
  summary: "Cancel a cloud upstream push run",
  body: cloudCompanyBodySchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/cloud-upstreams/{connectionId}/push-runs/{runId}/activation",
  tags: ["cloud-upstreams"],
  summary: "Activate cloud upstream push run entities",
  body: cloudPushRunActivationSchema,
});

for (const route of [
  ["get", "/api/companies/{companyId}/secret-providers/health", "Check configured secret providers"],
  ["get", "/api/companies/{companyId}/secret-provider-configs", "List secret provider configurations"],
  ["get", "/api/secret-provider-configs/{id}", "Get a secret provider configuration"],
  ["delete", "/api/secret-provider-configs/{id}", "Delete a secret provider configuration"],
  ["post", "/api/secret-provider-configs/{id}/default", "Set the default secret provider configuration"],
  ["post", "/api/secret-provider-configs/{id}/health", "Check a secret provider configuration"],
  ["get", "/api/secrets/{id}/usage", "Get secret usage"],
  ["get", "/api/secrets/{id}/access-events", "List secret access events"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["secrets"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/secret-provider-configs",
  tags: ["secrets"],
  summary: "Create a secret provider configuration",
  body: createSecretProviderConfigSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/secret-provider-configs/{id}",
  tags: ["secrets"],
  summary: "Update a secret provider configuration",
  body: updateSecretProviderConfigSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/secret-provider-configs/discovery/preview",
  tags: ["secrets"],
  summary: "Preview secret provider discovery",
  body: secretProviderConfigDiscoveryPreviewSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/secrets/remote-import/preview",
  tags: ["secrets"],
  summary: "Preview remote secret import",
  body: remoteSecretImportPreviewSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/secrets/remote-import",
  tags: ["secrets"],
  summary: "Import remote secrets",
  body: remoteSecretImportSchema,
});

for (const route of [
  ["get", "/api/skills/catalog", "List catalog skills"],
  ["get", "/api/skills/catalog/{catalogId}", "Get a catalog skill"],
  ["get", "/api/skills/catalog/{catalogId}/files", "List catalog skill files"],
  ["post", "/api/companies/{companyId}/skills/install-catalog", "Install a catalog skill"],
  ["get", "/api/companies/{companyId}/skills/categories", "List company skill categories"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/audit", "Audit a company skill"],
  ["patch", "/api/companies/{companyId}/skills/{skillId}", "Update a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/versions", "List skill versions"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/versions", "Create a skill version"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/versions/{versionId}", "Get a skill version"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/star", "Star a company skill"],
  ["delete", "/api/companies/{companyId}/skills/{skillId}/star", "Unstar a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/fork-precheck", "Preview company skill fork impact"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/fork", "Fork a company skill"],
  ["get", "/api/companies/{companyId}/skills/{skillId}/comments", "List skill comments"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/comments", "Create a skill comment"],
  ["patch", "/api/companies/{companyId}/skills/{skillId}/comments/{commentId}", "Update a skill comment"],
  ["delete", "/api/companies/{companyId}/skills/{skillId}/comments/{commentId}", "Delete a skill comment"],
  ["post", "/api/companies/{companyId}/skills/{skillId}/reset", "Reset a company skill"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["skills"],
    summary: route[2],
    ...(route[0] === "post" ? { body: z.record(z.unknown()).optional() } : {}),
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
  tags: ["instance-settings"],
  summary: "Preview issue graph liveness auto-recovery",
  body: issueGraphLivenessAutoRecoveryRequestSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
  tags: ["instance-settings"],
  summary: "Run issue graph liveness auto-recovery",
  body: issueGraphLivenessAutoRecoveryRequestSchema,
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/accepted-plan-decompositions",
  tags: ["issues"],
  summary: "List accepted plan decompositions",
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/accepted-plan-decompositions",
  tags: ["issues"],
  summary: "Create accepted plan decomposition child issues",
  body: createAcceptedPlanDecompositionSchema,
});

for (const route of [
  ["get", "/api/issues/{id}/documents/{key}/annotations", "List document annotation threads"],
  ["get", "/api/issues/{id}/documents/{key}/annotations/{threadId}", "Get a document annotation thread"],
  ["post", "/api/issues/{id}/documents/{key}/lock", "Lock an issue document"],
  ["post", "/api/issues/{id}/documents/{key}/unlock", "Unlock an issue document"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["issues"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/annotations",
  tags: ["issues"],
  summary: "Create a document annotation thread",
  body: createDocumentAnnotationThreadSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/documents/{key}/annotations/{threadId}/comments",
  tags: ["issues"],
  summary: "Add a document annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/low-trust/promotions",
  tags: ["issues"],
  summary: "Promote quarantined low-trust output",
  body: z.object({
    sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
    sourceArtifactId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(8_000),
  }),
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound, 422: r.unprocessable },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/issues/{id}/documents/{key}/annotations/{threadId}",
  tags: ["issues"],
  summary: "Update a document annotation thread",
  body: updateDocumentAnnotationThreadSchema,
});

for (const route of [
  ["get", "/api/routines/{id}/description/annotations", "List routine description annotation threads"],
  ["get", "/api/routines/{id}/description/annotations/{threadId}", "Get a routine description annotation thread"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["routines"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations",
  tags: ["routines"],
  summary: "Create a routine description annotation thread",
  body: createDocumentAnnotationThreadSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations/{threadId}/comments",
  tags: ["routines"],
  summary: "Add a routine description annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/routines/{id}/description/annotations/{threadId}",
  tags: ["routines"],
  summary: "Update a routine description annotation thread",
  body: updateDocumentAnnotationThreadSchema,
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/diagnostics/blockers",
  tags: ["issues"],
  summary: "Get blocker diagnostics for an issue",
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/diagnostics/wakes",
  tags: ["issues"],
  summary: "Get wake diagnostics for an issue",
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/diagnostics/subtree",
  tags: ["issues"],
  summary: "Get bounded subtree wake and blocker diagnostics for an issue",
});

registerCurrentRoute({
  method: "get",
  path: "/api/issues/{id}/recovery-actions",
  tags: ["issues"],
  summary: "List issue recovery actions",
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/recovery-actions/resolve",
  tags: ["issues"],
  summary: "Resolve an issue recovery action",
  body: resolveIssueRecoveryActionSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/scheduled-retry/retry-now",
  tags: ["issues"],
  summary: "Retry a scheduled issue run now",
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/monitor/check-now",
  tags: ["issues"],
  summary: "Run an issue monitor check now",
});

registerCurrentRoute({
  method: "post",
  path: "/api/issues/{id}/interactions/{interactionId}/cancel",
  tags: ["issues"],
  summary: "Cancel an issue question interaction",
  body: cancelIssueThreadInteractionSchema,
});

for (const route of [
  ["get", "/api/routines/{id}/revisions", "List routine revisions"],
  ["post", "/api/routines/{id}/revisions/{revisionId}/restore", "Restore a routine revision"],
  ["get", "/api/routines/{id}/description/annotations", "List routine description annotation threads"],
  ["get", "/api/routines/{id}/description/annotations/{threadId}", "Get a routine description annotation thread"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["routines"],
    summary: route[2],
  });
}

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations",
  tags: ["routines"],
  summary: "Create a routine description annotation thread",
  body: createDocumentAnnotationThreadSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/routines/{id}/description/annotations/{threadId}/comments",
  tags: ["routines"],
  summary: "Add a routine description annotation comment",
  body: createDocumentAnnotationCommentSchema,
  responses: { 201: r.ok(), 400: r.badRequest, 401: r.unauthorized, 404: r.notFound },
});

registerCurrentRoute({
  method: "patch",
  path: "/api/routines/{id}/description/annotations/{threadId}",
  tags: ["routines"],
  summary: "Update a routine description annotation thread",
  body: updateDocumentAnnotationThreadSchema,
});

const pluginLocalFolderRequestSchema = z.object({
  path: z.string().min(1),
  access: z.enum(["read", "readWrite"]).optional(),
  requiredDirectories: z.array(z.string()).optional(),
  requiredFiles: z.array(z.string()).optional(),
});

for (const route of [
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/local-folders", "List plugin local folders"],
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/status", "Get plugin local folder status"],
  ["post", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}/validate", "Validate a plugin local folder"],
  ["put", "/api/plugins/{pluginId}/companies/{companyId}/local-folders/{folderKey}", "Save a plugin local folder"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["plugins"],
    summary: route[2],
    ...(route[0] === "post" || route[0] === "put" ? { body: pluginLocalFolderRequestSchema } : {}),
  });
}

// ─── Spec builder ─────────────────────────────────────────────────────────────

for (const route of [
  ["get", "/api/plugins/agent-platform/extensions", "List agent-platform plugin extensions"],
  ["get", "/api/plugins/memory-providers", "List available memory providers"],
  ["get", "/api/plugins/companies/{companyId}/memory-provider", "Get the company memory provider"],
  ["put", "/api/plugins/companies/{companyId}/memory-provider", "Set the company memory provider"],
  ["get", "/api/plugins/companies/{companyId}/memory-provider/deliveries", "List memory-provider deliveries"],
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/tool-grants", "List plugin tool grants"],
  ["put", "/api/plugins/{pluginId}/companies/{companyId}/tool-grants/{agentId}", "Set an agent plugin tool grant"],
  ["get", "/api/plugins/{pluginId}/companies/{companyId}/tool-audit", "List plugin tool audit events"],
  ["get", "/api/plugins/registry/stages", "List staged registry plugins"],
  ["post", "/api/plugins/registry/stages", "Stage a registry plugin"],
  ["post", "/api/plugins/registry/stages/{stageId}/enable", "Enable a staged registry plugin"],
  ["get", "/api/plugins/{pluginId}/migration-plan", "Get a plugin database migration plan"],
  ["get", "/api/plugins/{pluginId}/pending-update", "Get a pending plugin update"],
] as const) {
  registerCurrentRoute({ method: route[0], path: route[1], tags: ["plugins"], summary: route[2] });
}

const marketplaceSearchQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  capability: z.string().optional(),
  limit: z.string().optional(),
});

const marketplaceMessageListQuerySchema = z.object({
  limit: z.string().optional(),
  after: z.string().optional(),
});

const marketplaceAssistantSessionSchema = z.object({
  agentId: z.string().uuid(),
});

const marketplaceAssistantMessageSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const marketplaceAssistantToolSchema = z.object({
  input: z.unknown(),
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/marketplace/plugins",
  tags: ["marketplace"],
  summary: "Search Marketplace plugins",
  query: marketplaceSearchQuerySchema,
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/marketplace/plugins/{pluginId}",
  tags: ["marketplace"],
  summary: "Get Marketplace plugin details",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/marketplace/assistant/agents",
  tags: ["marketplace"],
  summary: "List Agents available to Marketplace Assistant",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden },
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/marketplace/assistant/sessions",
  tags: ["marketplace"],
  summary: "Create or reuse a Marketplace Assistant session",
  body: marketplaceAssistantSessionSchema,
  responses: {
    201: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/marketplace/assistant/sessions/{sessionId}/messages",
  tags: ["marketplace"],
  summary: "List Marketplace Assistant messages",
  query: marketplaceMessageListQuerySchema,
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/marketplace/assistant/sessions/{sessionId}/messages",
  tags: ["marketplace"],
  summary: "Send a Marketplace Assistant message",
  body: marketplaceAssistantMessageSchema,
  responses: {
    202: { description: "Marketplace Assistant run queued" },
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
  },
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/marketplace/assistant/sessions/{sessionId}/close",
  tags: ["marketplace"],
  summary: "Close a Marketplace Assistant session",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/marketplace/assistant/tools/{toolName}",
  tags: ["marketplace"],
  summary: "Execute a scoped Marketplace Assistant tool",
  body: marketplaceAssistantToolSchema,
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

const pluginDependencyImpactQuerySchema = z.object({
  action: z.enum(["disable", "delete"]),
});

registerCurrentRoute({
  method: "get",
  path: "/api/plugins/{pluginId}/companies/{companyId}/dependencies",
  tags: ["plugins"],
  summary: "Get a plugin dependency report for a company",
  responses: { 200: r.ok(), 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "get",
  path: "/api/plugins/{pluginId}/dependency-impact",
  tags: ["plugins"],
  summary: "Preview the impact of disabling or deleting a plugin",
  query: pluginDependencyImpactQuerySchema,
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

registerCurrentRoute({
  method: "get",
  path: "/api/plugins/{pluginId}/diagnostics",
  tags: ["plugins"],
  summary: "Get canonical plugin diagnostics",
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    501: { description: "Canonical plugin diagnostics are unavailable" },
  },
});

registerCurrentRoute({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/runs/{runId}/cancel",
  tags: ["plugins"],
  summary: "Cancel a plugin job run",
  responses: {
    200: r.ok(),
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
    501: { description: "Job scheduling is not enabled" },
  },
});

registerCurrentRoute({
  method: "post",
  path: "/api/plugins/{pluginId}/jobs/{jobId}/runs/{runId}/retry",
  tags: ["plugins"],
  summary: "Retry a plugin job run",
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    403: r.forbidden,
    404: r.notFound,
    409: r.conflict,
    501: { description: "Job scheduling is not enabled" },
  },
});

registerCurrentRoute({
  method: "post",
  path: "/api/plugins/{pluginId}/worker/restart",
  tags: ["plugins"],
  summary: "Restart a plugin worker",
  responses: { 200: r.ok(), 400: r.badRequest, 401: r.unauthorized, 403: r.forbidden, 404: r.notFound },
});

const workspaceShellSelectionSchema = z.object({
  pluginId: z.string().uuid().nullable(),
  shellId: z.string().min(1).max(100).nullable().optional(),
});

const workspaceDashboardLayoutSchema = z.object({
  items: z.array(z.object({
    pluginId: z.string().uuid(),
    widgetId: z.string().min(1).max(100),
    size: z.enum(["small", "medium", "large", "full"]),
    position: z.number().int(),
    collapsed: z.boolean().optional(),
  })).max(200),
});

const workspaceInboxStateSchema = z.object({
  read: z.boolean().optional(),
  archived: z.boolean().optional(),
}).refine((value) => value.read !== undefined || value.archived !== undefined, {
  message: "At least one Inbox state field is required",
});

const workspaceInboxQuerySchema = z.object({
  archived: z.enum(["true", "false"]).optional(),
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/workspace-shell/providers",
  tags: ["workspace"],
  summary: "List workspace shell providers",
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/workspace-shell",
  tags: ["workspace"],
  summary: "Get the selected workspace shell",
});

registerCurrentRoute({
  method: "put",
  path: "/api/companies/{companyId}/workspace-shell",
  tags: ["workspace"],
  summary: "Select the workspace shell",
  body: workspaceShellSelectionSchema,
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/workspace-dashboard",
  tags: ["workspace"],
  summary: "Get the workspace dashboard",
});

registerCurrentRoute({
  method: "put",
  path: "/api/companies/{companyId}/workspace-dashboard/layout",
  tags: ["workspace"],
  summary: "Save the workspace dashboard layout",
  body: workspaceDashboardLayoutSchema,
});

registerCurrentRoute({
  method: "get",
  path: "/api/companies/{companyId}/workspace-inbox",
  tags: ["workspace"],
  summary: "List workspace Inbox items",
  query: workspaceInboxQuerySchema,
});

registerCurrentRoute({
  method: "patch",
  path: "/api/companies/{companyId}/workspace-inbox/{itemId}",
  tags: ["workspace"],
  summary: "Update a workspace Inbox item",
  body: workspaceInboxStateSchema,
});

registerCurrentRoute({
  method: "post",
  path: "/api/companies/{companyId}/workspace-inbox/{itemId}/actions/{actionId}",
  tags: ["workspace"],
  summary: "Perform a workspace Inbox action",
  responses: {
    200: r.ok(),
    400: r.badRequest,
    401: r.unauthorized,
    404: r.notFound,
    501: { description: "Plugin Inbox actions are unavailable" },
  },
});

for (const route of [
  ["get", "/api/companies/{companyId}/sps-members", "List SPS company members"],
  ["post", "/api/companies/{companyId}/sps-members/{memberId}/revoke", "Revoke an SPS company member"],
  ["get", "/api/companies/{companyId}/sps-nodes", "List SPS Nodes"],
  ["post", "/api/companies/{companyId}/sps-nodes", "Register an SPS Node"],
  ["post", "/api/sps-nodes/{nodeId}/heartbeat", "Send an SPS Node heartbeat"],
  ["post", "/api/sps-nodes/{nodeId}/runners/availability", "Report SPS Node runner availability"],
  ["post", "/api/sps-nodes/{nodeId}/approve", "Approve an SPS Node"],
  ["post", "/api/sps-nodes/{nodeId}/revoke", "Revoke an SPS Node"],
  ["post", "/api/sps-nodes/{nodeId}/disconnect", "Disconnect an SPS Node"],
  ["put", "/api/sps-nodes/{nodeId}/agent-grants/{agentId}", "Grant an agent access to an SPS Node"],
  ["delete", "/api/sps-nodes/{nodeId}/agent-grants/{agentId}", "Revoke an agent SPS Node grant"],
  ["put", "/api/sps-nodes/{nodeId}/runners/{runnerProfileId}/agent-grants/{agentId}", "Grant an agent access to an SPS Node runner"],
  ["delete", "/api/sps-nodes/{nodeId}/runners/{runnerProfileId}/agent-grants/{agentId}", "Revoke an agent SPS Node runner grant"],
  ["put", "/api/agents/{agentId}/sps-node-binding", "Bind an agent to an SPS Node"],
  ["delete", "/api/agents/{agentId}/sps-node-binding", "Remove an agent SPS Node binding"],
  ["get", "/api/projects/{projectId}/sps-host-share", "Get an SPS project host share"],
  ["put", "/api/projects/{projectId}/sps-host-share", "Set an SPS project host share"],
  ["put", "/api/projects/{projectId}/sps-host-share/nodes/{nodeId}", "Grant an SPS Node access to a project host share"],
  ["delete", "/api/projects/{projectId}/sps-host-share/nodes/{nodeId}", "Revoke an SPS Node project host share grant"],
  ["post", "/api/sps-nodes/{nodeId}/workspace-sources/{sourceId}/claim-route", "Claim an SPS workspace source route"],
  ["post", "/api/sps-nodes/{nodeId}/commands/claim-next", "Claim the next SPS Node command"],
  ["post", "/api/sps-nodes/{nodeId}/commands/{commandId}/lease", "Renew an SPS Node command lease"],
  ["post", "/api/sps-nodes/{nodeId}/commands/{commandId}/events", "Append SPS Node command events"],
  ["post", "/api/sps-nodes/{nodeId}/commands/{commandId}/complete", "Complete an SPS Node command"],
  ["post", "/api/sps-nodes/{nodeId}/plugin-runs/claim-next", "Claim the next SPS Node plugin run"],
  ["post", "/api/sps-nodes/{nodeId}/plugin-runs/{runId}/lease", "Renew an SPS Node plugin-run lease"],
  ["post", "/api/sps-nodes/{nodeId}/plugin-runs/{runId}/events", "Append SPS Node plugin-run events"],
  ["post", "/api/sps-nodes/{nodeId}/plugin-runs/{runId}/complete", "Complete an SPS Node plugin run"],
] as const) {
  registerCurrentRoute({ method: route[0], path: route[1], tags: ["sps-nodes"], summary: route[2] });
}

for (const route of [
  ["get", "/api/companies/{companyId}/sps-workspace-sources", "List SPS workspace sources"],
  ["post", "/api/companies/{companyId}/sps-workspace-sources", "Create an SPS workspace source"],
  ["patch", "/api/companies/{companyId}/sps-workspace-sources/{sourceId}", "Update an SPS workspace source"],
  ["delete", "/api/companies/{companyId}/sps-workspace-sources/{sourceId}", "Delete an SPS workspace source"],
  ["put", "/api/companies/{companyId}/sps-workspace-sources/{sourceId}/nodes/{nodeId}", "Grant an SPS Node workspace-source access"],
  ["delete", "/api/companies/{companyId}/sps-workspace-sources/{sourceId}/nodes/{nodeId}", "Revoke an SPS Node workspace-source grant"],
] as const) {
  registerCurrentRoute({
    method: route[0],
    path: route[1],
    tags: ["sps-workspace-sources"],
    summary: route[2],
  });
}

const spsWorkspaceParamsSchema = z.object({ companyId: z.string().uuid() });
const spsExecutionLaneSchema = z.enum(["node", "agent_session", "model_request"]);
const spsCanonicalTimestampSchema = z.string().datetime().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
const spsExecutionPluginQuerySchema = z.object({ pluginId: z.string().uuid() }).strict();
const spsExecutionHistoryQuerySchema = spsExecutionPluginQuerySchema.extend({
  limit: z.string().regex(/^(?:[1-9]\d?|100)$/).optional(),
  lane: spsExecutionLaneSchema.optional(),
  beforeCreatedAt: spsCanonicalTimestampSchema.optional(),
  beforeRunId: z.string().uuid().optional(),
  beforeLane: spsExecutionLaneSchema.optional(),
}).strict();
const spsExecutionSummaryQuerySchema = spsExecutionPluginQuerySchema.extend({
  from: spsCanonicalTimestampSchema,
  to: spsCanonicalTimestampSchema,
  lane: spsExecutionLaneSchema.optional(),
  agentId: z.string().uuid().optional(),
}).strict();
const spsExecutionCursorSchema = z.object({
  createdAt: spsCanonicalTimestampSchema,
  runId: z.string().uuid(),
  lane: spsExecutionLaneSchema,
}).strict();
const spsUsageMetricSchema = z.object({
  value: z.number().nonnegative().nullable(),
  provenance: z.enum(["reported", "estimated", "unavailable"]),
}).strict();
const spsExecutionMetadataSchema = z.object({
  lane: spsExecutionLaneSchema,
  runId: z.string().uuid(),
  companyId: z.string().uuid(),
  pluginKey: z.string(),
  agentId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  subjectKey: z.string().nullable(),
  runtime: z.object({ kind: z.string().nullable(), model: z.string().nullable(), modelSource: z.enum(["reported", "configured", "unavailable"]) }).strict(),
  status: z.string(),
  phase: z.enum(["queued", "active", "stopping", "succeeded", "failed", "cancelled", "interrupted", "unknown"]),
  cancellationRequested: z.boolean(),
  termination: z.enum(["not_applicable", "pending", "confirmed"]),
  failure: z.object({
    category: z.enum(["authorization", "configuration", "provider_limit", "timeout", "cancelled", "execution", "unknown"]),
    code: z.string().nullable(),
    retrySafety: z.literal("requires_review"),
  }).strict().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  usage: z.object({
    inputTokens: spsUsageMetricSchema,
    cachedInputTokens: spsUsageMetricSchema,
    outputTokens: spsUsageMetricSchema,
    costUsd: spsUsageMetricSchema,
    currency: z.literal("USD").nullable(),
    billingType: z.enum(["metered_api", "subscription_included", "subscription_overage", "credits", "fixed", "unknown"]),
    costBasis: z.enum(["incremental_api", "subscription_reference", "unknown"]),
  }).strict(),
}).strict();
const spsUsageAggregateSchema = z.object({
  reported: z.number().nonnegative().nullable(), estimated: z.number().nonnegative().nullable(),
  reportedExecutions: z.number().int().nonnegative(), estimatedExecutions: z.number().int().nonnegative(),
  unavailableExecutions: z.number().int().nonnegative(), overflowed: z.boolean(),
}).strict();
const spsExecutionSummarySchema = z.object({
  companyId: z.string().uuid(), pluginKey: z.string(),
  window: z.object({ from: spsCanonicalTimestampSchema, to: spsCanonicalTimestampSchema }).strict(),
  generatedAt: z.string().datetime(), executionCount: z.number().int().nonnegative(), terminalCount: z.number().int().nonnegative(),
  inFlightCount: z.number().int().nonnegative(), unknownPhaseCount: z.number().int().nonnegative(),
  tokens: z.object({ inputTokens: spsUsageAggregateSchema, cachedInputTokens: spsUsageAggregateSchema, outputTokens: spsUsageAggregateSchema }).strict(),
  costs: z.object({ currency: z.literal("USD"), incrementalApi: spsUsageAggregateSchema, subscriptionReference: spsUsageAggregateSchema, other: spsUsageAggregateSchema }).strict(),
  duration: z.object({ totalMs: z.number().int().nonnegative().nullable(), knownExecutions: z.number().int().nonnegative(), unavailableExecutions: z.number().int().nonnegative(), overflowed: z.boolean() }).strict(),
}).strict();
const spsModelConnectionRecordSchema = z.object({
  id: z.string().uuid(), companyId: z.string().uuid(), displayName: z.string(), protocol: z.literal("responses_text_v1"),
  endpoint: z.string(), model: z.string(), secretId: z.string().uuid().nullable(), versionSelector: z.string(),
  status: z.enum(["active", "disabled"]), allowLoopbackHttp: z.boolean(),
  timeoutMs: z.number().int(), maxOutputTokens: z.number().int(), maxRequestBytes: z.number().int(),
  maxResponseBytes: z.number().int(), maxConcurrentRequests: z.number().int(),
  createdByUserId: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
const spsModelGrantRecordSchema = z.object({
  id: z.string().uuid(), companyId: z.string().uuid(), pluginId: z.string().uuid(), connectionId: z.string().uuid(),
  bindingId: z.string().uuid().nullable(), revision: z.number().int().positive(), status: z.enum(["active", "revoked"]),
  revokedAt: z.string().datetime().nullable(), createdByUserId: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
const noStoreResponse = (response: OpenApiResponse): OpenApiResponse => ({
  ...response,
  headers: { "Cache-Control": { description: "This response is not cached.", schema: { type: "string", enum: ["no-store"] } } },
});

registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-executions", tags: ["sps-executions"],
  summary: "List Plugin execution metadata", params: spsWorkspaceParamsSchema, query: spsExecutionHistoryQuerySchema,
  description: "The required pluginId is the installed registry UUID, not a Plugin key. Returns safe metadata across node, agent_session and model_request lanes, including disabled Plugin history; no raw input, output, paths or credentials. Newest-first pages default to 20 items (1..100). Supply all three beforeCreatedAt/beforeRunId/beforeLane cursor fields together or omit all three. Unknown query parameters are rejected.",
  responses: { 200: noStoreResponse(r.ok(z.object({ items: z.array(spsExecutionMetadataSchema), nextCursor: spsExecutionCursorSchema.nullable() }).strict())), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});
registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-executions/summary", tags: ["sps-executions"],
  summary: "Summarize Plugin execution usage", params: spsWorkspaceParamsSchema, query: spsExecutionSummaryQuerySchema,
  description: "The required pluginId is the installed registry UUID. Uses a canonical UTC millisecond createdAt window [from, to), greater than zero and at most 31 days. agentId is invalid with node or model_request lanes. More than 10000 executions returns 422, never partial totals. Usage provenance and billing bases stay separate; this is not a provider invoice. Unknown query parameters are rejected.",
  responses: { 200: noStoreResponse(r.ok(spsExecutionSummarySchema)), 400: r.badRequest, 403: r.forbidden, 404: r.notFound, 422: r.unprocessable },
});
registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-executions/{lane}/{runId}", tags: ["sps-executions"],
  summary: "Get Plugin execution metadata",
  params: spsWorkspaceParamsSchema.extend({ lane: spsExecutionLaneSchema, runId: z.string().uuid() }),
  query: spsExecutionPluginQuerySchema,
  description: "Reads one Workspace- and registry-Plugin-scoped execution, including the model_request lane. Returns safe technical metadata, not raw model input/output, endpoint configuration or credentials. Only the pluginId query parameter is accepted.",
  responses: { 200: noStoreResponse(r.ok(spsExecutionMetadataSchema)), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});
registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-model-connections", tags: ["sps-model-connections"],
  summary: "List Host model connections", params: spsWorkspaceParamsSchema,
  description: "Lists at most 100 Host configuration records for this Workspace, including endpoint and Secret references but never credential values. No query parameters are accepted.",
  responses: { 200: noStoreResponse(r.ok(z.array(spsModelConnectionRecordSchema))), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});
registerCurrentRoute({
  method: "post", path: "/api/companies/{companyId}/sps-model-connections", tags: ["sps-model-connections"],
  summary: "Create an immutable Host model connection", params: spsWorkspaceParamsSchema, body: createSpsModelConnectionSchema,
  description: "Persists an immutable Host-selected endpoint/model and company-scoped active Secret reference. HTTPS is required except for explicit loopback HTTP opt-in; localhost is pinned to 127.0.0.1. The selected Secret version and combined buffer/concurrency budget are also validated. Does not dispatch a model request. No query parameters are accepted.",
  responses: { 201: noStoreResponse(r.ok(spsModelConnectionRecordSchema)), 400: r.badRequest, 403: r.forbidden, 422: r.unprocessable },
});
registerCurrentRoute({
  method: "patch", path: "/api/companies/{companyId}/sps-model-connections/{connectionId}", tags: ["sps-model-connections"],
  summary: "Set model connection status", params: spsWorkspaceParamsSchema.extend({ connectionId: z.string().uuid() }), body: updateSpsModelConnectionStatusSchema,
  description: "Changes only active/disabled status, not immutable configuration. Disabling revokes grants; re-enabling does not silently reactivate them. No query parameters are accepted.",
  responses: { 200: noStoreResponse(r.ok(spsModelConnectionRecordSchema)), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});
registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-model-connections/{connectionId}/grants", tags: ["sps-model-connections"],
  summary: "List model connection grants", params: spsWorkspaceParamsSchema.extend({ connectionId: z.string().uuid() }),
  description: "Lists at most 100 Workspace-scoped grant records, including revoked grants. No query parameters are accepted.",
  responses: { 200: noStoreResponse(r.ok(z.array(spsModelGrantRecordSchema))), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});
registerCurrentRoute({
  method: "post", path: "/api/companies/{companyId}/sps-model-connections/{connectionId}/grants", tags: ["sps-model-connections"],
  summary: "Approve a Plugin instance for a model connection", params: spsWorkspaceParamsSchema.extend({ connectionId: z.string().uuid() }), body: grantSpsModelConnectionSchema,
  description: "pluginId is the installed registry UUID. Reuses an unchanged active grant; reapproval after revocation increments its revision. Checks current Workspace, Plugin capability/activation/dependencies and Secret availability, and creates the exact Plugin credential binding. No query parameters are accepted.",
  responses: { 201: noStoreResponse(r.ok(spsModelGrantRecordSchema)), 400: r.badRequest, 403: r.forbidden, 422: r.unprocessable },
});
registry.registerPath({
  method: "post", path: "/api/companies/{companyId}/sps-model-grants/{grantId}/revoke", tags: ["sps-model-connections"],
  summary: "Revoke a model connection grant",
  description: "Revokes the Workspace-scoped grant and deletes only its own binding. The body may be omitted or an empty object; fields and query parameters are rejected. This does not prove upstream work terminated.",
  request: {
    params: spsWorkspaceParamsSchema.extend({ grantId: z.string().uuid() }),
    body: { ...jsonBody(z.object({}).strict()), required: false },
  },
  responses: { 204: noStoreResponse(r.noContent), 400: r.badRequest, 403: r.forbidden, 404: r.notFound },
});

const memberDeviceSchema = z.object({
  id: z.string().uuid(), hostId: z.string().uuid(), ownerUserId: z.string(), displayName: z.string(),
  certificateSha256: z.string(), spkiSha256: z.string(), status: z.enum(["pending", "approved", "revoked"]),
  revision: z.number().int().positive(), certificateNotBefore: z.string(), certificateNotAfter: z.string(),
  approvedAt: z.string().nullable(), approvedByUserId: z.string().nullable(), revokedAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
const memberDeviceEventSchema = z.object({
  id: z.string().uuid(), hostId: z.string().uuid(), deviceId: z.string().uuid().nullable(),
  deviceSnapshotId: z.string().uuid(), ownerUserId: z.string(), actorUserId: z.string(),
  action: z.enum(["request", "approved", "revoked"]), revision: z.number().int().positive(), createdAt: z.string(),
}).strict();
const nativeDeviceDescription = "Optional Native Core management contract. Product startup mounts nativeConnectivityManagement only for the prepared Host identity, owned Main IPC binding and exact current SPS Identity Owner session; nativeConnectivityHostId alone is retained for explicit legacy composition. No LAN listener, device TLS handshake, Node grant or Plugin SDK method is created by this endpoint. Unknown query/body fields are rejected; raw certificates and private keys are absent from responses.";
const nativePairingSchema = z.object({
  id: z.string().uuid(), status: z.enum(["pending", "expired", "identity_changed", "consumed", "revoked", "exhausted"]),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), failedAttempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(), issuedByUserId: z.string(), consumedByUserId: z.string().nullable(),
  consumedDeviceSnapshotId: z.string().uuid().nullable(), target: z.enum(["any_verified_user", "verified_email"]),
}).strict();
const nativePairingDescription = `${nativeDeviceDescription} Invitation management is available only from the local Desktop Host with a current Owner SPS Identity session. Invitations expire after one hour, allow five attempts and are capped at ten active invitations. Listing and revocation never return invitation secrets.`;
registerCurrentRoute({
  method: "get", path: "/api/sps/native-pairings", tags: ["sps-native-pairings"],
  summary: "List local Host invitations", description: nativePairingDescription,
  responses: { 200: noStoreResponse(r.ok(z.array(nativePairingSchema))), 400: r.badRequest, 403: r.forbidden, 503: { description: "Native Host pairing state is unavailable." } },
});
registerCurrentRoute({
  method: "post", path: "/api/sps/native-pairings", tags: ["sps-native-pairings"],
  summary: "Create a local Host invitation", description: `${nativePairingDescription} The one-time secret appears only in this response and is not stored or returned by later reads.`,
  body: z.object({}).strict(),
  responses: { 201: noStoreResponse(r.ok(z.object({ pairingId: z.string().uuid(), pairingSecret: z.string().min(32).max(128), issuedAt: z.number().int(), expiresAt: z.number().int() }).strict())),
    400: r.badRequest, 403: r.forbidden, 409: r.conflict, 503: { description: "Invitation state or one-time result delivery is unavailable." } },
});
registerCurrentRoute({
  method: "post", path: "/api/sps/native-pairings/{pairingId}/revoke", tags: ["sps-native-pairings"],
  summary: "Revoke a local Host invitation", params: z.object({ pairingId: z.string().uuid() }), body: z.object({}).strict(),
  description: `${nativePairingDescription} Revocation is terminal.`,
  responses: { 200: noStoreResponse(r.ok(nativePairingSchema)), 400: r.badRequest, 403: r.forbidden, 503: { description: "Native Host pairing state is unavailable." } },
});
registerCurrentRoute({
  method: "get", path: "/api/sps/member-devices/status", tags: ["sps-member-devices"],
  summary: "Read the prepared local Native Host binding",
  description: `${nativeDeviceDescription} Requires both direct-loopback Desktop Host proofs and the startup-bound Owner's real SPS Identity cookie session, with no Authorization header. A Board session is not a substitute. Returns only the public Host ID and server SPKI pin; no Workspace membership is needed. Legacy composition without nativeConnectivityManagement returns 503.`,
  responses: {
    200: noStoreResponse(r.ok(z.object({ hostId: z.string().uuid(), serverSpkiSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())),
    400: r.badRequest, 403: r.forbidden,
    503: { description: "Native Host management is unavailable." },
  },
});
registerCurrentRoute({
  method: "get", path: "/api/sps/member-devices", tags: ["sps-member-devices"],
  summary: "List Host Member devices", description: `${nativeDeviceDescription} Requires a real user session and both direct-loopback Desktop Host proofs. Returns at most 200 records.`,
  responses: { 200: noStoreResponse(r.ok(z.array(memberDeviceSchema))), 400: r.badRequest, 403: r.forbidden },
});
registerCurrentRoute({
  method: "get", path: "/api/sps/member-devices/{deviceId}/events", tags: ["sps-member-devices"],
  summary: "List Member device security history", params: z.object({ deviceId: z.string().uuid() }),
  description: `${nativeDeviceDescription} Host-only read of at most 200 non-authorizing history records.`,
  responses: { 200: noStoreResponse(r.ok(z.array(memberDeviceEventSchema))), 400: r.badRequest, 403: r.forbidden },
});
for (const action of ["approve", "revoke"] as const) {
  registry.registerPath({
    method: "post", path: `/api/sps/member-devices/{deviceId}/${action}`, tags: ["sps-member-devices"],
    summary: action === "approve" ? "Approve a pending Member device" : "Revoke a Member device",
    description: `${nativeDeviceDescription} Host-only; API keys and legacy implicit/admin authority are insufficient. Revocation is terminal for this key. Body may be omitted or an empty object; no fields are accepted.`,
    request: { params: z.object({ deviceId: z.string().uuid() }), body: { ...jsonBody(z.object({}).strict()), required: false } },
    responses: { 200: noStoreResponse(r.ok(memberDeviceSchema)), 400: r.badRequest, 403: r.forbidden, 404: r.notFound, 409: r.conflict },
  });
}
registerCurrentRoute({
  method: "get", path: "/api/companies/{companyId}/sps-member-device-requests", tags: ["sps-member-devices"],
  summary: "List the signed-in user's devices", params: spsWorkspaceParamsSchema,
  description: `${nativeDeviceDescription} Requires current active Workspace membership, returns only this user's Host-scoped devices, at most 200 records.`,
  responses: { 200: noStoreResponse(r.ok(z.array(memberDeviceSchema))), 400: r.badRequest, 403: r.forbidden },
});
registerCurrentRoute({
  method: "post", path: "/api/companies/{companyId}/sps-member-device-requests", tags: ["sps-member-devices"],
  summary: "Request registration of a Member device", params: spsWorkspaceParamsSchema, body: createSpsMemberDeviceRequestSchema,
  description: `${nativeDeviceDescription} Authenticated member self-registration creates pending only, not TLS proof or approval. Immutable certificate/key, no owner/Host/status override; a revoked key is not revived. Native TLS enrollment must complete through the explicitly configured Desktop Main TLS ingress.`,
  responses: { 201: noStoreResponse(r.ok(memberDeviceSchema)), 400: r.badRequest, 403: r.forbidden, 409: r.conflict },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenApiDocument(): any {
  return applyDocumentFixups({
    openapi: "3.0.0",
    info: {
      title: "Paperclip API",
      version: "1.0.0",
      description: "REST API for the Paperclip AI agent management platform",
    },
    servers: [{ url: "/" }],
    components: registry.buildComponents(),
    paths: registry.buildPaths(),
  });
}

export const buildOpenApiSpec = buildOpenApiDocument;

export function openApiRoutes() {
  const router = Router();
  router.get("/openapi.json", (_req, res) => {
    res.json(buildOpenApiDocument());
  });
  return router;
}
