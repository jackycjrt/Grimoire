import type { AttachmentStore } from '@/core/attachments/AttachmentStore';
import {
  hydrateImageAttachments,
  hydrateImages,
  hydrateImagesForSend,
  ImageAttachmentUnavailableError,
} from '@/core/attachments/hydrateImages';
import type { ChatMessage } from '@/core/types';

const HASH = 'a'.repeat(64);

const bytesOf = (text: string): ArrayBuffer => {
  const buffer = Buffer.from(text, 'utf-8');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

function messageWithImage(overrides: Record<string, unknown>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'look',
    timestamp: 0,
    images: [{
      id: 'img-1',
      name: 'shot.webp',
      mediaType: 'image/webp',
      data: '',
      size: 5,
      source: 'paste',
      ...overrides,
    }],
  } as unknown as ChatMessage;
}

describe('hydrateImageAttachments', () => {
  it('refills the bytes a stored attachment left out of metadata', async () => {
    const store = { read: jest.fn().mockResolvedValue(bytesOf('hello')) } as unknown as AttachmentStore;
    const messages = [messageWithImage({ hash: HASH })];

    await hydrateImageAttachments(messages, store);

    expect(store.read).toHaveBeenCalledWith(HASH, 'image/webp');
    expect(Buffer.from(messages[0].images![0].data, 'base64').toString()).toBe('hello');
  });

  it('leaves an attachment that still carries its own bytes alone', async () => {
    const store = { read: jest.fn() } as unknown as AttachmentStore;
    const messages = [messageWithImage({ hash: HASH, data: 'aGk=' })];

    await hydrateImageAttachments(messages, store);

    expect(store.read).not.toHaveBeenCalled();
    expect(messages[0].images![0].data).toBe('aGk=');
  });

  it('ignores an attachment the store never held', async () => {
    const store = { read: jest.fn() } as unknown as AttachmentStore;
    const messages = [messageWithImage({})];

    await hydrateImageAttachments(messages, store);

    expect(store.read).not.toHaveBeenCalled();
  });

  it('opens the conversation anyway when the stored file is gone', async () => {
    const store = { read: jest.fn().mockResolvedValue(null) } as unknown as AttachmentStore;
    const messages = [messageWithImage({ hash: HASH })];

    await expect(hydrateImageAttachments(messages, store)).resolves.toBeUndefined();
    expect(messages[0].images![0].data).toBe('');
  });

  it('tolerates a conversation with no messages', async () => {
    const store = { read: jest.fn() } as unknown as AttachmentStore;

    await expect(hydrateImageAttachments(undefined, store)).resolves.toBeUndefined();
  });
});

describe('hydrateImages', () => {
  it('refills the attachments of a turn before a provider writes them to disk', async () => {
    const store = { read: jest.fn().mockResolvedValue(bytesOf('bytes')) } as unknown as AttachmentStore;
    const images = messageWithImage({ hash: HASH }).images!;

    await hydrateImages(images, store);

    expect(Buffer.from(images[0].data, 'base64').toString()).toBe('bytes');
  });

  it('tolerates a turn with no attachments', async () => {
    const store = { read: jest.fn() } as unknown as AttachmentStore;

    await expect(hydrateImages(undefined, store)).resolves.toBeUndefined();
    expect(store.read).not.toHaveBeenCalled();
  });
});

describe('hydrateImagesForSend', () => {
  it('refuses the whole batch when one stored attachment is missing', async () => {
    const store = { read: jest.fn().mockResolvedValue(null) } as unknown as AttachmentStore;
    const images = [
      ...messageWithImage({ data: 'AQID' }).images!,
      ...messageWithImage({ hash: HASH }).images!,
    ];
    await expect(hydrateImagesForSend(images, store)).rejects.toBeInstanceOf(ImageAttachmentUnavailableError);
  });

  it('accepts inline bytes without a store', async () => {
    await expect(hydrateImagesForSend(messageWithImage({ data: 'AQID' }).images)).resolves.toBeUndefined();
  });

  it('refuses missing bytes even when no store is available', async () => {
    await expect(hydrateImagesForSend(messageWithImage({}).images)).rejects.toThrow('shot.webp');
  });
});
