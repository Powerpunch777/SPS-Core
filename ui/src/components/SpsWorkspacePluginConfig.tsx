import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@/compat/paperclip/shared";
import { ApiError } from "@/api/client";
import {
  spsWorkspacePluginConfigApi,
  type SpsWorkspacePluginRuntimeConfigRecord,
} from "@/api/sps-workspace-plugin-config";
import {
  getDefaultValues,
  JsonSchemaForm,
  validateJsonSchemaForm,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface SpsWorkspacePluginConfigProps {
  plugin: PluginRecord;
  workspaceId: string;
}

interface WorkspacePluginManifestConfig {
  entrypoints?: { workspaceWorker?: unknown };
  workspaceConfigSchema?: unknown;
}

interface DraftState {
  targetKey: string;
  targetGeneration: number;
  revision: string | null;
  baseConfig: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface RecoveryState {
  targetKey: string;
  targetGeneration: number;
  reconciling: boolean;
  failed: boolean;
  reloadRequired: boolean;
}

const DEFAULT_SCHEMA: JsonSchemaNode = Object.freeze({
  type: "object",
  properties: {},
  additionalProperties: false,
});
const QUERY_PREFIX = ["sps-workspace-plugin-runtime-config"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainJsonObject(value: unknown, ancestors = new Set<object>()): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors));
  });
  ancestors.delete(value);
  return valid;
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || ancestors.has(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => key !== "length"
      && (!/^(?:0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= value.length))) return false;
    ancestors.add(value);
    const valid = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return Boolean(descriptor?.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors));
    }).every(Boolean);
    ancestors.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors));
  });
  ancestors.delete(value);
  return valid;
}

function containsSensitiveField(schema: JsonSchemaNode): boolean {
  if (schema.format === "secret-ref" || schema.format === "password" || schema.writeOnly === true) return true;
  for (const property of Object.values(schema.properties ?? {})) {
    if (containsSensitiveField(property)) return true;
  }
  if (schema.items && containsSensitiveField(schema.items)) return true;
  if (isRecord(schema.additionalProperties) && containsSensitiveField(schema.additionalProperties as JsonSchemaNode)) return true;
  return false;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function mergeSchemaDefaults(schema: JsonSchemaNode, config: Record<string, unknown>) {
  return { ...getDefaultValues(schema), ...config };
}

function validateRecord(
  value: SpsWorkspacePluginRuntimeConfigRecord,
  pluginId: string,
  workspaceId: string,
) {
  if (value.pluginId !== pluginId || value.workspaceId !== workspaceId || !isPlainJsonObject(value.configJson)
    || (value.revision !== null && typeof value.revision !== "string")
    || (value.updatedAt !== null && typeof value.updatedAt !== "string")) {
    throw new Error("Workspace configuration response did not match the selected workspace.");
  }
  return value;
}

function safeWriteError(error: unknown, action: "save" | "reset") {
  if (error instanceof ApiError && error.status === 403) {
    return "Only the SPS Host can change workspace configuration. Connect to the Host to continue.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return "Workspace configuration changed. Your draft is preserved; reload to see current settings before making another change.";
  }
  if (error instanceof ApiError && error.status === 503) {
    return "The result could not be confirmed. Your draft is preserved; reload current settings before making another change.";
  }
  return action === "save"
    ? "Workspace configuration could not be saved. Your draft is preserved; reload current settings before trying again."
    : "Workspace configuration could not be reset. Reload current settings before trying again.";
}

export function SpsWorkspacePluginConfig({ plugin, workspaceId }: SpsWorkspacePluginConfigProps) {
  const manifest = plugin.manifestJson as unknown as WorkspacePluginManifestConfig;
  const pluginId = plugin.id;
  const targetKey = JSON.stringify([pluginId, workspaceId]);
  const targetIdentityRef = useRef({ targetKey, generation: 0 });
  if (targetIdentityRef.current.targetKey !== targetKey) {
    targetIdentityRef.current = {
      targetKey,
      generation: targetIdentityRef.current.generation + 1,
    };
  }
  const targetGeneration = targetIdentityRef.current.generation;
  const isCurrentTarget = (key: string, generation: number) =>
    targetIdentityRef.current.targetKey === key && targetIdentityRef.current.generation === generation;
  const queryClient = useQueryClient();
  const queryKey = [...QUERY_PREFIX, pluginId, workspaceId] as const;
  const workspaceWorkerDeclared = typeof manifest.entrypoints?.workspaceWorker === "string"
    && manifest.entrypoints.workspaceWorker.length > 0;
  const rawSchema = manifest.workspaceConfigSchema;
  const schemaValid = rawSchema === undefined || (isPlainJsonObject(rawSchema) && rawSchema.type === "object");
  const schema = useMemo<JsonSchemaNode>(() =>
    schemaValid && isPlainJsonObject(rawSchema) ? rawSchema as JsonSchemaNode : DEFAULT_SCHEMA,
  [rawSchema, schemaValid]);
  const sensitiveSchema = schemaValid && containsSensitiveField(schema);
  const schemaError = !schemaValid
    ? "This plugin has an unsupported workspace configuration form."
    : sensitiveSchema
      ? "This configuration includes secret fields and cannot be edited here."
      : null;

  const loadConfig = async (
    loadPluginId: string,
    loadWorkspaceId: string,
    signal?: AbortSignal,
  ) => validateRecord(
    await spsWorkspacePluginConfigApi.get(loadPluginId, loadWorkspaceId, { signal }),
    loadPluginId,
    loadWorkspaceId,
  );
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => loadConfig(pluginId, workspaceId, signal),
    enabled: workspaceWorkerDeclared && Boolean(pluginId) && Boolean(workspaceId),
    retry: false,
  });

  useEffect(() => {
    const observedQueryKey = [...QUERY_PREFIX, pluginId, workspaceId] as const;
    return () => {
      void queryClient.cancelQueries({ queryKey: observedQueryKey, exact: true });
    };
  }, [queryClient, pluginId, workspaceId]);

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const currentRecovery = recovery?.targetKey === targetKey && recovery.targetGeneration === targetGeneration
    ? recovery
    : null;

  useEffect(() => {
    setFieldErrors({});
    setNotice(null);
    setRecovery(null);
  }, [targetKey]);

  useEffect(() => {
    const record = query.data;
    if (!record) return;
    const freshConfig = mergeSchemaDefaults(schema, record.configJson);
    setDraft((current) => {
      if (current?.targetKey === targetKey && current.targetGeneration === targetGeneration) {
        const hasLocalEdits = stableJson(current.config) !== stableJson(current.baseConfig);
        if (hasLocalEdits && current.revision !== record.revision) return current;
        if (current.revision === record.revision) return current;
      }
      return {
        targetKey,
        targetGeneration,
        revision: record.revision,
        baseConfig: freshConfig,
        config: freshConfig,
      };
    });
  }, [query.data, schema, targetKey, targetGeneration]);

  const activeDraft = draft?.targetKey === targetKey && draft.targetGeneration === targetGeneration ? draft : null;
  const record = query.data;
  const isDirty = Boolean(activeDraft && stableJson(activeDraft.config) !== stableJson(activeDraft.baseConfig));
  const observedRevisionChanged = Boolean(isDirty && activeDraft && record && activeDraft.revision !== record.revision);
  const reloadRequired = Boolean(currentRecovery?.reloadRequired || observedRevisionChanged);
  const hasEditableFields = Object.keys(schema.properties ?? {}).length > 0;
  const hostDenied = query.error instanceof ApiError && query.error.status === 403;

  const reconcileAfterWrite = async (
    error: unknown,
    action: "save" | "reset",
    variables: { targetKey: string; targetGeneration: number; pluginId: string; workspaceId: string },
  ) => {
    const matchesTarget = () => isCurrentTarget(variables.targetKey, variables.targetGeneration);
    const variablesQueryKey = [...QUERY_PREFIX, variables.pluginId, variables.workspaceId] as const;
    if (!matchesTarget()) {
      void queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true });
      return;
    }
    setNotice(safeWriteError(error, action));
    setRecovery({
      targetKey: variables.targetKey,
      targetGeneration: variables.targetGeneration,
      reconciling: true,
      failed: false,
      reloadRequired: true,
    });
    try {
      await queryClient.cancelQueries({ queryKey: variablesQueryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true, refetchType: "none" });
      await queryClient.fetchQuery({
        queryKey: variablesQueryKey,
        queryFn: ({ signal }) => loadConfig(variables.pluginId, variables.workspaceId, signal),
        staleTime: 0,
        retry: false,
      });
      if (matchesTarget()) {
        setRecovery({
          targetKey: variables.targetKey,
          targetGeneration: variables.targetGeneration,
          reconciling: false,
          failed: false,
          reloadRequired: true,
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true });
      }
    } catch {
      if (matchesTarget()) {
        setRecovery({
          targetKey: variables.targetKey,
          targetGeneration: variables.targetGeneration,
          reconciling: false,
          failed: true,
          reloadRequired: true,
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true });
      }
    } finally {
      if (matchesTarget()) {
        setRecovery((current) => current?.targetGeneration === variables.targetGeneration
          ? { ...current, reconciling: false }
          : current);
      }
    }
  };

  const saveMutation = useMutation({
    mutationFn: async (variables: {
      targetKey: string;
      targetGeneration: number;
      pluginId: string;
      workspaceId: string;
      configJson: Record<string, unknown>;
      expectedRevision: string | null;
    }) => {
      if (!isCurrentTarget(variables.targetKey, variables.targetGeneration)) throw new Error("Workspace changed before the save started.");
      return validateRecord(await spsWorkspacePluginConfigApi.put(variables.pluginId, variables.workspaceId, {
        configJson: variables.configJson,
        expectedRevision: variables.expectedRevision,
      }), variables.pluginId, variables.workspaceId);
    },
    onSuccess: (updated, variables) => {
      const variablesQueryKey = [...QUERY_PREFIX, variables.pluginId, variables.workspaceId] as const;
      if (!isCurrentTarget(variables.targetKey, variables.targetGeneration)) {
        void queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true });
        return;
      }
      const config = mergeSchemaDefaults(schema, updated.configJson);
      queryClient.setQueryData(variablesQueryKey, updated);
      setDraft({ targetKey: variables.targetKey, targetGeneration: variables.targetGeneration, revision: updated.revision, baseConfig: config, config });
      setFieldErrors({});
      setNotice("Workspace configuration saved.");
      setRecovery(null);
    },
    onError: (error, variables) => reconcileAfterWrite(error, "save", variables),
    retry: false,
  });

  const resetMutation = useMutation({
    mutationFn: async (variables: { targetKey: string; targetGeneration: number; pluginId: string; workspaceId: string; expectedRevision: string | null }) => {
      if (!isCurrentTarget(variables.targetKey, variables.targetGeneration)) throw new Error("Workspace changed before the reset started.");
      return validateRecord(
        await spsWorkspacePluginConfigApi.reset(variables.pluginId, variables.workspaceId, variables.expectedRevision),
        variables.pluginId,
        variables.workspaceId,
      );
    },
    onSuccess: (updated, variables) => {
      const variablesQueryKey = [...QUERY_PREFIX, variables.pluginId, variables.workspaceId] as const;
      if (!isCurrentTarget(variables.targetKey, variables.targetGeneration)) {
        void queryClient.invalidateQueries({ queryKey: variablesQueryKey, exact: true });
        return;
      }
      const config = mergeSchemaDefaults(schema, updated.configJson);
      queryClient.setQueryData(variablesQueryKey, updated);
      setDraft({ targetKey: variables.targetKey, targetGeneration: variables.targetGeneration, revision: updated.revision, baseConfig: config, config });
      setFieldErrors({});
      setNotice("Workspace configuration reset.");
      setRecovery(null);
    },
    onError: (error, variables) => reconcileAfterWrite(error, "reset", variables),
    retry: false,
  });

  const reloadCurrent = async () => {
    const reloadTargetKey = targetKey;
    const reloadGeneration = targetGeneration;
    const reloadPluginId = pluginId;
    const reloadWorkspaceId = workspaceId;
    const reloadQueryKey = [...QUERY_PREFIX, reloadPluginId, reloadWorkspaceId] as const;
    if (!isCurrentTarget(reloadTargetKey, reloadGeneration) || hostDenied
      || saveMutation.isPending || resetMutation.isPending) return;
    setRecovery({
      targetKey: reloadTargetKey,
      targetGeneration: reloadGeneration,
      reconciling: true,
      failed: false,
      reloadRequired: true,
    });
    try {
      await queryClient.cancelQueries({ queryKey: reloadQueryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey: reloadQueryKey, exact: true, refetchType: "none" });
      const refreshed = await queryClient.fetchQuery({
        queryKey: reloadQueryKey,
        queryFn: ({ signal }) => loadConfig(reloadPluginId, reloadWorkspaceId, signal),
        staleTime: 0,
        retry: false,
      });
      if (!isCurrentTarget(reloadTargetKey, reloadGeneration)) {
        void queryClient.invalidateQueries({ queryKey: reloadQueryKey, exact: true });
        return;
      }
      const config = mergeSchemaDefaults(schema, refreshed.configJson);
      setDraft({ targetKey: reloadTargetKey, targetGeneration: reloadGeneration,
        revision: refreshed.revision, baseConfig: config, config });
      setFieldErrors({});
      setNotice("Current workspace configuration reloaded. The previous draft was discarded.");
      setRecovery(null);
    } catch {
      if (isCurrentTarget(reloadTargetKey, reloadGeneration)) {
        setRecovery({
          targetKey: reloadTargetKey,
          targetGeneration: reloadGeneration,
          reconciling: false,
          failed: true,
          reloadRequired: true,
        });
        setNotice("Workspace configuration could not be reloaded. This panel remains read-only until it can be checked.");
      } else {
        void queryClient.invalidateQueries({ queryKey: reloadQueryKey, exact: true });
      }
    } finally {
      if (isCurrentTarget(reloadTargetKey, reloadGeneration)) {
        setRecovery((current) => current?.targetGeneration === reloadGeneration
          ? { ...current, reconciling: false }
          : current);
      }
    }
  };

  if (!workspaceWorkerDeclared) return null;

  const controlsBlocked = query.isPending || query.isError || query.isFetching || !record || hostDenied
    || Boolean(currentRecovery?.reconciling) || Boolean(currentRecovery?.failed) || reloadRequired
    || saveMutation.isPending || resetMutation.isPending || Boolean(schemaError);
  const canSave = !controlsBlocked && hasEditableFields && Boolean(activeDraft) && isDirty
    && !Object.keys(validateJsonSchemaForm(schema, activeDraft?.config ?? {})).length;

  const save = () => {
    if (!canSave || !record || !activeDraft || activeDraft.targetKey !== targetKey) return;
    const errors = validateJsonSchemaForm(schema, activeDraft.config);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setNotice(null);
    saveMutation.mutate({
      targetKey,
      targetGeneration,
      pluginId,
      workspaceId,
      configJson: activeDraft.config,
      expectedRevision: record.revision,
    });
  };

  const reset = () => {
    if (controlsBlocked || !record) return;
    setNotice(null);
    resetMutation.mutate({ targetKey, targetGeneration, pluginId, workspaceId, expectedRevision: record.revision });
  };

  return (
    <Card data-testid="sps-workspace-plugin-config">
      <CardHeader>
        <CardTitle>Workspace configuration</CardTitle>
        <CardDescription>
          These settings apply only to this workspace and are stored by the SPS Host. They are separate from global plugin settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">Loading workspace configuration…</p>
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {hostDenied
              ? "Workspace configuration is available only from the SPS Host. Connect to the Host to view or change these settings."
              : "Workspace configuration could not be loaded. Reopen this panel after checking the Host connection."}
          </p>
        ) : schemaError ? (
          <p className="text-sm text-muted-foreground" role="status">{schemaError}</p>
        ) : (
          <>
            {observedRevisionChanged && (
              <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground" role="status">
                Workspace configuration changed since this draft was loaded. Your draft is preserved; reload to discard it and see the current settings.
              </p>
            )}
            {currentRecovery?.reconciling && (
              <p className="text-xs text-muted-foreground" role="status">Checking the current workspace configuration…</p>
            )}
            {currentRecovery?.failed && (
              <p className="text-sm text-destructive" role="alert">
                The Host response could not be confirmed. Reload current settings before changing anything.
              </p>
            )}
            {hasEditableFields ? (
              <JsonSchemaForm
                schema={schema}
                values={activeDraft?.config ?? mergeSchemaDefaults(schema, record!.configJson)}
                onChange={(config) => {
                  if (!activeDraft || activeDraft.targetKey !== targetKey) return;
                  setDraft({ ...activeDraft, config });
                  setFieldErrors({});
                  setNotice(null);
                }}
                errors={fieldErrors}
                disabled={controlsBlocked || !activeDraft}
              />
            ) : (
              <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                This plugin has no workspace-specific fields to configure.
              </p>
            )}
            {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
          {reloadRequired && (
            <Button
              type="button"
              variant="outline"
              onClick={reloadCurrent}
              disabled={Boolean(currentRecovery?.reconciling) || query.isFetching || hostDenied
                || saveMutation.isPending || resetMutation.isPending}
            >
              {currentRecovery?.reconciling ? "Reloading…" : "Reload workspace configuration"}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={reset} disabled={controlsBlocked}>
            {resetMutation.isPending ? "Resetting…" : "Reset"}
          </Button>
          <Button type="button" onClick={save} disabled={!canSave}>
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
