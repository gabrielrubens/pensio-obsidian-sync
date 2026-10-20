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

/**
 * An element that keeps the text written into it (`recorded`), for the rows
 * that build themselves by hand: the status card, the setup code. Text
 * written into a child it made counts for it too; `empty()` clears only the
 * element it is called on, as in the DOM.
 */
type TextEl = HTMLElement & { recorded: string };
function textEl(parent?: { write: (text: string) => void }): TextEl {
    let text = '';
    const write = (more: string) => { text += more; parent?.write(more); };
    const self = { write };
    const make = (options?: { text?: string }) => {
        const child = textEl(self);
        if (options?.text) (child as unknown as { write: (t: string) => void }).write(options.text);
        return child;
    };
    const target: Record<string | symbol, unknown> = {
        write,
        empty: () => { text = ''; },
        appendText: (more: string) => write(more),
        createEl: (_tag: string, options?: { text?: string }) => make(options),
        createDiv: (options?: { text?: string }) => make(options),
        createSpan: (options?: { text?: string }) => make(options),
    };
    Object.defineProperty(target, 'recorded', { get: () => text });
    return new Proxy(target, {
        get: (t, prop) => {
            if (prop in t) return t[prop];
            if (prop === 'then') return undefined;
            return () => fakeEl();
        },
    }) as unknown as TextEl;
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

/** The icon buttons in the status card's top line. */
class ExtraButtonComponent {
    static rendered: ExtraButtonComponent[] = [];
    icon = '';
    tooltip = '';
    click: (() => unknown) | null = null;
    constructor() { ExtraButtonComponent.rendered.push(this); }
    setIcon(icon: string) { this.icon = icon; return this; }
    setTooltip(tooltip: string) { this.tooltip = tooltip; return this; }
    onClick(fn: () => unknown) { this.click = fn; return this; }
}

/** Obsidian 1.13's confirmation dialog: records what it asks and its buttons. */
class ConfirmationModal {
    static last: ConfirmationModal | null = null;
    title = '';
    content = '';
    buttons: FakeButton[] = [];
    cancel = false;
    opened = false;
    constructor() { ConfirmationModal.last = this; }
    setTitle(title: string) { this.title = title; return this; }
    setContent(content: unknown) { this.content = typeof content === 'string' ? content : ''; return this; }
    addButton(cb: (b: FakeButton) => void) {
        const button = new FakeButton();
        this.buttons.push(button);
        cb(button);
        return this;
    }
    addCancelButton() { this.cancel = true; return this; }
    open() { this.opened = true; }
}

// Records every Setting a test renders (Setting.rendered) and runs the
// component callbacks, so a test can find a control by its name and press it.
class Setting {
    static rendered: Setting[] = [];
    name = '';
    desc = '';
    /** The heading of the group or list the framework rendered it in. */
    group: string | undefined = undefined;
    /** The sub-page it sits on (`type: 'page'`), when it is on one. */
    page: string | undefined = undefined;
    /** This row opens a sub-page. */
    opensPage = false;
    aliases: string[] = [];
    /** The definition's name: what Obsidian's settings search finds it by. */
    searchName = '';
    searchable = true;
    classes: string[] = [];
    buttons: FakeButton[] = [];
    texts: FakeText[] = [];
    action: ((el: HTMLElement, index: number) => void) | null = null;
    control: unknown = null;
    settingEl = textEl();
    infoEl = fakeEl();
    nameEl = fakeEl();
    descEl = textEl();
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
    aliases?: string[];
    desc?: unknown;
    visible?: boolean | (() => boolean);
    searchable?: boolean | (() => boolean);
    render?: (setting: Setting, group: unknown) => unknown;
    action?: (el: HTMLElement, index: number) => void;
    control?: unknown;
}

const evaluate = (value: boolean | (() => boolean) | undefined): boolean =>
    typeof value === 'function' ? value() : value !== false;

/** What each `render` returned, run before the rows are drawn again. */
const cleanups: (() => void)[] = [];

/**
 * Renders definitions the way Obsidian's settings framework does, as far as
 * the tests need: one Setting per definition that is visible, named and
 * described from the definition, then `render` handed that Setting. Groups
 * and lists render their items under their heading.
 *
 * A page (`type: 'page'`) draws its row, then its items as if it were open,
 * each marked with the page's name: Obsidian's settings search reaches into a
 * declarative page, so a test of what search finds has to as well.
 */
function renderDefinitions(items: FakeDefinition[], heading: string | undefined, page?: string): void {
    for (const item of items) {
        if (!evaluate(item.visible)) continue;
        if (item.type === 'group' || item.type === 'list') {
            renderDefinitions(item.items ?? [], item.heading, page);
            continue;
        }
        const setting = new Setting();
        setting.group = heading;
        setting.page = page;
        setting.searchable = evaluate(item.searchable);
        setting.aliases = item.aliases ?? [];
        setting.searchName = item.name;
        setting.setName(item.name);
        if (item.desc !== undefined) setting.setDesc(item.desc);
        if (item.type === 'page') {
            setting.opensPage = true;
            renderDefinitions(item.items ?? [], undefined, item.name);
            continue;
        }
        if (item.render) {
            const cleanup = item.render(setting, fakeEl());
            if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
        }
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
        cleanups.splice(0).forEach(cleanup => cleanup());
        Setting.rendered.length = 0;
        ExtraButtonComponent.rendered.length = 0;
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
    // A notice that can be hidden, as SyncStatus hides one a sync made stale.
    Notice: jest.fn().mockImplementation(() => ({ hide: jest.fn() })),
    ConfirmationModal,
    ExtraButtonComponent,
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
    setTooltip: jest.fn(),
};
