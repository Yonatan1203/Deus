import fs from 'fs';
import path from 'path';

import type { Channel, RegisteredGroup } from '../../types.js';
import { CHANNEL_CONFIGURED } from './mcps.js';

export const ADAPTERS = [
  'whatsapp',
  'telegram',
  'discord',
  'slack',
  'gmail',
  'outlook',
  'teams',
  'x',
] as const;

export interface PairingState {
  needs_pairing: boolean;
  qr_available: boolean;
  pairing_code_available: boolean;
}

export interface ChannelView {
  name: string;
  package: string;
  configured: boolean | null;
  connected: boolean;
  groups: string[];
  pairing?: PairingState;
}

export interface ChannelDeps {
  repoRoot: string;
  envHas: (key: string) => boolean;
  channels: () => Channel[];
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** The adapter's own auth dir; qr-data.txt and pairing-code.txt live in its parent. */
  whatsappAuthDir: string;
}

export function pairingState(authDir: string): PairingState {
  const parent = path.dirname(authDir);
  return {
    needs_pairing: !fs.existsSync(path.join(authDir, 'creds.json')),
    qr_available: fs.existsSync(path.join(parent, 'qr-data.txt')),
    pairing_code_available: fs.existsSync(
      path.join(parent, 'pairing-code.txt'),
    ),
  };
}

export function listChannels(deps: ChannelDeps): ChannelView[] {
  const live = new Map(deps.channels().map((c) => [c.name, c]));
  const groups = Object.entries(deps.registeredGroups());
  return ADAPTERS.map((name) => {
    const channel = live.get(name);
    const owned = channel
      ? groups
          .filter(([jid]) => {
            try {
              return channel.ownsJid(jid);
            } catch {
              return false;
            }
          })
          .map(([, g]) => g.folder)
      : [];
    const view: ChannelView = {
      name,
      package: `mcp-${name}`,
      configured:
        CHANNEL_CONFIGURED[`mcp-${name}`]?.(deps.repoRoot, deps.envHas) ?? null,
      connected: channel ? channel.isConnected() : false,
      groups: [...new Set(owned)].sort(),
    };
    if (name === 'whatsapp') view.pairing = pairingState(deps.whatsappAuthDir);
    return view;
  });
}

type QrGenerate = (
  text: string,
  opts: { small: boolean },
  cb: (out: string) => void,
) => void;

async function renderAscii(text: string): Promise<string | null> {
  try {
    const moduleName = 'qrcode-terminal'; // untyped; resolved at runtime only
    const mod = (await import(moduleName)) as {
      generate?: QrGenerate;
      default?: { generate?: QrGenerate };
    };
    // Call through the module object: `generate` reads `this.error` for the
    // error-correction level, so a detached reference throws.
    const qt = typeof mod.generate === 'function' ? mod : mod.default;
    if (!qt?.generate) return null;
    return await new Promise<string>((resolve) => {
      // Re-checked here because narrowing does not cross the executor closure.
      if (qt.generate) qt.generate(text, { small: true }, resolve);
    });
  } catch {
    return null;
  }
}

export async function whatsappQr(
  authDir: string,
): Promise<{ qr: string; ascii: string | null } | { status: 404 | 409 }> {
  if (fs.existsSync(path.join(authDir, 'creds.json'))) return { status: 409 };
  let qr: string;
  try {
    qr = fs
      .readFileSync(path.join(path.dirname(authDir), 'qr-data.txt'), 'utf-8')
      .trim();
  } catch {
    return { status: 404 };
  }
  if (!qr) return { status: 404 };
  return { qr, ascii: await renderAscii(qr) };
}
