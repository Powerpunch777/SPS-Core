import { z } from "zod";

export const spsWorkspaceExecutionActionSchema = z.object({
  action: z.enum(["pause", "stop", "resume"]),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
}).strict();

export type SpsWorkspaceExecutionAction = z.infer<typeof spsWorkspaceExecutionActionSchema>;
export type SpsWorkspaceExecutionStatus = {
  state: "running" | "paused" | "stopped";
  epoch: string;
  revision: number;
  updatedAt: string | null;
  pending: { agents: number; jobs: number; models: number; commands: number; plugins: number };
  canControl: boolean;
  cancellationFailures?: string[];
};
