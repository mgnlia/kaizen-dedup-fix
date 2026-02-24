/**
 * Patch diff — changes to packages/backend/src/scheduler/jobs.ts
 *
 * Two targeted fixes:
 *
 * 1. pickAssignee — filter out stopped agents before role matching
 *    Prevents stopped/retired agents from being auto-assigned new tasks.
 *
 * 2. resumeAssignedInProgressTasksAfterRestart — skip stopped agents
 *    On restart, the scheduler resumes all in-progress tasks. If the assignee
 *    is stopped, sending a resume message re-activates a retired agent.
 */

// ─── PATCH 1: pickAssignee ───────────────────────────────────────────────────
//
// BEFORE:
// function pickAssignee(task: Task, agents: Agent[]): Agent | undefined {
//   const byRole = (role: Agent["role"]) => agents.find((a) => a.role === role);
//   ...
// }
//
// AFTER:
// function pickAssignee(task: Task, agents: Agent[]): Agent | undefined {
//   // DEDUP FIX: never assign to stopped agents
//   const active = agents.filter((a) => a.status !== "stopped");
//   const byRole = (role: Agent["role"]) => active.find((a) => a.role === role);
//   ...
// }

// ─── PATCH 2: resumeAssignedInProgressTasksAfterRestart ─────────────────────
//
// BEFORE:
// async function resumeAssignedInProgressTasksAfterRestart(): Promise<void> {
//   ...
//   for (const task of assigned) {
//     if (!task.assigneeId) continue;
//     const assignee = byId.get(task.assigneeId);
//     if (!assignee) continue;
//     // sends resume message unconditionally
//     manager.sendMessageToAgent(assignee.id, ...).catch(...)
//   }
// }
//
// AFTER:
// async function resumeAssignedInProgressTasksAfterRestart(): Promise<void> {
//   ...
//   for (const task of assigned) {
//     if (!task.assigneeId) continue;
//     const assignee = byId.get(task.assigneeId);
//     if (!assignee) continue;
//     // DEDUP FIX: skip stopped agents — do not re-activate retired agents
//     if (assignee.status === "stopped") continue;
//     manager.sendMessageToAgent(assignee.id, ...).catch(...)
//   }
// }
