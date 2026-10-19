/**
 * Manual mock for the 'obsidian' package.
 * Used by Jest tests — the real module is only available inside Obsidian.
 */
class FakeButton {
    text = '';
    disabled = false;
    click: (() => unknown) | null = null;
    setButtonText(text: string) { this.text = text; return this; }
    setCta() { return this; }
    setWarning() { return this; }
    setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
    onClick(fn: () => unknown) { this.click = fn; return this; }
}

class FakeText {
    inputEl = { type: 'text' };
    setPlaceholder() { return this; }
    setValue() { return this; }
    onChange() { return this; }
}

module.exports = {
    Notice: jest.fn(),
    Plugin: class Plugin { },
    PluginSettingTab: class PluginSettingTab { },
    // Records every Setting a test renders (Setting.rendered) and runs the
    // component callbacks, so a test can find a control by its name and press
    // it. Nothing outside the settings tab constructs one.
    Setting: class Setting {
        static rendered: Setting[] = [];
        name = '';
        desc = '';
        buttons: FakeButton[] = [];
        constructor() { Setting.rendered.push(this); }
        setName(name: string) { this.name = name; return this; }
        setDesc(desc: string) { this.desc = desc; return this; }
        setHeading() { return this; }
        addText(cb?: (t: FakeText) => void) { cb?.(new FakeText()); return this; }
        addToggle(cb?: (t: FakeText) => void) { cb?.(new FakeText()); return this; }
        addButton(cb?: (b: FakeButton) => void) {
            const button = new FakeButton();
            this.buttons.push(button);
            cb?.(button);
            return this;
        }
        addDropdown() { return this; }
    },
    App: class App { },
    TFile: class TFile { },
    TFolder: class TFolder { },
    TAbstractFile: class TAbstractFile { },
    FuzzySuggestModal: class FuzzySuggestModal { },
    requestUrl: jest.fn(),
    setIcon: jest.fn(),
};
