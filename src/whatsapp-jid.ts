/**
 * Chats owned by the WhatsApp channel: groups (`<digits>@g.us`, older
 * `<creator>-<ts>@g.us`), phone DMs (`<digits>@s.whatsapp.net`) and DMs whose
 * LID the channel could not translate (`<digits>@lid`), each with an optional
 * `:<device>`. Anchored, so no other channel's JID can match (a suffix check
 * would also accept `tg:1@g.us`). The adapter drops inbound items for chats a
 * channel does not own, so a form missing here goes unheard: WhatsApp channels
 * (`@newsletter`), broadcast lists and legacy `@c.us` are left out on purpose.
 */
const WHATSAPP_JID =
  /^[0-9]+(-[0-9]+)?(:[0-9]+)?@(g\.us|s\.whatsapp\.net|lid)$/;

export function isWhatsAppJid(jid: string): boolean {
  return WHATSAPP_JID.test(jid);
}
