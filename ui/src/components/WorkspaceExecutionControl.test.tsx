// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceExecutionControl } from "./WorkspaceExecutionControl";

const mocks = vi.hoisted(() => ({ getExecutionControl: vi.fn(), controlExecution: vi.fn() }));
vi.mock("../api/companies", () => ({ companiesApi: mocks }));
const status = (overrides = {}) => ({ state: "running", epoch: "0", revision: 4, updatedAt: null, canControl: true,
  pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 }, ...overrides });
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
const render = () => { flushSync(() => root.render(<QueryClientProvider client={client}><WorkspaceExecutionControl companyId="workspace-a" /></QueryClientProvider>)); };
const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)!;

it("sends the displayed revision and selected Workspace, then displays paused state", async () => {
  mocks.getExecutionControl.mockResolvedValue(status());
  mocks.controlExecution.mockImplementation(async () => { const value = status({ state: "paused", revision: 5 }); mocks.getExecutionControl.mockResolvedValue(value); return value; });
  render();
  await vi.waitFor(() => expect(button("일시정지")?.disabled).toBe(false));
  button("일시정지").click();
  await vi.waitFor(() => expect(mocks.controlExecution).toHaveBeenCalledWith("workspace-a", { action: "pause", expectedRevision: 4 }));
  await vi.waitFor(() => expect(container.textContent).toContain("일시정지 — 새 작업 대기"));
});

it("shows pending termination rather than claiming stopped jobs have exited", async () => {
  mocks.getExecutionControl.mockResolvedValue(status({ state: "stopped", pending: { agents: 0, jobs: 1, models: 0, commands: 0, plugins: 0 } }));
  render();
  await vi.waitFor(() => expect(container.textContent).toContain("기존 작업의 종료 확인 대기"));
  expect(container.textContent).not.toContain("실행 중인 작업 없음");
  expect(button("종료 확인 재시도")).toBeDefined();
});

it("a read-only Member sees status without Host control actions", async () => {
  mocks.getExecutionControl.mockResolvedValue(status({ canControl: false })); render();
  await vi.waitFor(() => expect(container.textContent).toContain("새 작업 실행 가능"));
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
