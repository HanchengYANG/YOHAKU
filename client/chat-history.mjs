// Messages already have the server's saved order. Filtering must never regroup
// or sort them: two groups can have interleaved questions at the same timestamp.
export function visibleChatMessages(messages = [], groupIds = null) {
  if (!groupIds) return messages;
  const selected = new Set(groupIds);
  return messages.filter((message) => selected.has(message.groupId));
}

export function availableChatGroups(groups = [], groupIds = null) {
  return groupIds ? groups.filter((group) => groupIds.includes(group.id)) : groups;
}

// Kept by the logged-in workspace only; drafts never survive a page reload.
export function createChatSession() {
  return { scopeGroupIds: null, groupId: null, drafts: {}, views: new Map(), lastScope: null, lastNavigationKey: null, failedIntent: null };
}
