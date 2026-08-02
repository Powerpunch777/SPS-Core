# SPS Desktop UI Brief

## Purpose

This is a working brief for redesigning SPS Desktop with Open Design. It is not
part of the SPS runtime and does not define Core or plugin behavior. Product
contracts remain in the SPS documents and source code.

## Product Context

SPS is a Windows-first, local-first workspace for an AI-enabled team. A Host
computer owns the company data and project sources. Team members may connect
their computers as SPS Nodes and run only the Agents that the Host has granted.

The product is an operational workspace, not a marketing dashboard. Each view
must make the current work, its owner, and the next useful action immediately
legible.

## Primary Users

- Host: creates a workspace, connects Nodes, manages project sources, and
  enables plugins.
- Team member: opens approved workspaces, uses the Agents available to them,
  and sees the work relevant to their projects.
- Plugin builder: develops and tests an optional workflow without changing the
  SPS Core shell.

## Visual Direction

- Calm, clean, desktop-native, and high-trust.
- Use the clarity and focus of the Codex desktop workspace as a reference, not
  as a visual copy.
- Favor a restrained blue SPS accent over decorative gradients.
- Use a light default theme with a complete dark theme. Keep contrast suitable
  for long sessions.
- Prefer dense, scannable operational layouts to oversized cards or empty
  marketing-style surfaces.
- Use the existing SPS logo and product name consistently. Do not expose
  Paperclip branding, terminology, or icons.

## Workspace Layout

### Global Shell

- Left navigation: workspace destinations and current workspace selection.
  It can be collapsed and resized.
- Center: the active task surface. This is the visual priority and owns its
  own scroll area.
- Right context panel: files, changes, related activity, and scoped actions.
  It can be collapsed and resized independently of the center.
- Each main region scrolls independently. A long file/change list must never
  push the conversation composer or central work out of view.

### Rooms and Tasks

- Room pages center the conversation. Messages, live work state, tool output,
  and completion reports are chronological and easy to distinguish.
- Task pages show the task contract and execution state without turning the
  message area into a dense properties sheet.
- Contextual information belongs in the right panel: attached files, changed
  files, related tasks, and activity.
- The composer remains visible at the bottom of the center panel whenever a
  user is allowed to send a message.

### Settings

- Keep Host-only administration within Host settings, not in the everyday
  workspace navigation.
- Server status, Nodes, Agent sources, runtime packs, data export, and plugin
  management are settings surfaces.
- Plugin Discovery & Builder is a workspace destination because it is active
  work. Generic plugin management remains inside Host settings.

## Information Hierarchy

Every primary screen should answer these questions in order:

1. What workspace or project am I in?
2. What needs attention now?
3. What is actively running, blocked, or complete?
4. What action can this user take here?

Use one shared vocabulary across Core screens:

- Workspace, Project, Agent, Task, Room, Node, Source, Plugin, Host.
- Do not use legacy Paperclip terms such as company board, issue, ticket, or
  organization when the SPS term is clearer.

## States and Feedback

- Running work is visible but quiet: compact status, elapsed time, and a
  readable activity trail.
- Blocked work explains the blocker and the required next action.
- Empty states direct the user to one appropriate starting action.
- Errors name the affected operation and preserve the user input where
  possible.
- Destructive or scope-expanding actions require an explicit confirmation.

## Components

- Use the existing token layer in `ui/src/index.css`; do not introduce a
  second token source.
- Reuse shared primitives before creating a new visual pattern.
- Cards frame repeated content, dialogs, and tools. Do not nest cards merely
  to create visual separation.
- Machine values such as IDs, paths, timestamps, usage, and logs use
  monospace styling and copy affordances when appropriate.
- Icons support familiar actions; unfamiliar icon-only controls need a
  tooltip and accessible label.

## Accessibility and Responsive Boundaries

- Target Windows desktop first, including 1366px-wide laptop screens.
- Support narrow desktop widths by collapsing side panels before compressing
  conversation content.
- Preserve keyboard focus, readable text, and WCAG AA contrast in both themes.
- Do not rely on color alone for task, Node, or Agent state.

## Explicit Non-goals

- Do not embed Open Design into SPS.
- Do not redesign Core contracts or plugin boundaries through visual work.
- Do not add a marketplace, workflow automation, or permissions policy merely
  to make a screen look complete.
- Do not use decorative gradients, blurred blobs, excessive rounded cards, or
  marketing-page hero patterns in the product workspace.
