/**
 * Manual mock for the 'obsidian' package.
 * Used by Jest tests — the real module is only available inside Obsidian.
 */
module.exports = {
    Notice: jest.fn(),
    Plugin: class Plugin {},
    PluginSettingTab: class PluginSettingTab {},
    Setting: class Setting {
        setName() { return this; }
        setDesc() { return this; }
        setHeading() { return this; }
        addText() { return this; }
        addToggle() { return this; }
        addButton() { return this; }
        addDropdown() { return this; }
    },
    App: class App {},
    TFile: class TFile {},
    TFolder: class TFolder {},
    TAbstractFile: class TAbstractFile {},
    FuzzySuggestModal: class FuzzySuggestModal {},
    requestUrl: jest.fn(),
};
