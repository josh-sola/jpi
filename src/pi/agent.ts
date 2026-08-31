import type { AgentSession } from "@earendil-works/pi-coding-agent";

type Agent = AgentSession["agent"];
type BeforeToolCallHook = NonNullable<Agent["beforeToolCall"]>;

/**
 * Installs `gate` in front of whatever `beforeToolCall` hook `agent` already
 * carries, chaining to it when `gate` doesn't decide to block: `gate` runs
 * first, and the prior hook (if any) only runs when `gate` returns
 * `undefined`.
 *
 * Reassigning `beforeToolCall` after construction — rather than registering
 * through a documented multi-hook API, which pi's `Agent` doesn't have — is
 * the Pi-internal reach here: pi's own execution loop reads whatever this
 * field holds at call time, so this has to preserve whatever hook was
 * already installed instead of clobbering it.
 */
export function wrapBeforeToolCall(agent: Agent, gate: BeforeToolCallHook): void {
  const prior = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    const gated = await gate(context, signal);
    if (gated !== undefined) return gated;
    return prior?.(context, signal);
  };
}

type AgentState = Agent["state"];

/**
 * Overwrites `agent.state.systemPrompt`. Pi has no setter for this beyond the
 * raw state assignment — a session's prompt is normally derived from cwd/
 * agentDir at construction, and this replaces it after the fact with a
 * caller-supplied one (e.g. copying another session's live system prompt).
 */
export function setSystemPrompt(agent: Agent, prompt: string): void {
  agent.state.systemPrompt = prompt;
}

/**
 * Appends to `agent.state.messages` in place (`push`, not assign). Pi's
 * `AgentState.messages` is an accessor pair — assigning a new array COPIES
 * it, so an assign-based append (`state.messages = [...state.messages, ...]`)
 * would silently detach from whatever the session was actually built to keep
 * using. Pushing onto the array the getter returns keeps that identity.
 */
export function pushMessages(agent: Agent, messages: AgentState["messages"]): void {
  agent.state.messages.push(...messages);
}
