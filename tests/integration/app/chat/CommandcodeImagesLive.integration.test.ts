import '@/providers';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TestDurableStorage } from '@test/unit/core/persistence/TestDurableStorage';

import { ExecutionKernelHost } from '@/app/execution/ExecutionKernelHost';
import { AttachmentStore } from '@/core/attachments/AttachmentStore';
import type { ImageAttachment, StreamChunk } from '@/core/types';
import type GrimoirePlugin from '@/main';
import { CommandcodeExecution } from '@/providers/commandcode/execution/CommandcodeExecutionComposition';

// Explicit opt-in: makes one paid vision request using the authenticated CLI.
const live = process.env.GRIMOIRE_COMMANDCODE_IMAGES_LIVE === '1' ? describe : describe.skip;
const redPng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

live('Command Code native image reading', () => {
  jest.setTimeout(120_000);
  it('opens a stored image from a vault path and answers its color through Safe mode', async () => {
    const vault = mkdtempSync(join(tmpdir(), 'grimoire-image-vault '));
    const model = 'commandcode:qwen/qwen3.8-flash';
    const attachments = new AttachmentStore({
      exists: async path => existsSync(join(vault, path)),
      readBinary: async path => Uint8Array.from(readFileSync(join(vault, path))).buffer,
      writeBinary: async (path, bytes) => {
        mkdirSync(dirname(join(vault, path)), { recursive: true });
        writeFileSync(join(vault, path), Buffer.from(bytes));
      },
      delete: async () => undefined, listFiles: async () => [], getResourcePath: path => path,
    });
    const plugin = { settings: { model, savedProviderModel: { commandcode: model }, permissionMode: 'normal',
      providerConfigs: { commandcode: { enabled: true, imageAttachmentsAsFiles: true } } },
    app: { vault: { adapter: { basePath: vault } } }, storage: { attachments },
    getApplicationRuntimeOrNull: () => null, recordDebugLog: () => undefined } as unknown as GrimoirePlugin;
    const host = new ExecutionKernelHost({ storage: new TestDurableStorage(),
      scheduler: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) } });
    const execution = new CommandcodeExecution(plugin, host.registry);
    const backend = execution.createBackend();
    host.registerBackend({ backend, interactions: backend.interactions });
    await host.start();
    const runtime = execution.createRuntime();
    runtime.installInteractions({ approval: async () => 'deny' });
    try {
      const image: ImageAttachment = { id: 'color', name: 'color.png', data: redPng, mediaType: 'image/png',
        size: Buffer.from(redPng, 'base64').length, source: 'paste' };
      const stored = await attachments.put(Uint8Array.from(Buffer.from(redPng, 'base64')).buffer, image.mediaType);
      Object.assign(image, stored, { data: '' });
      const turn = runtime.prepareTurn({ text: 'Open the attached image with your read_file tool. Reply only with its dominant color in English.', images: [image] });
      const chunks: StreamChunk[] = [];
      for await (const chunk of runtime.query(turn, [], { model })) chunks.push(chunk);
      expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]);
      expect(chunks.some(chunk => chunk.type === 'tool_use' && chunk.name === 'Read')).toBe(true);
      const answer = chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.content).join('');
      expect(answer.toLowerCase()).toContain('red');
      expect(runtime.getSessionId()).toBeTruthy();
    } finally { await runtime.cleanup(); await host.dispose(); await execution.dispose(); rmSync(vault, { recursive: true, force: true }); }
  });
});
