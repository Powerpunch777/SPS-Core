# Workplane Plugin Guide

## Purpose

SPS Core is an Agent Platform, not a fixed company workflow. A Workplane plugin
turns the neutral Core objects into a concrete operating model such as a
manager-to-worker studio, an OpenHands-style coding loop, or a research queue.

The Core owns identity, authorization, projects, work-item lifecycle, agent
runs, backend selection, provider discovery, and extension contracts. A
Workplane plugin owns its workflow vocabulary, room layout, task creation
rules, artifacts, and UI. Core must never import a Workplane by plugin id.

## Start From The Template

```bash
pnpm create-paperclip-plugin @acme/my-workplane \
  --template workplane \
  --output ./plugins
```

The template declares this extension identity:

```ts
agentPlatform: {
  contractVersion: "1.0",
  kind: "workplane",
  profileKey: "acme.my-workplane-profile"
}
```

`profileKey` is stable product metadata, not a database id and not a secret.
It can be shown by installers and used by deployment configuration without the
Core learning the plugin's private implementation details.

## Boundary Rules

1. Use the Agent Platform contract for references to organization, project,
   work item, thread, run, agent, backend, and artifact.
2. Keep workflow-specific state in the plugin's state/database namespace.
3. Declare only the capabilities actually used by the plugin.
4. Treat `agentToolAccess: "explicit_grant"` as mandatory for any connector
   that can change external state or reveal sensitive material.
5. Use Core project and agent authorization as the source of truth. Do not
   recreate a second permission system inside a Workplane plugin.
6. Never encode a plugin id in Core routes, migrations, or UI conditions.

## Memory Lifecycle Handoff

When a Workplane has a durable Room, Task, or artifact boundary, publish a
structured reference through Core rather than writing directly to a provider:

```ts
await ctx.memory.publishLifecycle({
  eventType: "room.checkpoint",
  companyId,
  entityType: "room",
  entityId: roomId,
  roomId,
  idempotencyKey: `room:${roomId}:room.checkpoint:${checkpointVersion}`,
});
```

This requires `memory.lifecycle.publish`. The payload contains identifiers only:
never include a chat transcript, checkpoint summary, prompt, secret, or provider
specific data. Core validates the event, selects the company's provider, and
keeps an idempotent delivery audit. The provider decides retention, recall, and
whether it creates a reviewable memory candidate.

For background work that finishes after an action invocation has ended, use a
declared job to reconcile the most recent durable checkpoint. Do not keep a
stale action context or call a provider's storage API directly.

## Runtime Visibility Profile

The Core can optionally expose a neutral room/task visibility profile through
deployment variables:

```text
SPS_WORKPLANE_MODE=true
SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES=plugin:acme.my-workplane:agent-room
SPS_WORKPLANE_DEFAULT_PROJECT_TAB=plugin:acme.my-workplane:project-workplane
```

These values are a host deployment mapping. They are not a substitute for the
plugin manifest and must not be used to grant authority.

## Acceptance Checklist

- The plugin is discoverable from `GET /api/plugins/agent-platform/extensions`.
- Work-item and room/task rules stay in the plugin.
- Disabling the plugin leaves Core projects, agents, and task records intact.
- Plugin-owned data can be removed without deleting Core records.
- All external tools use declared capabilities and their appropriate Core
  access policy.
- Memory lifecycle publication is content-free, idempotent, and uses the Core
  selection path rather than a provider-specific HTTP client.
