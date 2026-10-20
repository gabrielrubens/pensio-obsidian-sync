/**
 * Manual mock for the 'obsidian' package.
 * Used by Jest tests — the real module is only available inside Obsidian.
 *
 * ⭐ Only the API the plugin is allowed to use is here. `setWarning()` and
 * `display()` are deprecated since Obsidian 1.13.0 and are deliberately
 * absent, so a call that brings one back throws in any test that reaches it
 * (lint refuses it too: `@typescript-eslint/no-deprecated`).
 *
 * ⭐ THE SETTINGS TAB RENDERS THE WAY OBSIDIAN 1.14.4 DOES (since plugin
 * 0.7.1), read from its own app.js during the 2026-10-20 review:
 * - `update()` rebuilds the definitions and redraws only while the tab is
 *   open; `open()` and `close()` run every cleanup and start from fresh rows.
 * - A redraw REUSES a row whose key matches (`id:`, `ctrl:<key>`,
 *   `name:<name>` or `item#<i>`, inside a group keyed by `type:heading` or
 *   `type#<i>`; loose top-level items share an anonymous group). For a reused
 *   row it runs the cleanup `render` returned, empties only `controlEl`
 *   (`Setting.clear()`), resets the name and the description, and calls
 *   `render` again on the SAME Setting, so anything `render` put elsewhere in
 *   `settingEl` is still there.
 * - A sub-page's rows exist only while it is open (`openPage()`).
 * ⛔ The mock before this built a fresh Setting on every update(), so the
 * status card's brand line and icon piling up once per redraw (plugin 0.7.0,
 * Gabriel's screenshots of 2026-10-20) could not happen in any test.
 */

/** A small DOM: enough of Obsidian's element helpers to count what a row drew. */
class FakeNode {
    children: FakeNode[] = [];
    parent: FakeNode | null = null;
    classes = new Set<string>();
    text = '';
    attrs: Record<string, string> = {};
    hidden = false;
    constructor(public tag: string) {}
    get firstChild(): FakeNode | null { return this.children[0] ?? null; }
    /** Everything written into it and its children, in order. */
    get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
    appendChild(node: FakeNode) { node.detach(); node.parent = this; this.children.push(node); return node; }
    insertBefore(node: FakeNode, ref: FakeNode | null) {
        node.detach();
        node.parent = this;
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
        return node;
    }
    removeChild(node: FakeNode) { this.children = this.children.filter(c => c !== node); node.parent = null; return node; }
    detach() { this.parent?.removeChild(this); }
    remove() { this.detach(); }
    empty() { for (const child of [...this.children]) this.removeChild(child); this.text = ''; }
    setText(text: string) { this.empty(); this.text = text; }
    appendText(text: string) { const node = new FakeNode('#text'); node.text = text; this.appendChild(node); }
    addClass(...classes: string[]) { classes.forEach(c => this.classes.add(c)); }
    removeClass(...classes: string[]) { classes.forEach(c => this.classes.delete(c)); }
    toggleClass(cls: string, on: boolean) { if (on) this.classes.add(cls); else this.classes.delete(cls); }
    hasClass(cls: string) { return this.classes.has(cls); }
    setAttr(key: string, value: string) { this.attrs[key] = value; }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    hide() { this.hidden = true; }
    show() { this.hidden = false; }
    addEventListener() { /* no events in tests */ }
    createEl(tag: string, options?: string | { cls?: string; text?: string; href?: string; prepend?: boolean }) {
        const o = typeof options === 'string' ? { cls: options } : (options ?? {});
        const el = new FakeNode(tag);
        if (o.cls) o.cls.split(' ').filter(Boolean).forEach(c => el.classes.add(c));
        if (o.text) el.setText(o.text);
        if (o.href) el.attrs.href = o.href;
        if (o.prepend) this.insertBefore(el, this.firstChild); else this.appendChild(el);
        return el;
    }
    createDiv(options?: string | { cls?: string; text?: string; prepend?: boolean }) { return this.createEl('div', options); }
    createSpan(options?: string | { cls?: string; text?: string; prepend?: boolean }) { return this.createEl('span', options); }
    /** Every descendant carrying `cls`, depth first. */
    find(cls: string): FakeNode[] {
        const found: FakeNode[] = [];
        const walk = (node: FakeNode) => { for (const child of node.children) { if (child.classes.has(cls)) found.push(child); walk(child); } };
        walk(this);
        return found;
    }
}

/** Obsidian's setIcon replaces the element's first svg. */
function setIcon(el: FakeNode, icon: string) {
    // A test's stand-in element (a status bar of plain objects) has no tree.
    if (!(el instanceof FakeNode)) return;
    const first = el.firstChild;
    if (first && first.tag === 'svg') el.removeChild(first);
    const svg = new FakeNode('svg');
    svg.attrs.icon = icon;
    el.insertBefore(svg, el.firstChild);
}

class FakeButton {
    buttonEl: FakeNode;
    text = '';
    disabled = false;
    cta = false;
    destructive = false;
    click: (() => unknown) | null = null;
    constructor(parent?: FakeNode) { this.buttonEl = parent ? parent.createEl('button') : new FakeNode('button'); }
    setButtonText(text: string) { this.text = text; this.buttonEl.setText(text); return this; }
    setCta() { this.cta = true; return this; }
    setDestructive() { this.destructive = true; return this; }
    setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
    setTooltip() { return this; }
    onClick(fn: () => unknown) { this.click = fn; return this; }
}

class FakeText {
    inputEl: FakeNode;
    value = '';
    placeholder = '';
    change: ((value: string) => unknown) | null = null;
    constructor(parent?: FakeNode) { this.inputEl = parent ? parent.createEl('input') : new FakeNode('input'); }
    setPlaceholder(placeholder: string) { this.placeholder = placeholder; return this; }
    setValue(value: string) { this.value = value; return this; }
    getValue() { return this.value; }
    onChange(fn: (value: string) => unknown) { this.change = fn; return this; }
    /** Type into the field: what Obsidian's onChange receives. */
    async type(value: string) { this.value = value; await this.change?.(value); }
}

/** The icon buttons in the status card's top line. */
class ExtraButtonComponent {
    extraSettingsEl: FakeNode;
    icon = '';
    tooltip = '';
    click: (() => unknown) | null = null;
    constructor(parent: FakeNode) { this.extraSettingsEl = parent.createDiv({ cls: 'clickable-icon extra-setting-button' }); }
    setIcon(icon: string) { this.icon = icon; setIcon(this.extraSettingsEl, icon); return this; }
    setTooltip(tooltip: string) { this.tooltip = tooltip; this.extraSettingsEl.attrs.tooltip = tooltip; return this; }
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

/** Obsidian's Setting (app.js `rT`), the members the plugin uses. */
class Setting {
    /** The rows on screen after the last render, in order. */
    static rendered: Setting[] = [];
    settingEl: FakeNode;
    infoEl: FakeNode;
    nameEl: FakeNode;
    descEl: FakeNode;
    controlEl: FakeNode;
    components: unknown[] = [];
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
    action: ((el: HTMLElement, index: number) => void) | null = null;
    control: unknown = null;
    /** How many times `render` ran on this row. */
    renders = 0;
    constructor(container: FakeNode) {
        this.settingEl = container.createDiv({ cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv('setting-item-info');
        this.nameEl = this.infoEl.createDiv('setting-item-name');
        this.descEl = this.infoEl.createDiv('setting-item-description');
        this.controlEl = this.settingEl.createDiv('setting-item-control');
    }
    /** The row's title as drawn. */
    get name(): string { return this.nameEl.textContent; }
    get desc(): string { return this.descEl.textContent; }
    get classes(): string[] { return [...this.settingEl.classes]; }
    get buttons(): FakeButton[] { return this.components.filter((c): c is FakeButton => c instanceof FakeButton); }
    get texts(): FakeText[] { return this.components.filter((c): c is FakeText => c instanceof FakeText); }
    setName(name: string) { this.nameEl.setText(name); return this; }
    setDesc(desc: unknown) { this.descEl.setText(typeof desc === 'string' ? desc : ''); return this; }
    setClass(cls: string) { this.settingEl.addClass(...cls.split(' ').filter(Boolean)); return this; }
    setHeading() { return this; }
    addText(cb?: (t: FakeText) => void) {
        const text = new FakeText(this.controlEl);
        this.components.push(text);
        cb?.(text);
        return this;
    }
    addToggle(cb?: (t: FakeText) => void) { const t = new FakeText(this.controlEl); this.components.push(t); cb?.(t); return this; }
    addButton(cb?: (b: FakeButton) => void) {
        const button = new FakeButton(this.controlEl);
        this.components.push(button);
        cb?.(button);
        return this;
    }
    addDropdown() { return this; }
    /** app.js: empties the control area only; the rest of the row stays. */
    clear() { this.controlEl.empty(); this.components = []; this.settingEl.removeClass('is-invalid'); return this; }
}

interface FakeDefinition {
    type?: 'group' | 'list' | 'page';
    id?: string;
    heading?: string;
    items?: FakeDefinition[];
    name: string;
    aliases?: string[];
    desc?: unknown;
    visible?: boolean | (() => boolean);
    searchable?: boolean | (() => boolean);
    render?: (setting: Setting, group: unknown) => unknown;
    action?: (el: HTMLElement, index: number) => void;
    control?: { key: string; type: string };
}

interface Row { key: string; setting: Setting; cleanup?: () => void }

const evaluate = (value: boolean | (() => boolean) | undefined): boolean =>
    typeof value === 'function' ? value() : value !== false;

/** app.js P4: run a row's cleanup once. */
function runCleanup(row: Row) {
    const cleanup = row.cleanup;
    row.cleanup = undefined;
    cleanup?.();
}

/** app.js C4: a row's key inside its group. */
function rowKey(def: FakeDefinition, index: number): string {
    if (def.type === 'page') return `page:${def.name}`;
    if (def.id) return `id:${def.id}`;
    if (def.control) return `ctrl:${def.control.key}`;
    return def.name ? `name:${def.name}` : `item#${index}`;
}

/** Loose top-level items share an anonymous group, as Obsidian draws them. */
function groupsOf(items: FakeDefinition[]): { key: string; heading?: string; items: FakeDefinition[] }[] {
    const groups: { key: string; heading?: string; items: FakeDefinition[] }[] = [];
    let loose: FakeDefinition[] | null = null;
    items.forEach((item) => {
        if (item.type === 'group' || item.type === 'list') {
            loose = null;
            if (!evaluate(item.visible)) return;
            const key = item.heading ? `${item.type}:${item.heading}` : `${item.type}#${groups.length}`;
            groups.push({ key, heading: item.heading, items: item.items ?? [] });
            return;
        }
        if (!loose) {
            loose = [];
            groups.push({ key: `group#${groups.length}`, items: loose });
        }
        loose.push(item);
    });
    return groups;
}

class PluginSettingTab {
    /**
     * The tab opened last: only it reports its rows in Setting.rendered, so a
     * test's tab is not overwritten by an earlier test's late redraw.
     */
    static latest: PluginSettingTab | null = null;
    app: unknown;
    plugin: unknown;
    containerEl = new FakeNode('div');
    settingItems: unknown[] = [];
    /** The settings window shows this tab. */
    active = false;
    /** The sub-page that is open, if any. */
    openPageName: string | null = null;
    private rows: Row[] = [];
    constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
    }
    getSettingDefinitions(): unknown[] { return []; }
    /** Obsidian rebuilds the definitions, and redraws the tab only if it is open. */
    update() {
        this.settingItems = this.getSettingDefinitions();
        if (this.active) this.reconcile();
    }
    /** She opens the tab: fresh rows from the definitions built last. */
    open() {
        if (this.settingItems.length === 0) this.settingItems = this.getSettingDefinitions();
        PluginSettingTab.latest = this;
        this.teardown();
        this.active = true;
        this.reconcile();
    }
    /** She closes the settings: every cleanup runs. */
    close() {
        this.teardown();
        this.active = false;
    }
    openPage(name: string) {
        this.teardown();
        this.openPageName = name;
        this.reconcile();
    }
    closePage() {
        this.teardown();
        this.openPageName = null;
        this.reconcile();
    }
    refreshDomState() { }
    private teardown() {
        for (const row of this.rows) { runCleanup(row); row.setting.settingEl.detach(); }
        this.rows = [];
        this.containerEl.empty();
        if (PluginSettingTab.latest === this) Setting.rendered = [];
    }
    private reconcile() {
        let items = this.settingItems as FakeDefinition[];
        if (this.openPageName !== null) {
            const page = items.find(item => item.type === 'page' && item.name === this.openPageName);
            items = page?.items ?? [];
        }
        const next: Row[] = [];
        for (const group of groupsOf(items)) {
            group.items.forEach((def, index) => {
                if (!evaluate(def.visible)) return;
                const key = `${group.key}|${rowKey(def, index)}`;
                let row = this.rows.find(r => r.key === key);
                if (row) {
                    runCleanup(row);
                    row.setting.clear();
                } else {
                    row = { key, setting: new Setting(this.containerEl) };
                }
                this.draw(row, def, group.heading);
                next.push(row);
            });
        }
        for (const row of this.rows) {
            if (!next.includes(row)) { runCleanup(row); row.setting.settingEl.detach(); }
        }
        this.rows = next;
        if (PluginSettingTab.latest === this) Setting.rendered = next.map(row => row.setting);
    }
    /** app.js O4: name, description, then render on the same Setting. */
    private draw(row: Row, def: FakeDefinition, heading: string | undefined) {
        const setting = row.setting;
        setting.group = heading;
        setting.page = this.openPageName ?? undefined;
        setting.searchName = def.name;
        setting.aliases = def.aliases ?? [];
        setting.searchable = evaluate(def.searchable);
        setting.setName(def.name);
        setting.setDesc(def.desc ?? '');
        if (def.type === 'page') {
            setting.opensPage = true;
            return;
        }
        if (def.render) {
            setting.renders++;
            const cleanup = def.render(setting, {});
            if (typeof cleanup === 'function') row.cleanup = cleanup as () => void;
        }
        if (def.action) setting.action = def.action;
        if (def.control) {
            setting.control = def.control;
            setting.controlEl.createEl('input');
        }
    }
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
    setIcon: jest.fn((el: FakeNode, icon: string) => setIcon(el, icon)),
    setTooltip: jest.fn(),
    /** Not Obsidian's: a detached element for tests that need one. */
    __Node: FakeNode,
};
