#!/usr/bin/env bash
# Runs pi-test.sh with a scenario prompt for testing a feature by hand.
# Usage: ./piber-test.sh <scenario> [pi-test.sh args...]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 <scenario> [pi-test.sh args...]"
  echo
  echo "Scenarios:"
  echo "  chat   Subagent chat: subagent to subagent, reply waits, orchestrator replies, held messages, broadcast"
}

chat_prompt() {
  cat <<'EOF'
This is a manual test of the subagent chat feature. Follow these steps exactly. Do not edit any files, and tell every subagent not to edit files either.

1. In ONE `subagent` call with `background: true`, start these three `worker` subagents in parallel (only two run at once, so charlie should start queued):
   - name "alpha", task: Do not edit files. Run `grep -rn "class ChatHub" packages/coding-agent/src`. Send the file and line to the orchestrator with chat_send and waitForReply: true, asking "Found ChatHub. Should I also look for ChatClient?". If the answer is yes, find ChatClient the same way. Answer any message that is waiting for your reply. If your wait ends before the orchestrator answers, ask it again with waitForReply. Do not finish until you have the orchestrator's answer. Finish with what you found and every chat message you received, with its sender.
   - name "bravo", task: Do not edit files. Ask alpha with chat_send and waitForReply: true: "Which file defines ChatHub?". After the reply, run `grep -rn "class ChatBubble" packages/coding-agent/src` and send the result to alpha without waiting. Finish with the reply you got and every chat message you received, with its sender.
   - name "charlie", task: Do not edit files. First list the chat messages you have already received. Then send "charlie is running" to "all". Finish with every chat message you received, with its sender.
2. Right after that call returns, send charlie, without waiting: "Held message: you were queued when this was sent." Then call chat_peers.
3. Call subagent_wait with no names. A chat message to you ends the wait early; answer it, then call subagent_wait again to keep waiting, until all three have finished.
4. When alpha asks its question, answer "yes" with chat_send to alpha. Answer any other message that is waiting for your reply with a short acknowledgement.
5. Once all three have finished, read their results with subagent_result. Then give a checklist of chat paths, each marked worked or failed with the evidence:
   - subagent to subagent (bravo to alpha, without waiting)
   - subagent to subagent with waitForReply (bravo asks alpha)
   - subagent to orchestrator with waitForReply (alpha asks you)
   - orchestrator to subagent (your reply to alpha)
   - held message for a queued subagent (charlie)
   - broadcast (charlie to all)
   - a reply wait ended early by another message, if it happened
   - subagent_wait ended early by a chat message, and waiting again afterwards
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

SCENARIO="$1"
shift

case "$SCENARIO" in
  chat)
    PROMPT="$(chat_prompt)"
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    echo
    usage
    exit 1
    ;;
esac

exec "$SCRIPT_DIR/pi-test.sh" "$@" "$PROMPT"
