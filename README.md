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

```bash
git clone <repo-url> ~/pi-command-center
cd ~/pi-command-center
bash install.sh
```

Restart pi. Both extensions load automatically on next start.

To update after a `git pull`, no re-install is needed — the symlinks pick up changes immediately (a pi restart is still required).

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
