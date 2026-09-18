import { commandcodeProviderModule } from '@/providers/commandcode/CommandcodeProviderModule';
import { decodeCommandcodeSettings, getCommandcodeSettings, updateCommandcodeSettings } from '@/providers/commandcode/settings';
import { commandcodeChatUIConfig as ui } from '@/providers/commandcode/ui/CommandcodeChatUIConfig';

describe('Command Code visible models', () => {
  const models = [
    { rawId: 'vendor/one', label: 'One' },
    { rawId: 'vendor/two', label: 'Two' },
  ];

  it('keeps the live catalog as the default, and uses only the saved selection when configured', () => {
    const settings = {};
    updateCommandcodeSettings(settings, { discoveredModels: models });
    expect(ui.getModelOptions(settings).map(model => model.value)).toEqual(['commandcode:vendor/one', 'commandcode:vendor/two']);
    updateCommandcodeSettings(settings, { visibleModels: ['vendor/two'] });
    expect(ui.getModelOptions(settings)).toEqual([{ value: 'commandcode:vendor/two', label: 'Two' }]);
    updateCommandcodeSettings(settings, { discoveredModels: [...models, { rawId: 'new/model', label: 'New' }] });
    expect(ui.getModelOptions(settings).map(model => model.value)).toEqual(['commandcode:vendor/two']);
    updateCommandcodeSettings(settings, { visibleModels: [] });
    expect(ui.getModelOptions(settings)).toHaveLength(3);
  });

  it('preserves opaque selections across missing catalogs and settings round trips', () => {
    const settings = {};
    const decoded = decodeCommandcodeSettings({ visibleModels: [' vendor/two:free ', '', null, 'vendor/two:free'], imageAttachmentsAsFiles: true, modelAliases: { ' vendor/two:free ': ' Daily ', bad: 7 } });
    const persisted = commandcodeProviderModule.settings.encode(decoded);
    updateCommandcodeSettings(settings, persisted);
    expect(getCommandcodeSettings(settings).visibleModels).toEqual(['vendor/two:free']);
    expect(getCommandcodeSettings(settings).modelAliases).toEqual({ 'vendor/two:free': 'Daily' });
    expect(getCommandcodeSettings(settings).imageAttachmentsAsFiles).toBe(true);
    expect(ui.getModelOptions(settings)).toEqual([expect.objectContaining({ value: 'commandcode:vendor/two:free', label: 'Daily' })]);
    expect(decodeCommandcodeSettings({}).imageAttachmentsAsFiles).toBe(false);
  });
});
