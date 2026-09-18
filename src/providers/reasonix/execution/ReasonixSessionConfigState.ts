import { hashCatalogFingerprint } from '@/core/providers/catalogFingerprint';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ChatRuntimeQueryOptions } from '@/core/runtime/types';
import {
  extractAcpSessionModelState,
  extractAcpSessionModeState,
} from '@/providers/acp';
import type {
  AcpSessionConfigOption,
  AcpSessionConfigSelectOption,
  AcpSessionModelState,
  AcpSessionModeState,
} from '@/providers/acp/types';
import {
  decodeReasonixModelId,
  encodeReasonixModelId,
  REASONIX_SYNTHETIC_MODEL_ID,
} from '@/providers/reasonix/models';
import { mapReasonixModeToGrimoire } from '@/providers/reasonix/modes';
import {
  getReasonixProviderSettings,
  REASONIX_AUTO_EFFORT,
  type ReasonixDiscoveredModel,
  type ReasonixEffort,
  type ReasonixMode,
  updateReasonixProviderSettings,
} from '@/providers/reasonix/settings';

const PROVIDER_ID = 'reasonix' as const;

export interface ReasonixSessionConfigPorts {
  /** The whole settings object, which this both reads and seeds. */
  readonly settingsBag: () => Record<string, unknown>;
  /**
   * What the discovered catalogue was discovered *under*.
   *
   * Stored beside the models, because the refresh cache reads it back on the
   * next load to tell a list discovered under this configuration from one
   * merely assumed to match. Without a writer the recorded digest stays empty
   * and `seedFingerprintMatches` short-circuits to true for every load, so a
   * stale list survives a CLI upgrade or a changed `REASONIX_HOME`.
   */
  readonly catalogFingerprint?: () => string;
}

/**
 * What a Reasonix session is configured with, and what the vault knows of it.
 *
 * Devin's, over a session that answers in ACP's own vocabulary: `session/new`
 * replies with `models` and `modes` beside its `configOptions`, and
 * `extractAcpSessionModelState` and `extractAcpSessionModeState` read both.
 *
 * The mode a session *reports when it opens* is recorded and never adopted:
 * only a `current_mode_update` moves the toolbar, and it is translated on the
 * way, because the toolbar speaks Grimoire's three values and Reasonix's `goal`
 * is not among them.
 */
export class ReasonixSessionConfigState {
  private currentSessionModelId: string | null = null;
  private currentSessionModeId: string | null = null;

  constructor(private readonly ports: ReasonixSessionConfigPorts) {}

  /** The model the session is on, in Reasonix's own id. */
  get sessionModelId(): string | null {
    return this.currentSessionModelId;
  }

  /** The mode the session is in, as Reasonix names it. */
  get sessionModeId(): string | null {
    return this.currentSessionModeId;
  }

  /** Records what a set actually applied, so the next turn does not repeat it. */
  markApplied(applied: {
    readonly modeId?: string | null;
    readonly modelId?: string | null;
  }): void {
    if (applied.modeId) {
      this.currentSessionModeId = applied.modeId;
    }
    if (applied.modelId) {
      this.currentSessionModelId = applied.modelId;
    }
  }

  /** Forgets what the live session was set to. */
  forgetSession(): void {
    this.currentSessionModelId = null;
    this.currentSessionModeId = null;
  }

  /**
   * This provider's own permission mode, not whichever one was projected last.
   *
   * `settings.permissionMode` is a shared field the coordinator projects the
   * active provider's value into; reading it directly answers for whoever was
   * toggled most recently.
   */
  permissionMode(): string {
    const snapshot = ProviderSettingsCoordinator
      .getProviderSettingsSnapshot(this.ports.settingsBag(), PROVIDER_ID);
    return typeof snapshot.permissionMode === 'string' ? snapshot.permissionMode : '';
  }

  /** Whether this session may reach outside the workspace. */
  fullAccess(): boolean {
    return this.permissionMode() === 'full_access';
  }

  /**
   * The reasoning effort a turn should ask for, or nothing.
   *
   * Nothing in three cases, each of which would otherwise be a call the agent
   * refuses: the person left it on `auto`, the session has not said which
   * levels it takes, or it said and this is not one of them. Reasonix validates
   * the value against the model — `UNSUPPORTED_REASONING_EFFORT` — so sending
   * an unoffered level buys a failure rather than a deeper answer.
   */
  resolveSelectedEffort(): string | null {
    const settings = getReasonixProviderSettings(this.ports.settingsBag());
    const level = settings.effortLevel.trim();
    if (!level || level === REASONIX_AUTO_EFFORT) {
      return null;
    }
    return settings.availableEfforts.some(effort => effort.id === level) ? level : null;
  }

  /** What a turn should ask the session to switch to, before translation. */
  resolveSelectedModeId(): string {
    return this.permissionMode()
      || getReasonixProviderSettings(this.ports.settingsBag()).selectedMode;
  }

  resolveSelectedRawModelId(queryOptions?: ChatRuntimeQueryOptions): string | null {
    if (queryOptions?.model !== undefined) {
      return typeof queryOptions.model === 'string'
        ? decodeReasonixModelId(queryOptions.model)
        : null;
    }
    const settingsBag = this.ports.settingsBag();
    const providerSettings = getReasonixProviderSettings(settingsBag);
    const savedProviderModel = settingsBag.savedProviderModel;
    const savedReasonixModel = savedProviderModel
      && typeof savedProviderModel === 'object'
      && !Array.isArray(savedProviderModel)
      ? (savedProviderModel as Record<string, unknown>).reasonix
      : null;
    return typeof savedReasonixModel === 'string'
      ? decodeReasonixModelId(savedReasonixModel)
      : this.currentSessionModelId ?? providerSettings.visibleModels[0] ?? null;
  }

  /** The model a usage badge is labelled with. */
  getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string {
    const rawModelId = this.currentSessionModelId ?? this.resolveSelectedRawModelId(queryOptions);
    return rawModelId ? encodeReasonixModelId(rawModelId) : REASONIX_SYNTHETIC_MODEL_ID;
  }

  /**
   * Takes on a mode the session says it switched to, and answers with the
   * toolbar's word for it. The one door that may move the user's selection.
   *
   * **Auto-approve survives a reported `normal`.** Reasonix runs Safe and
   * Auto-approve in the same session mode and separates them with the
   * `tool_approval` option, so a `current_mode_update` saying `normal` is not
   * evidence that the person left Auto-approve — and adopting it as Safe would
   * silently demote them every time the agent reported the mode it was already
   * in.
   */
  adoptCurrentMode(currentModeId: string): 'normal' | 'full_access' | 'plan' {
    this.currentSessionModeId = currentModeId;
    const reported = mapReasonixModeToGrimoire(currentModeId);
    const permissionMode = reported === 'normal' && this.permissionMode() === 'full_access'
      ? 'full_access'
      : reported;
    updateReasonixProviderSettings(this.ports.settingsBag(), { selectedMode: permissionMode });
    return permissionMode;
  }

  /**
   * Keeps what a session reported about itself.
   *
   * Answered once, when the session is created or loaded; a selector fed only
   * from later updates stays empty on a fresh vault.
   */
  syncSessionDiscovery(params: {
    configOptions?: Parameters<typeof extractAcpSessionModelState>[0]['configOptions'];
    models?: AcpSessionModelState | null;
    modes?: AcpSessionModeState | null;
  }): boolean {
    const modelState = extractAcpSessionModelState(params);
    const modeState = extractAcpSessionModeState(params);
    const updates: Parameters<typeof updateReasonixProviderSettings>[1] = {};
    const reportedEfforts = readEffortOptions(params.configOptions);

    if (modelState.currentModelId) {
      this.currentSessionModelId = modelState.currentModelId;
    }

    const stored = getReasonixProviderSettings(this.ports.settingsBag());
    if (modelState.availableModels.length > 0) {
      const discoveredModels = modelState.availableModels.map((model): ReasonixDiscoveredModel => ({
        description: model.description ?? undefined,
        label: model.name || model.id,
        rawId: model.id,
      }));
      const visibleModels = modelState.availableModels
        .map((model) => model.id.trim())
        .filter(Boolean);
      // **Only when it actually differs.** Reasonix answers every
      // `session/set_config_option` with its whole option list, and a turn
      // sends two — so reporting "changed" for an echo spent a full
      // `saveSettings` and a selector rebuild across every open view, twice a
      // turn, for a catalogue nobody had touched.
      if (!sameModels(stored.discoveredModels, discoveredModels)) {
        updates.discoveredModels = discoveredModels;
        updates.visibleModels = visibleModels;
        const fingerprint = this.ports.catalogFingerprint?.();
        if (fingerprint) {
          updates.discoveredModelsFingerprint = hashCatalogFingerprint(fingerprint);
        }
      }
    }

    if (modeState.availableModes.length > 0) {
      const availableModes = modeState.availableModes.map((mode): ReasonixMode => ({
        description: mode.description ?? undefined,
        id: mode.id,
        name: mode.name,
      }));
      if (stored.availableModes.map(mode => mode.id).join('\u0000')
        !== availableModes.map(mode => mode.id).join('\u0000')) {
        updates.availableModes = availableModes;
      }
    }

    if (modeState.currentModeId) {
      // Recorded, not adopted: where the agent starts is not what the user
      // picked. Only `adoptCurrentMode` moves the toolbar.
      this.currentSessionModeId = modeState.currentModeId;
    }

    if (reportedEfforts.length > 0
      && stored.availableEfforts.map(effort => effort.id).join('\u0000')
        !== reportedEfforts.map(effort => effort.id).join('\u0000')) {
      updates.availableEfforts = reportedEfforts;
    }

    if (Object.keys(updates).length === 0) {
      return false;
    }
    updateReasonixProviderSettings(this.ports.settingsBag(), updates);
    return true;
  }
}

/** Whether a reported catalogue is the one already stored, id and label alike. */
function sameModels(
  stored: readonly ReasonixDiscoveredModel[],
  reported: readonly ReasonixDiscoveredModel[],
): boolean {
  return stored.length === reported.length
    && stored.every((model, index) => model.rawId === reported[index]?.rawId
      && model.label === reported[index]?.label);
}

/**
 * The reasoning levels the session says this model takes.
 *
 * Read off the `effort` config option rather than assumed: a provider block
 * with `supported_efforts` offers `disabled`, `low`, `high`, `max`, and one
 * without gets the built-in set for its kind. `auto` is dropped here because it
 * is the picker's own default rather than a level, and the picker adds it back.
 */
function readEffortOptions(
  configOptions: readonly AcpSessionConfigOption[] | null | undefined,
): ReasonixEffort[] {
  const option = (configOptions ?? []).find(entry => entry?.id === 'effort');
  if (!option || option.type !== 'select') {
    return [];
  }
  // Flattened, because the protocol allows a grouped select and Reasonix has
  // only ever sent a flat one: a grouped list read as flat would be empty.
  const flat: AcpSessionConfigSelectOption[] = option.options.flatMap(entry => (
    'options' in entry ? entry.options : [entry]
  ));
  return flat.flatMap((entry): ReasonixEffort[] => {
    const id = typeof entry?.value === 'string' ? entry.value.trim() : '';
    if (!id || id === REASONIX_AUTO_EFFORT) {
      return [];
    }
    return [{
      ...(entry.description ? { description: entry.description } : {}),
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    }];
  });
}
