/**
 * stopped-agent-guard.ts
 *
 * Fixes BLOCKER 5 (scheduler guard): stopped agents must not be dispatched tasks
 * or auto-promoted to idle by the watchdog/reconciler.
 *
 * Three guards:
 *
 * 1. filterDispatchableAgents() — removes stopped agents before pickAssignee()
 *    Integration: line 190448 in dist/index.js (dispatchTodoTasks)
 *    Replace: `const agents3 = await listAgentsLight();`
 *    With:    `const agents3 = filterDispatchableAgents(await listAgentsLight());`
 *
 * 2. safeReconcileOnStartup() — explicitly skips stopped agents during state reconcile
 *    Integration: line 187924 in dist/index.js (reconcileAgentStatesOnStartup)
 *    The current code only resets thinking/executing → idle, which is correct,
 *    but it is implicit. This makes the stopped-agent skip explicit and logged.
 *
 * 3. guardedStartAgent() — throws if agent.status === 'stopped'
 *    Integration: line 196162 in dist/index.js (watchdog recovery path)
 *    Replace: `await startAgent(agent.id);`
 *    With:    `await guardedStartAgent(agent.id, getAgent, startAgent);`
 *    This prevents the watchdog from auto-recovering a deliberately stopped agent.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentLight {
  id: string;
  name: string;
  role: string;
  status: "idle" | "thinking" | "executing" | "error" | "stopped";
  lastActiveAt?: string | null;
}

// ---------------------------------------------------------------------------
// Guard 1: Filter dispatchable agents
// ---------------------------------------------------------------------------

/**
 * Removes stopped agents from the candidate pool before task dispatch.
 * This is the primary scheduler guard — a stopped agent must never receive
 * an auto-dispatched task or a scheduler-initiated send_message.
 */
export function filterDispatchableAgents(agents: AgentLight[]): AgentLight[] {
  const filtered = agents.filter((a) => a.status !== "stopped");
  const removedCount = agents.length - filtered.length;
  if (removedCount > 0) {
    console.log(
      `[stopped-agent-guard] Filtered ${removedCount} stopped agent(s) from dispatch pool: ` +
        agents
          .filter((a) => a.status === "stopped")
          .map((a) => `${a.name}(${a.id})`)
          .join(", ")
    );
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Guard 2: Safe reconcile on startup
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  reset: string[];   // agent IDs reset to idle
  skipped: string[]; // stopped agents explicitly skipped
}

/**
 * Drop-in replacement for reconcileAgentStatesOnStartup().
 * Resets thinking/executing → idle (same as before) but explicitly logs
 * and skips stopped agents so they cannot be accidentally promoted.
 *
 * Integration: replace the body of reconcileAgentStatesOnStartup() with a
 * call to this function.
 */
export async function safeReconcileOnStartup(
  agents: AgentLight[],
  updateAgentStatus: (id: string, status: string) => Promise<void>,
  insertActivity: (activity: {
    agentId: string;
    type: string;
    summary: string;
    details?: Record<string, unknown>;
  }) => Promise<void>
): Promise<ReconcileResult> {
  const staleStatuses = new Set(["thinking", "executing"]);
  const result: ReconcileResult = { reset: [], skipped: [] };

  for (const agent of agents) {
    // EXPLICIT STOPPED GUARD: never touch a stopped agent
    if (agent.status === "stopped") {
      result.skipped.push(agent.id);
      console.log(
        `[stopped-agent-guard] Startup reconcile: skipping stopped agent ${agent.name}(${agent.id}) — will NOT be promoted to idle`
      );
      continue;
    }

    if (!staleStatuses.has(agent.status)) {
      continue;
    }

    await updateAgentStatus(agent.id, "idle");
    await insertActivity({
      agentId: agent.id,
      type: "agent_stopped",
      summary: `${agent.name} state reconciled after restart (${agent.status} -> idle)`,
      details: {
        source: "startup_reconcile",
        previousStatus: agent.status,
        guardVersion: "stopped-agent-guard-v1",
      },
    });
    result.reset.push(agent.id);
  }

  if (result.skipped.length > 0) {
    console.log(
      `[stopped-agent-guard] Startup reconcile complete: ${result.reset.length} reset, ${result.skipped.length} stopped agents protected`
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Guard 3: Guarded startAgent (watchdog path)
// ---------------------------------------------------------------------------

/**
 * Wraps startAgent to prevent the watchdog from auto-recovering a deliberately
 * stopped agent. A stopped agent is stopped intentionally — the watchdog must
 * not treat it as a stalled agent to recover.
 *
 * Integration: in the watchdog recovery block (line ~196155 in dist/index.js),
 * replace:
 *   await startAgent(agent.id);
 * with:
 *   await guardedStartAgent(agent.id, getAgent, startAgent);
 */
export async function guardedStartAgent(
  agentId: string,
  getAgent: (id: string) => Promise<AgentLight | undefined>,
  startAgent: (id: string) => Promise<void>
): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`guardedStartAgent: agent ${agentId} not found`);
  }
  if (agent.status === "stopped") {
    throw new Error(
      `guardedStartAgent: refusing to start stopped agent ${agent.name}(${agentId}). ` +
        `Stopped agents must be manually restarted. This prevents watchdog from ` +
        `auto-recovering deliberately retired agents (e.g. VzKdJ89cpXOcS7EiC_n99).`
    );
  }
  await startAgent(agentId);
}
