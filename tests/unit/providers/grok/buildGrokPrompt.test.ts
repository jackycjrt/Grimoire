import { buildGrokPromptBlocks, buildGrokPromptText } from '../../../../src/providers/grok/runtime/buildGrokPrompt';

describe('buildGrokPromptText', () => {
  it('appends Grimoire XML context to the user query', () => {
    const prompt = buildGrokPromptText({
      browserSelection: {
        selectedText: 'Browser quote',
        source: 'browser:https://example.com',
        title: 'Example',
        url: 'https://example.com',
      },
      currentNotePath: 'notes/today.md',
      editorSelection: {
        mode: 'selection',
        notePath: 'notes/today.md',
        selectedText: 'Selected text',
        startLine: 4,
        lineCount: 2,
      },
      text: 'Summarize this',
    });

    expect(prompt).toContain('Summarize this');
    expect(prompt).toContain('<current_note>');
    expect(prompt).toContain('notes/today.md');
    expect(prompt).toContain('<editor_selection path="notes/today.md" lines="4-5">');
    expect(prompt).toContain('<browser_selection source="browser:https://example.com" title="Example" url="https://example.com">');
  });

  it('does not auto-attach external context folders to the Grok Build prompt', () => {
    const prompt = buildGrokPromptText({
      externalContextPaths: ['/tmp/project'],
      text: 'Summarize this',
    });

    expect(prompt).toContain('Summarize this');
    expect(prompt).not.toContain('<context_files>');
    expect(prompt).not.toContain('/tmp/project');
  });

  it('appends excluded folders to the Grok Build prompt', () => {
    const prompt = buildGrokPromptText({
      excludedFolders: ['Climate'],
      text: 'Summarize this',
    });

    expect(prompt).toContain('<excluded_folders>');
    expect(prompt).toContain('<folder>Climate</folder>');
  });

  it('appends selected context files to the Grok prompt', () => {
    const prompt = buildGrokPromptText({
      contextFiles: ['notes/instructions.md'],
      text: 'Apply these instructions',
    });

    expect(prompt).toContain('<context_files>');
    expect(prompt).toContain('The user selected these files as active context.');
    expect(prompt).toContain('Inspect the relevant selected files before answering broad or deictic requests.');
    expect(prompt).toContain('notes/instructions.md');
  });

  it('appends vault search context to the prompt', () => {
    const prompt = buildGrokPromptText({
      text: 'Summarize this',
      vaultSearchContext: {
        query: 'roadmap',
        snippets: [{
          source: { id: 'v1', kind: 'vault-note', path: 'notes/Roadmap.md', title: 'Roadmap' },
          text: 'Launch plan',
          score: 1,
          matchedTerms: ['roadmap'],
        }],
      },
    });

    expect(prompt).toContain('<vault_search query="roadmap">');
    expect(prompt).toContain('Launch plan');
  });

  it('rebuilds prior conversation context when a native session must be recreated', () => {
    const prompt = buildGrokPromptText(
      {
        text: 'Continue with the fix',
      },
      [
        {
          content: 'Inspect the bug',
          id: 'user-1',
          role: 'user',
          timestamp: 1,
        },
        {
          content: 'I found the failing path',
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 2,
        },
      ],
    );

    expect(prompt).toContain('User: Inspect the bug');
    expect(prompt).toContain('Assistant: I found the failing path');
    expect(prompt).toContain('User: Continue with the fix');
  });

  it('prepends orchestrator instructions when orchestrator mode is active', () => {
    const prompt = buildGrokPromptText({
      orchestratorMode: true,
      text: 'Plan this work',
    });

    expect(prompt).toContain('## Grimoire Parallel Workers Mode');
    expect(prompt).toContain('"type": "parallel_worker_plan"');
    expect(prompt.indexOf('## Grimoire Parallel Workers Mode')).toBeLessThan(
      prompt.indexOf('Plan this work'),
    );
  });
});

describe('buildGrokPromptBlocks', () => {
  it('refuses saved image requests instead of silently sending text', () => {
    expect(() => buildGrokPromptBlocks({
      images: [{
        data: 'base64-image',
        id: 'img-1',
        mediaType: 'image/png',
        name: 'diagram.png',
        size: 123,
        source: 'file',
      }],
      text: 'Inspect this image',
    })).toThrow('Grok Build does not support image attachments over ACP');
  });
});
