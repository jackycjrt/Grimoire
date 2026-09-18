/** @jest-environment jsdom */
import type GrimoirePlugin from '@/main';
import { getCommandcodeSettings, updateCommandcodeSettings } from '@/providers/commandcode/settings';
import { commandcodeChatUIConfig } from '@/providers/commandcode/ui/CommandcodeChatUIConfig';
import { renderCommandcodeModelPicker } from '@/providers/commandcode/ui/CommandcodeModelPicker';
import type { ProviderSettingsTabRendererContext } from '@/providers/shared/providerHostContracts';

function setup() {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    toggleClass(this: HTMLElement, cls: string, enabled: boolean) { this.classList.toggle(cls, enabled); },
  });
  const settings = {};
  updateCommandcodeSettings(settings, { enabled: true, discoveredModels: Array.from({ length: 70 }, (_, i) => ({ rawId: `vendor/model-${i}`, label: `Model ${i}` })) });
  const refreshModels = jest.fn(async () => {
    updateCommandcodeSettings(settings, { discoveredModels: [{ rawId: 'vendor/new-model', label: 'New model' }] });
    return 'refreshed';
  });
  const context = {
    plugin: { settings, saveSettings: jest.fn(async () => undefined),
      getApplicationRuntimeOrNull: () => ({ workspaceServicesFor: () => ({ modelCatalog: { refreshModels } }) }) } as unknown as GrimoirePlugin,
    suppressAutomaticDiscovery: true, refreshModelSelectors: jest.fn(),
  } as unknown as ProviderSettingsTabRendererContext;
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  renderCommandcodeModelPicker(container, context);
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent === text)!;
  return { settings, refreshModels, context, container, button };
}

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('Command Code dynamic model picker', () => {
  it('does not invent a vendor count or repeat an ID used as the model name', async () => {
    const f = setup();
    f.refreshModels.mockImplementationOnce(async () => {
      updateCommandcodeSettings(f.settings, {
        discoveredModels: [{ rawId: 'opaque-model', label: 'opaque-model' }],
      });
      return 'refreshed';
    });
    f.button('Refresh all models').click();
    await settle();
    expect(f.container.querySelector('.grimoire-model-picker-summary')?.textContent).not.toContain('0 providers');
    expect(f.container.querySelector('.grimoire-model-picker-row-meta')).toBeNull();
  });

  it('searches the catalog, saves a shortlist, and refreshes without losing absent selections', async () => {
    const f = setup();
    expect(f.refreshModels).not.toHaveBeenCalled();
    expect(f.container.querySelectorAll('label')).toHaveLength(70);
    const search = f.container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    search.value = 'model-42';
    search.dispatchEvent(new Event('input'));
    expect(f.container.querySelectorAll('label')).toHaveLength(1);
    const checkbox = f.container.querySelector<HTMLInputElement>('label input')!;
    checkbox.focus();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await settle();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Show Model 42 in chat');
    expect(commandcodeChatUIConfig.getModelOptions(f.settings).map(model => model.value)).toEqual(['commandcode:vendor/model-42']);
    expect(f.context.plugin.saveSettings).toHaveBeenCalled();
    f.button('Refresh all models').click();
    await settle();
    expect(f.refreshModels).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(getCommandcodeSettings(f.settings).visibleModels).toEqual(['vendor/model-42']);
    expect(f.container.textContent).toContain('Not currently reported by Command Code');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(f.container.querySelectorAll('label')).toHaveLength(2);
    f.button('Show all models').click();
    await settle();
    expect(commandcodeChatUIConfig.getModelOptions(f.settings).map(model => model.value)).toEqual(['commandcode:vendor/new-model']);
  });

  it('uses the shared selected row and persists aliases for chat labels', async () => {
    const f = setup();
    const checkbox = f.container.querySelector<HTMLInputElement>('label input')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    await settle();
    const alias = f.container.querySelector<HTMLInputElement>('.grimoire-model-picker-selected-alias');
    expect(alias).not.toBeNull();
    alias!.value = 'Daily model';
    alias!.dispatchEvent(new Event('blur'));
    await settle();
    expect(commandcodeChatUIConfig.getModelOptions(f.settings)[0].label).toBe('Daily model');
    f.button('Refresh all models').click();
    await settle();
    expect(commandcodeChatUIConfig.getModelOptions(f.settings)[0].label).toBe('Daily model');
  });

  it('reports a failed refresh without claiming that a saved catalog was refreshed', async () => {
    const f = setup();
    f.refreshModels.mockResolvedValueOnce('failed');
    const refreshButton = f.button('Refresh all models');
    refreshButton.click();
    refreshButton.click();
    await settle();
    expect(f.refreshModels).toHaveBeenCalledTimes(1);
    expect(f.container.textContent).toContain('Refresh failed. Try again.');
    expect(f.container.querySelectorAll('label')).toHaveLength(70);
    expect(f.context.refreshModelSelectors).not.toHaveBeenCalled();
  });
});
