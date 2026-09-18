// The permission mode is read through the settings coordinator, which asks the
// registry for this provider's chat UI config.
import '@/providers';

import { ReasonixSessionConfigState } from '@/providers/reasonix/execution/ReasonixSessionConfigState';
import { getReasonixProviderSettings, updateReasonixProviderSettings } from '@/providers/reasonix/settings';

/** What the recorded `session/new` answers with, shortened. */
function recordedSession(): Parameters<ReasonixSessionConfigState['syncSessionDiscovery']>[0] {
  return {
    models: {
      currentModelId: 'custom-api-z-ai/glm-5.3-flash',
      availableModels: [
        { modelId: 'custom-api-z-ai/glm-5.3', name: 'custom-api-z-ai/glm-5.3', description: 'custom-api-z-ai' },
        { modelId: 'custom-api-z-ai/glm-5.3-flash', name: 'custom-api-z-ai/glm-5.3-flash', description: 'custom-api-z-ai' },
      ],
    },
    configOptions: [
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'enabled', name: 'Enabled' },
          { value: 'disabled', name: 'Disabled' },
        ],
      },
    ],
    modes: {
      currentModeId: 'normal',
      availableModes: [
        { id: 'normal', name: 'Normal', description: 'Work directly and pause when user input is required' },
        { id: 'plan', name: 'Plan', description: 'Research and propose a plan before making changes' },
        { id: 'goal', name: 'Goal', description: 'Keep advancing the next prompt as a goal until complete or blocked' },
      ],
    },
  };
}

describe('ReasonixSessionConfigState', () => {
  function createState(settings: Record<string, unknown> = {}): {
    state: ReasonixSessionConfigState;
    settings: Record<string, unknown>;
  } {
    updateReasonixProviderSettings(settings, { enabled: true });
    return { state: new ReasonixSessionConfigState({ settingsBag: () => settings }), settings };
  }

  describe('what a session reported about itself', () => {
    it('seeds the models and modes from the config options a session opens with', () => {
      const { state, settings } = createState();

      expect(state.syncSessionDiscovery(recordedSession())).toBe(true);

      const stored = getReasonixProviderSettings(settings);
      expect(stored.visibleModels)
        .toEqual(['custom-api-z-ai/glm-5.3', 'custom-api-z-ai/glm-5.3-flash']);
      expect(stored.discoveredModels).toEqual([
        {
          description: 'custom-api-z-ai',
          label: 'custom-api-z-ai/glm-5.3',
          rawId: 'custom-api-z-ai/glm-5.3',
        },
        {
          description: 'custom-api-z-ai',
          label: 'custom-api-z-ai/glm-5.3-flash',
          rawId: 'custom-api-z-ai/glm-5.3-flash',
        },
      ]);
      expect(stored.availableModes.map(mode => mode.id)).toEqual(['normal', 'plan', 'goal']);
      expect(state.sessionModelId).toBe('custom-api-z-ai/glm-5.3-flash');
      expect(state.sessionModeId).toBe('normal');
    });

    it('replaces a stale catalogue rather than merging into it', () => {
      // A different account offers a different list, and the old one must go.
      const { state, settings } = createState();
      updateReasonixProviderSettings(settings, {
        discoveredModels: [{ label: 'Gone', rawId: 'gpt-5-6-sol-low' }],
        visibleModels: ['gpt-5-6-sol-low'],
      });

      state.syncSessionDiscovery(recordedSession());

      expect(getReasonixProviderSettings(settings).visibleModels)
        .toEqual(['custom-api-z-ai/glm-5.3', 'custom-api-z-ai/glm-5.3-flash']);
    });

    it('reports nothing changed when the session named nothing', () => {
      const { state } = createState();

      expect(state.syncSessionDiscovery({})).toBe(false);
    });

    it('records where the agent starts without moving what the user picked', () => {
      const { state, settings } = createState();
      updateReasonixProviderSettings(settings, { selectedMode: 'plan' });

      state.syncSessionDiscovery(recordedSession());

      expect(getReasonixProviderSettings(settings).selectedMode).toBe('plan');
      expect(state.sessionModeId).toBe('normal');
    });
  });

  describe('the reasoning levels the session offers', () => {
    it('takes them from the effort option, dropping the auto that is not a level', () => {
      const { state, settings } = createState();

      expect(state.syncSessionDiscovery(recordedSession())).toBe(true);

      expect(getReasonixProviderSettings(settings).availableEfforts).toEqual([
        { id: 'enabled', name: 'Enabled' },
        { id: 'disabled', name: 'Disabled' },
      ]);
    });

    it('asks for nothing on auto, and nothing the session did not offer', () => {
      // Reasonix validates the level against the model and answers
      // `UNSUPPORTED_REASONING_EFFORT`, so an unoffered one is a failed turn.
      const { state, settings } = createState();
      state.syncSessionDiscovery(recordedSession());

      expect(state.resolveSelectedEffort()).toBeNull();

      updateReasonixProviderSettings(settings, { effortLevel: 'max' });
      expect(state.resolveSelectedEffort()).toBeNull();

      updateReasonixProviderSettings(settings, { effortLevel: 'disabled' });
      expect(state.resolveSelectedEffort()).toBe('disabled');
    });
  });

  describe('a mode somebody switched the session to', () => {
    it('translates on the way into the vault and keeps the raw id beside it', () => {
      const { state, settings } = createState();

      expect(state.adoptCurrentMode('goal')).toBe('normal');

      expect(getReasonixProviderSettings(settings).selectedMode).toBe('normal');
      expect(state.sessionModeId).toBe('goal');
    });

    it('leaves somebody in Auto-approve when the session reports its own mode', () => {
      // Safe and Auto-approve are the same Reasonix mode; only `tool_approval`
      // separates them. A reported `normal` says nothing about which the person
      // is in, so it must not answer for them.
      const { state, settings } = createState();
      settings.permissionMode = 'full_access';
      settings.savedProviderPermissionMode = { reasonix: 'full_access' };
      updateReasonixProviderSettings(settings, { selectedMode: 'full_access' });

      expect(state.adoptCurrentMode('normal')).toBe('full_access');
      expect(getReasonixProviderSettings(settings).selectedMode).toBe('full_access');
      expect(state.sessionModeId).toBe('normal');
    });

    it('adopts Plan whatever the person was in', () => {
      const { state, settings } = createState();
      settings.permissionMode = 'full_access';
      settings.savedProviderPermissionMode = { reasonix: 'full_access' };

      expect(state.adoptCurrentMode('plan')).toBe('plan');
      expect(getReasonixProviderSettings(settings).selectedMode).toBe('plan');
    });
  });

  describe('what the live session was set to', () => {
    it('forgets the model and the mode together', () => {
      const { state } = createState();
      state.markApplied({ modeId: 'plan', modelId: 'swe-1-6-slow' });

      state.forgetSession();

      expect(state.sessionModeId).toBeNull();
      expect(state.sessionModelId).toBeNull();
    });
  });

  describe('what a turn should run under', () => {
    it('prefers the permission mode over the stored selection', () => {
      const { state, settings } = createState();
      settings.permissionMode = 'full_access';
      settings.savedProviderPermissionMode = { reasonix: 'full_access' };
      updateReasonixProviderSettings(settings, { selectedMode: 'normal' });

      expect(state.resolveSelectedModeId()).toBe('full_access');
      expect(state.fullAccess()).toBe(true);
    });

    it('reads its own permission mode, not whichever provider was toggled last', () => {
      const { state, settings } = createState();
      settings.permissionMode = 'full_access';
      settings.savedProviderPermissionMode = { reasonix: 'normal' };

      expect(state.fullAccess()).toBe(false);
    });

    it('asks for the model the query named, decoded out of the chat id', () => {
      const { state } = createState();

      expect(state.resolveSelectedRawModelId({ model: 'reasonix:swe-1-6-slow' }))
        .toBe('swe-1-6-slow');
    });

    it('asks for nothing at all before a session has said what exists', () => {
      const { state } = createState();

      expect(state.resolveSelectedRawModelId()).toBeNull();
    });

    it('falls back to the vault saved model, then to the first it discovered', () => {
      const { state, settings } = createState();
      updateReasonixProviderSettings(settings, { visibleModels: ['swe-1-6-slow', 'claude-opus-5-medium'] });

      expect(state.resolveSelectedRawModelId()).toBe('swe-1-6-slow');

      settings.savedProviderModel = { reasonix: 'reasonix:claude-opus-5-medium' };
      expect(state.resolveSelectedRawModelId()).toBe('claude-opus-5-medium');
    });

    it('keeps the session model on later turns until the user selects another one', () => {
      const { state, settings } = createState();
      state.syncSessionDiscovery(recordedSession());

      expect(state.resolveSelectedRawModelId()).toBe('custom-api-z-ai/glm-5.3-flash');
      settings.savedProviderModel = { reasonix: 'reasonix:custom-api-z-ai/glm-5.3' };
      expect(state.resolveSelectedRawModelId()).toBe('custom-api-z-ai/glm-5.3');
    });

    it('labels the badge with the model the session is actually on', () => {
      const { state, settings } = createState();
      updateReasonixProviderSettings(settings, { visibleModels: ['swe-1-6-slow'] });

      expect(state.getActiveDisplayModel()).toBe('reasonix:swe-1-6-slow');

      state.markApplied({ modelId: 'claude-opus-5-medium' });
      expect(state.getActiveDisplayModel()).toBe('reasonix:claude-opus-5-medium');
    });
  });
});
