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
 *   spawn_agent        — Create a new tmux window running pi in a given workspace
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { Type } from "typebox";

const CC_STATE_DIR = join(homedir(), ".pi/agent/cc-state");
const CC_INBOX_DIR = join(homedir(), ".pi/agent/cc-inbox");
const STALE_STREAMING_MS = 2 * 60 * 1000; // mirror cc-reporter's staleness threshold

function workspaceKey(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "_");
}

function isActuallyStreaming(state: any): boolean {
  return (
    state.isStreaming &&
    !!state.lastActivity &&
    Date.now() - new Date(state.lastActivity).getTime() < STALE_STREAMING_MS
  );
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
        status: isActuallyStreaming(s) ? "busy" : "idle",
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
        status: isActuallyStreaming(state) ? "busy" : "idle",
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
        const busy = isActuallyStreaming(state);
        const status = busy
          ? "Agent is currently busy — message will be delivered after its current task finishes."
          : "Message queued for delivery (arrives within ~500ms).";
        return {
          content: [{ type: "text" as const, text: `Message sent to agent at ${params.workspace}. ${status}` }],
          details: { success: true, queued: busy },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to deliver message: ${err?.message ?? err}` }],
          details: { success: false },
        };
      }
    },
  });

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Create a new tmux window running a pi agent in the given workspace directory. " +
      "Waits up to 10s for the agent to confirm it started. " +
      "After spawning, use send_to_agent to give it an initial task. " +
      "Requires the supervisor to be running inside tmux.",
    parameters: Type.Object({
      workspace: Type.String({ description: "Absolute path to an existing directory to run pi in" }),
      windowName: Type.Optional(Type.String({ description: "Tmux window name (defaults to the directory basename)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!process.env.TMUX) {
        return {
          content: [{ type: "text" as const, text: "Not running inside tmux — cannot spawn a window." }],
          details: { success: false },
        };
      }
      if (!existsSync(params.workspace)) {
        return {
          content: [{ type: "text" as const, text: `Workspace does not exist: ${params.workspace}` }],
          details: { success: false },
        };
      }

      const name = params.windowName ?? basename(params.workspace);
      const result = spawnSync("tmux", ["new-window", "-c", params.workspace, "-n", name, "pi"], { timeout: 5000 });
      if (result.status !== 0) {
        const err = result.stderr?.toString().trim() || "unknown error";
        return {
          content: [{ type: "text" as const, text: `Failed to spawn tmux window: ${err}` }],
          details: { success: false },
        };
      }

      // Poll cc-state for up to 10s waiting for cc-reporter to register the new session
      const expectedPath = join(CC_STATE_DIR, workspaceKey(params.workspace) + ".json");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(expectedPath)) {
          return {
            content: [{ type: "text" as const, text: `Agent ready in: ${params.workspace}` }],
            details: { success: true, workspace: params.workspace, confirmed: true },
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      return {
        content: [{ type: "text" as const, text: `Pi is starting in ${params.workspace} — call list_agents in a few seconds to confirm.` }],
        details: { success: true, workspace: params.workspace, confirmed: false },
      };
    },
  });
}
