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
import { maybeGetKimicodeWorkspaceServices } from '../app/KimicodeWorkspaceServices';
import { clearKimicodeDiscoveryState } from '../discoveryState';
import {
  buildKimicodeBaseModels,
  type KimicodeDiscoveredModel,
  splitKimicodeModelLabel,
} from '../models';
import {
  getKimicodeProviderSettings,
  KIMICODE_DEFAULT_ENVIRONMENT_VARIABLES,
  normalizeKimicodeVisibleModels,
  updateKimicodeProviderSettings,
} from '../settings';
import { KimicodeAgentSettings } from './KimicodeAgentSettings';

export const kimicodeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const kimicodeWorkspace = maybeGetKimicodeWorkspaceServices(context.plugin);
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const kimicodeSettings = getKimicodeProviderSettings(settingsBag);
    const hostnameKey = getHostnameKey();

    if (!kimicodeSettings.enabled) {
      renderProviderDisabledNotice(container, 'Kimi Code');
    }

    new Setting(container).setName(t('settings.setup')).setHeading();

    const cliPathSetting = new Setting(container)
      .setName(t('settings.providerTabs.acp.cliPath.name', { provider: 'Kimi Code' }))
      .setDesc(t('settings.providerTabs.acp.cliPath.desc', {
        command: 'kimi',
        provider: 'Kimi Code',
      }));

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

    const cliPathsByHost = { ...kimicodeSettings.cliPathsByHost };
    const currentValue = kimicodeSettings.cliPathsByHost[hostnameKey] || '';
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

      updateKimicodeProviderSettings(settingsBag, { cliPathsByHost: { ...cliPathsByHost } });
      clearKimicodeDiscoveryState(settingsBag);
      await context.plugin.saveSettings();
      kimicodeWorkspace?.cliResolver?.reset();
      await recycleKimicodeRuntime();
      return true;
    };

    const recycleKimicodeRuntime = async (): Promise<void> => {
      for (const view of context.plugin.getAllViews()) {
        const tabManager = view.getTabManager();
        if (tabManager?.broadcastToProviderTabs) {
          await tabManager.broadcastToProviderTabs('kimicode', (service) => Promise.resolve(service.cleanup()));
        } else {
          await tabManager?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup()),
          );
        }
        view.invalidateProviderCommandCaches?.(['kimicode']);
        view.refreshModelSelector?.();
      }
    };

    cliPathSetting.addText((text) => {
      text
        .setPlaceholder(process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\kimi.cmd'
          : '/usr/local/bin/kimi')
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });

      text.inputEl.addClass('grimoire-settings-cli-path-input');
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    renderProviderModelPicker(container, {
      providerName: 'Kimi Code',
      description: t('settings.providerTabs.acp.visibleModels.desc', { provider: 'Kimi Code' }),
      suppressAutomaticDiscovery: context.suppressAutomaticDiscovery,
      getState: () => {
        const current = getKimicodeProviderSettings(settingsBag);
        return {
          models: buildEnrichedModels(current.discoveredModels, current.visibleModels),
          discoveredCount: current.discoveredModels.length,
          visibleModels: current.visibleModels,
          modelAliases: current.modelAliases,
        };
      },
      onSelectionChange: async (ids) => {
        const current = getKimicodeProviderSettings(settingsBag);
        const normalized = normalizeKimicodeVisibleModels(ids, current.discoveredModels);
        if (sameStringList(current.visibleModels, normalized)) return;
        updateKimicodeProviderSettings(settingsBag, { visibleModels: normalized });
        await context.plugin.saveSettings();
        context.refreshModelSelectors();
      },
      onAliasChange: async (rawId, alias) => {
        const modelAliases = { ...getKimicodeProviderSettings(settingsBag).modelAliases };
        if (alias) modelAliases[rawId] = alias;
        else delete modelAliases[rawId];
        updateKimicodeProviderSettings(settingsBag, { modelAliases });
        await context.plugin.saveSettings();
        context.refreshModelSelectors();
      },
      onModelAdded: async (rawModelId) => {
        try {
          const loaded = await context.plugin.getKimicodeExecution().metadata.discoverMetadata({ rawModelId });
          if (loaded) context.refreshModelSelectors();
        } catch {
          // Optional metadata can be discovered again on the first chat turn.
        }
      },
      onRefresh: async () => {
        const loaded = await context.plugin.getKimicodeExecution().metadata.discoverMetadata();
        if (loaded) context.refreshModelSelectors();
        return loaded && getKimicodeProviderSettings(settingsBag).discoveredModels.length > 0;
      },
    });

    const advancedContainer = context.renderAdvancedSection(container, {
      count: 6,
      summary: t('settings.advanced.providerSummary'),
    });

    const skillsSection = context.createWorkspaceSection(advancedContainer, ['skills']);
    new Setting(skillsSection).setName(t('settings.hub.skills')).setHeading();
    if (kimicodeWorkspace?.commandCatalog) {
      const skillsContainer = skillsSection.createDiv({ cls: 'grimoire-slash-commands-container' });
      new ProviderSkillSettings(
        skillsContainer,
        context.plugin.app,
        'kimicode',
        kimicodeWorkspace.commandCatalog,
      );
    }

    const commandsSection = context.createWorkspaceSection(advancedContainer, ['commands']);
    new Setting(commandsSection).setName(t('settings.slashCommands.name')).setHeading();

    const commandsDesc = commandsSection.createDiv({ cls: 'grimoire-sp-settings-desc' });
    commandsDesc.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.providerTabs.acp.commandsDesc', { provider: 'Kimi Code' }),
    });

    context.renderHiddenProviderCommandSetting(commandsSection, 'kimicode', {
      name: t('settings.hiddenSlashCommands.name'),
      desc: t('settings.providerTabs.acp.hiddenCommandsDesc', { provider: 'Kimi Code' }),
      placeholder: 'compact\nreview\nfix',
    });

    if (kimicodeWorkspace?.agentStorage) {
      const agentsSection = context.createWorkspaceSection(advancedContainer, ['agents']);
      new Setting(agentsSection).setName(t('settings.subagents.name')).setHeading();

      const subagentsDesc = agentsSection.createDiv({ cls: 'grimoire-sp-settings-desc' });
      subagentsDesc.createEl('p', {
        cls: 'setting-item-description',
        text: t('settings.providerTabs.acp.subagentsDesc', {
          legacyRoot: '.kimicode/agents/',
          provider: 'Kimi Code',
          root: '.kimicode/agent/',
        }),
      });

      const subagentsContainer = agentsSection.createDiv({ cls: 'grimoire-slash-commands-container' });
      new KimicodeAgentSettings(
        subagentsContainer,
        kimicodeWorkspace.agentStorage,
        context.plugin.app,
        async () => {
          await kimicodeWorkspace.refreshAgentMentions?.();
          await recycleKimicodeRuntime();
        },
      );
    }

    if (kimicodeWorkspace?.mcpStorage) {
      const mcpSection = context.createWorkspaceSection(advancedContainer, ['mcp']);
      new Setting(mcpSection).setName(t('settings.mcpServers.name')).setHeading();
      const mcpContainer = mcpSection.createDiv({ cls: 'grimoire-mcp-container' });
      new McpSettingsManager(mcpContainer, {
        app: context.plugin.app,
        mcpStorage: kimicodeWorkspace.mcpStorage,
        broadcastMcpReload: async () => {
          for (const view of context.plugin.getAllViews()) {
            await view.getTabManager()?.broadcastToProviderTabs?.(
              'kimicode',
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
      scope: 'provider:kimicode',
      heading: t('settings.environment'),
      name: t('settings.providerTabs.environmentVariables'),
      desc: t('settings.providerTabs.acp.environmentDesc', {
        environmentVariable: 'KIMICODE_ENABLE_EXA',
        provider: 'Kimi Code',
      }),
      placeholder: `${KIMICODE_DEFAULT_ENVIRONMENT_VARIABLES}\nKIMICODE_DB=/path/to/kimicode.db`,
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'kimicode'),
    });
  },
};

function buildEnrichedModels(
  discoveredModels: KimicodeDiscoveredModel[],
  visibleModels: string[],
): ModelPickerModel[] {
  const enriched: ModelPickerModel[] = [];
  const discoveredIds = new Set<string>();
  const baseModels = buildKimicodeBaseModels(discoveredModels);

  for (const model of baseModels) {
    const { modelLabel, providerLabel } = splitKimicodeModelLabel(model.label || model.rawId);
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

    const { modelLabel, providerLabel } = splitKimicodeModelLabel(rawId);
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
