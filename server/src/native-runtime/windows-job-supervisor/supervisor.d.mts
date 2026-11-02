import type { ChildProcess } from "node:child_process";

export type WindowsSupervisedProcess = ChildProcess & {
  readonly supervisorReady: Promise<number>;
  terminateOwnedJob(): Promise<unknown>;
  waitForOwnedJobTermination(): Promise<unknown>;
  hasUnconfirmedOwnedJobTermination(): boolean;
};

export type WindowsJobSupervisorInvocation = Readonly<{
  executable: string;
  cwd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

/** Starts one process inside a Windows Job Object and exposes stdio streams. */
export function spawnWindowsJobSupervisor(
  invocation: WindowsJobSupervisorInvocation,
  internal?: Readonly<Record<string, unknown>> & { helperPath?: string; platform?: NodeJS.Platform },
): WindowsSupervisedProcess;

export function assertWindowsJobSupervisorAvailable(
  internal?: Readonly<Record<string, unknown>> & { helperPath?: string; platform?: NodeJS.Platform },
): Promise<string>;
