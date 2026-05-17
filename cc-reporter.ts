/**
 * Command Center Reporter
 *
 * Companion extension that runs in every pi instance and writes real-time state
 * to ~/.pi/agent/cc-state/ so the command center can display agent status.
 *
 * Install alongside command-center.ts in ~/.pi/agent/extensions/
 *
 * Commands:
 *   /cc-ticket PROJ-123  — Associate a Jira ticket with this workspace
 *   /cc-ticket           — Clear the Jira ticket association
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function getTmuxWindowId(): string | undefined {
  try {
    const id = execSync("tmux display-message -p '#{window_id}'", { encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

const CC_STATE_DIR = join(homedir(), ".pi/agent/cc-state");
const CC_CONFIG_DIR = join(homedir(), ".pi/agent/cc-config");

interface CCState {
  workspace: string;
  branch: string;
  repoRoot: string;
  sessionId: string;
  sessionName: string | undefined;
  isStreaming: boolean;
  lastActivity: string;
  lastSummary: string;
  tmuxPane: string | undefined;
  tmuxWindow: string | undefined;
  jiraTicket: string | null;
}

function workspaceKey(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/\//g, "_");
}

function stateFilePath(cwd: string): string {
  return join(CC_STATE_DIR, workspaceKey(cwd) + ".json");
}

function configFilePath(cwd: string): string {
  return join(CC_CONFIG_DIR, workspaceKey(cwd) + ".json");
}

function readConfig(cwd: string): { jiraTicket: string | null } {
  try {
    return JSON.parse(readFileSync(configFilePath(cwd), "utf8"));
  } catch {
    return { jiraTicket: null };
  }
}

function writeConfig(cwd: string, jiraTicket: string | null): void {
  try {
    mkdirSync(CC_CONFIG_DIR, { recursive: true });
    writeFileSync(configFilePath(cwd), JSON.stringify({ jiraTicket }, null, 2));
  } catch {}
}

function getBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function getRepoRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return cwd;
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

function extractTextFromMessage(msg: any): string {
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
  for (const block of msg.content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      const text = stripMarkdown(block.text);
      if (!text) continue;
      return text.length > 300 ? text.slice(0, 297) + "..." : text;
    }
  }
  return "";
}

function readExistingState(cwd: string): Partial<CCState> | null {
  try {
    const raw = readFileSync(stateFilePath(cwd), "utf8");
    return JSON.parse(raw) as Partial<CCState>;
  } catch {
    return null;
  }
}

function extractLastSummary(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractTextFromMessage(messages[i]);
    if (text) return text;
  }
  return "";
}

export default function ccReporterExtension(pi: ExtensionAPI) {
  let state: CCState | null = null;

  function writeState() {
    if (!state) return;
    try {
      mkdirSync(CC_STATE_DIR, { recursive: true });
      writeFileSync(stateFilePath(state.workspace), JSON.stringify(state, null, 2));
    } catch {
      // Non-critical — command center will simply not see this agent
    }
  }

  function deleteState() {
    if (!state) return;
    try {
      const path = stateFilePath(state.workspace);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Ignore
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const existing = readExistingState(cwd);
    const config = readConfig(cwd);
    state = {
      workspace: cwd,
      branch: getBranch(cwd),
      repoRoot: getRepoRoot(cwd),
      sessionId: ctx.sessionManager.getSessionId() ?? "",
      sessionName: pi.getSessionName(),
      isStreaming: false,
      lastActivity: new Date().toISOString(),
      lastSummary: existing?.lastSummary ?? "",
      tmuxPane: process.env.TMUX_PANE,
      tmuxWindow: getTmuxWindowId(),
      jiraTicket: config.jiraTicket,
    };
    writeState();
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!state) return;
    state.branch = getBranch(ctx.cwd);
    state.isStreaming = true;
    state.lastActivity = new Date().toISOString();
    writeState();
  });

  pi.on("agent_end", async (event, _ctx) => {
    if (!state) return;
    state.isStreaming = false;
    state.lastActivity = new Date().toISOString();
    const summary = extractLastSummary(event.messages);
    if (summary) state.lastSummary = summary;
    writeState();
  });

  pi.on("turn_start", async (_event, _ctx) => {
    if (!state) return;
    state.isStreaming = true;
    state.lastActivity = new Date().toISOString();
    writeState();
  });

  pi.on("turn_end", async (event, _ctx) => {
    if (!state) return;
    state.isStreaming = false;
    state.lastActivity = new Date().toISOString();
    const summary = extractTextFromMessage(event.message);
    if (summary) state.lastSummary = summary;
    writeState();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    deleteState();
    state = null;
  });

  pi.registerCommand("cc-ticket", {
    description: "Set or clear the Jira ticket for this workspace in the command center",
    handler: async (args, ctx) => {
      if (!state) {
        ctx.ui.notify("Command center reporter not initialized yet", "error");
        return;
      }
      const ticket = args.trim() || null;
      state.jiraTicket = ticket;
      writeState();
      writeConfig(state.workspace, ticket);
      ctx.ui.notify(ticket ? `Jira ticket set: ${ticket}` : "Jira ticket cleared", "info");
    },
  });
}
