import { AttachmentStore } from '@/core/attachments/AttachmentStore';
import { hydrateImagesForSend } from '@/core/attachments/hydrateImages';
import type { ImageAttachment } from '@/core/types';

import { type ChatProjectionHarness, userMessage } from './chatProjectionLiveHarness';

// Two solid 64px PNGs. Neither the names nor the prompt reveal their colors.
const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC',
];

/** One paid turn, through the real provider composition and the chat persistence barrier. */
export async function imageAttachmentRoundTrip(
  harness: ChatProjectionHarness,
  conversationId: string,
  model?: string,
): Promise<void> {
  const files = new Map<string, ArrayBuffer>();
  const store = new AttachmentStore({
    exists: async path => files.has(path),
    readBinary: async path => files.get(path)!,
    writeBinary: async (path, bytes) => { files.set(path, bytes); },
    delete: async path => { files.delete(path); },
    listFiles: async () => [...files.keys()],
    getResourcePath: path => path,
  });
  const images: ImageAttachment[] = await Promise.all(pngs.map(async (data, index) => ({
    ...await store.put(Uint8Array.from(Buffer.from(data, 'base64')).buffer, 'image/png'),
    id: `image-${index}`, name: `attachment-${index + 1}.png`, source: 'paste' as const, data: '',
  })));
  await hydrateImagesForSend(images, store);
  const text = 'Look at both attached images. If supplied as file paths, open them with your image-reading tool. '
    + 'Do not search for other files or inspect source code, tests, or session logs. '
    + 'If you cannot see the attachments, reply unavailable. Otherwise reply only with the dominant color '
    + 'of the first image, then the second image, in English.';
  const timer = setTimeout(() => { void harness.tab.cancel(); }, 90_000);
  try {
    const submitted = await harness.tab.send({ text, images }, { ...userMessage(text), images }, {
      queryOptions: model ? { model } : undefined,
    });
    const completed = await submitted.ticket.completion;
    await harness.tab.settled();
    process.stdout.write(`IMAGE ${conversationId} ${model ?? 'CLI default'} ${completed.terminal.kind} `
      + `${JSON.stringify(harness.column.drawn.join('').slice(0, 300))} `
      + `${JSON.stringify(harness.column.failures)}\n`);
    if (!/\bred\b[\s\S]*\bblue\b/i.test(harness.column.drawn.join(''))) {
      for (const chunk of harness.column.chunks) {
        if (chunk.type === 'tool_use' || chunk.type === 'tool_result') {
          process.stdout.write(`IMAGE TOOL ${JSON.stringify(chunk).slice(0, 1500)}\n`);
        }
      }
    }
    expect(completed.terminal.kind).toBe('succeeded');
    expect(harness.column.failures).toEqual([]);
    expect(harness.column.drawn.join('').toLowerCase()).toMatch(/\bred\b[\s\S]*\bblue\b/);
    await harness.saveAfterTurn();
    const stored = await harness.sessions.records.read(conversationId);
    expect(stored.kind).toBe('present');
    const savedImages = stored.kind === 'present'
      ? stored.metadata.messages?.find(message => message.role === 'user')?.images
      : undefined;
    expect(savedImages?.map(image => image.hash)).toEqual(images.map(image => image.hash));
    // Reload from the saved references, without relying on in-memory image data.
    const reloaded = savedImages!.map(image => ({ ...image, data: '' }));
    await hydrateImagesForSend(reloaded, store);
    expect(reloaded.map(image => image.data)).toEqual(pngs);
  } finally {
    clearTimeout(timer);
  }
}
