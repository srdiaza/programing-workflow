import type { Plugin } from "@opencode-ai/plugin"

const WORKFLOW_AGENT = "workflow-lead"

/**
 * Opt-in companion hook. It is loaded globally but is inert for every agent
 * except workflow-lead. State authority remains workflow_state + Engram; this
 * hook only helps a selected Lead remember to reload state after compaction.
 */
export const ContinuousWorkflow: Plugin = async () => {
  const workflowSessions = new Set<string>()

  return {
    "chat.message": async (input) => {
      if (input.agent === WORKFLOW_AGENT) workflowSessions.add(input.sessionID)
    },

    "experimental.session.compacting": async (input, output) => {
      if (!input.sessionID || !workflowSessions.has(input.sessionID)) return
      output.context.push(
        "CONTINUOUS WORKFLOW RECOVERY: after compaction, call workflow_state with operation=status before reading or modifying project files. The persisted Engram state is authoritative; reload its version and owner lease before any mutation.",
      )
    },
  }
}
