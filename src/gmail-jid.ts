/**
 * Chats owned by the Gmail channel. Anything an agent writes to one of these
 * is sent as an email, so no `gmail:` chat may ever be a registered group —
 * the Gmail channel's ownsJid and the routing-table refusal share this check.
 */
export function isGmailJid(jid: string): boolean {
  return jid.startsWith('gmail:');
}
