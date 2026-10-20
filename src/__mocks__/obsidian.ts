/**
 * Manual mock for the 'obsidian' package.
 * Used by Jest tests — the real module is only available inside Obsidian.
 *
 * ⭐ Only the API the plugin is allowed to use is here. `setWarning()` and
 * `display()` are deprecated since Obsidian 1.13.0 and are deliberately
 * absent, so a call that brings one back throws in any test that reaches it
 * (lint refuses it too: `@typescript-eslint/no-deprecated`).
 */

/** An element whose every method returns another element. */
function fakeEl(): HTMLElement {
    return new Proxy({} as Record<string | symbol, unknown>, {
        get: (target, prop) => {
            if (prop in target) return target[prop];
            // Not a thenable: an awaited element must not hang the test.
            if (prop === 'then') return undefined;
            return () => fakeEl();
        },
    }) as unknown as HTMLElement;
}

class FakeButton {
    text = '';
    disabled = false;
    cta = false;
    destructive = false;
    click: (() => unknown) | null = null;
    setButtonText(text: string) { this.text = text; return this; }
    setCta() { this.cta = true; return this; }
    setDestructive() { this.destructive = true; return this; }
    setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
    onClick(fn: () => unknown) { this.click = fn; return this; }
}

class FakeText {
    inputEl = { type: 'text' };
    value = '';
    change: ((value: string) => unknown) | null = null;
    setPlaceholder() { return this; }
    setValue(value: string) { this.value = value; return this; }
    onChange(fn: (value: string) => unknown) { this.change = fn; return this; }
}

// Records every Setting a test renders (Setting.rendered) and runs the
// component callbacks, so a test can find a control by its name and press it.
class Setting {
    static rendered: Setting[] = [];
    name = '';
    desc = '';
    /** The heading of the group or list the framework rendered it in. */
    group: string | undefined = undefined;
    searchable = true;
    classes: string[] = [];
    buttons: FakeButton[] = [];
    texts: FakeText[] = [];
    action: ((el: HTMLElement, index: number) => void) | null = null;
    control: unknown = null;
    settingEl = fakeEl();
    infoEl = fakeEl();
    nameEl = fakeEl();
    descEl = fakeEl();
    controlEl = fakeEl();
    constructor() { Setting.rendered.push(this); }
    setName(name: string) { this.name = name; return this; }
    setDesc(desc: unknown) { this.desc = typeof desc === 'string' ? desc : ''; return this; }
    setClass(cls: string) { this.classes.push(cls); return this; }
    setHeading() { return this; }
    addText(cb?: (t: FakeText) => void) {
        const text = new FakeText();
        this.texts.push(text);
        cb?.(text);
        return this;
    }
    addToggle(cb?: (t: FakeText) => void) { cb?.(new FakeText()); return this; }
    addButton(cb?: (b: FakeButton) => void) {
        const button = new FakeButton();
        this.buttons.push(button);
        cb?.(button);
        return this;
    }
    addDropdown() { return this; }
}

interface FakeDefinition {
    type?: 'group' | 'list' | 'page';
    heading?: string;
    items?: FakeDefinition[];
    name: string;
    desc?: unknown;
    visible?: boolean | (() => boolean);
    searchable?: boolean | (() => boolean);
    render?: (setting: Setting, group: unknown) => unknown;
    action?: (el: HTMLElement, index: number) => void;
    control?: unknown;
}

const evaluate = (value: boolean | (() => boolean) | undefined): boolean =>
    typeof value === 'function' ? value() : value !== false;

/**
 * Renders definitions the way Obsidian's settings framework does, as far as
 * the tests need: one Setting per definition that is visible, named and
 * described from the definition, then `render` handed that Setting. Groups
 * and lists render their items under their heading.
 */
function renderDefinitions(items: FakeDefinition[], heading: string | undefined): void {
    for (const item of items) {
        if (!evaluate(item.visible)) continue;
        if (item.type === 'group' || item.type === 'list') {
            renderDefinitions(item.items ?? [], item.heading);
            continue;
        }
        if (item.type === 'page') continue;
        const setting = new Setting();
        setting.group = heading;
        setting.searchable = evaluate(item.searchable);
        setting.setName(item.name);
        if (item.desc !== undefined) setting.setDesc(item.desc);
        if (item.render) item.render(setting, fakeEl());
        if (item.action) setting.action = item.action;
        if (item.control) setting.control = item.control;
    }
}

class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl = fakeEl();
    settingItems: unknown[] = [];
    constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
    }
    getSettingDefinitions(): unknown[] { return []; }
    /** Obsidian rebuilds the definitions and re-renders the open tab. */
    update() {
        this.settingItems = this.getSettingDefinitions();
        Setting.rendered.length = 0;
        renderDefinitions(this.settingItems as FakeDefinition[], undefined);
    }
    refreshDomState() { }
}

class TAbstractFile {
    path = '';
    name = '';
}

class TFile extends TAbstractFile {
    basename = '';
    extension = '';
    stat = { mtime: 0, ctime: 0, size: 0 };
}

class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
}

/** Obsidian's normalizePath, for the inputs a settings field can produce. */
function normalizePath(path: string): string {
    const cleaned = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    return cleaned === '' ? '/' : cleaned;
}

module.exports = {
    Notice: jest.fn(),
    Plugin: class Plugin { },
    PluginSettingTab,
    Setting,
    App: class App { },
    TFile,
    TFolder,
    TAbstractFile,
    normalizePath,
    requestUrl: jest.fn(),
    setIcon: jest.fn(),
};
