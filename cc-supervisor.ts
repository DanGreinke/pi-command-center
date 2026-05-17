/**
 * Command Center Supervisor
 *
 * Registers LLM-callable tools that let a "supervisor" pi session observe all
 * running agents and dispatch messages to them on the user's behalf.
 *
 * Install alongside cc-reporter.ts in ~/.pi/agent/extensions/
 * (Safe to install in all sessions — tools are harmless if unused.)
 *
 * Tools available to the model:
 *   list_agents        — Summarize all running agent sessions
 *   get_agent_detail   — Full state for one agent
 *   send_to_agent      — Inject a message into an agent's chat as a user turn
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Type } from "typebox";

const CC_STATE_DIR = join(homedir(), ".pi/agent/cc-state");
const CC_INBOX_DIR = join(homedir(), ".pi/agent/cc-inbox");

function workspaceKey(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "_");
}

function readAllStates(): any[] {
  if (!existsSync(CC_STATE_DIR)) return [];
  try {
    return readdirSync(CC_STATE_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(CC_STATE_DIR, f), "utf8"))];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function relativeTime(isoStr: string): string {
  if (!isoStr) return "unknown";
  const secs = Math.floor(Math.abs(Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function ccSupervisorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List all running pi agent sessions with their current status, branch, Jira ticket, and most recent activity summary. Call this to get an overview of what all agents are working on.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const states = readAllStates();
      if (states.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No agent sessions are currently running." }],
          details: [],
        };
      }
      const summaries = states.map((s) => ({
        workspace: s.workspace,
        branch: s.branch || "(none)",
        status: s.isStreaming ? "busy" : "idle",
        lastActive: relativeTime(s.lastActivity),
        jiraTicket: s.jiraTicket ?? null,
        summary: s.lastSummary || "(no summary yet)",
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summaries, null, 2) }],
        details: summaries,
      };
    },
  });

  pi.registerTool({
    name: "get_agent_detail",
    label: "Get Agent Detail",
    description:
      "Get full details for a specific agent session. Use list_agents first to get the exact workspace path.",
    parameters: Type.Object({
      workspace: Type.String({ description: "Absolute path to the agent's workspace directory (from list_agents)" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = readAllStates().find((s) => s.workspace === params.workspace);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: `No running agent found for workspace: ${params.workspace}` }],
          details: null,
        };
      }
      const detail = {
        workspace: state.workspace,
        branch: state.branch || "(none)",
        status: state.isStreaming ? "busy" : "idle",
        lastActive: relativeTime(state.lastActivity),
        jiraTicket: state.jiraTicket ?? null,
        summary: state.lastSummary || "(no summary yet)",
        sessionId: state.sessionId,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
        details: detail,
      };
    },
  });

  pi.registerTool({
    name: "send_to_agent",
    label: "Send to Agent",
    description:
      "Send a message to a specific agent's pi session. The message is injected as a user turn — the agent will receive and respond to it as if the user had typed it. If the agent is currently busy, the message is queued and delivered after it finishes. Use list_agents first to get the workspace path.",
    parameters: Type.Object({
      workspace: Type.String({ description: "Absolute path to the agent's workspace directory (from list_agents)" }),
      message: Type.String({ description: "The message to send to the agent" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const states = readAllStates();
      const state = states.find((s) => s.workspace === params.workspace);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: `No running agent found for workspace: ${params.workspace}. Use list_agents to see available workspaces.` }],
          details: { success: false },
        };
      }
      try {
        mkdirSync(CC_INBOX_DIR, { recursive: true });
        writeFileSync(
          join(CC_INBOX_DIR, workspaceKey(params.workspace) + ".json"),
          JSON.stringify({ message: params.message, timestamp: new Date().toISOString(), from: "supervisor" }),
        );
        const queued = state.isStreaming ? " (agent is busy — message queued)" : "";
        return {
          content: [{ type: "text" as const, text: `Message delivered to agent at ${params.workspace}${queued}.` }],
          details: { success: true, queued: state.isStreaming },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to deliver message: ${err?.message ?? err}` }],
          details: { success: false },
        };
      }
    },
  });
}
