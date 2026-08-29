/**
 * Host-side voice-note transcription through the OpenAI auth provider.
 *
 * Trust model: a channel process (packages/mcp-whatsapp) downloads audio into
 * a dedicated temp dir and sends the host a JSON reference. That reference is
 * UNTRUSTED — it crosses a process boundary — so everything security-relevant
 * (path containment, file type, size, extension) is re-derived here before the
 * file is read, uploaded, or unlinked. The paid call runs only for registered
 * chats whose sender may trigger the agent, under a per-chat hourly cap, and
 * the API key never leaves the OpenAIAuthProvider (the same object the
 * credential proxy uses, so rotation semantics are identical: restart to
 * pick up a new key).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureDefaultProviders } from './auth-providers/index.js';
import { AuthProviderRegistry } from './auth-providers/types.js';
import type { AuthProvider } from './auth-providers/types.js';
import { logger } from './logger.js';
import { createRateLimiter } from './rate-limiter.js';

/** OpenAI's per-file limit for the transcription endpoints. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/**
 * Must equal `AUDIO_TMP_DIR` in packages/mcp-whatsapp/src/audio.ts. Recomputed
 * here (not read from the reference) so the child cannot steer it.
 */
export const AUDIO_TMP_DIR = path.join(os.tmpdir(), 'deus-whatsapp-audio');

/**
 * Fixed mimetype → upload extension map. Deliberately mirrored from
 * packages/mcp-whatsapp/src/audio.ts: the host never imports channel packages,
 * and the extension must come from this table, never from raw mimetype text.
 */
const AUDIO_MIME_EXT: Readonly<Record<string, string>> = {
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

export const AUDIO_PLACEHOLDER = {
  voice: '[Voice Message]',
  unavailable: '[Voice Message - transcription unavailable]',
  failed: '[Voice Message - transcription failed]',
  rateLimited: '[Voice Message - transcription rate limit reached]',
} as const;

export interface ValidatedAudio {
  path: string;
  mimetype: string;
  ext: string;
  bytes: number;
  fileName?: string;
  isVoiceNote: boolean;
}

export type AudioValidation =
  { ok: true; audio: ValidatedAudio } | { ok: false; reason: string };

function normalizeMimetype(raw: unknown): string {
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Validate a channel-supplied audio reference at the host boundary.
 * A reference that fails here is never read, uploaded, or unlinked.
 */
export function validateAudioRef(
  ref: unknown,
  tmpDir: string = AUDIO_TMP_DIR,
): AudioValidation {
  if (!ref || typeof ref !== 'object')
    return { ok: false, reason: 'not-object' };
  const r = ref as Record<string, unknown>;
  if (typeof r.path !== 'string' || r.path.length === 0) {
    return { ok: false, reason: 'path-missing' };
  }
  const mimetype = normalizeMimetype(r.mimetype);
  const ext = AUDIO_MIME_EXT[mimetype];
  if (!ext) return { ok: false, reason: 'mimetype-not-allowed' };

  let realDir: string;
  let realPath: string;
  try {
    realDir = fs.realpathSync(tmpDir);
    realPath = fs.realpathSync(r.path);
  } catch {
    return { ok: false, reason: 'path-unresolvable' };
  }
  if (!realPath.startsWith(realDir + path.sep)) {
    return { ok: false, reason: 'path-outside-tmp-dir' };
  }
  if (path.dirname(realPath) !== realDir) {
    return { ok: false, reason: 'path-nested' };
  }

  let st: fs.Stats;
  try {
    st = fs.lstatSync(realPath);
  } catch {
    return { ok: false, reason: 'stat-failed' };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-regular-file' };
  if (st.size === 0) return { ok: false, reason: 'empty' };
  if (st.size > MAX_TRANSCRIBE_BYTES) return { ok: false, reason: 'too-large' };

  return {
    ok: true,
    audio: {
      path: realPath,
      mimetype,
      ext,
      bytes: st.size,
      fileName: typeof r.fileName === 'string' ? r.fileName : undefined,
      isVoiceNote: r.isVoiceNote === true,
    },
  };
}

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export class TranscriptionUnavailableError extends Error {
  constructor(message = 'OpenAI provider has no credentials') {
    super(message);
    this.name = 'TranscriptionUnavailableError';
  }
}

export interface TranscribeOptions {
  model: string;
  provider?: AuthProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function defaultProvider(): AuthProvider {
  ensureDefaultProviders();
  return AuthProviderRegistry.default().get('openai');
}

/** Read the validated file through a descriptor (size re-checked on the fd). */
function readAudioFile(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > MAX_TRANSCRIBE_BYTES) {
      throw new TranscriptionError('audio file changed after validation');
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * POST the audio to `<provider upstream>/v1/audio/transcriptions` with the
 * provider injecting credentials. Returns the transcript text.
 */
export async function transcribeAudioFile(
  audio: ValidatedAudio,
  opts: TranscribeOptions,
): Promise<string> {
  const provider = opts.provider ?? defaultProvider();
  if (!provider.isAvailable()) throw new TranscriptionUnavailableError();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const data = readAudioFile(audio.path);
  // Copy into a plain ArrayBuffer: Buffer's pooled ArrayBufferLike is not a
  // BlobPart under the ES2022 lib typings.
  const bytes = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: audio.mimetype }),
    `audio.${audio.ext}`,
  );
  form.append('model', opts.model);
  form.append('response_format', 'json');

  const headers: Record<string, string | string[] | undefined> = {};
  provider.injectAuth(headers);
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') outHeaders[k] = v;
  }

  // Origin + path — the same semantics the credential proxy applies to
  // OPENAI_BASE_URL (an origin, no /v1 suffix).
  const url = `${provider.getUpstreamUrl().replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: outHeaders,
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new TranscriptionError(
      `OpenAI transcription HTTP ${res.status}`,
      res.status,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new TranscriptionError('OpenAI transcription: malformed JSON');
  }
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') {
    throw new TranscriptionError('OpenAI transcription: no text in response');
  }
  return text.trim();
}

export function formatTranscript(
  audio: { isVoiceNote: boolean; fileName?: string },
  text: string,
): string {
  if (audio.isVoiceNote || !audio.fileName) return `[Voice: ${text}]`;
  return `[Audio "${audio.fileName}": ${text}]`;
}

export interface AudioResolverOpts {
  /** Per-chat paid-transcription budget per hour. */
  hourlyCap: number;
  /** Model passed to the transcription endpoint. */
  model: string;
  /** Skip uploads for this long after a 401/403 (dead/rotated key). */
  cooldownMs?: number;
  /** Injectable for tests. */
  transcribe?: (audio: ValidatedAudio) => Promise<string>;
  tmpDir?: string;
  now?: () => number;
}

export interface ResolveContext {
  chatJid: string;
  /** Registered chat AND (own message OR sender may trigger the agent). */
  allowed: boolean;
}

/**
 * Builds the resolver used by the host message path. `resolve()` always
 * returns the content string to store and never throws; a validated temp
 * file is unlinked on every exit path, an invalid reference is never touched.
 */
export function createAudioResolver(opts: AudioResolverOpts) {
  const now = opts.now ?? Date.now;
  const cooldownMs = opts.cooldownMs ?? 10 * 60_000;
  const transcribe =
    opts.transcribe ??
    ((audio: ValidatedAudio) =>
      transcribeAudioFile(audio, { model: opts.model }));
  const limiter = createRateLimiter(opts.hourlyCap, 60 * 60_000);
  let cooldownUntil = 0;

  async function resolve(ref: unknown, ctx: ResolveContext): Promise<string> {
    const v = validateAudioRef(ref, opts.tmpDir);
    if (!v.ok) {
      logger.warn(
        { chatJid: ctx.chatJid, reason: v.reason },
        'Rejected audio reference from channel',
      );
      return AUDIO_PLACEHOLDER.voice;
    }
    const { audio } = v;
    try {
      if (!ctx.allowed) return AUDIO_PLACEHOLDER.voice;
      const t = now();
      if (t < cooldownUntil) return AUDIO_PLACEHOLDER.unavailable;
      if (limiter.isRateLimited(ctx.chatJid, t)) {
        logger.warn(
          { chatJid: ctx.chatJid, hourlyCap: opts.hourlyCap },
          'Voice transcription rate limit reached',
        );
        return AUDIO_PLACEHOLDER.rateLimited;
      }
      const text = await transcribe(audio);
      // Never log the transcript itself — chat content is private.
      logger.info(
        {
          chatJid: ctx.chatJid,
          bytes: audio.bytes,
          mimetype: audio.mimetype,
          chars: text.length,
          ms: now() - t,
        },
        'Transcribed voice message',
      );
      return formatTranscript(audio, text);
    } catch (err) {
      if (err instanceof TranscriptionUnavailableError) {
        logger.warn(
          { chatJid: ctx.chatJid },
          'Voice transcription unavailable: OPENAI_API_KEY not configured',
        );
        return AUDIO_PLACEHOLDER.unavailable;
      }
      if (
        err instanceof TranscriptionError &&
        (err.status === 401 || err.status === 403)
      ) {
        cooldownUntil = now() + cooldownMs;
        logger.error(
          { chatJid: ctx.chatJid, status: err.status, cooldownMs },
          'OpenAI rejected transcription credentials — if OPENAI_API_KEY was rotated, restart the service (the key is read once at startup)',
        );
        return AUDIO_PLACEHOLDER.unavailable;
      }
      logger.warn({ err, chatJid: ctx.chatJid }, 'Voice transcription failed');
      return AUDIO_PLACEHOLDER.failed;
    } finally {
      try {
        fs.unlinkSync(audio.path);
      } catch {
        // Already gone — nothing to clean up.
      }
    }
  }

  return {
    resolve,
    /** @internal */
    _resetForTest(): void {
      limiter.resetForTest();
      cooldownUntil = 0;
    },
  };
}

/**
 * Remove stale files from the audio temp dir (process death between download
 * and unlink, or references the host rejected and deliberately never touched).
 * Runs once at startup.
 */
export function sweepAudioTmpDir(
  maxAgeMs: number = 60 * 60_000,
  tmpDir: string = AUDIO_TMP_DIR,
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const p = path.join(tmpDir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      // Raced with another writer/remover — skip.
    }
  }
  if (removed > 0) {
    logger.info({ removed, tmpDir }, 'Swept stale audio temp files');
  }
  return removed;
}
