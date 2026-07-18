import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issueComments,
  issues as issuesTable,
} from "@paperclipai/db";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { validateIssueReportBody } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { issueService } from "./issues.js";

export type IssueReportKind = "final" | "blocker";

export interface SubmitIssueReportInput {
  companyId: string;
  issueId: string;
  kind: IssueReportKind;
  body: string;
  actorAgentId: string;
  actorRunId: string;
}

export interface SubmitIssueReportResult {
  issue: Issue;
  comment: IssueComment;
  idempotent: boolean;
}

const FINAL_REPORT_HEADER = "## Paperclip Final Report";
const BLOCKER_REPORT_HEADER = "## Paperclip Blocker Report";

function reportKindForBody(body: string): IssueReportKind | null {
  const firstLine = body.split(/\r?\n/, 1)[0];
  if (firstLine === FINAL_REPORT_HEADER) return "final";
  if (firstLine === BLOCKER_REPORT_HEADER) return "blocker";
  return null;
}

export function parseIssueReportSummary(summary: unknown): { kind: IssueReportKind; body: string } | null {
  if (typeof summary !== "string") return null;
  const kind = reportKindForBody(summary);
  if (!kind) return null;
  const validationResult = validateIssueReportBody(summary, kind);
  return validationResult.valid ? { kind, body: summary } : null;
}

export function issueReportService(db: Db) {
  const issues = issueService(db);

  return {
    async submit(input: SubmitIssueReportInput): Promise<SubmitIssueReportResult> {
      const validationResult = validateIssueReportBody(input.body, input.kind);
      if (!validationResult.valid) {
        throw badRequest(validationResult.error || "Invalid report body");
      }

      const mutation = await db.transaction(async (tx): Promise<{
        issue: Issue | null;
        comment: IssueComment;
        idempotent: boolean;
      }> => {
        // Serialize terminal reports before checking idempotency. This keeps
        // concurrent retries from creating two comments or two transitions.
        const issueRow = await tx
          .select()
          .from(issuesTable)
          .where(eq(issuesTable.id, input.issueId))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!issueRow) throw notFound("Issue not found");
        if (issueRow.companyId !== input.companyId) {
          throw badRequest("Issue does not belong to the specified company");
        }
        if (issueRow.assigneeAgentId !== input.actorAgentId) {
          throw badRequest("Actor agent is not the assignee of the issue");
        }

        const run = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, input.actorRunId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.agentId, input.actorAgentId),
          ))
          .then((rows) => rows[0] ?? null);

        if (!run) {
          throw badRequest("Actor run does not belong to the specified company/agent");
        }

        const contextSnapshot = (run.contextSnapshot ?? {}) as Record<string, unknown>;
        if (
          contextSnapshot.issueId !== input.issueId
          && contextSnapshot.taskId !== input.issueId
        ) {
          throw badRequest("Actor run context snapshot does not match the issue ID");
        }

        const priorRunComments = await tx
          .select()
          .from(issueComments)
          .where(and(
            eq(issueComments.issueId, input.issueId),
            eq(issueComments.createdByRunId, input.actorRunId),
            isNull(issueComments.deletedAt),
          ));
        const priorReports = priorRunComments
          .map((comment) => ({ comment, kind: reportKindForBody(comment.body) }))
          .filter((entry): entry is { comment: typeof priorRunComments[number]; kind: IssueReportKind } => (
            entry.kind !== null
          ));
        const priorKinds = new Set(priorReports.map((entry) => entry.kind));
        if (priorKinds.size > 1) {
          throw badRequest("Conflicting reports already exist for this run");
        }

        const existingReport = priorReports[0] ?? null;
        if (existingReport) {
          if (existingReport.kind !== input.kind) {
            throw badRequest("An opposite-kind report was already submitted for this run");
          }

          const targetStatus = input.kind === "final" ? "in_review" : "blocked";
          if (issueRow.status === "in_progress") {
            if (
              issueRow.checkoutRunId !== input.actorRunId
              && issueRow.executionRunId !== input.actorRunId
            ) {
              throw badRequest("Actor run is not the active issue execution owner");
            }
            const repairedIssue = await issues.update(input.issueId, { status: targetStatus }, tx);
            if (!repairedIssue) throw new Error("Failed to repair issue report status");
            return {
              issue: repairedIssue as Issue,
              comment: existingReport.comment as IssueComment,
              idempotent: true,
            };
          }

          return {
            issue: null,
            comment: existingReport.comment as IssueComment,
            idempotent: true,
          };
        }

        if (issueRow.status !== "in_progress") {
          throw badRequest(`Cannot submit report for issue in status: ${issueRow.status}`);
        }
        if (
          issueRow.checkoutRunId !== input.actorRunId
          && issueRow.executionRunId !== input.actorRunId
        ) {
          throw badRequest("Actor run is not the active issue execution owner");
        }

        const comment = await issues.addComment(
          input.issueId,
          input.body,
          { agentId: input.actorAgentId, runId: input.actorRunId },
          undefined,
          tx,
        );
        const targetStatus = input.kind === "final" ? "in_review" : "blocked";
        const issue = await issues.update(input.issueId, { status: targetStatus }, tx);
        if (!issue) throw new Error("Failed to update issue status");

        return {
          issue: issue as Issue,
          comment: comment as IssueComment,
          idempotent: false,
        };
      });

      if (mutation.issue) return mutation as SubmitIssueReportResult;

      const issue = await issues.getById(input.issueId);
      if (!issue || issue.companyId !== input.companyId) throw notFound("Issue not found");
      return {
        issue: issue as Issue,
        comment: mutation.comment,
        idempotent: true,
      };
    },
  };
}
