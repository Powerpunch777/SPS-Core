# SPS Core Direction and Roadmap

This document records SPS Core product direction, not the upstream Paperclip
product roadmap and not a claim that the user's broader implementation goal is
currently active. The normative source is
[`doc/SPS-CORE-CONTRACT.md`](doc/SPS-CORE-CONTRACT.md), aligned to the
user-reaffirmed 2026-10-25 Core–Plugin architecture on 2026-11-02. This bounded
documentation task does not resume that broader goal.

## Product Direction

- Keep Core workflow-neutral. AI, Agents, Tasks, Dashboard, Inbox, collaboration
  and common plugin navigation are optional. Empty Workspaces and non-AI plugins
  are valid.
- Install each plugin package once per Host; keep activation and plugin-owned
  data/settings independent per Workspace. Allow zero or one Primary UI plugin
  and any number of Extensions. Primary is not a privilege tier. Extensions may
  be full-screen, headless, background, or independent-window plugins.
- Keep Native System UI, Plugin management, security, recovery, and updates
  independent of plugin UI. A plugin does not have to expose or embed Core
  navigation.
- Support local standalone operation; remote Host/Member/Node connectivity is
  optional. Keep multiple Workspaces operational without one Workspace's UI
  state controlling another's work.
- Persist Workspace pause/stop state. Pause blocks new work while existing work
  continues; stop cancels managed work in that Workspace; resume does not
  automatically replay canceled or uncertain work. Do not infer process exit
  from a stop request or database status alone.
- Make maximum file-access bounds optional. The target bound applies to plugin
  code and its CLI/child processes when configured; without a bound, ordinary OS
  user access applies, except Core Secret Vault material remains protected.
  Same-user execution is not an OS sandbox; enforcement remains unproven until
  verified at the OS boundary. Resource observation does not imply quotas or
  automatic shutdown.
- Keep update application a manual user decision. Scope reset and backup to
  Core-managed plugin data; external project files are not implicitly included
  or deleted, and credentials are excluded by default. State actual export and
  restore gaps honestly.
- Treat the generic public Plugin Builder as optional. The separate public
  SPS-MY-PluginBuilder v15 design is a reference solution for Builder workflows,
  not Core product authority. Existing SDK contracts remain; completing common
  Preview lifecycle capabilities is future work. Do not invent API support or licensing terms.
- Do not treat public Marketplace/discovery/ecosystem goals as retired by the
  superseded 2026-10-28 personal-only scope note. This direction does not claim
  those features are implemented. Retired legacy Marketplace Assistant
  credentials and contexts remain denied.

## Implementation Status

The architecture is a target. Current implementation is partial, and the wider
goal has not been resumed by this documentation update. The Core contract's
implementation/evidence passages and focused tests describe only what has been
verified; they must not be generalized into completion claims.

Known target areas that require implementation evidence before being called
complete:

- Workspace-specific Primary/Extension selection and standalone presentation,
  with no forced sidebar, Dashboard or Inbox.
- Durable pause/stop/resume across restart, exact Workspace impact, and no
  automatic replay of canceled or uncertain work.
- OS-enforced optional file bounds for plugin processes and descendants, plus
  Vault isolation even when broad user-file access is allowed.
- Accurate attribution/observation of per-Workspace and shared-process resource
  use without introducing automatic quotas.
- Complete scoped backup/reset/restore behavior with default credential
  exclusion and explicit handling of external files.
- Common SDK/Preview contracts, if and when separately designed and authorized.
- Optional public Builder and broader package discovery/ecosystem workflows;
  package trust signals must describe their actual evidence, not promise safety.

## Security Reference

Electron surfaces must be evaluated against the official
[Electron Security guide](https://www.electronjs.org/docs/latest/tutorial/security).
It recommends not enabling Node.js integration for remote content, enabling
context isolation and renderer sandboxing, validating IPC senders, and limiting
navigation and new windows. This is reference guidance, not evidence that these
controls have been audited or implemented in SPS.
