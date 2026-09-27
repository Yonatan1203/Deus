import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('googleapis', () => {
  const mockGmail = {
    users: {
      getProfile: vi.fn(),
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        send: vi.fn(),
        modify: vi.fn(),
        batchModify: vi.fn(),
      },
      labels: {
        list: vi.fn(),
        create: vi.fn(),
      },
      drafts: {
        create: vi.fn(),
      },
    },
  };
  return {
    google: {
      auth: {
        OAuth2: class MockOAuth2 {
          setCredentials = vi.fn();
          on = vi.fn();
        },
      },
      gmail: () => mockGmail,
    },
    gmail_v1: {},
  };
});

vi.mock('google-auth-library', () => ({
  OAuth2Client: class MockOAuth2Client {
    setCredentials = vi.fn();
    on = vi.fn();
  },
}));

vi.mock('pino', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  };
  const pinoFn: any = () => mockLogger;
  pinoFn.destination = () => ({});
  return { default: pinoFn };
});

import { GmailProvider } from './gmail.js';

describe('GmailProvider', () => {
  let provider: GmailProvider;

  beforeEach(() => {
    provider = new GmailProvider();
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(provider.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(provider.isConnected()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns disconnected status before connect', () => {
      const status = provider.getStatus();
      expect(status.connected).toBe(false);
      expect(status.channel).toBe('gmail');
      expect(status.uptime_seconds).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  describe('hasCredentials', () => {
    it('returns false when credentials directory does not exist', () => {
      // Default CREDENTIALS_DIR is ~/.gmail-mcp/ which likely has no keys in test
      expect(provider.hasCredentials()).toBe(false);
    });
  });

  describe('listChats', () => {
    it('returns empty array before any messages', async () => {
      const chats = await provider.listChats();
      expect(chats).toEqual([]);
    });
  });

  describe('sendMessage failure propagation', () => {
    it('throws when gmail is not initialized', async () => {
      await expect(provider.sendMessage('gmail:abc', 'hi')).rejects.toThrow(
        'Gmail not initialized',
      );
    });

    it('throws when there is no thread metadata for the reply', async () => {
      (provider as any).gmail = { users: { messages: { send: vi.fn() } } };

      await expect(provider.sendMessage('gmail:abc', 'hi')).rejects.toThrow(
        'No thread metadata for reply',
      );
    });

    it('throws when the underlying send fails', async () => {
      const send = vi.fn().mockRejectedValue(new Error('quota exceeded'));
      (provider as any).gmail = { users: { messages: { send } } };
      (provider as any).threadMeta.set('abc', {
        sender: 'a@b.com',
        senderName: 'A',
        subject: 'hi',
        messageId: '<id@b.com>',
      });

      await expect(provider.sendMessage('gmail:abc', 'hi')).rejects.toThrow(
        'quota exceeded',
      );
    });
  });

  describe('processed label (no mark-as-read)', () => {
    const LABEL_ID = 'Label_processed';

    function fakeGmail() {
      return {
        users: {
          messages: {
            list: vi.fn(),
            get: vi.fn(),
            modify: vi.fn().mockResolvedValue({}),
            batchModify: vi.fn().mockResolvedValue({}),
          },
          labels: {
            list: vi.fn(),
            create: vi.fn(),
          },
        },
      };
    }

    function emailFrom(from: string, body = 'hello') {
      return {
        data: {
          threadId: 't1',
          internalDate: '1790000000000',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: from },
              { name: 'Subject', value: 'Hi' },
              { name: 'Message-ID', value: '<m1@x>' },
            ],
            body: { data: Buffer.from(body).toString('base64url') },
          },
        },
      };
    }

    it('queries Primary via category:personal and excludes processed mail', () => {
      const q = (provider as any).buildQuery();
      expect(q).toContain('category:personal');
      expect(q).toContain('-label:deus-processed');
      expect(q).not.toContain('category:primary');
    });

    it('labels a delivered email and never removes UNREAD', async () => {
      const g = fakeGmail();
      g.users.messages.list.mockResolvedValue({
        data: { messages: [{ id: 'm1' }] },
      });
      g.users.messages.get.mockResolvedValue(emailFrom('Sup <sup@vendor.com>'));
      (provider as any).gmail = g;
      (provider as any).processedLabelId = LABEL_ID;
      const onMessage = vi.fn();
      provider.onMessage = onMessage;

      await (provider as any).pollForMessages();

      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(g.users.messages.modify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'm1',
        requestBody: { addLabelIds: [LABEL_ID] },
      });
      for (const [arg] of g.users.messages.modify.mock.calls) {
        expect(arg.requestBody.removeLabelIds).toBeUndefined();
      }
    });

    it('labels a skipped self-sent email so it cannot starve the query', async () => {
      const g = fakeGmail();
      g.users.messages.list.mockResolvedValue({
        data: { messages: [{ id: 'm2' }] },
      });
      g.users.messages.get.mockResolvedValue(emailFrom('Me <me@shop.com>'));
      (provider as any).gmail = g;
      (provider as any).processedLabelId = LABEL_ID;
      (provider as any).userEmail = 'me@shop.com';
      const onMessage = vi.fn();
      provider.onMessage = onMessage;

      await (provider as any).pollForMessages();

      expect(onMessage).not.toHaveBeenCalled();
      expect(g.users.messages.modify).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm2',
          requestBody: { addLabelIds: [LABEL_ID] },
        }),
      );
    });

    it('keeps polling healthy when labelling fails', async () => {
      const g = fakeGmail();
      g.users.messages.list.mockResolvedValue({
        data: { messages: [{ id: 'm3' }] },
      });
      g.users.messages.get.mockResolvedValue(emailFrom('Sup <sup@vendor.com>'));
      g.users.messages.modify.mockRejectedValue(new Error('rate limited'));
      (provider as any).gmail = g;
      (provider as any).processedLabelId = LABEL_ID;
      provider.onMessage = vi.fn();

      await expect(
        (provider as any).pollForMessages(),
      ).resolves.toBeUndefined();
      expect((provider as any).consecutiveErrors).toBe(0);
    });

    it('reuses an existing label without baselining', async () => {
      const g = fakeGmail();
      g.users.labels.list.mockResolvedValue({
        data: { labels: [{ id: LABEL_ID, name: 'deus-processed' }] },
      });
      (provider as any).gmail = g;

      await (provider as any).ensureProcessedLabel();

      expect((provider as any).processedLabelId).toBe(LABEL_ID);
      expect(g.users.labels.create).not.toHaveBeenCalled();
      expect(g.users.messages.batchModify).not.toHaveBeenCalled();
    });

    it('creates a hidden label and tags the backlog without delivering it', async () => {
      const g = fakeGmail();
      g.users.labels.list.mockResolvedValue({ data: { labels: [] } });
      g.users.labels.create.mockResolvedValue({ data: { id: LABEL_ID } });
      g.users.messages.list.mockResolvedValue({
        data: { messages: [{ id: 'a' }, { id: 'b' }] },
      });
      (provider as any).gmail = g;
      const onMessage = vi.fn();
      provider.onMessage = onMessage;

      await (provider as any).ensureProcessedLabel();

      expect(g.users.labels.create).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: {
          name: 'deus-processed',
          labelListVisibility: 'labelHide',
          messageListVisibility: 'hide',
        },
      });
      expect(g.users.messages.batchModify).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { ids: ['a', 'b'], addLabelIds: [LABEL_ID] },
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(g.users.messages.get).not.toHaveBeenCalled();
    });

    it('pages the backlog and chunks batchModify at 1000 ids', async () => {
      const g = fakeGmail();
      g.users.labels.list.mockResolvedValue({ data: { labels: [] } });
      g.users.labels.create.mockResolvedValue({ data: { id: LABEL_ID } });
      const ids = (n: number, off: number) =>
        Array.from({ length: n }, (_, i) => ({ id: `id${off + i}` }));
      g.users.messages.list
        .mockResolvedValueOnce({
          data: { messages: ids(1000, 0), nextPageToken: 'p2' },
        })
        .mockResolvedValueOnce({ data: { messages: ids(500, 1000) } });
      (provider as any).gmail = g;

      await (provider as any).ensureProcessedLabel();

      expect(g.users.messages.list).toHaveBeenCalledTimes(2);
      expect(g.users.messages.list.mock.calls[1][0].pageToken).toBe('p2');
      const calls = g.users.messages.batchModify.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].requestBody.ids).toHaveLength(1000);
      expect(calls[1][0].requestBody.ids).toHaveLength(500);
    });

    it('fails connect() with a named cause when label setup fails', async () => {
      const fs = await import('fs');
      const exists = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true);
      const read = vi
        .spyOn(fs.default, 'readFileSync')
        .mockReturnValue(
          JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }),
        );
      const { google } = await import('googleapis');
      const g: any = (google as any).gmail();
      g.users.getProfile.mockResolvedValue({
        data: { emailAddress: 'me@shop.com' },
      });
      g.users.labels.list.mockRejectedValue(new Error('insufficient scope'));

      await expect(provider.connect()).rejects.toThrow(
        'Gmail processed-label setup failed: insufficient scope',
      );
      expect(provider.isConnected()).toBe(false);
      exists.mockRestore();
      read.mockRestore();
    });
  });
});
