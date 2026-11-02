export type AppServerReadRequest = (
  method: "thread/list" | "thread/read",
  params: Record<string, unknown>,
) => Promise<unknown>;

export type CodexDirectChild = Readonly<{
  id: string;
  parentThreadId: string;
  agentRole: string | null;
  agentNickname: string | null;
}>;

export type ReadCodexDirectChildrenOptions = {
  maxPages?: number;
  pageSize?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 4096;
const MAX_METADATA_LENGTH = 256;

function fail(message: string): never {
  throw new TypeError(`Invalid app-server thread/list response: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(`missing or accessor ${key}`);
  return descriptor.value;
}

function readOptions(options: unknown): { maxPages: number; pageSize: number } {
  if (!isRecord(options)) fail("invalid options");
  let maxPages: unknown = 5;
  let pageSize: unknown = 50;
  for (const key of Reflect.ownKeys(options)) {
    if (key !== "maxPages" && key !== "pageSize") fail("unknown option");
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(`invalid option ${key}`);
    if (key === "maxPages") maxPages = descriptor.value;
    else pageSize = descriptor.value;
  }
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    fail("invalid maxPages");
  }
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    fail("invalid pageSize");
  }
  return { maxPages, pageSize };
}

function readDenseArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxItems) {
    fail("data must be a bounded array");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail("data must be dense and contain no extra properties");
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("data entries must be own data properties");
    items.push(descriptor.value);
  }
  return items;
}

function readMetadata(record: Record<string, unknown>, key: string): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return null;
  if (!Object.hasOwn(descriptor, "value")) fail(`invalid ${key}`);
  const value = descriptor.value;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_METADATA_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`invalid ${key}`);
  }
  return value;
}

function assertThreadId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) fail(`invalid ${label}`);
}

/** Observes thread metadata only; it proves no Worker registration, execution approval, memory isolation, or raw-log/status safety. */
export async function readCodexDirectChildren(
  request: AppServerReadRequest,
  parentThreadId: string,
  options: ReadCodexDirectChildrenOptions = {},
): Promise<{ children: readonly CodexDirectChild[] }> {
  assertThreadId(parentThreadId, "parentThreadId");

  const parsedOptions = readOptions(options);
  const maxPages = parsedOptions.maxPages;
  const pageSize = parsedOptions.pageSize;

  const children: CodexDirectChild[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await request("thread/list", {
      parentThreadId,
      limit: pageSize,
      cursor,
      archived: false,
    });
    if (!isRecord(response)) fail("response must be an object");

    const data = readDataProperty(response, "data");
    const nextCursor = readDataProperty(response, "nextCursor");
    const entries = readDenseArray(data, pageSize);
    if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length === 0
      || nextCursor.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/.test(nextCursor))) {
      fail("invalid nextCursor");
    }

    for (const value of entries) {
      if (!isRecord(value)) fail("thread entry must be an object");
      const id = readDataProperty(value, "id");
      const childParentThreadId = readDataProperty(value, "parentThreadId");
      assertThreadId(id, "thread id");
      assertThreadId(childParentThreadId, "thread parentThreadId");
      if (id === parentThreadId) fail("thread cannot be its own child");
      if (childParentThreadId !== parentThreadId) fail("thread has the wrong parentThreadId");
      if (ids.has(id)) fail("duplicate thread id");
      ids.add(id);
      children.push(Object.freeze({
        id,
        parentThreadId: childParentThreadId,
        agentRole: readMetadata(value, "agentRole"),
        agentNickname: readMetadata(value, "agentNickname"),
      }));
    }

    if (nextCursor === null) return Object.freeze({ children: Object.freeze(children) });
    if (cursors.has(nextCursor)) fail("repeated cursor");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  fail("page limit exceeded");
}
