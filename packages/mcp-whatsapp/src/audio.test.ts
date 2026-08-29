import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  AUDIO_MIME_EXT,
  AUDIO_TMP_DIR,
  MAX_TRANSCRIBE_BYTES,
  audioTempPath,
  classifyAudio,
  normalizeMimetype,
  tooLargePlaceholder,
} from './audio.js';

describe('classifyAudio', () => {
  it('classifies a push-to-talk voice note', () => {
    const audioMessage = {
      mimetype: 'audio/ogg; codecs=opus',
      fileLength: 12345,
      ptt: true,
    };
    const ref = classifyAudio({ audioMessage });
    expect(ref).toEqual({
      mediaType: 'audio',
      message: audioMessage,
      mimetype: 'audio/ogg',
      fileLength: 12345,
      isVoiceNote: true,
    });
  });

  it('classifies a plain audio message as a file, not a voice note', () => {
    const ref = classifyAudio({
      audioMessage: { mimetype: 'audio/mpeg', fileLength: 10, ptt: false },
    });
    expect(ref?.mediaType).toBe('audio');
    expect(ref?.isVoiceNote).toBe(false);
  });

  it('accepts Long-shaped fileLength values', () => {
    const ref = classifyAudio({
      audioMessage: {
        mimetype: 'audio/mp4',
        fileLength: { toNumber: () => 4242 },
        ptt: true,
      },
    });
    expect(ref?.fileLength).toBe(4242);
  });

  it('classifies an audio/* document with its file name', () => {
    const ref = classifyAudio({
      documentMessage: {
        mimetype: 'audio/mp4',
        fileLength: 99,
        fileName: 'meeting.m4a',
      },
    });
    expect(ref).toMatchObject({
      mediaType: 'document',
      mimetype: 'audio/mp4',
      fileName: 'meeting.m4a',
      isVoiceNote: false,
    });
  });

  it('ignores non-audio documents', () => {
    expect(
      classifyAudio({
        documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' },
      }),
    ).toBeNull();
  });

  it('ignores messages with no audio at all', () => {
    expect(classifyAudio({})).toBeNull();
    expect(
      classifyAudio({ audioMessage: null, documentMessage: null }),
    ).toBeNull();
  });
});

describe('normalizeMimetype', () => {
  it('strips parameters and lowercases', () => {
    expect(normalizeMimetype('Audio/OGG; codecs=opus')).toBe('audio/ogg');
    expect(normalizeMimetype(undefined)).toBe('');
  });
});

describe('tooLargePlaceholder', () => {
  it('reports the size in MB against the 25 MB limit', () => {
    expect(tooLargePlaceholder(MAX_TRANSCRIBE_BYTES + 1024 * 1024)).toBe(
      '[Voice Message - too large to transcribe (26 MB, limit 25 MB)]',
    );
  });
});

describe('audioTempPath', () => {
  it('builds a path inside the dedicated tmp dir with a mapped extension', () => {
    const p = audioTempPath('3EB0ABC123', 'audio/ogg; codecs=opus');
    expect(p).not.toBeNull();
    expect(path.dirname(p as string)).toBe(AUDIO_TMP_DIR);
    expect(path.basename(p as string)).toMatch(
      /^3EB0ABC123-[a-z0-9]+-[a-z0-9]+\.ogg$/,
    );
  });

  it('sanitizes the message id so it can never escape the directory', () => {
    const p = audioTempPath('../../etc/passwd', 'audio/mpeg', '/tmp/x');
    expect(p).toBe(path.join('/tmp/x', path.basename(p as string)));
    expect(path.basename(p as string)).toMatch(
      /^etcpasswd-[a-z0-9]+-[a-z0-9]+\.mp3$/,
    );
  });

  it('returns null for a mimetype outside the allow-map', () => {
    expect(audioTempPath('id', 'audio/x-evil')).toBeNull();
    expect(audioTempPath('id', 'application/octet-stream')).toBeNull();
  });

  it('never derives the extension from raw mimetype text', () => {
    for (const [mime, ext] of Object.entries(AUDIO_MIME_EXT)) {
      expect(audioTempPath('id', `${mime}; x=../..`)).toMatch(
        new RegExp(`\\.${ext}$`),
      );
    }
  });
});
