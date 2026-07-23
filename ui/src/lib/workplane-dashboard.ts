import type { Issue } from "@paperclipai/shared";

const ATTENTION_STATUSES = new Set<Issue["status"]>(["blocked", "in_review"]);

const ACTIVE_STATUSES = new Set<Issue["status"]>(["todo", "in_progress"]);

export function getSpsDashboardFocusIssues(issues: Issue[], limit = 5): Issue[] {
  const attention = issues.filter((issue) => ATTENTION_STATUSES.has(issue.status));
  if (attention.length > 0) return attention.slice(0, limit);

  return issues.filter((issue) => ACTIVE_STATUSES.has(issue.status)).slice(0, limit);
}

export function getSpsTaskStatusLabel(status: Issue["status"]): string {
  switch (status) {
    case "blocked":
      return "차단됨";
    case "in_review":
      return "검토 대기";
    case "in_progress":
      return "진행 중";
    case "todo":
      return "대기";
    case "done":
      return "완료";
    case "cancelled":
      return "취소됨";
    default:
      return status;
  }
}
