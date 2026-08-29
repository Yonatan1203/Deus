/**
 * Voice-note / audio-file handling for the WhatsApp channel (producer side).
 *
 * The channel process holds no credentials. It only classifies inbound audio,
 * downloads it to a dedicated temp directory, and hands the host a reference
 * (`metadata.audio`). The host re-validates that reference at its own boundary
 * (`src/openai-transcription.ts`), gates the paid transcription on chat
 * registration + sender allowlist, and unlinks the file. Pure helpers here so
 * they are unit-testable without a Baileys socket.
 */

import os from 'os';
import path from 'path';

/** OpenAI's per-file limit for the transcription endpoints. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/**
 * Dedicated temp dir — the host recomputes the same path and refuses any
 * reference that does not resolve inside it. Keep in sync with
 * `AUDIO_TMP_DIR` in `src/openai-transcription.ts`.
 */
export const AUDIO_TMP_DIR = path.join(os.tmpdir(), 'deus-whatsapp-audio');

/**
 * Fixed mimetype → on-disk extension map. Only these are accepted; the
 * extension is never derived from raw mimetype text. Mirrored (deliberately —
 * the host does not import channel packages) in
 * `src/openai-transcription.ts`.
 */
export const AUDIO_MIME_EXT: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

export const VOICE_PLACEHOLDER = '[Voice Message]';

/** Strip `; codecs=…` parameters and normalize case. */
export function normalizeMimetype(raw: string | null | undefined): string {
  return (raw ?? '').split(';')[0].trim().toLowerCase();
}

/** Baileys reports `fileLength` as number | Long | null. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber(): number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Structural subset of Baileys' IAudioMessage / IDocumentMessage. */
interface AudioLike {
  mimetype?: string | null;
  fileLength?: unknown;
  ptt?: boolean | null;
}
interface DocumentLike {
  mimetype?: string | null;
  fileLength?: unknown;
  fileName?: string | null;
}

export interface ClassifiedAudio {
  /** Baileys media type for downloadContentFromMessage. */
  mediaType: 'audio' | 'document';
  /** The message object to pass to downloadContentFromMessage. */
  message: AudioLike | DocumentLike;
  mimetype: string;
  fileLength: number;
  fileName?: string;
  /** Push-to-talk voice note (vs an attached audio file). */
  isVoiceNote: boolean;
}

/**
 * Returns an audio reference for a voice note, an audio message, or a document
 * with an `audio/*` mimetype; null for anything else.
 */
export function classifyAudio(normalized: {
  audioMessage?: AudioLike | null;
  documentMessage?: DocumentLike | null;
}): ClassifiedAudio | null {
  const audio = normalized.audioMessage;
  if (audio) {
    return {
      mediaType: 'audio',
      message: audio,
      mimetype: normalizeMimetype(audio.mimetype),
      fileLength: toNumber(audio.fileLength),
      isVoiceNote: audio.ptt === true,
    };
  }
  const doc = normalized.documentMessage;
  if (doc) {
    const mimetype = normalizeMimetype(doc.mimetype);
    if (!mimetype.startsWith('audio/')) return null;
    return {
      mediaType: 'document',
      message: doc,
      mimetype,
      fileLength: toNumber(doc.fileLength),
      fileName: doc.fileName ?? undefined,
      isVoiceNote: false,
    };
  }
  return null;
}

export function tooLargePlaceholder(bytes: number): string {
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `[Voice Message - too large to transcribe (${mb} MB, limit 25 MB)]`;
}

/**
 * Unique temp path for a downloaded audio message, or null when the mimetype
 * is not in the allow-map. The message id is reduced to `[A-Za-z0-9_-]`.
 */
export function audioTempPath(
  msgId: string,
  mimetype: string,
  tmpDir: string = AUDIO_TMP_DIR,
): string | null {
  const ext = AUDIO_MIME_EXT[normalizeMimetype(mimetype)];
  if (!ext) return null;
  const safeId = msgId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'msg';
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(tmpDir, `${safeId}-${unique}.${ext}`);
}
