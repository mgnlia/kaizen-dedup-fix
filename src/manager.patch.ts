/**
 * Patch diff — changes to packages/backend/src/agents/manager.ts
 *
 * Three targeted fixes for the duplicate delivery loop:
 *
 * 1. ensureAgentStarted — hard-block if agent.status === 'stopped'
 *    Prevents stopped/retired agents from being auto-restarted when a
 *    message arrives for them.
 *
 * 2. reconcileAgentStatesOnStartup — skip stopped agents
 *    Currently promotes ALL thinking/executing → idle including stopped ones.
 *    Stopped agents must stay stopped across restarts.
 *
 * 3. sendMessageToAgent — DB-backed dedup before delivery
 *    Calls isDuplicateMessage() (message-dedup.ts) before inserting the
 *    user message and triggering the agent loop. Drops duplicates within 72h.
 *
 * 4. registerSendMessageHandler — block delivery to stopped agents
 *    The inter-agent routing handler must check target agent status before
 *    calling sendMessageToAgent.
 *
 * Apply these diffs to packages/backend/src/agents/manager.ts
 */

// ─── PATCH 1: ensureAgentStarted ────────────────────────────────────────────
//
// BEFORE:
// async function ensureAgentStarted(agentId: string): Promise<void> {
//   if (runningAgents.has(agentId)) return;
//   ...
//   const startPromise = startAgent(agentId)...
// }
//
// AFTER (add stopped-agent guard before startAgent call):
// async function ensureAgentStarted(agentId: string): Promise<void> {
//   if (runningAgents.has(agentId)) return;
//
//   // DEDUP FIX: never restart a stopped agent — stopped is a permanent state
//   const agent = await repo.getAgent(agentId);
//   if (agent?.status === "stopped") {
//     throw new Error(`Agent ${agentId} is stopped and cannot be restarted automatically`);
//   }
//   ...
// }

// ─── PATCH 2: reconcileAgentStatesOnStartup ─────────────────────────────────
//
// BEFORE:
// export async function reconcileAgentStatesOnStartup(): Promise<void> {
//   const agents = await repo.listAgents();
//   const staleStatuses = new Set(["thinking", "executing"]);
//   for (const agent of agents) {
//     if (!staleStatuses.has(agent.status)) continue;
//     await repo.updateAgentStatus(agent.id, "idle");
//     ...
//   }
// }
//
// AFTER (add stopped guard):
// export async function reconcileAgentStatesOnStartup(): Promise<void> {
//   const agents = await repo.listAgents();
//   const staleStatuses = new Set(["thinking", "executing"]);
//   for (const agent of agents) {
//     if (!staleStatuses.has(agent.status)) continue;
//     // DEDUP FIX: never promote a stopped agent back to idle
//     if (agent.status === "stopped") continue;
//     await repo.updateAgentStatus(agent.id, "idle");
//     ...
//   }
// }

// ─── PATCH 3: sendMessageToAgent — DB-backed dedup ──────────────────────────
//
// Add import at top of file:
// import { isDuplicateMessage } from "./message-dedup.js";
//
// BEFORE (in sendMessageToAgent):
//   const agent = await repo.getAgent(agentId);
//   if (!agent) throw new Error(`Agent ${agentId} not found`);
//   await ensureAgentStarted(agentId);
//   ...
//   await repo.insertMessage({ agentId, role: "user", content });
//
// AFTER:
//   const agent = await repo.getAgent(agentId);
//   if (!agent) throw new Error(`Agent ${agentId} not found`);
//
//   // DEDUP FIX: block delivery to stopped agents
//   if (agent.status === "stopped") {
//     console.warn(`[Manager] Dropping message to stopped agent ${agentId}: ${content.slice(0, 80)}`);
//     return;
//   }
//
//   // DEDUP FIX: DB-backed dedup — survives restarts, catches session-replays
//   const isDup = await isDuplicateMessage(agentId, content);
//   if (isDup) {
//     await repo.insertActivity({
//       agentId,
//       type: "task_updated",
//       summary: `[Dedup] Dropped duplicate message to ${agent.name}: ${content.slice(0, 80)}`,
//       details: { source: "message_dedup", dropped: true },
//     });
//     return;
//   }
//
//   await ensureAgentStarted(agentId);
//   ...
//   await repo.insertMessage({ agentId, role: "user", content });

// ─── PATCH 4: registerSendMessageHandler — stopped-agent guard ──────────────
//
// BEFORE:
// registerSendMessageHandler(async (fromAgentId, toAgentId, message) => {
//   const fromAgent = await repo.getAgent(fromAgentId);
//   const toAgent = await resolveTargetAgent(toAgentId);
//   if (!toAgent) return `Error: agent ${toAgentId} not found`;
//   ...
//   await sendMessageToAgent(toAgent.id, `[Message from ${fromName}]: ${message}`);
//   return `Message delivered to ${toAgent.name}`;
// });
//
// AFTER:
// registerSendMessageHandler(async (fromAgentId, toAgentId, message) => {
//   const fromAgent = await repo.getAgent(fromAgentId);
//   const toAgent = await resolveTargetAgent(toAgentId);
//   if (!toAgent) return `Error: agent ${toAgentId} not found`;
//
//   // DEDUP FIX: never deliver to stopped agents
//   if (toAgent.status === "stopped") {
//     return `Error: agent ${toAgent.name} is stopped — message not delivered`;
//   }
//   ...
// });
