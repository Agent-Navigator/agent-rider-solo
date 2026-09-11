export type CollaborationInputSender = (value: string, submit?: boolean) => boolean

export function agentCollaborationPrompt(agentId: string) {
  return `Agent Rider collaboration reference for the already-open TUI agent ${agentId}.\nThis is reference information only. Do not run commands, inspect the target, or contact it now.\nThis Agent ID applies only when the user's next concrete collaboration task refers to this target. It is not a permanent restriction on which Agent you may contact.\nFor each collaboration task, follow the Agent ID most recently and explicitly provided by the user. A later user-provided Agent ID replaces this reference for that task.\nWhen this target is the current user-selected target, use exactly ${agentId}:\nInspect: agrider agent inspect ${agentId}\nSend:    printf '%s' '<task>' | agrider agent send ${agentId} --stdin\nAdd --wait only when the user explicitly asks you to wait for the result.\nDo not substitute another target or discover tmux session names unless the user explicitly provides a different Agent ID.\nFor now, wait for the user's further instructions.`
}

export function sendAgentCollaborationPrompt(
  agentId: string,
  sender: CollaborationInputSender | null | undefined,
) {
  return sender?.(agentCollaborationPrompt(agentId), true) ?? false
}
