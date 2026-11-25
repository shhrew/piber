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

`system-prompt.md` in this directory goes at the start of every subagent's prompt: what working as a subagent means, and how to use chat, findings, and credentials. A trusted project's `.pi/subagents/system-prompt.md` is appended to it. The full prompt is the global prompt, then the agent's own prompt, then its skills section, then a generated chat section with the subagent's chat name and who it may message.

Agents are loaded from two places:

| Location | When |
|---|---|
| `agents/*.md` in this directory | Always. Ships with the fork: `scout`, `planner`, `reviewer`, `worker`. |
| `.pi/subagents/agents/*.md` in the project or an ancestor directory | Only when the project is trusted. Replaces a bundled agent with the same name. |

## Tools

A subagent gets, in order:

1. The core tools from `config.json` in this directory: `read`, `grep`, `find`, `ls`, and the web tools of the `pi-web-access` package (`web_search`, `fetch_content`, `get_search_content`). Tools that are not installed are skipped. A trusted project can replace them with `.pi/subagents/config.json`.
2. The agent's `tools`.
3. The call's `extraTools`.
4. `skill_search` and `load_skill`, when the agent has skill groups.
5. `chat_send` and `chat_peers`, when the agent may send chat messages.
6. `add_finding`, `update_finding`, `get_finding`, and `list_findings`, when findings are enabled.
7. `add_credential`, `get_credential`, and `list_credentials`, when credentials are enabled.

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

While the `subagent` tool is active, the parent's system prompt has a `<subagents>` section listing each discovered agent's name and description, so the model can choose an agent without guessing names. Subagent processes run without the `subagent` tool and get no list.

Every new subagent also takes `name` and `description`, at the top level in single mode or per task:

- `name` is one word, such as `auth-scout`. It is lowercased and reduced to letters, digits, `-`, and `_`, and becomes the subagent's id: the agent view lists it, and `session` uses it to continue the subagent. A name already used in this session gets `-2`, `-3`, and so on. Without a name, the agent name is used.
- `description` says what the subagent is doing in 2-4 words, such as `Map auth flow`. Without one, the first words of the task are used.

Every mode accepts `cwd`, `extraTools`, and `extraSkillGroups`, at the top level or per task, and `background` at the top level (see [Background subagents](#background-subagents)).

## Background subagents

By default a `subagent` call runs in the foreground: it returns when its subagents finish, and the orchestrator waits. With `background: true` (or `defaultMode: "background"` in the config), the call starts its subagents and returns at once with their names, and the orchestrator keeps working. A background chain starts its later steps as earlier ones finish.

Four tools manage background subagents:

| Tool | Parameters | Returns |
|---|---|---|
| `subagent_wait` | `names` (optional), `returnOnFirst` (optional, default `false`) | Each target's status once all of them have finished, or, with `returnOnFirst`, once the first has. Without `names`, it waits for every subagent still running or queued, including later chain steps. A chat message to the orchestrator ends the wait early, with the targets' status; the message follows the result, and the orchestrator can answer it, change direction, or call `subagent_wait` again. The chat shows `Waiting(all)` or `Waiting(any)`. |
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

In the chat, a background call's rows keep updating after the call returns. A wait for all or any subagents shows only its call line (`● Waiting(all) · waiting for a subagent to finish`); a wait for two or more named subagents shows the mode and adds one row each with the name and description while it waits; a wait for one subagent names it on the call line (`● Waiting(scout-a) · waiting for it to finish`). A finished wait is always a single line, such as `● Waiting(any) · done waiting`. Background subagents stop when the session ends; after a resume, their rows show `Started in background`.

## Chat

Agents in a session can send each other short messages, so a swarm can share findings and steer each other while it works: the orchestrator to a subagent, a subagent to the orchestrator, a subagent to another subagent, or anyone to everyone at once.

| Tool | Parameters | Use |
|---|---|---|
| `chat_send` | `to`: a subagent's name, `orchestrator`, or `all`; `replyTo`: the numeric id of the message being answered; `text`; `waitForReply` (optional); `timeoutSeconds` (optional) | Send a message, or reply to one. With `waitForReply`, block until the recipient answers or the timeout passes. |
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
<agent_message id="4" from="scout-a" to="you" awaiting_reply="false">
Found it in src/a.ts
</agent_message>
Reply with chat_send replyTo 4 only if it is needed.
```

`to` is `you` or `all`. Other messages the system sends in the user role are tagged the same way: background completion notices as `<system_notice from="subagents">`, and resume and handback requests as `<subagent_control action="resume">` or `action="handback"`, with the orchestrator's `message` inside as `<note from="orchestrator">`.

**Message ids and replies.** The hub numbers every message in the session: 1, 2, and so on. The sender gets the id in its tool result (`Message 4 delivered to worker.`). To answer a message, an agent calls `chat_send` with `replyTo` and no `to`; the reply goes to the original sender and its tag carries `reply_to="4"`. Two questions from the same sender can then be answered separately. The hub refuses a `replyTo` that names an unknown message, one not sent to the replier (directly or to `all`), or a `to` other than the original sender. It remembers the last 500 messages. The TUI shows ids as `#4`.

**Waiting for a reply.** With `waitForReply`, the sender blocks until the recipient's next message to it that has no `replyTo` or answers the awaited message, up to `timeoutSeconds` (default `chat.replyTimeoutSeconds`, at most `chat.maxReplyTimeoutSeconds`). While an agent waits it cannot read messages the normal way, so any other message to it, including one from the recipient answering a different message, ends the wait and is returned in the tool result instead. That also resolves two agents waiting on each other. A timeout leaves the message delivered; a later reply arrives as a normal message. `waitForReply` cannot be used with `to: "all"`.

**Limits.** Messages longer than `chat.maxMessageLength` are refused, and so are sends beyond `chat.maxMessagesPerMinute` per agent.

**Display.** Messages are drawn as bubbles. The current agent is always first in the label, so the arrow points from sender to recipient: a sent message sits on the left as `orchestrator → worker`, a received one on the right as `orchestrator ← scout-a`. A sent bubble has its outcome (`✓ #5 delivered`, `◷ #5 held until worker starts`, `✗ not sent: …`) under it, and the reply, if it waited for one, as a received bubble below. A received bubble's border shows its id and, for a reply, `reply to #4`; a sent reply is labeled with the recipient's name and has `reply to #4` in its border. When the sender is waiting for a reply, the border adds `waiting for your reply` in the warning color until the sender stops waiting, then `asked for a reply`. The recipient's model is told the same: the sender is blocked until it answers, so it should reply, even if only to acknowledge. The main chat shows the orchestrator's messages, collapsed to 6 lines until expanded; the agent view shows a subagent's messages in full.

```
                         ╭─ orchestrator ← scout-a ──────────────╮
                         │ Is the session token cached anywhere? │
                         ╰───────── #4 · waiting for your reply ─╯

 ╭─ orchestrator → scout-a ─╮
 │ Yes, in src/cache.ts     │
 ╰──────────── reply to #4 ─╯
 ✓ #5 delivered
```

**How it works.** The parent runs a chat hub on a local socket (a Unix socket in a private temporary directory, or a named pipe on Windows) and gives each subagent process the socket path and a secret token (in the `PI_SUBAGENT_CHAT_TOKEN` environment variable). The hub checks every message's permissions and limits, so a subagent cannot impersonate another or go past its `canMessage`.

## Findings

Agents record what they discover on a findings board shared by the session, so the orchestrator hears about urgent discoveries while a long subagent is still working, and can look up any finding later instead of digging through chat.

| Tool | Parameters | Use |
|---|---|---|
| `add_finding` | `key`, `description`, `priority`, `metadata` (optional) | Add a finding. Returns its id. |
| `update_finding` | `id`, and any of `key`, `description`, `priority`, `metadata` | Change a finding you added. |
| `get_finding` | `ids` | Read findings in full. |
| `list_findings` | `from`, `key` (a prefix), `minPriority`, `after` (an id), `limit` (all optional) | List findings, highest priority first. |

A finding has:

- `id`: an integer the board assigns, 1, 2, and so on, in the order findings are added in the session;
- `from`: the agent that added it, taken from its chat token, so it cannot be forged;
- `key`: a slug such as `auth.token-cache`, lowercased, with characters other than letters, digits, `.`, `_`, and `-` dropped;
- `description`: what was found and why it matters;
- `priority`: `low`, `medium`, `high`, or `critical`;
- `metadata`: key/value details, such as `file` and `line`; values are strings, numbers, or booleans;
- `revision`: 1 when added, one more with each update.

```
scout-a  add_finding {key: "auth.token-cache", priority: "critical",
                      description: "Session tokens are never invalidated on logout",
                      metadata: {file: "src/cache.ts", line: 42}}
         → Added finding 7 (critical). The orchestrator was told.
orch     <agent_findings>
         <finding id="7" from="scout-a" priority="critical" key="auth.token-cache"/>
         </agent_findings>
orch     get_finding {ids: [7]} → the description and metadata
```

**Delivery.** Priority alone decides whether the orchestrator is told, as `findings.delivery` sets. By default:

| Priority | Delivery | What happens |
|---|---|---|
| `critical`, `high` | `wake` | The notice is steered in after the orchestrator's current tool call, or starts a turn when it is idle. It also ends a `subagent_wait`, like a chat message. |
| `medium` | `notify` | The notice is added to the orchestrator's next turn. Findings within half a second share one notice. |
| `low` | `silent` | Only stored. |

The notice names each finding's id, sender, priority, and key, never its description or metadata, so it stays small; the orchestrator reads the rest with `get_finding`. Findings the orchestrator adds itself are never delivered to it. An update is delivered only when the new priority has a stronger delivery than the old one (low to high, say), so a subagent refining a finding does not wake the orchestrator again; its notice carries `revision`.

**Ownership.** Every agent can list and read every finding. Only the agent that added a finding can update it. An update merges `metadata` into the finding's metadata, and a key set to `null` removes it; other fields are replaced. A subagent continued with `session` keeps its name, so it can still update its earlier findings.

**Summaries.** `subagent_result` and the background completion notice end with a line per subagent that added findings, such as `Findings by scout-a: 7 critical auth.token-cache, 9 low docs.typo.` Status lines in `subagent_wait`, `subagent_list`, and notices count them: `done, 3 turns; 2 findings (1 critical)`. Low findings are not lost when a final answer leaves them out.

**Limits.** Descriptions longer than `findings.maxDescriptionLength` characters, and metadata larger than `findings.maxMetadataBytes` as JSON, are refused.

**Persistence.** Findings are appended to `findings.jsonl` in the session's subagent directory (see [Sessions](#sessions)), one line per add or update. A resumed session loads them, keeping the last revision of each, and new ids continue after the highest. Without a session file, findings are kept in memory only. A subagent in a resumed session that takes the name of an earlier one can update that one's findings.

**How it works.** The board lives in the parent. Subagents reach it over the chat hub's socket, which runs while chat or findings is enabled, so with chat turned off a subagent still joins the hub for findings. Subagents get the finding tools whenever findings are enabled; no permission is needed.

## Credentials

A credential store, also shared by the session, for secrets an agent finds and what they are for: a token, a key, a password, a connection string. Unlike a finding, a new credential is announced to the orchestrator AND every other subagent at once, value included, so a swarm that discovers a secret can all use it without asking.

| Tool | Parameters | Use |
|---|---|---|
| `add_credential` | `label`, `purpose`, `value` | Store a credential. Returns its id. |
| `get_credential` | `ids` | Read credentials in full, value included. |
| `list_credentials` | `from`, `limit` (both optional) | List credentials, without their values. |

A credential has:

- `id`: an integer the store assigns, 1, 2, and so on;
- `from`: the agent that added it, taken from its chat token, so it cannot be forged;
- `label`: a slug such as `github-ci-token`, normalized like a finding key;
- `purpose`: what the credential is for;
- `value`: the secret itself.

Credentials are immutable: to change one, add a new one.

**Delivery.** Adding a credential tells the orchestrator (steered in after its current tool call, or starting a turn when it is idle, and ending a `subagent_wait`, like an urgent finding) and every other subagent still running, queued, or paused. A subagent not started yet gets it when it starts; a paused one when it resumes. The announcement carries the value, so every agent can use the credential as soon as it is stored. A subagent does not receive its own credential back, and the orchestrator is not told about one it added itself. Status summaries in `subagent_result` and the completion notice list a subagent's credentials by id and label.

**Secrets on disk and in context.** This is a deliberately unguarded store: values are written to `credentials.jsonl` in the session's subagent directory in plaintext, reach every agent's context, and appear in `PIBER_DEBUG` dumps. Treat a session directory that holds credentials as secret. `list_credentials` leaves the value out, but `get_credential` and the announcement include it.

**Persistence.** Credentials are appended to `credentials.jsonl` next to the findings (see [Sessions](#sessions)). A resumed session loads them and continues the ids. Without a session file, they are kept in memory only.

**How it works.** The store lives in the parent, served over the same hub socket as chat and findings; the hub runs while chat, findings, or credentials is enabled. Subagents get the credential tools whenever credentials are enabled; no permission is needed.

## Configuration

`config.json` in this directory sets defaults for every subagent. A trusted project can override any field in `.pi/subagents/config.json`.

```json
{
	"coreTools": ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content"],
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
	},
	"findings": {
		"enabled": true,
		"delivery": { "critical": "wake", "high": "wake", "medium": "notify", "low": "silent" },
		"maxDescriptionLength": 1000,
		"maxMetadataBytes": 4096
	},
	"credentials": {
		"enabled": true
	}
}
```

| Field | Meaning |
|---|---|
| `coreTools` | Tools every subagent gets (see [Tools](#tools)). |
| `maxConcurrent` | How many subagent processes may run at once in a session. It must be a positive integer; other values are ignored. |
| `defaultMode` | `"foreground"` or `"background"`: how a `subagent` call runs when it does not set `background`. |
| `chat` | Subagent chat (see [Chat](#chat)): `enabled`; `defaultCanMessage` for agents without `canMessage`; `orchestratorCanMessage`; `maxMessageLength` in characters; `maxMessagesPerMinute` per agent; `replyTimeoutSeconds` and `maxReplyTimeoutSeconds` for `waitForReply`. A project's `chat` object overrides individual fields. |
| `findings` | The findings board (see [Findings](#findings)): `enabled`; `delivery`, `wake`, `notify`, or `silent` for each priority; `maxDescriptionLength` in characters; `maxMetadataBytes` as JSON. A project's `findings` object overrides individual fields, and its `delivery` individual priorities. |
| `credentials` | The credential store (see [Credentials](#credentials)): `enabled`. A project can turn it off with `{ "enabled": false }`. |
| `onBackgroundComplete` | What happens when a background subagent finishes and nothing has reported it: `"wake"` posts a notice at once, starting a turn if the orchestrator is idle or queuing it after the current one; `"notify"` posts it with the next turn; `"silent"` posts nothing, leaving the result to `subagent_wait` and `subagent_result`. |

`maxConcurrent` covers every subagent the session starts: parallel tasks, separate `subagent` calls, `session` continuations, and follow-ups sent from the agent view. A subagent beyond the limit waits in a queue with the status `queued` (`◷`), and starts in order when a running one finishes. Esc in the agent view, or aborting the parent's tool call, removes it from the queue. A queued subagent cannot be steered until it starts. The orchestrator can reorder this with `subagent_control` (see [Controlling subagents](#controlling-subagents)). The limit is read again before each run, so editing `config.json` takes effect for the next subagent.

## Sessions

Each subagent keeps a normal Pi session file in `<parent session dir>/subagents/<parent session id>/`, named `<name>: <description>`. The tool result tells the parent model the subagent's name so it can send a follow-up with `session`. You can open any subagent session later with `pi --session <path>`. When the parent runs without a session file (`--no-session`), subagents do not keep one either. The same directory holds the session's `findings.jsonl` and `credentials.jsonl` (see [Findings](#findings) and [Credentials](#credentials)).

The child process runs only while the subagent works. A follow-up starts a new process on the same session file.

## In the main session

The main chat shows each `subagent` call as a compact line with one status row per subagent. Subagent output never appears in the main chat; read it in the [agent view](#agent-view).

```
● Subagents · 2 in parallel
  ⎿  ✓ scout-a  Read a.txt · Done · 3 turns · 26s
     ⠋ scout-b  Read b.txt · Thinking · 2 turns · 8s
```

The bullet turns green when the call succeeds and red when it fails. A running row shows only a phase, as in the dock: `Thinking`, `Responding`, or `Working`. Clicking the call or pressing Ctrl+O adds the latest command each subagent ran (`→ read a.txt`) under its row. A subagent's task, session, and output are in the agent view.

The chat and skill tools are drawn the same way, with their arguments on the call line and a one-line summary below. Expanding one shows a row per peer or match, or a loaded skill's directory and body.

```
● List chat peers
  ⎿  orchestrator · ● scout-a · ◷ scout-b · ○ worker · all
● Search skills(path traversal) #security
  ⎿  1 match · security-review
● Load skill(security-review)
  ⎿  38 lines · Review code for security issues
```

Peers are marked `●` running, `◷` queued, `‖` paused, and `○` finished. The agent view draws these tools the same way in subagent transcripts.

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

Press `←` while the editor is empty (keybinding `app.agents.view`, configurable in `keybindings.json`). The view has four tabs, **Agents**, **Chat**, **Findings**, and **Credentials**; it opens on Agents, `→` (keybinding `app.agents.chat`) shows the next tab, and `←` the previous one.

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
 12:01   #1 orchestrator → scout-a  Check b.ts too
 12:02 ? #2 scout-a → worker        Use verifyToken from b.ts, or the helper in
                                    auth/session.ts?
 12:02 ~ #3 orchestrator → tester   Run auth tests next
 12:03   #4 worker → scout-a        ↩ #2 verifyToken
 12:03 x    worker → all            Tests pass
                                    ✗ You are not allowed to message everyone.
```

The message id follows the marker; a refused send has none, and a reply's text starts with `↩` and the id it answers. The marker after the time is `?` while the sender waits for a reply, `~` while a recipient that has not started yet holds the message, and `x` for a refused send, which shows the reason in red under the text. The log scrolls like the transcript and follows new messages until you scroll up. It keeps the last 500 messages and is cleared when a new session starts.

The Findings tab lists every finding in the session, highest priority first, one row each with the time it last changed, its id, priority (critical red, high yellow, medium in the accent color, low muted), sender, key, and the start of its description. `↑` and `↓` select a finding, and `Enter` shows or hides its whole description, metadata, and revision under the row. The tab label shows the count.

```
 Agents   Chat 3   Findings 2
 ↑↓ select · enter show details · ← chat · esc close

›12:01 #2 critical bravo auth.token-cache  Tokens are never invalidated
      Tokens are never invalidated
      file: src/cache.ts
      line: 42
 12:03 #1 low      alpha docs.typo  Typo in README
```

In the main chat, a finding notice is one line per finding: `⚑ #7 critical · scout-a · auth.token-cache`, in the priority's color. The finding tools are drawn as call lines (`● Add finding(auth.token-cache) critical`, `⎿  #7 critical auth.token-cache · orchestrator told`). Clicking a notice or a finding tool's result, or pressing the expand key, shows each finding in full as JSON: a notice shows the finding as it is now, a tool result as the tool returned it. In the dock, a subagent that added findings has a badge with their count, in the color of the highest priority: `⚑2`.

The **Credentials** tab lists every credential, one row each with the time it was added, its id, label, sender, and purpose; `Enter` shows or hides its value. In the main chat, a credential announcement is one line per credential: `⚷ #3 github-ci-token · scout-a · push to the CI repo`; expanding it, or a credential tool's result, shows the credential as JSON with its value. A subagent that stored credentials has a second dock badge, `⚷N`.

Dialogs from a subagent's extensions (confirm, select, input) appear in the parent, prefixed with the agent name. So do their warning and error notifications; info notifications, such as per-run token statistics, are dropped.

## Debugging

Set `PIBER_DEBUG` to a directory to see exactly what each model receives:

```bash
PIBER_DEBUG=/tmp/piber-debug pi
```

Every request to the model is written there as JSON, with the system prompt, tool definitions, and messages, in a file named by time and agent, such as `2026-10-29T22-27-44-185Z-orchestrator.json` or `...-planner.json`. Subagent processes inherit the variable, so one setting covers the orchestrator and every subagent. Files are never deleted; clear the directory between runs. They hold the full conversation, so keep them private.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Tools (`subagent`, `subagent_wait`, `subagent_result`, `subagent_list`, `subagent_control`, and the skill, chat, finding, and credential tools), run planning, background, finding, and credential notices, and the agent-view trigger |
| `agents.ts` | Agent discovery |
| `skills.ts` | Skill groups, tags, and search |
| `child.ts` | One subagent process and its transcript, and pausing, resuming, and handing back |
| `rpc.ts` | RPC client for the child process |
| `registry.ts` | Subagents started in this session |
| `view.ts` | The agent view |
| `dock.ts` | The dock under the composer |
| `slots.ts` | The `maxConcurrent` slot queue |
| `chat.ts` | The chat hub, the subagents' chat client, permissions, and message framing |
| `findings.ts` | The findings board and store, ownership and limits, persistence, and notice framing |
| `credentials.ts` | The credential store and board, persistence, and announcement framing |
| `system-prompt.md` | The global subagent prompt |
| `render.ts` | Tool call and result rendering |
| `paths.ts` | Bundled asset location, `config.json`, and the global prompt |

The build copies `agents/`, `skills/`, `config.json`, and `system-prompt.md` to `dist/extensions/subagent/` and, for standalone binaries, to `subagent/` next to the executable (see `copy-assets` and `copy-binary-assets` in `package.json`).
