import { renderProviderModelPicker } from '@/features/settings/ui/ProviderModelPicker';
import type { ProviderSettingsTabRendererContext } from '@/providers/shared/providerHostContracts';

import { getCommandcodeSettings, updateCommandcodeSettings } from '../settings';

export function renderCommandcodeModelPicker(container: HTMLElement, context: ProviderSettingsTabRendererContext): void {
  const { plugin } = context;
  renderProviderModelPicker(container, {
    providerName: 'Command Code',
    description: 'Choose which models appear in chat. With none selected, all discovered models are shown. Refresh keeps your selection.',
    suppressAutomaticDiscovery: context.suppressAutomaticDiscovery,
    showProviderFilter: false,
    clearSelectionLabel: 'Show all models',
    getState: () => {
      const current = getCommandcodeSettings(plugin.settings);
      const models = current.discoveredModels.map(model => ({
        rawId: model.rawId, modelLabel: model.label, description: model.description ?? '',
        providerKey: '', providerLabel: '', isAvailable: true,
      }));
      const discoveredIds = new Set(models.map(model => model.rawId));
      for (const rawId of current.visibleModels) {
        if (!discoveredIds.has(rawId)) models.push({ rawId, modelLabel: rawId, description: '',
          providerKey: '', providerLabel: '', isAvailable: false });
      }
      return { models, discoveredCount: current.discoveredModels.length, visibleModels: current.visibleModels,
        modelAliases: current.modelAliases };
    },
    onSelectionChange: async visibleModels => {
      updateCommandcodeSettings(plugin.settings, { visibleModels });
      await plugin.saveSettings();
      context.refreshModelSelectors();
    },
    onAliasChange: async (rawId, alias) => {
      const modelAliases = { ...getCommandcodeSettings(plugin.settings).modelAliases };
      if (alias) modelAliases[rawId] = alias;
      else delete modelAliases[rawId];
      updateCommandcodeSettings(plugin.settings, { modelAliases });
      await plugin.saveSettings();
      context.refreshModelSelectors();
    },
    onRefresh: async () => {
      const catalog = plugin.getApplicationRuntimeOrNull()?.workspaceServicesFor('commandcode')?.modelCatalog;
      const outcome = await catalog?.refreshModels({ plugin, settings: plugin.settings, force: true });
      if (outcome !== 'refreshed') return false;
      await plugin.saveSettings();
      context.refreshModelSelectors();
      return true;
    },
  });
}
