import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('./logger.js', () => ({ logger: mockLogger }));

import {
  AUDIO_PLACEHOLDER,
  MAX_TRANSCRIBE_BYTES,
  TranscriptionError,
  TranscriptionUnavailableError,
  createAudioResolver,
  formatTranscript,
  sweepAudioTmpDir,
  transcribeAudioFile,
  validateAudioRef,
} from './openai-transcription.js';
import type { AuthProvider } from './auth-providers/types.js';

let tmpDir: string;
let outsideDir: string;

function writeAudio(name: string, bytes = 16, dir = tmpDir): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

function fakeProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    name: 'openai',
    priority: 1,
    envKeys: ['OPENAI_API_KEY'],
    isAvailable: () => true,
    getUpstreamUrl: () => 'https://api.openai.example',
    injectAuth: (headers) => {
      headers.authorization = 'Bearer sk-real';
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-audio-test-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deus-audio-outside-'));
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('validateAudioRef', () => {
  it('accepts a regular file inside the tmp dir with an allowed mimetype', () => {
    const p = writeAudio('a.ogg', 100);
    const v = validateAudioRef(
      {
        path: p,
        mimetype: 'audio/ogg; codecs=opus',
        isVoiceNote: true,
        bytes: 1,
      },
      tmpDir,
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.audio.bytes).toBe(100); // re-derived from fs.stat, not the ref
      expect(v.audio.ext).toBe('ogg');
      expect(v.audio.mimetype).toBe('audio/ogg');
      expect(v.audio.isVoiceNote).toBe(true);
    }
  });

  it('rejects a path outside the tmp dir (traversal)', () => {
    const p = writeAudio('secret.ogg', 10, outsideDir);
    const v = validateAudioRef(
      {
        path: path.join(tmpDir, '..', path.basename(outsideDir), 'secret.ogg'),
        mimetype: 'audio/ogg',
      },
      tmpDir,
    );
    expect(v).toEqual({ ok: false, reason: 'path-outside-tmp-dir' });
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rejects a symlink that escapes the tmp dir', () => {
    const target = writeAudio('real.ogg', 10, outsideDir);
    const link = path.join(tmpDir, 'link.ogg');
    fs.symlinkSync(target, link);
    const v = validateAudioRef({ path: link, mimetype: 'audio/ogg' }, tmpDir);
    expect(v).toEqual({ ok: false, reason: 'path-outside-tmp-dir' });
  });

  it('rejects a nested path inside the tmp dir', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    const p = writeAudio(path.join('sub', 'a.ogg'));
    const v = validateAudioRef({ path: p, mimetype: 'audio/ogg' }, tmpDir);
    expect(v).toEqual({ ok: false, reason: 'path-nested' });
  });

  it('rejects a non-regular file', () => {
    const d = path.join(tmpDir, 'dir.ogg');
    fs.mkdirSync(d);
    const v = validateAudioRef({ path: d, mimetype: 'audio/ogg' }, tmpDir);
    expect(v).toEqual({ ok: false, reason: 'not-regular-file' });
  });

  it('rejects a mimetype outside the allow-map', () => {
    const p = writeAudio('a.bin');
    expect(
      validateAudioRef(
        { path: p, mimetype: 'application/octet-stream' },
        tmpDir,
      ),
    ).toEqual({ ok: false, reason: 'mimetype-not-allowed' });
  });

  it('rejects oversized and empty files from fs.stat, ignoring the ref bytes', () => {
    const big = writeAudio('big.ogg', MAX_TRANSCRIBE_BYTES + 1);
    expect(
      validateAudioRef({ path: big, mimetype: 'audio/ogg', bytes: 1 }, tmpDir),
    ).toEqual({ ok: false, reason: 'too-large' });
    const empty = writeAudio('empty.ogg', 0);
    expect(
      validateAudioRef({ path: empty, mimetype: 'audio/ogg' }, tmpDir),
    ).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects malformed references', () => {
    expect(validateAudioRef(null, tmpDir).ok).toBe(false);
    expect(validateAudioRef({ mimetype: 'audio/ogg' }, tmpDir).ok).toBe(false);
    expect(
      validateAudioRef(
        { path: path.join(tmpDir, 'missing.ogg'), mimetype: 'audio/ogg' },
        tmpDir,
      ),
    ).toEqual({ ok: false, reason: 'path-unresolvable' });
  });
});

describe('transcribeAudioFile', () => {
  it('posts multipart to <upstream>/v1/audio/transcriptions with provider auth', async () => {
    const p = writeAudio('a.ogg', 32);
    const v = validateAudioRef({ path: p, mimetype: 'audio/ogg' }, tmpDir);
    if (!v.ok) throw new Error('fixture invalid');

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const form = init?.body as FormData;
        expect(form.get('model')).toBe('gpt-4o-transcribe');
        expect(form.get('response_format')).toBe('json');
        const file = form.get('file') as File;
        expect(file.name).toBe('audio.ogg');
        expect(file.size).toBe(32);
        return new Response(JSON.stringify({ text: '  hello world ' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    const text = await transcribeAudioFile(v.audio, {
      model: 'gpt-4o-transcribe',
      provider: fakeProvider(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(text).toBe('hello world');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.example/v1/audio/transcriptions');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-real',
    );
  });

  it('throws TranscriptionUnavailableError when the provider has no credentials', async () => {
    const p = writeAudio('a.ogg');
    const v = validateAudioRef({ path: p, mimetype: 'audio/ogg' }, tmpDir);
    if (!v.ok) throw new Error('fixture invalid');
    await expect(
      transcribeAudioFile(v.audio, {
        model: 'm',
        provider: fakeProvider({ isAvailable: () => false }),
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TranscriptionUnavailableError);
  });

  it('throws TranscriptionError carrying the HTTP status', async () => {
    const p = writeAudio('a.ogg');
    const v = validateAudioRef({ path: p, mimetype: 'audio/ogg' }, tmpDir);
    if (!v.ok) throw new Error('fixture invalid');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      transcribeAudioFile(v.audio, {
        model: 'm',
        provider: fakeProvider(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptionError', status: 401 });
  });
});

describe('formatTranscript', () => {
  it('formats voice notes and named audio files', () => {
    expect(formatTranscript({ isVoiceNote: true }, 'hi')).toBe('[Voice: hi]');
    expect(
      formatTranscript({ isVoiceNote: false, fileName: 'call.m4a' }, 'hi'),
    ).toBe('[Audio "call.m4a": hi]');
    expect(formatTranscript({ isVoiceNote: false }, 'hi')).toBe('[Voice: hi]');
  });
});

describe('createAudioResolver', () => {
  function makeRef(name = 'a.ogg') {
    const p = writeAudio(name, 20);
    return { p, ref: { path: p, mimetype: 'audio/ogg', isVoiceNote: true } };
  }

  it('transcribes an allowed message, formats it, and unlinks the file', async () => {
    const transcribe = vi.fn(async () => 'bring milk');
    const r = createAudioResolver({
      hourlyCap: 5,
      model: 'm',
      transcribe,
      tmpDir,
    });
    const { p, ref } = makeRef();
    const content = await r.resolve(ref, { chatJid: 'c@g.us', allowed: true });
    expect(content).toBe('[Voice: bring milk]');
    expect(fs.existsSync(p)).toBe(false);
    expect(transcribe).toHaveBeenCalledTimes(1);
    // Transcript text is never logged.
    const logged = JSON.stringify(mockLogger.info.mock.calls);
    expect(logged).not.toContain('bring milk');
  });

  it('never uploads for a denied sender: placeholder + unlink', async () => {
    const transcribe = vi.fn(async () => 'x');
    const r = createAudioResolver({
      hourlyCap: 5,
      model: 'm',
      transcribe,
      tmpDir,
    });
    const { p, ref } = makeRef();
    const content = await r.resolve(ref, { chatJid: 'c@g.us', allowed: false });
    expect(content).toBe(AUDIO_PLACEHOLDER.voice);
    expect(transcribe).not.toHaveBeenCalled();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('never reads, uploads, or unlinks a rejected reference', async () => {
    const transcribe = vi.fn(async () => 'x');
    const r = createAudioResolver({
      hourlyCap: 5,
      model: 'm',
      transcribe,
      tmpDir,
    });
    const outside = writeAudio('leak.ogg', 20, outsideDir);
    const content = await r.resolve(
      { path: outside, mimetype: 'audio/ogg' },
      { chatJid: 'c@g.us', allowed: true },
    );
    expect(content).toBe(AUDIO_PLACEHOLDER.voice);
    expect(transcribe).not.toHaveBeenCalled();
    expect(fs.existsSync(outside)).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'path-outside-tmp-dir' }),
      'Rejected audio reference from channel',
    );
  });

  it('enforces the per-chat hourly cap only for allowed chats', async () => {
    const transcribe = vi.fn(async () => 'x');
    const r = createAudioResolver({
      hourlyCap: 2,
      model: 'm',
      transcribe,
      tmpDir,
    });
    for (let i = 0; i < 2; i++) {
      const { ref } = makeRef(`a${i}.ogg`);
      await r.resolve(ref, { chatJid: 'c@g.us', allowed: true });
    }
    const { p, ref } = makeRef('over.ogg');
    const content = await r.resolve(ref, { chatJid: 'c@g.us', allowed: true });
    expect(content).toBe(AUDIO_PLACEHOLDER.rateLimited);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(p)).toBe(false);
    // A different chat has its own budget.
    const other = makeRef('other.ogg');
    expect(
      await r.resolve(other.ref, { chatJid: 'd@g.us', allowed: true }),
    ).toBe('[Voice: x]');
  });

  it('enters a cooldown after 401/403 and stops uploading', async () => {
    let t = 1_000_000;
    const transcribe = vi
      .fn<(a: unknown) => Promise<string>>()
      .mockRejectedValueOnce(new TranscriptionError('HTTP 401', 401))
      .mockResolvedValue('ok');
    const r = createAudioResolver({
      hourlyCap: 10,
      model: 'm',
      transcribe,
      tmpDir,
      cooldownMs: 60_000,
      now: () => t,
    });
    const first = makeRef('a.ogg');
    expect(
      await r.resolve(first.ref, { chatJid: 'c@g.us', allowed: true }),
    ).toBe(AUDIO_PLACEHOLDER.unavailable);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);

    t += 30_000; // inside cooldown
    const second = makeRef('b.ogg');
    expect(
      await r.resolve(second.ref, { chatJid: 'c@g.us', allowed: true }),
    ).toBe(AUDIO_PLACEHOLDER.unavailable);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(second.p)).toBe(false);

    t += 60_000; // cooldown expired
    const third = makeRef('c.ogg');
    expect(
      await r.resolve(third.ref, { chatJid: 'c@g.us', allowed: true }),
    ).toBe('[Voice: ok]');
  });

  it('maps unavailable credentials and generic failures to placeholders', async () => {
    const r1 = createAudioResolver({
      hourlyCap: 10,
      model: 'm',
      tmpDir,
      transcribe: async () => {
        throw new TranscriptionUnavailableError();
      },
    });
    expect(
      await r1.resolve(makeRef('u.ogg').ref, { chatJid: 'c', allowed: true }),
    ).toBe(AUDIO_PLACEHOLDER.unavailable);
    const r2 = createAudioResolver({
      hourlyCap: 10,
      model: 'm',
      tmpDir,
      transcribe: async () => {
        throw new Error('boom');
      },
    });
    const { p, ref } = makeRef('f.ogg');
    expect(await r2.resolve(ref, { chatJid: 'c', allowed: true })).toBe(
      AUDIO_PLACEHOLDER.failed,
    );
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('sweepAudioTmpDir', () => {
  it('removes only files older than maxAge', () => {
    const old = writeAudio('old.ogg');
    const fresh = writeAudio('fresh.ogg');
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    fs.utimesSync(old, past, past);
    expect(sweepAudioTmpDir(60 * 60_000, tmpDir)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('is a no-op when the dir does not exist', () => {
    expect(sweepAudioTmpDir(1, path.join(tmpDir, 'nope'))).toBe(0);
  });
});
