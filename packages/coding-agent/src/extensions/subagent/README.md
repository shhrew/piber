# Subagents

A built-in extension that lets the model delegate tasks to subagents. Each subagent runs as a separate `pi --mode rpc` process with its own system prompt, tools, skill groups, and session file. Its work stays out of the parent's context; the parent gets the final answer.

## Agents

An agent is a Markdown file. The body is the agent's own system prompt; Pi's default prompt is not included. Every subagent's prompt starts with the [global subagent prompt](#global-subagent-prompt).

```markdown
---
name: symfony-dev
description: Implements Symfony features
model: anthropic/claude-sonnet-4-5   # optional; without it the parent's model and thinking level are used
tools: [edit, write, bash]            # added to the core tools
skillGroups: [php, testing]           # skill groups the agent can search
pinnedSkills: [symfony]               # optional; always listed in the agent's prompt
canMessage: [orchestrator, subagents] # optional; who it may message over chat (see Chat)
---

You are a Symfony developer...
```

`tools`, `skillGroups`, `pinnedSkills`, and `canMessage` accept a YAML list or a comma-separated string.

### Global subagent prompt

`system-prompt.md` in this directory goes at the start of every subagent's prompt: what working as a subagent means, and how to use chat. A trusted project's `.pi/subagents/system-prompt.md` is appended to it. The full prompt is the global prompt, then the agent's own prompt, then its skills section, then a generated chat section with the subagent's chat name and who it may message.

Agents are loaded from two places:

| Location | When |
|---|---|
| `agents/*.md` in this directory | Always. Ships with the fork: `scout`, `planner`, `reviewer`, `worker`. |
| `.pi/subagents/agents/*.md` in the project or an ancestor directory | Only when the project is trusted. Replaces a bundled agent with the same name. |

## Tools

A subagent gets, in order:

1. The core tools from `config.json` in this directory (`read`, `grep`, `find`, `ls`). A trusted project can replace them with `.pi/subagents/config.json`.
2. The agent's `tools`.
3. The call's `extraTools`.
4. `skill_search` and `load_skill`, when the agent has skill groups.

Extension and MCP tools work when the child process loads the same extensions. The `subagent` tool is never passed to a subagent, so subagents cannot start further subagents.

## Skills

Subagent skills are grouped by directory and are separate from the main session's skills:

```
skills/<group>/<skill>/SKILL.md                 (bundled, in this directory)
.pi/subagents/skills/<group>/<skill>/SKILL.md   (trusted projects; adds to the bundled group)
```

A skill uses the usual `SKILL.md` frontmatter plus `tags`:

```markdown
---
name: symfony
description: Symfony 7 controllers, services, DI config, and console commands.
tags: [php, symfony]
---
```

- `name` and `description` follow the [Agent Skills](https://agentskills.io/specification) rules. A skill without a description is skipped. Other problems produce warnings, which the parent shows as notifications.
- `tags` is a list or a comma-separated string, lowercased. `metadata.tags` (a comma-separated string, valid under the Agent Skills spec) is merged in.
- The group comes from the directory. To put a skill in two groups, symlink it into both.

Skills are not pasted into the subagent's prompt. The prompt names the tags available in the agent's groups and lists its pinned skills. The subagent then:

- calls `skill_search` with a query and/or tags. Results are ranked by matching tags, then name matches, then text relevance, and each result has the skill's name, description, and tags. With no query, it lists every skill in its groups.
- calls `load_skill` to read one skill's instructions. It refuses skills outside the agent's groups.

`load_skill` limits what the subagent is pointed to. It is not a sandbox: an agent with `read` or `bash` can still read any file.

## The `subagent` tool

| Mode | Parameters |
|---|---|
| Single | `agent`, `task` |
| Parallel | `tasks: [{ agent, task }, ...]` (at most 8 per call; how many run at once is set by `maxConcurrent`) |
| Chain | `chain: [{ agent, task }, ...]`, where `{previous}` in a task is replaced by the previous step's output |
| Continue | `session` (a subagent's name, or a session file path plus `agent`), `task` |

Every new subagent also takes `name` and `description`, at the top level in single mode or per task:

- `name` is one word, such as `auth-scout`. It is lowercased and reduced to letters, digits, `-`, and `_`, and becomes the subagent's id: the agent view lists it, and `session` uses it to continue the subagent. A name already used in this session gets `-2`, `-3`, and so on. Without a name, the agent name is used.
- `description` says what the subagent is doing in 2-4 words, such as `Map auth flow`. Without one, the first words of the task are used.

Every mode accepts `cwd`, `extraTools`, and `extraSkillGroups`, at the top level or per task, and `background` at the top level (see [Background subagents](#background-subagents)).

## Background subagents

By default a `subagent` call runs in the foreground: it returns when its subagents finish, and the orchestrator waits. With `background: true` (or `defaultMode: "background"` in the config), the call starts its subagents and returns at once with their names, and the orchestrator keeps working. A background chain starts its later steps as earlier ones finish.

Four tools manage background subagents:

| Tool | Parameters | Returns |
|---|---|---|
| `subagent_wait` | `names` (optional), `returnOnFirst` (optional, default `false`) | Each target's status once all of them have finished, or, with `returnOnFirst`, once the first has. Without `names`, it waits for every subagent still running or queued, including later chain steps. A chat message to the orchestrator ends the wait early, with the targets' status; the message follows the result, and the orchestrator can answer it, change direction, or call `subagent_wait` again. The chat shows `Wait(all)` or `Wait(any)`. |
| `subagent_result` | `names` (one or more) | Each finished subagent's final answer, or its error, capped at 50 KB each. Running and queued subagents have no result yet; a call that returns no result at all is an error, so the orchestrator notices it asked too early. |
| `subagent_list` | none | Every subagent in the session: running, queued (waiting for a free slot), paused, or finished, with whether its result has been read. |
| `subagent_control` | `action`, `names`, `message` (optional) | Pause, resume, start now, terminate, or ask for a handback (see [Controlling subagents](#controlling-subagents)). |

A subagent is `queued` only while it waits for a free slot (see `maxConcurrent`); one that finds a free slot starts at once.

### Controlling subagents

`subagent_control` lets the orchestrator manage its subagents while they work, mainly when slots are scarce or a subagent's findings change the plan. It takes `action`, `names` (one or more), and an optional `message`, a note passed to the subagent on `resume`, `start`, and `handback`. Names are handled one at a time, in order.

| Action | Applies to | What happens |
|---|---|---|
| `pause` | running, queued | The child process stops (its current turn is aborted) and its slot goes to the next queued subagent. The session file is kept. Chat messages to it are held until it resumes. |
| `resume` | paused | A new process continues the session, told that it was paused and to rerun an interrupted tool call. It takes the next free slot, or queues. A subagent paused before its task reached it gets the task instead. |
| `start` | queued, paused | Starts it at once, ahead of the queue, even when every slot is busy. |
| `terminate` | running, queued, paused | Stops it for good, as `aborted`. Its session can still be continued with `session`. |
| `handback` | running, paused | Asks it to stop and end with a report of what it has so far: a steer for a running subagent (seen after its current tool call), a resume for a paused one. The report is its result, read like any other. |

**Start now and the limit.** The queue is first-come, so a slot freed by `pause` goes to the queue's head, not to a chosen subagent. `start` skips the queue and runs past `maxConcurrent`; no queued subagent starts until running ones drop below the limit again. To start a chosen subagent within the limit, `start` it first, then `pause` another: the freed slot covers the one that started early.

```
start w6   →  w1 w2 w3 w4 w6 running (5 of 4), w5 queued
pause w1   →  w2 w3 w4 w6 running (4 of 4), w5 still queued, w1 paused
```

A paused subagent is neither running nor finished. `subagent_wait` does not wait for it, since it only continues once resumed, and says which targets are paused. `subagent_result` has no result for it yet. A pause does not end its background run, so it gets no completion notice until it finishes after a resume, and a background chain waits on a paused step. Subagents of a foreground `subagent` call cannot be paused: the call would wait for the resume, which the orchestrator cannot send while that call holds its turn. A subagent that runs without a session file (`--no-session`) cannot be paused once its task has reached it.

When a background subagent finishes and no wait or result call has reported it, the orchestrator is told, as `onBackgroundComplete` sets. Subagents that finish within half a second of each other share one notice. The notice gives each subagent's status and points to `subagent_result`; it never includes the output.

While the orchestrator is working, notices are held until its run settles. A message posted mid-run would only be delivered at the end of the run, after the orchestrator may already have read those results; holding it lets the extension drop subagents that a wait or result call reported in the meantime, and post nothing if none are left.

In the chat, a background call's rows keep updating after the call returns. A wait for all or any subagents shows only its call line (`● Wait(all) · waiting for a subagent to finish`); a wait for two or more named subagents shows the mode and adds one row each with the name and description while it waits; a wait for one subagent names it on the call line (`● Wait(scout-a) · waiting for it to finish`). A finished wait is always a single line, such as `● Wait(any) · done waiting`. Background subagents stop when the session ends; after a resume, their rows show `Started in background`.

## Chat

Agents in a session can send each other short messages, so a swarm can share findings and steer each other while it works: the orchestrator to a subagent, a subagent to the orchestrator, a subagent to another subagent, or anyone to everyone at once.

| Tool | Parameters | Use |
|---|---|---|
| `chat_send` | `to`: a subagent's name, `orchestrator`, or `all`; `text`; `waitForReply` (optional); `timeoutSeconds` (optional) | Send a message. With `waitForReply`, block until the recipient answers or the timeout passes. |
| `chat_peers` | none | List who the caller may message, with what each subagent is doing and whether it is still running. |

**Permissions.** An agent's `canMessage` says whom it may send to: `orchestrator`, `subagents` (any other subagent by name), and `all` (both, plus broadcasting with `to: "all"`). Agents without `canMessage` use `chat.defaultCanMessage`; the orchestrator uses `chat.orchestratorCanMessage`. An agent that may not send still receives messages. Subagents get `chat_send` and `chat_peers` only when they may send.

**Delivery.**

| Recipient | What happens |
|---|---|
| A running subagent | Gets the message after its current tool call. |
| A queued subagent | The message is held and delivered when it starts; the sender is told. |
| A paused subagent | The message is held and delivered when it resumes; the sender is told. |
| A finished subagent | The send is refused. |
| The orchestrator | Gets the message after its current tool call while it works; when it is idle, the message starts a turn. |
| `all` | Every running, queued, or paused subagent except the sender, and the orchestrator when a subagent sends it. |

Recipients see a message wrapped in a tag, followed by a line saying whether the sender waits for a reply, so their model does not mistake it for the user:

```
<agent_message from="scout-a" to="you" awaiting_reply="false">
Found it in src/a.ts
</agent_message>
Reply with chat_send only if it is needed.
```

`to` is `you` or `all`. Other messages the system sends in the user role are tagged the same way: background completion notices as `<system_notice from="subagents">`, and resume and handback requests as `<subagent_control action="resume">` or `action="handback"`, with the orchestrator's `message` inside as `<note from="orchestrator">`.

**Waiting for a reply.** With `waitForReply`, the sender blocks until the recipient's next message to it, up to `timeoutSeconds` (default `chat.replyTimeoutSeconds`, at most `chat.maxReplyTimeoutSeconds`). While an agent waits it cannot read messages the normal way, so any other message to it ends the wait and is returned in the tool result instead. That also resolves two agents waiting on each other. A timeout leaves the message delivered; a later reply arrives as a normal message. `waitForReply` cannot be used with `to: "all"`.

**Limits.** Messages longer than `chat.maxMessageLength` are refused, and so are sends beyond `chat.maxMessagesPerMinute` per agent.

**Display.** Messages are drawn as bubbles. The current agent is always on the right of the label, so the arrow shows the direction: a received message sits on the left as `scout-a → orchestrator`, a sent one on the right as `worker ← orchestrator`, with its outcome (`✓ delivered`, `◷ held until worker starts`, `✗ not sent: …`) under it and the reply, if it waited for one, as a received bubble below. When the sender is waiting for a reply, the received bubble's border says `waiting for your reply` in the warning color until the sender stops waiting, then `asked for a reply`. The recipient's model is told the same: the sender is blocked until it answers, so it should reply, even if only to acknowledge. The main chat shows the orchestrator's messages, collapsed to 6 lines until expanded; the agent view shows a subagent's messages in full.

```
 ╭─ scout-a → orchestrator ──────────────╮
 │ Is the session token cached anywhere? │
 ╰────────────── waiting for your reply ─╯

                         ╭─ scout-a ← orchestrator ─╮
                         │ Yes, in src/cache.ts     │
                         ╰──────────────────────────╯
                                          ✓ delivered
```

**How it works.** The parent runs a chat hub on a local socket (a Unix socket in a private temporary directory, or a named pipe on Windows) and gives each subagent process the socket path and a secret token (in the `PI_SUBAGENT_CHAT_TOKEN` environment variable). The hub checks every message's permissions and limits, so a subagent cannot impersonate another or go past its `canMessage`.

## Configuration

`config.json` in this directory sets defaults for every subagent. A trusted project can override any field in `.pi/subagents/config.json`.

```json
{
	"coreTools": ["read", "grep", "find", "ls"],
	"maxConcurrent": 4,
	"defaultMode": "foreground",
	"onBackgroundComplete": "wake",
	"chat": {
		"enabled": true,
		"defaultCanMessage": ["orchestrator"],
		"orchestratorCanMessage": ["subagents", "all"],
		"maxMessageLength": 4000,
		"maxMessagesPerMinute": 10,
		"replyTimeoutSeconds": 120,
		"maxReplyTimeoutSeconds": 600
	}
}
```

| Field | Meaning |
|---|---|
| `coreTools` | Tools every subagent gets (see [Tools](#tools)). |
| `maxConcurrent` | How many subagent processes may run at once in a session. It must be a positive integer; other values are ignored. |
| `defaultMode` | `"foreground"` or `"background"`: how a `subagent` call runs when it does not set `background`. |
| `chat` | Subagent chat (see [Chat](#chat)): `enabled`; `defaultCanMessage` for agents without `canMessage`; `orchestratorCanMessage`; `maxMessageLength` in characters; `maxMessagesPerMinute` per agent; `replyTimeoutSeconds` and `maxReplyTimeoutSeconds` for `waitForReply`. A project's `chat` object overrides individual fields. |
| `onBackgroundComplete` | What happens when a background subagent finishes and nothing has reported it: `"wake"` posts a notice at once, starting a turn if the orchestrator is idle or queuing it after the current one; `"notify"` posts it with the next turn; `"silent"` posts nothing, leaving the result to `subagent_wait` and `subagent_result`. |

`maxConcurrent` covers every subagent the session starts: parallel tasks, separate `subagent` calls, `session` continuations, and follow-ups sent from the agent view. A subagent beyond the limit waits in a queue with the status `queued` (`◷`), and starts in order when a running one finishes. Esc in the agent view, or aborting the parent's tool call, removes it from the queue. A queued subagent cannot be steered until it starts. The orchestrator can reorder this with `subagent_control` (see [Controlling subagents](#controlling-subagents)). The limit is read again before each run, so editing `config.json` takes effect for the next subagent.

## Sessions

Each subagent keeps a normal Pi session file in `<parent session dir>/subagents/<parent session id>/`, named `<name>: <description>`. The tool result tells the parent model the subagent's name so it can send a follow-up with `session`. You can open any subagent session later with `pi --session <path>`. When the parent runs without a session file (`--no-session`), subagents do not keep one either.

The child process runs only while the subagent works. A follow-up starts a new process on the same session file.

## In the main session

The main chat shows each `subagent` call as a compact line with one status row per subagent. Subagent output never appears in the main chat; read it in the [agent view](#agent-view).

```
● Subagents · 2 in parallel
  ⎿  ✓ scout-a  Read a.txt · Done · 3 turns · 26s
     ⠋ scout-b  Read b.txt · Thinking · 2 turns · 8s
```

The bullet turns green when the call succeeds and red when it fails. A running row shows only a phase, as in the dock: `Thinking`, `Responding`, or `Working`. Clicking the call or pressing Ctrl+O adds the latest command each subagent ran (`→ read a.txt`) under its row. A subagent's task, session, and output are in the agent view.

### Dock

A short list under the composer shows what is happening now: running subagents, then subagents that finished in the last 10 seconds, at most 4 rows. A running row shows only a phase: `Thinking`, `Responding`, or `Working` (calling tools, or between turns). Queued and paused subagents are only counted (`◷ 2 queued · ‖ 1 paused`). The dock renders nothing when there is nothing to show.

```
  ⠋ scout-a  Read a.txt · Thinking · 2 turns · 8s
  ✓ scout-b  Read b.txt · Done · 2 turns · 36s
  +1 more · ◷ 2 queued
```

| Key | Action |
|---|---|
| `↓` in an empty composer | Select the first row |
| `↑` / `↓` | Move; `↑` on the first row returns to the composer |
| `Enter` | Open the selected subagent in the agent view |
| `Esc` | Return to the composer |
| Any other key | Return to the composer, which then handles the key |

Rows beyond the fourth are reached by moving the selection; the dock shows how many are hidden.

## Agent view

Press `←` while the editor is empty (keybinding `app.agents.view`, configurable in `keybindings.json`). The view has two tabs, **Agents** and **Chat**; it opens on Agents, and `→` (keybinding `app.agents.chat`) switches to Chat.

The Agents tab lists the main session at the top, then the subagents started in this session under **In progress**, **Queued**, **Paused**, and **Completed** (empty sections are hidden), each by name, description, and agent. Running subagents show a spinner, queued ones `◷`, paused ones `‖`, and finished ones `✓`, or `✗` when they failed or were aborted. Section headers are not selectable: ↑ and ↓ move between rows, and the selection stays on a subagent as it moves from one section to the next. It starts on the session you last opened in it: the main session at first, then whichever subagent (or the main session) you opened most recently. Going back from a subagent returns to the list on that subagent, unless it was opened from the dock: then going back returns to the main session.

| Key | Agents | Subagent | Chat |
|---|---|---|---|
| `↑` / `↓` | Select | | |
| `Enter` | Open the selection (the main session closes the view) | Send the input: steers a running subagent, resumes a paused one with it, or starts a follow-up on an idle one | |
| `Esc` | Close the view | Abort a running or paused subagent, cancel a queued one, or go back | Close the view |
| `←` | Close the view | Go back (when the input is empty) | Back to Agents |
| `→` | Show Chat | | |
| `PgUp` / `PgDn`, mouse wheel | Wheel moves the selection | Scroll the transcript | Scroll the log |
| `Ctrl+Home` / `Ctrl+End` | | Jump to the top or bottom of the transcript | Jump to the top or bottom of the log |

The transcript scrolls like the fullscreen transcript. It uses the same configurable `tui.altScreen.*` keys (page, half-page, and line actions; the half-page and line actions have no default key). It follows new output until you scroll up, then holds its position and shows how many lines are below. Scrolling back to the bottom resumes following. The scrollbar follows the `fullscreenScrollbar` setting.

The Chat tab lists every chat message sent in this session, oldest first, including sends the hub refused. The tab label shows the count. Each message is one entry, with long text wrapped under its own column:

```
 12:01   orchestrator → scout-a  Check b.ts too
 12:02 ? scout-a → worker        Use verifyToken from b.ts, or the helper in
                                 auth/session.ts?
 12:02 ~ orchestrator → tester   Run auth tests next
 12:03 x worker → all            You are not allowed to message everyone.
```

The marker after the time is `?` while the sender waits for a reply, `~` while a recipient that has not started yet holds the message, and `x` for a refused send, which shows the reason in place of the text. The log scrolls like the transcript and follows new messages until you scroll up. It keeps the last 500 messages and is cleared when a new session starts.

Dialogs from a subagent's extensions (confirm, select, input) appear in the parent, prefixed with the agent name. So do their warning and error notifications; info notifications, such as per-run token statistics, are dropped.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Tools (`subagent`, `subagent_wait`, `subagent_result`, `subagent_list`, `subagent_control`, and the skill tools), run planning, background notices, and the agent-view trigger |
| `agents.ts` | Agent discovery |
| `skills.ts` | Skill groups, tags, and search |
| `child.ts` | One subagent process and its transcript, and pausing, resuming, and handing back |
| `rpc.ts` | RPC client for the child process |
| `registry.ts` | Subagents started in this session |
| `view.ts` | The agent view |
| `dock.ts` | The dock under the composer |
| `slots.ts` | The `maxConcurrent` slot queue |
| `chat.ts` | The chat hub, the subagents' chat client, permissions, and message framing |
| `system-prompt.md` | The global subagent prompt |
| `render.ts` | Tool call and result rendering |
| `paths.ts` | Bundled asset location, `config.json`, and the global prompt |

The build copies `agents/`, `skills/`, `config.json`, and `system-prompt.md` to `dist/extensions/subagent/` and, for standalone binaries, to `subagent/` next to the executable (see `copy-assets` and `copy-binary-assets` in `package.json`).
