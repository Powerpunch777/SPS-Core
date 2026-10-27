import { useCallback, useEffect, useMemo, useState } from "react";
import type { NativePluginContext, SpsNativePluginBridge } from "../native-plugin-bridge";

type BridgeError = Readonly<{ code: string; message: string }>;

function unavailableFeature(name: string): never {
  throw Object.assign(new Error(`The Native Plugin renderer does not provide ${name}.`), {
    code: "SPS_NATIVE_PLUGIN_UNSUPPORTED",
  });
}

export function useNativePluginData<TData = unknown>(bridge: SpsNativePluginBridge, key: string, params?: Record<string, unknown>) {
  const paramsText = useMemo(() => {
    try { return JSON.stringify(params ?? {}) ?? "{}"; }
    catch { return ""; }
  }, [params]);
  const [data, setData] = useState<TData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BridgeError | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(paramsText);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      parsed = value as Record<string, unknown>;
    } catch {
      setData(null);
      setError({ code: "SPS_NATIVE_PLUGIN_INVALID_PARAMS", message: "Plugin request parameters are invalid." });
      setLoading(false);
      return () => { current = false; };
    }
    void bridge.getData(key, parsed).then(result => {
      if (!current) return;
      setData(result.data as TData);
      setError(null);
    }).catch(() => {
      if (current) {
        setData(null);
        setError({ code: "SPS_NATIVE_PLUGIN_DATA_FAILED", message: "Plugin data could not be loaded." });
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [bridge, generation, key, paramsText]);
  return { data, loading, error, refresh };
}

export function createNativePluginSdk(bridge: SpsNativePluginBridge, context: NativePluginContext, reactModule: object, reactDomModule: object) {
  function usePluginData<TData = unknown>(key: string, params?: Record<string, unknown>) {
    return useNativePluginData<TData>(bridge, key, params);
  }
  function usePluginAction<TParams extends Record<string, unknown> = Record<string, unknown>, TResult = unknown>(key: string) {
    return useCallback(async (params?: TParams): Promise<TResult> => {
      const result = await bridge.performAction(key, params);
      return result.data as TResult;
    }, [bridge, key]);
  }
  return Object.freeze({
    react: reactModule,
    reactDom: reactDomModule,
    sdkUi: Object.freeze({
      nativeUnsupportedSdkUi: true,
      usePluginData,
      usePluginAction,
      useHostContext: () => context,
      useHostNavigation: () => unavailableFeature("Host navigation"),
      useHostLocation: () => unavailableFeature("Host location"),
      usePluginStream: () => unavailableFeature("Plugin streams"),
      usePluginToast: () => unavailableFeature("Host notifications"),
    }),
  });
}
