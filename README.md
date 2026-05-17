# pi-command-center

A [pi coding agent](https://pi.ai) extension that gives you a live TUI dashboard of all your running agents across tmux panes and windows.

## Features

- See every agent's workspace, branch, PR, Jira ticket, and last activity at a glance
- Color-coded commit status (green → yellow-green → yellow → amber → red)
- Auto-refreshes every 5 seconds
- Navigate cards with arrow keys; press Enter to jump to that agent's tmux pane/window
- Associate a Jira ticket with any workspace via `/cc-ticket PROJ-123`

## Requirements

- [pi coding agent](https://pi.ai) with extension support
- tmux (for pane/window navigation)
- `gh` CLI (optional — for PR display)

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/DanGreinke/pi-command-center/main/install.sh | bash
```

This clones the repo to `~/pi-command-center` and symlinks both extension files into `~/.pi/agent/extensions/`. Restart pi and both extensions load automatically.

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

Both files must be installed. `cc-reporter.ts` runs silently in every pi instance and writes state to `~/.pi/agent/cc-state/`. `command-center.ts` reads that state and renders the TUI.

| Command | Effect |
|---|---|
| `/cc` | Open the command center overlay |
| `/cc-ticket PROJ-123` | Associate a Jira ticket with the current workspace |
| `/cc-ticket` | Clear the Jira ticket for the current workspace |

### Keyboard shortcuts (inside `/cc`)

| Key | Action |
|---|---|
| `↑` / `↓` | Navigate between agent cards |
| `Enter` | Focus that agent's tmux pane (switches window if needed) |
| `r` | Refresh data immediately |
| `q` / `Esc` | Close the command center |

## How it works

`cc-reporter.ts` is a companion extension installed in every pi instance. It listens to pi lifecycle events (`session_start`, `turn_start`, `turn_end`, etc.) and writes a JSON state file to `~/.pi/agent/cc-state/<workspace>.json` after each event. A separate config file in `~/.pi/agent/cc-config/` stores the Jira ticket association and survives agent restarts.

`command-center.ts` registers the `/cc` command. When opened, it reads all state files, cross-references live tmux panes (to pick up non-pi terminals as "orphan" cards), fetches open PRs via `gh`, and renders the dashboard.
