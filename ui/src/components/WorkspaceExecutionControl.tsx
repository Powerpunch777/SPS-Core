import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpsWorkspaceExecutionAction } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { Button } from "./ui/button";

export function WorkspaceExecutionControl({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["workspace-execution-control", companyId];
  const status = useQuery({ queryKey, queryFn: () => companiesApi.getExecutionControl(companyId), refetchInterval: 3000 });
  const mutation = useMutation({
    mutationFn: (action: SpsWorkspaceExecutionAction["action"]) => {
      if (!status.data) throw new Error("실행 상태를 먼저 확인해 주세요.");
      return companiesApi.controlExecution(companyId, { action, expectedRevision: status.data.revision });
    },
    onSuccess: data => { queryClient.setQueryData(queryKey, data); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }); },
  });
  const data = status.data;
  const pending = data ? Object.values(data.pending).some(value => value > 0) : false;
  return <section className="space-y-3 border-t border-border pt-6" aria-label="Workspace 실행 제어">
    <h2 className="text-base font-medium">Workspace 실행</h2>
    <p className="text-sm text-muted-foreground">일시정지는 새 작업을 막고 진행 중인 작업은 마칩니다. 중지는 진행 중인 작업에도 취소를 요청합니다.</p>
    <p className="text-sm" role="status">{!data ? (status.isError ? "실행 상태를 불러오지 못했습니다." : "실행 상태 확인 중…")
      : data.state === "running" ? "새 작업 실행 가능"
      : data.state === "paused" ? "일시정지 — 새 작업 대기"
      : pending ? "중지됨 — 기존 작업의 종료 확인 대기" : "중지됨 — 실행 중인 작업 없음"}</p>
    {data && pending && <p className="text-sm text-muted-foreground">
      실행 또는 종료 확인 중: Agent {data.pending.agents} · 작업 {data.pending.jobs} · 모델 {data.pending.models} · Node {data.pending.commands + data.pending.plugins}
    </p>}
    {data?.state === "stopped" && pending && <p className="text-sm text-muted-foreground">
      종료가 확인되지 않은 작업이 있습니다. 연결이 끊긴 장치나 응답하지 않는 작업은 종료 확인이 늦어질 수 있습니다.
    </p>}
    {data?.canControl && <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={mutation.isPending || data.state !== "running"} onClick={() => mutation.mutate("pause")}>일시정지</Button>
      <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate("stop")}>{data.state === "stopped" ? "종료 확인 재시도" : "중지"}</Button>
      <Button variant="outline" disabled={mutation.isPending || data.state === "running"} onClick={() => mutation.mutate("resume")}>재개</Button>
    </div>}
    <p className="text-sm text-muted-foreground">재개하면 새 작업을 실행할 수 있습니다. 취소되거나 중단된 작업은 자동으로 다시 실행되지 않습니다.</p>
    {(mutation.isError || (data?.cancellationFailures?.length ?? 0) > 0) && <p role="alert" className="text-sm text-destructive">
      일부 작업의 종료를 확인하지 못했습니다. 상태를 새로 확인한 후 재시도해 주세요.
    </p>}
  </section>;
}
