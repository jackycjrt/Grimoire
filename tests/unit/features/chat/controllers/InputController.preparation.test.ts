import '@/providers';

import { createMockDeps } from '@test/helpers/inputControllerHarness';
import { Notice } from 'obsidian';

import { InputController } from '@/features/chat/controllers/InputController';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 0; };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function projection() {
  return {
    send: jest.fn().mockResolvedValue({
      userMessage: { content: 'request' },
      ticket: { completion: Promise.resolve({ terminal: { kind: 'succeeded' } }) },
    }),
    cancel: jest.fn().mockResolvedValue(undefined),
    settled: jest.fn().mockResolvedValue(undefined),
  };
}

test('stopping during initialization must prevent later dispatch', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  const ready = deferred<boolean>();
  const entered = deferred<void>();
  deps.ensureServiceInitialized = jest.fn(() => { entered.resolve(); return ready.promise; });
  deps.getInputEl().value = 'Change my note';
  const controller = new InputController(deps);
  const sending = controller.sendMessage();
  await entered.promise;
  controller.cancelStreaming();
  ready.resolve(true);
  await sending;
  expect(p.cancel).toHaveBeenCalledTimes(1);
  expect(p.send).not.toHaveBeenCalled();
});

test.each(['failed', 'invalidated', 'indeterminate', 'interrupted'])(
  'terminal %s must hold queued followups', async kind => {
    jest.useFakeTimers();
    try {
      const deps = createMockDeps();
      const p = projection();
      p.send.mockResolvedValue({
        userMessage: { content: 'request' },
        ticket: { completion: Promise.resolve({ terminal: { kind } }) },
      });
      deps.getProjectionExecution = () => p as never;
      deps.getInputEl().value = 'First request';
      const controller = new InputController(deps);
      deps.state.queue.enqueue({ content: 'Dependent followup', images: undefined, editorContext: null, canvasContext: null });
      await controller.sendMessage();
      expect(deps.state.queue.isPaused).toBe(true);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  },
);

test('failed initialization must preserve the unsent draft', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  deps.ensureServiceInitialized = jest.fn().mockResolvedValue(false);
  deps.getInputEl().value = 'Important unsent request';
  await new InputController(deps).sendMessage();
  expect(p.send).not.toHaveBeenCalled();
  expect(deps.getInputEl().value).toBe('Important unsent request');
});

test('an initialization exception restores text and images', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  deps.ensureServiceInitialized = jest.fn().mockRejectedValue(new Error('CLI unavailable'));
  const images = [{ id: 'image-1', name: 'note.png', mediaType: 'image/png' as const, data: 'AQID', size: 3, source: 'paste' as const }];
  const manager = deps.getImageContextManager()!;
  jest.spyOn(manager, 'getAttachedImages').mockReturnValue(images);
  deps.getInputEl().value = '  Keep my formatting\n';
  await new InputController(deps).sendMessage();
  expect(deps.getInputEl().value).toBe('  Keep my formatting\n');
  expect(manager.setImages).toHaveBeenCalledWith(images);
  expect(deps.state.isStreaming).toBe(false);
  expect(p.send).not.toHaveBeenCalled();
});

test('a missing saved image refuses dispatch and preserves the draft', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  const images = [{ id: 'image-1', name: 'missing.png', mediaType: 'image/png' as const,
    data: '', hash: 'a'.repeat(64), size: 3, source: 'paste' as const }];
  const manager = deps.getImageContextManager()!;
  jest.spyOn(manager, 'getAttachedImages').mockReturnValue(images);
  Object.assign(deps.plugin, { storage: { attachments: { read: jest.fn().mockResolvedValue(null) } } });
  deps.getInputEl().value = 'Describe my picture';

  await new InputController(deps).sendMessage();

  expect(p.send).not.toHaveBeenCalled();
  expect(deps.getInputEl().value).toBe('Describe my picture');
  expect(manager.setImages).toHaveBeenCalledWith(images);
  expect(Notice).toHaveBeenCalledWith(expect.stringContaining('missing.png'));
  expect(deps.state.isStreaming).toBe(false);
});

test('a queued request hydrates its own images before dispatch', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  const images = [{ id: 'image-1', name: 'saved.png', mediaType: 'image/png' as const,
    data: '', hash: 'a'.repeat(64), size: 3, source: 'paste' as const }];
  Object.assign(deps.plugin, { storage: { attachments: {
    read: jest.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  } } });

  await new InputController(deps).sendMessage({ content: 'Queued picture',
    turnRequestOverride: { text: 'Queued picture', images } });

  expect(p.send).toHaveBeenCalledWith(expect.objectContaining({
    images: [expect.objectContaining({ data: 'AQID' })],
  }), expect.objectContaining({ images: [expect.objectContaining({ data: 'AQID' })] }), expect.anything());
});

test('a queued text request cannot borrow images from the newer composer draft', async () => {
  const deps = createMockDeps();
  const p = projection();
  deps.getProjectionExecution = () => p as never;
  const draftImages = [{ id: 'draft-image', name: 'draft.png', data: 'AQID',
    mediaType: 'image/png' as const, size: 3, source: 'paste' as const }];
  jest.spyOn(deps.getImageContextManager()!, 'getAttachedImages').mockReturnValue(draftImages);

  await new InputController(deps).sendMessage({ content: 'Earlier text',
    turnRequestOverride: { text: 'Earlier text' } });

  expect(p.send).toHaveBeenCalledWith(expect.objectContaining({ images: undefined }),
    expect.objectContaining({ images: undefined }), expect.anything());
  expect(deps.getImageContextManager()!.clearImages).not.toHaveBeenCalled();
});

test.each([true, false])('steering requires saved image bytes (available=%s)', async available => {
  jest.mocked(Notice).mockClear();
  const deps = createMockDeps();
  const service = deps.getAgentService!()!;
  jest.spyOn(service, 'getCapabilities').mockReturnValue({
    ...service.getCapabilities(), supportsTurnSteer: true,
  });
  const steer = jest.fn().mockResolvedValue(true);
  deps.getProjectionExecution = () => ({ ...projection(), steer }) as never;
  const images = [{ id: 'image-1', name: 'saved.png', mediaType: 'image/png' as const,
    data: '', hash: 'a'.repeat(64), size: 3, source: 'paste' as const }];
  Object.assign(deps.plugin, { storage: { attachments: {
    read: jest.fn().mockResolvedValue(available ? Uint8Array.from([1, 2, 3]).buffer : null),
  } } });
  deps.state.isStreaming = true;
  deps.state.queue.enqueue({ content: 'Look at this', images, editorContext: null, canvasContext: null });
  const controller = new InputController(deps);

  await (controller as unknown as { steerQueuedMessage(): Promise<void> }).steerQueuedMessage();

  const expectedCall = [expect.objectContaining({
    request: expect.objectContaining({ images: [expect.objectContaining({ data: 'AQID' })] }),
  }), expect.objectContaining({ images: [expect.objectContaining({ data: 'AQID' })] })];
  const missingNotice = [expect.stringContaining('saved.png')];
  expect(steer.mock.calls).toEqual(available ? [expectedCall] : []);
  expect(deps.state.queue.items.map(item => item.images)).toEqual(available ? [] : [images]);
  expect(jest.mocked(Notice).mock.calls).toEqual(available ? [] : [missingNotice]);
});

test('a failed start preserves a newer draft and queues the original request', async () => {
  const deps = createMockDeps();
  const ready = deferred<boolean>();
  const entered = deferred<void>();
  deps.ensureServiceInitialized = () => { entered.resolve(); return ready.promise; };
  deps.getInputEl().value = 'Original request';
  const sending = new InputController(deps).sendMessage();
  await entered.promise;
  deps.getInputEl().value = 'New draft';
  ready.resolve(false);
  await sending;
  expect(deps.getInputEl().value).toBe('New draft');
  expect(deps.state.queue.items[0].content).toBe('Original request');
  expect(deps.state.queue.isPaused).toBe(true);
});

test('a drained message returns to the head of the queue when initialization fails', async () => {
  const deps = createMockDeps();
  deps.ensureServiceInitialized = jest.fn().mockResolvedValue(false);
  deps.state.queue.enqueue({ content: 'Later', images: undefined, editorContext: null, canvasContext: null });
  deps.getInputEl().value = 'Draft';
  const request = { text: 'Queued', currentNotePath: 'original.md' };
  await new InputController(deps).sendMessage({ content: 'Queued', turnRequestOverride: request });
  expect(deps.state.queue.items.map(item => item.content)).toEqual(['Queued', 'Later']);
  expect(deps.state.queue.items[0].turnRequest).toEqual(request);
  expect(deps.getInputEl().value).toBe('Draft');
  expect(deps.state.queue.isPaused).toBe(true);
});

test('completion must not overwrite the provider checkpoint with the display message id', async () => {
  const deps = createMockDeps();
  const nativeId = '8baecb38-3c01-4bc9-8447-2ec235a2057c';
  const assistant = { id: 'assistant-run-1', role: 'assistant' as const,
    content: 'Answer', timestamp: 1, assistantMessageId: nativeId };
  deps.state.addMessage(assistant);
  const p = projection();
  p.send.mockResolvedValue({
    userMessage: { content: 'request' },
    ticket: { completion: Promise.resolve({ terminal: { kind: 'succeeded' }, assistantMessageId: assistant.id }) },
  });
  deps.getProjectionExecution = () => p as never;
  deps.getInputEl().value = 'A request';
  await new InputController(deps).sendMessage();
  expect(assistant.assistantMessageId).toBe(nativeId);
});
