export type SpsSessionExecutionPolicy = Readonly<{
  mode: "plugin-tools-only-v1";
  toolNames: readonly string[];
}>;

/** An execution restriction, not workflow authority or an OS isolation certificate. */
export function parseSpsSessionExecutionPolicy(value: unknown): SpsSessionExecutionPolicy | null {
  if (value === undefined) return null;
  const fail = () => new TypeError("Invalid SPS session execution policy; unrestricted fallback is forbidden.");
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some(key => key !== "mode" && key !== "toolNames")) throw fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!["mode", "toolNames"].every(key => fields[key]?.enumerable && Object.hasOwn(fields[key], "value"))) throw fail();
  if (fields.mode!.value !== "plugin-tools-only-v1") throw fail();
  const names: unknown = fields.toolNames!.value;
  if (!Array.isArray(names) || Object.getPrototypeOf(names) !== Array.prototype || names.length < 1 || names.length > 32
    || Reflect.ownKeys(names).length !== names.length + 1) throw fail();
  const snapshot: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(names, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(field.value)) throw fail();
    snapshot.push(field.value);
  }
  if (new Set(snapshot).size !== snapshot.length) throw fail();
  snapshot.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return Object.freeze({ mode: "plugin-tools-only-v1", toolNames: Object.freeze(snapshot) });
}
