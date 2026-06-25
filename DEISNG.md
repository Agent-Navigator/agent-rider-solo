# Agent Workspace UI Design

> Current design note for the chat-first, blank-canvas Agent Workspace app.

## Product concept

This app is a **blank-canvas, chat-first workspace** for the Agent Era.

The UI starts minimal:
- only a single chat composer is visible
- no heavy navigation, no gateway controls, no dense dashboards
- the user types one message, and the workspace grows from that interaction

The experience should feel like a workspace that **comes alive from conversation**.

---

## Core information model

The app uses the following hierarchy:

```text
Category (taxonomy / tags)
  └─ Project
      └─ Workspace (disk folder + execution context)
          └─ Task (user-defined intent)
              └─ Job (automation / schedule / background / worker run)
```

### Definitions

- **Category**: top-level taxonomy, usually a label family such as Work, Life, Family, Infrastructure, or Research.
- **Project**: a long-term scope or initiative.
- **Workspace**: the actual execution environment, often backed by a local folder or repo path.
- **Task**: the specific intent the user wants the agent to do.
- **Job**: a concrete execution instance, such as an automated run, scheduled run, retry, or worker execution.

---

## Resource model

The app also maintains a **Resource view** for reusable context and credentials.

Resources can include:
- email accounts / credentials
- chat app accounts: Line, Telegram, WhatsApp
- website accounts: Cloudflare, Google, MS365
- API tokens: LLM, Telegram Bot, third-party APIs
- DB connections
- documents: Google Docs, NAS, internal docs
- networking assets: SSH keys, Tailscale information
- AI agents: Codex, Claude Code, Antigravity, etc.
- remote servers: SSH config / host definitions

### Resource behavior

Resources should be:
- reusable
- assignable to projects and tasks
- visible in a dedicated resource panel or list
- editable / expandable later without changing the core hierarchy

---

## Interaction model

### Initial state

When the app first opens:
- the page is mostly blank
- only the chat input is visible
- the user should immediately understand that the app is waiting for an intent

### After the first message

Once the user sends a message:
- the canvas expands
- a conversation transcript appears
- one or more hierarchy cards are created
- the Resource view becomes visible
- the UI begins to show the agent workspace structure

### Ongoing behavior

After the first interaction, the app should feel like a live system:
- message history grows
- the hierarchy becomes richer with each task
- resources are attached to runs, tasks, or workspaces
- the interface can show progress, status, and outcomes

---

## Hermes integration

The current design assumes Hermes is the execution backend.

### Runtime approach
- chat input forwards messages to Hermes
- Hermes creates or resumes a session
- prompt submission triggers agent execution
- streamed events update the transcript / status state

### Preferred behavior
- keep Hermes integration **read-only** in the UI surface by default
- do **not** expose gateway control actions unless explicitly required
- if Hermes is busy, queue the next prompt locally and replay it after the current turn completes

### Important rule

The UI should feel like it is connected to a live agent runtime, but the product surface should remain simple and calm.

---

## Layout principles

### Visual style
- dark, restrained palette
- low-noise surfaces
- subtle borders and shadows
- generous spacing
- readable typography
- chips and labels should be compact and consistent

### Desktop
- main content should use a balanced multi-panel layout after the first message
- the hierarchy and resource view should feel like natural outgrowths of the conversation
- keep one clear primary focus area

### Mobile
- single-column stacked layout
- content should compress gracefully
- avoid cramped grids
- use collapsible sections or cards where needed
- keep the composer easy to reach

---

## Recommended page structure

### Blank state
- Centered or near-centered minimal canvas
- short explanation copy
- one chat composer

### Active state
- conversation / transcript panel
- hierarchy panel showing:
  - Category
  - Project
  - Workspace
  - Task
  - Job
- resource panel / resource list
- connection or session status, if shown, must remain read-only
- composer fixed at the bottom or in a stable position

---

## User experience goals

The design should feel:
- calm
- intelligent
- capable
- not cluttered
- not like a traditional dashboard
- not like a chat app with extra noise

The UI should communicate:
- the agent is working
- the structure is growing
- resources are being organized
- the user stays in control through conversation

---

## What the UI must avoid

- gateway control buttons
- overly dense tab bars
- too many simultaneous panels on first load
- premature disclosure of complex controls
- visual noise from too many borders, shadows, or colors
- compressed mobile layouts

---

## Implementation notes

- Keep the first version shallow and readable.
- Favor progressive disclosure over static complexity.
- Make the blank canvas elegant.
- Let the hierarchy emerge from chat, not from navigation.
- Keep the resource system distinct from task content.
- Keep Hermes integration separate from the visual model.

---

## Status

This document describes the **current design direction** of the app:

- blank canvas first
- chat-driven growth
- Category → Project → Workspace → Task → Job hierarchy
- dedicated resource view
- Hermes-connected runtime behavior
- no gateway control surface

---

## Notes for future iteration

Future versions may add:
- richer session detail
- resource assignment editing
- task approval flows
- better artifact preview
- workspace switching
- automation templates
- Web Terminal
- Web App preview via iframe for development
- Resource creation and management

These features should continue to support the same product direction:

- the app starts blank
- the workspace grows from conversation
- the hierarchy emerges progressively
- resources remain reusable and assignable
- the UI stays calm, readable, and productivity-focused

Those additions should preserve the current principle:

> start blank, grow from conversation, stay calm and readable.
