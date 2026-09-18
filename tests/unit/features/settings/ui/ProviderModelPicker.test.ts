/** @jest-environment jsdom */
import type { ModelPickerState } from '@/features/settings/ui/ProviderModelPicker';
import { renderProviderModelPicker } from '@/features/settings/ui/ProviderModelPicker';

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function setup() {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    toggleClass(this: HTMLElement, cls: string, enabled: boolean) { this.classList.toggle(cls, enabled); },
  });
  const state: ModelPickerState = {
    models: [
      { rawId: 'alpha/model', modelLabel: 'Model', providerKey: 'alpha', providerLabel: 'Alpha', description: 'Fast', isAvailable: true },
      { rawId: 'beta/other', modelLabel: 'Other', providerKey: 'beta', providerLabel: 'Beta', description: 'Thorough', isAvailable: true },
    ],
    discoveredCount: 2, visibleModels: ['alpha/model'], modelAliases: {},
  };
  const refresh = jest.fn(async () => true);
  const aliasChange = jest.fn(async (id: string, value: string) => { state.modelAliases![id] = value; });
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  renderProviderModelPicker(container, {
    providerName: 'Example', description: 'Choose models', getState: () => state,
    suppressAutomaticDiscovery: true, onRefresh: refresh, onAliasChange: aliasChange,
    onSelectionChange: async ids => { state.visibleModels = ids; },
  });
  return { state, refresh, aliasChange, container };
}

describe('shared provider model picker', () => {
  it('combines search and provider filtering without changing the selection', () => {
    const f = setup();
    const select = f.container.querySelector<HTMLSelectElement>('select')!;
    const search = f.container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    select.value = 'beta';
    select.dispatchEvent(new Event('change'));
    search.value = 'Thorough';
    search.dispatchEvent(new Event('input'));
    expect(f.container.querySelectorAll('label')).toHaveLength(1);
    expect(f.container.querySelector('label')?.textContent).toContain('Other');
    search.value = 'Fast';
    search.dispatchEvent(new Event('input'));
    expect(f.container.querySelectorAll('label')).toHaveLength(0);
    expect(f.state.visibleModels).toEqual(['alpha/model']);
  });

  it('keeps an alias draft and its caret while a pending refresh completes', async () => {
    const f = setup();
    let complete!: (loaded: boolean) => void;
    f.refresh.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const refreshButton = Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === 'Refresh all models')!;
    refreshButton.click();
    const alias = f.container.querySelector<HTMLInputElement>('.grimoire-model-picker-selected-alias')!;
    alias.focus();
    alias.value = 'Uncommitted alias';
    alias.setSelectionRange(3, 7);
    complete(true);
    await settle();
    const current = document.activeElement as HTMLInputElement;
    expect(current.classList.contains('grimoire-model-picker-selected-alias')).toBe(true);
    expect(current.value).toBe('Uncommitted alias');
    expect([current.selectionStart, current.selectionEnd]).toEqual([3, 7]);
    expect(f.aliasChange).not.toHaveBeenCalled();
  });

  it('cancels an alias edit with Escape and saves it on blur', async () => {
    const f = setup();
    const alias = f.container.querySelector<HTMLInputElement>('.grimoire-model-picker-selected-alias')!;
    alias.focus();
    alias.value = 'Discard';
    alias.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(alias.value).toBe('');
    expect(f.aliasChange).not.toHaveBeenCalled();
    alias.focus();
    alias.value = 'Daily';
    alias.blur();
    await settle();
    expect(f.aliasChange).toHaveBeenCalledWith('alpha/model', 'Daily');
  });
});
