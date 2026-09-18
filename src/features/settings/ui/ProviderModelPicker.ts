import { type ButtonComponent, Setting } from 'obsidian';

import { t } from '../../../i18n/i18n';

export interface ModelPickerModel {
  rawId: string;
  modelLabel: string;
  description: string;
  providerKey: string;
  providerLabel: string;
  isAvailable: boolean;
}

export interface ModelPickerState {
  models: ModelPickerModel[];
  discoveredCount: number;
  visibleModels: string[];
  modelAliases?: Record<string, string>;
}

interface ProviderModelPickerOptions {
  providerName: string;
  description: string;
  getState: () => ModelPickerState;
  onSelectionChange: (ids: string[]) => Promise<void>;
  onRefresh: () => Promise<boolean>;
  onModelAdded?: (id: string) => Promise<void>;
  onAliasChange?: (id: string, alias: string) => Promise<void>;
  suppressAutomaticDiscovery: boolean;
  refreshOnBrowse?: boolean;
  showProviderFilter?: boolean;
  clearSelectionLabel?: string;
}

const ALL_PROVIDERS_KEY = 'all';

/** Shared presentation only: providers own discovery, IDs, preferences and persistence. */
export function renderProviderModelPicker(container: HTMLElement, options: ProviderModelPickerOptions): void {
  new Setting(container).setName(t('settings.models')).setHeading();

  let refreshModelsButton: ButtonComponent | undefined;
  new Setting(container)
    .setName(t('settings.providerTabs.acp.visibleModels.name'))
    .setDesc(options.description)
    .addButton((button) => {
      refreshModelsButton = button;
      button.setButtonText('Refresh all models').onClick(() => loadModelCatalog(true));
    });

  const pickerEl = container.createDiv({ cls: 'grimoire-model-picker' });

  let searchQuery = '';
  let providerFilter = ALL_PROVIDERS_KEY;

  const summaryEl = pickerEl.createDiv({ cls: 'grimoire-model-picker-summary', attr: { 'aria-live': 'polite' } });
  const selectedEl = pickerEl.createDiv({ cls: 'grimoire-model-picker-selected' });
  const catalogEl = pickerEl.createEl('details', { cls: 'grimoire-model-picker-catalog' });
  catalogEl.open = options.getState().visibleModels.length === 0;
  const catalogSummaryEl = catalogEl.createEl('summary', {
    cls: 'grimoire-model-picker-catalog-summary',
  });
  catalogSummaryEl.createSpan({
    cls: 'grimoire-model-picker-catalog-caret',
    text: '▸',
  });
  catalogSummaryEl.createSpan({
    cls: 'grimoire-model-picker-catalog-title',
    text: t('settings.providerModelPicker.browseModels'),
  });
  const catalogSummaryCountEl = catalogSummaryEl.createSpan({
    cls: 'grimoire-model-picker-catalog-count',
    attr: { 'aria-live': 'polite' },
  });

  const controlsEl = catalogEl.createDiv({ cls: 'grimoire-model-picker-controls' });

  const searchInput = controlsEl.createEl('input', {
    cls: 'grimoire-model-picker-search',
    type: 'search',
  });
  searchInput.placeholder = t('settings.providerModelPicker.searchPlaceholder');
  searchInput.setAttribute('aria-label', 'Search models');
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    renderList();
  });

  const providerSelectEl = controlsEl.createEl('select', {
    cls: 'grimoire-model-picker-provider',
  });
  providerSelectEl.setAttribute('aria-label', 'Filter models by provider');
  providerSelectEl.toggleClass('grimoire-hidden', options.showProviderFilter === false);
  providerSelectEl.addEventListener('change', () => {
    providerFilter = providerSelectEl.value;
    renderList();
  });

  const listEl = catalogEl.createDiv({ cls: 'grimoire-model-picker-list' });
  let loadingModelCatalog = false;
  let modelCatalogLoadFailed = false;

  const getModelPickerModels = (): ModelPickerModel[] => options.getState().models;

  const filterModels = (models: ModelPickerModel[]): ModelPickerModel[] => {
    return models.filter((model) => {
      if (providerFilter !== ALL_PROVIDERS_KEY && model.providerKey !== providerFilter) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      return (
        model.rawId.toLowerCase().includes(searchQuery)
        || model.modelLabel.toLowerCase().includes(searchQuery)
        || model.providerLabel.toLowerCase().includes(searchQuery)
        || model.description.toLowerCase().includes(searchQuery)
      );
    });
  };

  const persistVisibleModels = async (visibleModels: string[]): Promise<void> => {
    await options.onSelectionChange(visibleModels);
    renderAll();
  };

  const renderSummary = (): void => {
    refreshModelsButton?.setDisabled(loadingModelCatalog)
      .setButtonText(loadingModelCatalog ? t('settings.providerModelPicker.loadingModels') : 'Refresh all models');
    summaryEl.empty();
    const current = options.getState();
    const enriched = getModelPickerModels();
    const providerCount = new Set(enriched.map((model) => model.providerKey).filter(Boolean)).size;
    const providerWord = t(providerCount === 1
      ? 'settings.providerModelPicker.providerSingular'
      : 'settings.providerModelPicker.providerPlural');

    summaryEl.createSpan({ text: 'Selected: ' });
    summaryEl.createSpan({
      cls: 'grimoire-model-picker-summary-value',
      text: String(current.visibleModels.length),
    });
    summaryEl.createSpan({
      text: providerCount > 0 ? ` ${t('settings.providerModelPicker.summaryDiscovered', {
        total: current.discoveredCount,
        count: providerCount,
        providerWord,
      })}` : ` · ${t('settings.providerModelPicker.availableCount', { count: current.discoveredCount })}`,
    });

    let catalogSummary = t('settings.providerModelPicker.noDiscovered');
    if (loadingModelCatalog) {
      catalogSummary = t('settings.providerModelPicker.loadingModels');
    } else if (modelCatalogLoadFailed) {
      catalogSummary = 'Refresh failed. Try again.';
    } else if (current.discoveredCount > 0) {
      catalogSummary = t('settings.providerModelPicker.availableCount', {
        count: current.discoveredCount,
      });
    }
    catalogSummaryCountEl.setText(catalogSummary);
  };

  const renderSelected = (): void => {
    selectedEl.empty();
    const current = options.getState();
    if (current.visibleModels.length === 0) {
      selectedEl.toggleClass('grimoire-hidden', true);
      return;
    }

    selectedEl.toggleClass('grimoire-hidden', false);
    const enrichedByRawId = new Map(
      getModelPickerModels().map((model) => [model.rawId, model] as const),
    );

    const headerEl = selectedEl.createDiv({ cls: 'grimoire-model-picker-selected-header' });
    headerEl.createSpan({
      cls: 'grimoire-model-picker-selected-label',
      text: t('settings.providerModelPicker.selectedCount', { count: current.visibleModels.length }),
    });
    const clearAllBtn = headerEl.createEl('button', {
      cls: 'grimoire-model-picker-selected-clear',
      text: options.clearSelectionLabel ?? t('common.clearAll'),
    });
    clearAllBtn.setAttribute('aria-label', t('settings.providerModelPicker.clearSelected'));
    clearAllBtn.addEventListener('click', () => {
      void persistVisibleModels([]);
    });

    const rowsEl = selectedEl.createDiv({ cls: 'grimoire-model-picker-selected-rows' });

    for (const rawId of current.visibleModels) {
      const enriched = enrichedByRawId.get(rawId);
      const defaultLabel = enriched
        ? [enriched.providerLabel, enriched.modelLabel].filter(Boolean).join('/')
        : rawId;

      const rowEl = rowsEl.createDiv({ cls: 'grimoire-model-picker-selected-row' });
      if (enriched && !enriched.isAvailable) {
        rowEl.classList.add('grimoire-model-picker-selected-row--unavailable');
      }

      const infoEl = rowEl.createDiv({ cls: 'grimoire-model-picker-selected-info' });
      const titleEl = infoEl.createDiv({ cls: 'grimoire-model-picker-selected-title' });
      if (enriched) {
        if (enriched.providerLabel) titleEl.createSpan({
          cls: 'grimoire-model-picker-selected-badge',
          text: enriched.providerLabel,
        });
        titleEl.createSpan({
          cls: 'grimoire-model-picker-selected-name',
          text: enriched.modelLabel,
        });
      } else {
        titleEl.createSpan({
          cls: 'grimoire-model-picker-selected-name',
          text: rawId,
        });
      }

      if (enriched && !enriched.isAvailable) {
        infoEl.createDiv({
          cls: 'grimoire-model-picker-selected-unavailable',
          text: t('settings.providerModelPicker.notReported', { provider: options.providerName }),
        });
      }

      if (enriched?.modelLabel !== rawId) infoEl.createDiv({
        cls: 'grimoire-model-picker-selected-id',
        text: rawId,
      });

      const controlsEl = rowEl.createDiv({ cls: 'grimoire-model-picker-selected-controls' });
      if (options.onAliasChange) {
        const aliasInput = controlsEl.createEl('input', {
          cls: 'grimoire-model-picker-selected-alias',
          type: 'text',
        });
        aliasInput.placeholder = defaultLabel;
        aliasInput.value = current.modelAliases?.[rawId] ?? '';
        aliasInput.setAttribute('aria-label', t('settings.providerModelPicker.aliasLabel', { model: defaultLabel }));
        aliasInput.title = t('settings.providerModelPicker.aliasTitle');

        const commitAlias = (): void => {
          const latest = options.getState();
          const existing = latest.modelAliases?.[rawId] ?? '';
          const next = aliasInput.value.trim();
          if (next === existing) {
            aliasInput.value = existing;
            return;
          }

          void options.onAliasChange?.(rawId, next);
        };

        aliasInput.addEventListener('blur', commitAlias);
        aliasInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            aliasInput.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            aliasInput.value = options.getState().modelAliases?.[rawId] ?? '';
            aliasInput.blur();
          }
        });
      }

      const removeBtn = controlsEl.createEl('button', {
        cls: 'grimoire-model-picker-selected-remove',
        text: '×',
      });
      removeBtn.setAttribute('aria-label', t('settings.providerModelPicker.removeModel', { model: defaultLabel }));
      removeBtn.addEventListener('click', () => {
        void persistVisibleModels(current.visibleModels.filter((entry) => entry !== rawId));
      });
    }
  };

  const renderProviderSelect = (): void => {
    const enriched = getModelPickerModels();
    const providers = new Map<string, { count: number; label: string }>();
    for (const model of enriched) {
      const existing = providers.get(model.providerKey);
      if (existing) {
        existing.count += 1;
      } else {
        providers.set(model.providerKey, { count: 1, label: model.providerLabel });
      }
    }

    providerSelectEl.empty();
    providerSelectEl.createEl('option', {
      text: t('settings.providerModelPicker.allProviders', { count: enriched.length }),
    }).value = ALL_PROVIDERS_KEY;

    const sortedProviders = Array.from(providers.entries())
      .sort(([, left], [, right]) => left.label.localeCompare(right.label));
    for (const [key, { count, label }] of sortedProviders) {
      providerSelectEl.createEl('option', {
        text: `${label} (${count})`,
      }).value = key;
    }

    if (providerFilter !== ALL_PROVIDERS_KEY && !providers.has(providerFilter)) {
      providerFilter = ALL_PROVIDERS_KEY;
    }
    providerSelectEl.value = providerFilter;
  };

  const renderList = (): void => {
    listEl.empty();
    const current = options.getState();
    const selectedIds = new Set(current.visibleModels);
    const enriched = getModelPickerModels();
    const filtered = filterModels(enriched);

    if (filtered.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'grimoire-model-picker-empty' });
      let emptyText = t('settings.providerModelPicker.noMatch');
      if (loadingModelCatalog) {
        emptyText = t('settings.providerModelPicker.loadingCatalog', { provider: options.providerName });
      } else if (modelCatalogLoadFailed) {
        emptyText = t('settings.providerModelPicker.loadFailed', { provider: options.providerName });
      } else if (enriched.length === 0) {
        emptyText = t('settings.providerModelPicker.startToLoad', { provider: options.providerName });
      }
      emptyEl.setText(emptyText);
      return;
    }

    for (const model of filtered) {
      const rowEl = listEl.createEl('label', { cls: 'grimoire-model-picker-row' });
      const isSelected = selectedIds.has(model.rawId);
      if (isSelected) {
        rowEl.classList.add('grimoire-model-picker-row--selected');
      }
      rowEl.title = model.rawId;

      const checkboxEl = rowEl.createEl('input', { type: 'checkbox' });
      checkboxEl.checked = isSelected;
      checkboxEl.setAttribute('aria-label', `Show ${model.modelLabel} in chat`);
      checkboxEl.addEventListener('change', () => {
        const currentVisibleModels = options.getState().visibleModels;
        const next = checkboxEl.checked
          ? [...currentVisibleModels, model.rawId]
          : currentVisibleModels.filter((id) => id !== model.rawId);
        void (async () => {
          await persistVisibleModels(next);
          if (checkboxEl.checked) {
            await options.onModelAdded?.(model.rawId);
          }
        })();
      });

      const textEl = rowEl.createDiv({ cls: 'grimoire-model-picker-row-text' });

      const headerEl = textEl.createDiv({ cls: 'grimoire-model-picker-row-header' });
      headerEl.createSpan({
        cls: 'grimoire-model-picker-row-name',
        text: model.modelLabel,
      });
      const badgeEl = headerEl.createSpan({
        cls: 'grimoire-model-picker-row-badge',
        text: model.providerLabel,
      });
      if (!model.isAvailable) {
        badgeEl.classList.add('grimoire-model-picker-row-badge--unavailable');
        badgeEl.setText(t('settings.providerModelPicker.unavailable'));
        badgeEl.title = t('settings.providerModelPicker.unavailableTitle', { provider: options.providerName });
      }

      if (model.rawId !== model.modelLabel) {
        textEl.createDiv({
          cls: 'grimoire-model-picker-row-meta',
          text: model.rawId,
        });
      }

      if (model.description) {
        textEl.createDiv({
          cls: 'grimoire-model-picker-row-desc',
          text: model.description,
        });
      }

    }
  };

  const renderAll = (): void => {
    const focused = pickerEl.ownerDocument.activeElement;
    const focusedName = pickerEl.contains(focused) ? focused?.getAttribute('aria-label') : null;
    const input = focused?.tagName === 'INPUT' ? focused as HTMLInputElement : null;
    const draft = input && input.type !== 'checkbox'
      ? { value: input.value, start: input.selectionStart, end: input.selectionEnd } : null;
    renderSummary();
    renderSelected();
    renderProviderSelect();
    renderList();
    if (focusedName && !focused?.isConnected) {
      const replacement = Array.from(pickerEl.querySelectorAll<HTMLElement>('[aria-label]'))
        .find(element => element.getAttribute('aria-label') === focusedName);
      if (draft && replacement?.tagName === 'INPUT') {
        const nextInput = replacement as HTMLInputElement;
        nextInput.value = draft.value;
        nextInput.setSelectionRange(draft.start, draft.end);
      }
      (replacement ?? searchInput).focus();
    }
  };

  renderAll();

  const loadModelCatalog = async (force = false): Promise<void> => {
    if (loadingModelCatalog || (!force && !options.refreshOnBrowse && options.getState().discoveredCount > 0)) {
      return;
    }

    loadingModelCatalog = true;
    modelCatalogLoadFailed = false;
    renderAll();

    try {
      modelCatalogLoadFailed = !await options.onRefresh();
    } catch {
      modelCatalogLoadFailed = true;
    } finally {
      loadingModelCatalog = false;
      renderAll();
    }
  };

  catalogEl.addEventListener('toggle', () => {
    if (catalogEl.open && !options.suppressAutomaticDiscovery) {
      void loadModelCatalog();
    }
  });
  if (catalogEl.open && !options.suppressAutomaticDiscovery) {
    void loadModelCatalog();
  }
}
