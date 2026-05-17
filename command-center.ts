/**
 * Command Center
 *
 * Opens a TUI overlay showing all running pi agents as scrollable cards.
 * Each card shows workspace, branch, PR, Jira ticket, and recent activity.
 * Requires cc-reporter.ts in the same extensions directory.
 *
 * Install in ~/.pi/agent/extensions/
 *
 * Commands:
 *   /cc  — Open the command center overlay
 *
 * Keyboard shortcuts (inside overlay):
 *   ↑↓     Navigate between agents
 *   Enter  Focus the selected agent's tmux pane
 *   r      Refresh data
 *   q/Esc  Close
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

const CC_STATE_DIR = join(homedir(), ".pi/agent/cc-state");
const REFRESH_INTERVAL_MS = 5000;
// Fixed lines consumed by header (title + divider) + top padding + footer (divider + hints)
const CHROME_LINES = 6;
const CARD_GAP = 1;

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

interface PRInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
}

interface AgentInfo {
  workspace: string;
  branch: string;
  repoRoot: string;
  repoName: string;
  sessionId: string;
  sessionName: string | undefined;
  isStreaming: boolean;
  lastActivity: string;
  lastSummary: string;
  tmuxPane: string | undefined;
  tmuxWindow: string | undefined;
  jiraTicket: string | null;
  pr: PRInfo | null;
  isOrphan: boolean;
  commitsAhead: number | null;
  lastRemoteCommit: string;
  remoteSha: string;
  localSha: string;
}

// --- Data collection (unchanged from original) ---

function readStateFiles(): CCState[] {
  if (!existsSync(CC_STATE_DIR)) return [];
  try {
    return readdirSync(CC_STATE_DIR)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(CC_STATE_DIR, f), "utf8")) as CCState];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function getTmuxPanes(): Array<{ paneId: string; windowId: string; path: string }> {
  if (!process.env.TMUX) return [];
  try {
    const out = execSync("tmux list-panes -a -F '#{pane_id}:#{window_id}:#{pane_current_path}'", {
      encoding: "utf8",
      timeout: 2000,
      stdio: "pipe",
    }).trim();
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // pane_id (%N) and window_id (@N) never contain colons; path follows the second colon
        const first = line.indexOf(":");
        const second = line.indexOf(":", first + 1);
        return {
          paneId: line.slice(0, first),
          windowId: line.slice(first + 1, second),
          path: line.slice(second + 1),
        };
      });
  } catch {
    return [];
  }
}

function getGitBranch(dir: string): string {
  try {
    return execSync("git branch --show-current", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function getRepoRoot(dir: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return dir;
  }
}

function getCommitsAhead(dir: string): number | null {
  try {
    const out = execSync("git rev-list --count @{u}..HEAD", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
    return parseInt(out, 10);
  } catch {
    return null;
  }
}

function getLastRemoteCommit(dir: string): string {
  try {
    return execSync("git log -1 --format=%s @{u}", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function getRemoteSha(dir: string): string {
  try {
    return execSync("git rev-parse --short=7 @{u}", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function getLocalSha(dir: string): string {
  try {
    return execSync("git rev-parse --short=7 HEAD", { cwd: dir, encoding: "utf8", timeout: 2000, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function fetchPRs(repoRoots: string[]): Map<string, PRInfo> {
  const prMap = new Map<string, PRInfo>();
  const seen = new Set<string>();
  for (const root of repoRoots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const result = spawnSync(
      "gh",
      ["pr", "list", "--state", "open", "--json", "number,title,url,headRefName", "--limit", "50"],
      { cwd: root, encoding: "utf8", timeout: 5000 },
    );
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const prs: PRInfo[] = JSON.parse(result.stdout);
      for (const pr of prs) prMap.set(pr.headRefName, pr);
    } catch {}
  }
  return prMap;
}

function buildAgentList(): AgentInfo[] {
  const states = readStateFiles();
  const panes = getTmuxPanes();
  const agents: AgentInfo[] = [];
  const stateByPath = new Map<string, CCState>();

  // Build a live pane→window map so we can resolve window IDs for all agents
  const paneToWindow = new Map<string, string>();
  for (const pane of panes) {
    paneToWindow.set(pane.paneId, pane.windowId);
  }

  for (const state of states) {
    stateByPath.set(state.workspace, state);
    // Prefer live window ID (survives agent restarts without state file updates)
    const tmuxWindow = (state.tmuxPane ? paneToWindow.get(state.tmuxPane) : undefined) ?? state.tmuxWindow;
    agents.push({
      workspace: state.workspace,
      branch: state.branch,
      repoRoot: state.repoRoot,
      repoName: basename(state.repoRoot),
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      isStreaming: state.isStreaming,
      lastActivity: state.lastActivity,
      lastSummary: state.lastSummary,
      tmuxPane: state.tmuxPane,
      tmuxWindow,
      jiraTicket: state.jiraTicket,
      pr: null,
      isOrphan: false,
      commitsAhead: null,
      lastRemoteCommit: "",
      remoteSha: "",
      localSha: "",
    });
  }

  for (const pane of panes) {
    if (!stateByPath.has(pane.path)) {
      const branch = getGitBranch(pane.path);
      if (!branch) continue;
      const root = getRepoRoot(pane.path);
      agents.push({
        workspace: pane.path,
        branch,
        repoRoot: root,
        repoName: basename(root),
        sessionId: "",
        sessionName: undefined,
        isStreaming: false,
        lastActivity: "",
        lastSummary: "",
        tmuxPane: pane.paneId,
        tmuxWindow: pane.windowId,
        jiraTicket: null,
        pr: null,
        isOrphan: true,
        commitsAhead: null,
        lastRemoteCommit: "",
        remoteSha: "",
        localSha: "",
      });
    }
  }

  const repoRoots = [...new Set(agents.map((a) => a.repoRoot))];
  const prMap = fetchPRs(repoRoots);
  for (const agent of agents) {
    if (agent.branch && prMap.has(agent.branch)) {
      agent.pr = prMap.get(agent.branch)!;
    }
    agent.commitsAhead = getCommitsAhead(agent.workspace);
    agent.lastRemoteCommit = getLastRemoteCommit(agent.workspace);
    agent.remoteSha = getRemoteSha(agent.workspace);
    agent.localSha = getLocalSha(agent.workspace);
  }

  return agents;
}

// --- Helpers ---

function relativeTime(isoStr: string): string {
  if (!isoStr) return "unknown";
  const diffMs = Date.now() - new Date(isoStr).getTime();
  if (diffMs < 0) return "just now";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)) + "…";
}

function padLine(line: string, targetWidth: number): string {
  const vw = visibleWidth(line);
  return vw < targetWidth ? line + " ".repeat(targetWidth - vw) : line;
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

// --- Card rendering ---

const LABEL_W = 11;
const STALE_STREAMING_MS = 2 * 60 * 1000; // 2 minutes

interface CardRow { label: string; value: string; styleFn?: (s: string) => string }

function rgb(r: number, g: number, b: number): (s: string) => string {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

// Green → yellow-green → yellow → amber → red as commits pile up
const COMMITS_AHEAD_STYLE: Array<(s: string) => string> = [
  rgb(82,  196, 82),  // 0  — green
  rgb(140, 200, 40),  // 1  — yellow-green
  rgb(180, 188, 10),  // 2  — yellow-green leaning yellow
  rgb(218, 172,  0),  // 3  — yellow
  rgb(228, 110,  0),  // 4  — amber
];
const RED_STYLE = rgb(210, 50, 50); // 5+ — red

function commitsAheadStyleFn(n: number): ((s: string) => string) | undefined {
  if (n < COMMITS_AHEAD_STYLE.length) return COMMITS_AHEAD_STYLE[n];
  return RED_STYLE;
}

function getCardRows(agent: AgentInfo): CardRow[] {
  const rows: CardRow[] = [];
  rows.push({ label: "Workspace", value: agent.workspace.replace(homedir(), "~") });
  if (agent.branch) rows.push({ label: "Branch", value: agent.branch });
  if (agent.lastRemoteCommit) rows.push({ label: "Last push", value: agent.lastRemoteCommit });
  if (agent.commitsAhead !== null) {
    const count = agent.commitsAhead === 0 ? "up to date" : `${agent.commitsAhead} commit${agent.commitsAhead !== 1 ? "s" : ""} ahead`;
    const shas = agent.remoteSha && agent.localSha ? ` - ${agent.remoteSha} > ${agent.localSha}` : "";
    rows.push({ label: "Local", value: count + shas, styleFn: commitsAheadStyleFn(agent.commitsAhead) });
  }
  if (agent.pr) rows.push({ label: "PR", value: `#${agent.pr.number}  ${agent.pr.title}` });
  if (agent.jiraTicket) rows.push({ label: "Jira", value: agent.jiraTicket });
  if (!agent.isOrphan && agent.lastActivity) rows.push({ label: "Last active", value: relativeTime(agent.lastActivity) });
  if (agent.lastSummary) rows.push({ label: "Summary", value: stripMarkdown(agent.lastSummary) });
  return rows;
}

function cardHeight(agent: AgentInfo): number {
  return 2 + getCardRows(agent).length; // 2 = top + bottom border
}

function renderCard(agent: AgentInfo, theme: any, width: number, isSelected: boolean): string[] {
  const lines: string[] = [];
  const innerWidth = width - 2;
  const rows = getCardRows(agent);

  const styleBorder = isSelected
    ? (s: string) => theme.fg("accent", s)
    : (s: string) => theme.fg("dim", s);

  // isStreaming is treated as stale if lastActivity is older than STALE_STREAMING_MS
  const isActuallyStreaming =
    agent.isStreaming &&
    !!agent.lastActivity &&
    Date.now() - new Date(agent.lastActivity).getTime() < STALE_STREAMING_MS;

  // --- Top border with inline status + branch ---
  const statusText = agent.isOrphan
    ? "  "
    : isActuallyStreaming
    ? theme.fg("warning", "● busy ")
    : theme.fg("success", "○ idle ");
  const branchText = agent.branch
    ? isSelected ? theme.bold(agent.branch) : agent.branch
    : theme.fg("muted", "(no branch)");

  const headerInner = " " + statusText + branchText + " ";
  const dashCount = Math.max(0, innerWidth - visibleWidth(headerInner));
  lines.push(styleBorder("┌") + headerInner + styleBorder("─".repeat(dashCount)) + styleBorder("┐"));

  // --- Inner rows ---
  for (const { label, value, styleFn } of rows) {
    const labelStyled = theme.fg("muted", label.padEnd(LABEL_W));
    const valAvail = Math.max(8, innerWidth - LABEL_W - 3);
    const truncated = truncate(value, valAvail);
    const valueStyled = styleFn ? styleFn(truncated) : truncated;
    const content = "  " + labelStyled + " " + valueStyled;
    const padding = Math.max(0, innerWidth - visibleWidth(content));
    lines.push(styleBorder("│") + content + " ".repeat(padding) + styleBorder("│"));
  }

  // --- Bottom border ---
  lines.push(styleBorder("└") + styleBorder("─".repeat(innerWidth)) + styleBorder("┘"));

  return lines;
}

// --- Scroll helpers ---

function adjustScroll(agents: AgentInfo[], selectedIndex: number, scrollOffset: number, viewportLines: number): number {
  if (agents.length === 0) return 0;
  if (selectedIndex < scrollOffset) return selectedIndex;

  // Check if selected card is past the visible bottom
  let linesUsed = 0;
  let i = scrollOffset;
  while (i < agents.length) {
    const h = cardHeight(agents[i]) + CARD_GAP;
    if (linesUsed + h > viewportLines && i > scrollOffset) break;
    linesUsed += h;
    i++;
  }
  // i is now the first invisible card index
  if (selectedIndex < i) return scrollOffset; // selected is visible, no change

  // Scroll forward: find scrollOffset that makes selected the last visible card
  let newOffset = selectedIndex;
  let budget = viewportLines - cardHeight(agents[selectedIndex]) - CARD_GAP;
  while (newOffset > 0 && budget >= cardHeight(agents[newOffset - 1]) + CARD_GAP) {
    newOffset--;
    budget -= cardHeight(agents[newOffset]) + CARD_GAP;
  }
  return newOffset;
}

// --- Extension ---

export default function commandCenterExtension(pi: ExtensionAPI) {
  pi.registerCommand("cc", {
    description: "Open the command center — view all agent workspaces and statuses",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Command center requires interactive mode", "error");
        return;
      }

      mkdirSync(CC_STATE_DIR, { recursive: true });

      await ctx.ui.custom(
        (tui, theme, _kb, done) => {
          const myCwd = ctx.cwd;
          let agents: AgentInfo[] = [];
          let selectedIndex = 0;
          let scrollOffset = 0;
          let refreshTimer: ReturnType<typeof setInterval> | null = null;
          let lastRefreshed = "";

          function refresh() {
            const prev = agents[selectedIndex];
            agents = buildAgentList().filter((a) => a.workspace !== myCwd);

            // Try to preserve selection by matching workspace path
            if (prev) {
              const idx = agents.findIndex((a) => a.workspace === prev.workspace);
              if (idx !== -1) selectedIndex = idx;
            }
            selectedIndex = Math.min(selectedIndex, Math.max(0, agents.length - 1));
            scrollOffset = adjustScroll(agents, selectedIndex, scrollOffset, (process.stdout.rows ?? 40) - CHROME_LINES);
            lastRefreshed = new Date().toLocaleTimeString();
            tui.requestRender();
          }

          refresh();
          refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

          const component = {
            dispose() {
              if (refreshTimer) clearInterval(refreshTimer);
            },

            invalidate() {},

            render(width: number): string[] {
              const viewportLines = (process.stdout.rows ?? 40) - CHROME_LINES;
              const raw: string[] = [];
              const cardWidth = Math.max(width - 2, 20); // 1-space side margins

              // --- Header ---
              const countStr = agents.length > 0
                ? theme.fg("muted", `  ${selectedIndex + 1}/${agents.length}`)
                : "";
              const refreshStr = lastRefreshed
                ? theme.fg("dim", `  ${lastRefreshed}`)
                : "";
              raw.push(theme.bold(theme.fg("accent", " Command Center")) + countStr + refreshStr);
              raw.push(theme.fg("muted", "─".repeat(width)));

              if (agents.length === 0) {
                raw.push("");
                raw.push("  " + theme.fg("muted", "No agents found. Start pi with cc-reporter.ts installed."));
                raw.push("");
                raw.push("  " + theme.fg("dim", "[r] refresh   [q] close"));
                return raw.map((l) => padLine(l, width));
              }

              // --- Cards ---
              raw.push(""); // top padding before first card

              let linesUsed = 0;
              let i = scrollOffset;
              while (i < agents.length) {
                const h = cardHeight(agents[i]);
                if (linesUsed > 0 && linesUsed + h + CARD_GAP > viewportLines) break;

                const cardLs = renderCard(agents[i], theme, cardWidth, i === selectedIndex);
                for (const line of cardLs) {
                  raw.push(" " + line);
                }
                raw.push(""); // gap between cards
                linesUsed += h + CARD_GAP;
                i++;
              }

              // Scroll indicators
              const moreAbove = scrollOffset > 0;
              const moreBelow = i < agents.length;
              if (moreAbove || moreBelow) {
                const above = moreAbove ? `↑ ${scrollOffset} more` : "";
                const below = moreBelow ? `${agents.length - i} more ↓` : "";
                const indicator = [above, below].filter(Boolean).join("   ");
                raw.push("  " + theme.fg("muted", indicator));
              }

              // --- Footer ---
              raw.push(theme.fg("muted", "─".repeat(width)));
              raw.push(
                theme.fg("dim", " [↑↓] navigate   [enter] focus pane   [r] refresh   [q] close"),
              );

              // Pad every line to the full overlay width so no chat text bleeds through
              return raw.map((l) => padLine(l, width));
            },

            handleInput(data: string) {
              if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
                done(undefined);
                return;
              }
              if (matchesKey(data, "r")) {
                refresh();
                return;
              }
              if (matchesKey(data, Key.up)) {
                if (selectedIndex > 0) {
                  selectedIndex--;
                  scrollOffset = adjustScroll(agents, selectedIndex, scrollOffset, (process.stdout.rows ?? 40) - CHROME_LINES);
                  tui.requestRender();
                }
                return;
              }
              if (matchesKey(data, Key.down)) {
                if (selectedIndex < agents.length - 1) {
                  selectedIndex++;
                  scrollOffset = adjustScroll(agents, selectedIndex, scrollOffset, (process.stdout.rows ?? 40) - CHROME_LINES);
                  tui.requestRender();
                }
                return;
              }
              if (matchesKey(data, Key.enter)) {
                const agent = agents[selectedIndex];
                if (agent?.tmuxPane) {
                  if (agent.tmuxWindow) {
                    spawnSync("tmux", ["select-window", "-t", agent.tmuxWindow], { timeout: 2000 });
                  }
                  const result = spawnSync("tmux", ["select-pane", "-t", agent.tmuxPane], { timeout: 2000 });
                  if (result.status !== 0) {
                    ctx.ui.notify("Could not focus tmux pane", "error");
                  }
                }
                return;
              }
            },
          };

          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
          },
        },
      );

    },
  });
}
