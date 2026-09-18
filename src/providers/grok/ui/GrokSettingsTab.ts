import * as fs from 'fs';
import { Setting } from 'obsidian';

import { renderEnvironmentSettingsSection } from '../../../features/settings/ui/EnvironmentSettingsSection';
import { McpSettingsManager } from '../../../features/settings/ui/McpSettingsManager';
import { renderProviderDisabledNotice } from '../../../features/settings/ui/ProviderDisabledNotice';
import { type ModelPickerModel, renderProviderModelPicker } from '../../../features/settings/ui/ProviderModelPicker';
import { ProviderSkillSettings } from '../../../features/settings/ui/ProviderSkillSettings';
import { t } from '../../../i18n/i18n';
import type {
  ProviderSettingsTabRenderer,
} from '../../../providers/shared/providerHostContracts';
import { sameStringList } from '../../../utils/collections';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { maybeGetGrokWorkspaceServices } from '../app/GrokWorkspaceServices';
import { clearGrokDiscoveryState } from '../discoveryState';
import {
  buildGrokBaseModels,
  encodeGrokModelId,
  type GrokDiscoveredModel,
  splitGrokModelLabel,
} from '../models';
import {
  getGrokProviderSettings,
  GROK_DEFAULT_ENVIRONMENT_VARIABLES,
  normalizeGrokVisibleModels,
  updateGrokProviderSettings,
} from '../settings';
import { GrokAgentSettings } from './GrokAgentSettings';

export const grokSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const grokWorkspace = maybeGetGrokWorkspaceServices(context.plugin);
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const grokSettings = getGrokProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    if (!grokSettings.enabled) {
      renderProviderDisabledNotice(container, 'Grok');
    }

    new Setting(container).setName(t('settings.setup')).setHeading();

    const cliPathSetting = new Setting(container)
      .setName(t('settings.cliPath.name'))
      .setDesc(t('settings.grok.cliPath.desc'));

    const validationEl = container.createDiv({
      cls: 'grimoire-cli-path-validation grimoire-setting-validation grimoire-setting-validation-error grimoire-hidden',
    });

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const expandedPath = expandHomePath(trimmed);
      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }

      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }

      return null;
    };

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('grimoire-hidden', false);
        if (inputEl) {
          inputEl.toggleClass('grimoire-input-error', true);
        }
        return false;
      }

      validationEl.toggleClass('grimoire-hidden', true);
      if (inputEl) {
        inputEl.toggleClass('grimoire-input-error', false);
      }
      return true;
    };

    const cliPathsByHost = { ...grokSettings.cliPathsByHost };
    const currentValue = grokSettings.cliPathsByHost[hostnameKey] || '';
    let cliPathInputEl: HTMLInputElement | null = null;

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      updateGrokProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      clearGrokDiscoveryState(settingsBag);
      await context.plugin.saveSettings();
      grokWorkspace?.cliResolver?.reset();
      await recycleGrokRuntime();
      return true;
    };

    const recycleGrokRuntime = async (): Promise<void> => {
      for (const view of context.plugin.getAllViews()) {
        const tabManager = view.getTabManager();
        if (tabManager?.broadcastToProviderTabs) {
          await tabManager.broadcastToProviderTabs('grok', (service) => Promise.resolve(service.cleanup()));
        } else {
          await tabManager?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup()),
          );
        }
        view.invalidateProviderCommandCaches?.(['grok']);
        view.refreshModelSelector?.();
      }
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\grok.cmd'
          : '/usr/local/bin/grok')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });

      text.inputEl.addClass('grimoire-settings-cli-path-input');
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    renderProviderModelPicker(container, {
      providerName: 'Grok Build',
      description: t('settings.grok.visibleModels.desc'),
      suppressAutomaticDiscovery: context.suppressAutomaticDiscovery,
      refreshOnBrowse: true,
      getState: () => {
        const current = getGrokProviderSettings(settingsBag);
        return {
          models: buildEnrichedModels(current.discoveredModels, current.visibleModels),
          discoveredCount: current.discoveredModels.length,
          visibleModels: current.visibleModels,
          modelAliases: current.modelAliases,
        };
      },
      onSelectionChange: async (ids) => {
        const current = getGrokProviderSettings(settingsBag);
        const normalized = normalizeGrokVisibleModels(ids, current.discoveredModels);
        if (sameStringList(current.visibleModels, normalized)) return;
        updateGrokProviderSettings(settingsBag, { visibleModels: normalized });
        await context.plugin.saveSettings();
        context.refreshModelSelectors();
      },
      onAliasChange: async (rawId, alias) => {
        const modelAliases = { ...getGrokProviderSettings(settingsBag).modelAliases };
        if (alias) modelAliases[rawId] = alias;
        else delete modelAliases[rawId];
        updateGrokProviderSettings(settingsBag, { modelAliases });
        await context.plugin.saveSettings();
        context.refreshModelSelectors();
      },
      onModelAdded: async (rawModelId) => {
        try {
          const loaded = await context.plugin.getGrokExecution().metadata.discoverMetadata({ model: encodeGrokModelId(rawModelId) });
          if (loaded) context.refreshModelSelectors();
        } catch {
          // Optional metadata can be discovered again on the first chat turn.
        }
      },
      onRefresh: async () => {
        const catalog = maybeGetGrokWorkspaceServices(context.plugin)?.modelCatalog;
        const loaded = catalog
          ? await catalog.refreshModels({ force: true, plugin: context.plugin, settings: settingsBag }) !== 'failed'
          : await context.plugin.getGrokExecution().metadata.discoverMetadata();
        if (loaded) context.refreshModelSelectors();
        return loaded;
      },
    });

    const advancedContainer = context.renderAdvancedSection(container, {
      count: 6,
      summary: t('settings.grok.advanced.summary'),
    });

    const skillsSection = context.createWorkspaceSection(advancedContainer, ['skills']);
    new Setting(skillsSection).setName(t('settings.hub.skills')).setHeading();
    if (grokWorkspace?.commandCatalog) {
      const skillsContainer = skillsSection.createDiv({ cls: 'grimoire-slash-commands-container' });
      new ProviderSkillSettings(
        skillsContainer,
        context.plugin.app,
        'grok',
        grokWorkspace.commandCatalog,
      );
    }

    const commandsSection = context.createWorkspaceSection(advancedContainer, ['commands']);
    new Setting(commandsSection).setName(t('settings.slashCommands.name')).setHeading();

    const commandsDesc = commandsSection.createDiv({ cls: 'grimoire-sp-settings-desc' });
    commandsDesc.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.grok.commands.desc'),
    });

    context.renderHiddenProviderCommandSetting(commandsSection, 'grok', {
      name: t('settings.hiddenSlashCommands.name'),
      desc: t('settings.grok.hiddenCommands.desc'),
      placeholder: 'compact\nreview\nfix',
    });

    if (grokWorkspace?.agentStorage) {
      const agentsSection = context.createWorkspaceSection(advancedContainer, ['agents']);
      new Setting(agentsSection).setName(t('settings.subagents.name')).setHeading();

      const subagentsDesc = agentsSection.createDiv({ cls: 'grimoire-sp-settings-desc' });
      subagentsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: t('settings.grok.subagents.desc'),
      });

      const subagentsContainer = agentsSection.createDiv({ cls: 'grimoire-slash-commands-container' });
      new GrokAgentSettings(
        subagentsContainer,
        grokWorkspace.agentStorage,
        context.plugin.app,
        async () => {
          await grokWorkspace.refreshAgentMentions?.();
          await recycleGrokRuntime();
        },
      );
    }

    if (grokWorkspace?.mcpStorage) {
      const mcpSection = context.createWorkspaceSection(advancedContainer, ['mcp']);
      new Setting(mcpSection).setName(t('settings.mcpServers.name')).setHeading();
      const mcpContainer = mcpSection.createDiv({ cls: 'grimoire-mcp-container' });
      new McpSettingsManager(mcpContainer, {
        app: context.plugin.app,
        mcpStorage: grokWorkspace.mcpStorage,
        broadcastMcpReload: async () => {
          for (const view of context.plugin.getAllViews()) {
            await view.getTabManager()?.broadcastToProviderTabs?.(
              'grok',
              (service) => service.reloadMcpServers(),
            );
          }
        },
        features: { contextSaving: false, toolFiltering: false },
      });
    }

    renderEnvironmentSettingsSection({
      container: context.createWorkspaceSection(advancedContainer, ['environment']),
      plugin: context.plugin,
      scope: 'provider:grok',
      heading: t('settings.environment'),
      name: t('settings.customVariables.name'),
      desc: t('settings.grok.environment.desc'),
      placeholder: `${GROK_DEFAULT_ENVIRONMENT_VARIABLES}\nGROK_AUTH_PATH=~/.grok/auth.json`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'grok'),
    });
  },
};

function buildEnrichedModels(
  discoveredModels: GrokDiscoveredModel[],
  visibleModels: string[],
): ModelPickerModel[] {
  const enriched: ModelPickerModel[] = [];
  const discoveredIds = new Set<string>();
  const baseModels = buildGrokBaseModels(discoveredModels);

  for (const model of baseModels) {
    const { modelLabel, providerLabel } = splitGrokModelLabel(model.label || model.rawId, model.rawId);
    discoveredIds.add(model.rawId);
    enriched.push({
      description: model.description ?? '',
      isAvailable: true,
      modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      rawId: model.rawId,
    });
  }

  for (const rawId of visibleModels) {
    if (discoveredIds.has(rawId)) {
      continue;
    }

    const { modelLabel, providerLabel } = splitGrokModelLabel(rawId, rawId);
    enriched.push({
      description: '',
      isAvailable: false,
      modelLabel,
      providerKey: providerLabel.toLowerCase(),
      providerLabel,
      rawId,
    });
  }

  return enriched.sort((left, right) => {
    const providerCmp = left.providerLabel.localeCompare(right.providerLabel);
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.modelLabel.localeCompare(right.modelLabel);
  });
}
