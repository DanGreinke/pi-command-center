# pi-command-center

A [pi coding agent](https://pi.dev/) extension that gives you a live TUI dashboard of all your running agents across tmux panes and windows, plus a supervisor agent that can observe and delegate to them.

## Features

- See every agent's workspace, branch, PR, Jira ticket, and last activity at a glance
- Color-coded commit status (green → yellow-green → yellow → amber → red)
- Auto-refreshes every 5 seconds
- Navigate cards with arrow keys; press Enter to jump to that agent's tmux pane/window
- Associate a Jira ticket with any workspace via `/cc-ticket PROJ-123`
- **Supervisor agent** — chat with a dedicated pi session that can see all agents and send them instructions

## Requirements

- [pi coding agent](https://pi.dev/) with extension support
- tmux (for pane/window navigation)
- `gh` CLI (optional — for PR display)

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/DanGreinke/pi-command-center/main/install.sh | bash
```

This clones the repo to `~/pi-command-center` and symlinks all extension files into `~/.pi/agent/extensions/`. Restart pi and the extensions load automatically.

### Manual

```bash
git clone https://github.com/DanGreinke/pi-command-center.git ~/pi-command-center
cd ~/pi-command-center && bash install.sh
```

### Updating

```bash
cd ~/pi-command-center && git pull
```

The symlinks pick up changes immediately — no re-install needed. Restart pi to reload the extensions.

### Custom install location

Set `PI_CC_DIR` to override the default `~/pi-command-center`:

```bash
PI_CC_DIR=~/code/pi-command-center curl -fsSL https://raw.githubusercontent.com/DanGreinke/pi-command-center/main/install.sh | bash
```

## Usage

### Dashboard (`/cc`)

Open the command center overlay from any pi session:

| Command | Effect |
|---|---|
| `/cc` | Open the command center overlay |
| `/cc-ticket PROJ-123` | Associate a Jira ticket with the current workspace |
| `/cc-ticket` | Clear the Jira ticket for the current workspace |

#### Keyboard shortcuts (inside `/cc`)

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate between agent cards |
| `Enter` | Focus that agent's tmux pane (switches window if needed) |
| `r` | Refresh data immediately |
| `q` / `Esc` | Close the command center |

### Supervisor agent

Open a dedicated pi session in its own tmux pane to act as a supervisor. It has access to three tools the model can call:

| Tool | What it does |
|---|---|
| `list_agents` | Summarize all running agent sessions — workspace, branch, status, Jira ticket, last activity |
| `get_agent_detail` | Full state for a specific workspace |
| `send_to_agent` | Inject a message into another agent's chat as a user turn |

**Example prompts in the supervisor session:**

- *"What is everyone working on right now?"*
- *"Tell the change-calculator agent to write unit tests for the core module"*
- *"Summarize the status of all agents and flag anything that looks stuck"*

When `send_to_agent` is called, the message is written to a per-workspace inbox file. The target agent's `cc-reporter` picks it up within 500ms and injects it as a new user turn — queued after the current task if the agent is busy.

## How it works

Three extension files are installed:

**`cc-reporter.ts`** runs silently in every pi instance. It listens to pi lifecycle events (`session_start`, `turn_start`, `turn_end`, etc.) and writes a JSON state file to `~/.pi/agent/cc-state/<workspace>.json`. It also polls `~/.pi/agent/cc-inbox/<workspace>.json` every 500ms for incoming supervisor commands, injecting any found message as a user turn via `pi.sendUserMessage()`. A separate config file in `~/.pi/agent/cc-config/` stores the Jira ticket association and survives agent restarts.

**`command-center.ts`** registers the `/cc` command. When opened, it reads all state files, cross-references live tmux panes (to pick up non-pi terminals as "orphan" cards), fetches open PRs via `gh`, and renders the full-screen dashboard.

**`cc-supervisor.ts`** registers the `list_agents`, `get_agent_detail`, and `send_to_agent` tools in every pi session. These are most useful in a dedicated supervisor session but are available everywhere.
