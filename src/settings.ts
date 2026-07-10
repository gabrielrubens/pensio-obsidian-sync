import { App, FuzzySuggestModal, normalizePath, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import { errorMessage } from './errors';
import PensioPlugin from './main';

/**
 * Folder suggest modal for selecting folders
 */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    private onChooseFolderCallback: (folder: TFolder) => void;

    constructor(app: App, onChooseFolder: (folder: TFolder) => void) {
        super(app);
        this.onChooseFolderCallback = onChooseFolder;
    }

    getItems(): TFolder[] {
        const folders: TFolder[] = [];
        const rootFolder = this.app.vault.getRoot();

        const addFolders = (folder: TFolder) => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    addFolders(child);
                }
            }
        };

        addFolders(rootFolder);
        return folders;
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onChooseFolderCallback(folder);
    }
}

export class PensioSettingTab extends PluginSettingTab {
    plugin: PensioPlugin;

    constructor(app: App, plugin: PensioPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // --- Pensio branding ---
        this.renderBranding(containerEl);

        // --- Connection ---
        new Setting(containerEl).setName('Connection').setHeading();

        this.renderConnectionStatus(containerEl);

        // --- Sync folders ---
        new Setting(containerEl).setName('Sync folders').setHeading();

        containerEl.createEl('p', {
            cls: 'setting-item-description pensio-folder-desc',
            text: 'Add folders containing journal files. All .md files sync as Daily Journal entries. Use frontmatter "type:" to override per file.',
        });

        // Render each existing mapping
        for (let i = 0; i < this.plugin.settings.journalFolders.length; i++) {
            this.renderFolderMapping(containerEl, i);
        }

        // Add folder button
        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('+ Add journal folder')
                .onClick(async () => {
                    this.plugin.settings.journalFolders.push({
                        folder: '',
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(containerEl)
            .setName('People folder')
            .setDesc(
                'Each .md file becomes a relationship in Pensio. ' +
                'Use [[Name]] wikilinks in journal entries to connect entries to people automatically.'
            )
            .addText(text => {
                text
                    .setPlaceholder('People')
                    .setValue(this.plugin.settings.peopleFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.peopleFolder = normalizePath(value.trim());
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, (folder) => {
                        void (async () => {
                            this.plugin.settings.peopleFolder = folder.path;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    }).open();
                }));

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync when files change and run periodic sync every 5 minutes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));

        // --- Links ---
        new Setting(containerEl).setName('Links').setHeading();

        new Setting(containerEl)
            .setName('Documentation')
            .setDesc('Setup guide, features, and troubleshooting')
            .addButton(button => button
                .setButtonText('Open docs')
                .onClick(() => {
                    window.open('https://pensio.app/features/obsidian-sync/');
                }));

        new Setting(containerEl)
            .setName('Report an issue')
            .setDesc('Found a bug or have a suggestion?')
            .addButton(button => button
                .setButtonText('Open GitHub')
                .onClick(() => {
                    window.open('https://github.com/gabrielrubens/pensio-obsidian-sync/issues');
                }));

        // --- Advanced ---
        new Setting(containerEl).setName('Advanced').setHeading();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('For development or testing only')
            .addText(text => text
                .setPlaceholder('https://pensio.app')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Mirror delete')
            .setDesc(
                'Delete server entries that no longer exist in your vault. ' +
                'Only affects entries created by this plugin — web-created entries are never touched. Use with caution.'
            )
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMirrorDelete)
                .onChange(async (value) => {
                    this.plugin.settings.enableMirrorDelete = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debug mode')
            .setDesc('Enable verbose console logging for troubleshooting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));

        // Manual token entry — for self-hosters who prefer pasting JWTs over
        // the setup-code pairing. The normal path is the Setup code above.
        new Setting(containerEl)
            .setName('Access token')
            .setDesc('Manual token entry (advanced) — prefer the setup code')
            .addText(text => {
                text
                    .setPlaceholder('Access token')
                    .setValue(this.plugin.getAccessToken())
                    .onChange(async (value) => {
                        await this.plugin.setTokens(value.trim(), this.plugin.getRefreshToken());
                    });
                text.inputEl.type = 'password';
            });

        new Setting(containerEl)
            .setName('Refresh token')
            .setDesc('Both tokens are required when entered manually')
            .addText(text => {
                text
                    .setPlaceholder('Refresh token')
                    .setValue(this.plugin.getRefreshToken())
                    .onChange(async (value) => {
                        await this.plugin.setTokens(this.plugin.getAccessToken(), value.trim());
                    });
                text.inputEl.type = 'password';
            });

        this.renderTestButton(containerEl);
    }

    /**
     * Render the Pensio branding block at the top of settings.
     */
    private renderBranding(containerEl: HTMLElement): void {
        const brandingEl = containerEl.createDiv({ cls: 'pensio-branding' });

        const titleRow = brandingEl.createDiv({ cls: 'pensio-branding-title' });
        titleRow.createSpan({ text: '✦ ', cls: 'pensio-branding-icon' });
        titleRow.createSpan({ text: 'Pensio', cls: 'pensio-branding-name' });
        titleRow.createSpan({ text: 'Beta', cls: 'pensio-beta-badge' });

        brandingEl.createEl('p', {
            cls: 'pensio-branding-tagline',
            text: 'AI-powered journaling \u2014 emotion tracking, insights, relationship mapping, and an AI advisor that knows your entire journal.',
        });

        const learnMore = brandingEl.createEl('a', {
            text: 'Learn more at pensio.app',
            href: 'https://pensio.app',
            cls: 'pensio-branding-link',
        });
        learnMore.setAttr('target', '_blank');
    }

    /**
     * Render a single journal folder mapping row.
     * Shows: [folder text + browse] [remove button]
     */
    private renderFolderMapping(containerEl: HTMLElement, index: number): void {
        const mapping = this.plugin.settings.journalFolders[index];

        const setting = new Setting(containerEl)
            .setName(`Folder ${index + 1}`)
            .addText(text => {
                text
                    .setPlaceholder('Folder path')
                    .setValue(mapping.folder)
                    .onChange(async (value) => {
                        this.plugin.settings.journalFolders[index].folder = normalizePath(value.trim());
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, (folder) => {
                        void (async () => {
                            this.plugin.settings.journalFolders[index].folder = folder.path;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    }).open();
                }));

        // Only show remove button if there's more than one folder
        if (this.plugin.settings.journalFolders.length > 1) {
            setting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.journalFolders.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
        }
    }

    /**
     * Render the connection section with two distinct states:
     * - Disconnected: getting-started guide + token paste fields + test button
     * - Connected: account card with email, action buttons, token management
     */
    private renderConnectionStatus(containerEl: HTMLElement): void {
        const apiUrl = (this.plugin.settings.apiUrl || 'https://pensio.app').replace(/\/+$/, '');
        const hasBothTokens = this.plugin.getAccessToken() && this.plugin.getRefreshToken();
        const account = this.plugin.accountGuard.getAccount();

        if (hasBothTokens && this.plugin.apiClient.isAuthInvalidated()) {
            // ── Session dead (server-confirmed) — reconnect without data loss ──
            this.renderReconnectState(containerEl, apiUrl);
        } else if (hasBothTokens && account) {
            // ── Connected state ──
            this.renderConnectedState(containerEl, apiUrl, account);
        } else if (hasBothTokens) {
            // ── Tokens present but not verified ──
            this.renderUnverifiedState(containerEl, apiUrl);
        } else {
            // ── Disconnected state ──
            this.renderDisconnectedState(containerEl, apiUrl);
        }
    }

    /**
     * Connected: show account info card with quick actions.
     */
    private renderConnectedState(containerEl: HTMLElement, apiUrl: string, account: { email: string }): void {
        // Account info card
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u2713', cls: 'pensio-status-dot pensio-status-connected' });
        statusRow.createSpan({ text: `Connected as ${account.email}`, cls: 'pensio-account-email' });

        // Token expiry info
        const tokenManager = this.plugin.apiClient.getTokenManager();
        void tokenManager.getTokenExpiry().then(expiry => {
            if (expiry) {
                const timeUntilExpiry = expiry.getTime() - Date.now();
                const hoursUntilExpiry = Math.floor(timeUntilExpiry / (1000 * 60 * 60));
                const expiryText = hoursUntilExpiry > 0
                    ? `Token expires in ${hoursUntilExpiry}h \u2014 auto-refreshes`
                    : 'Token expired \u2014 will auto-refresh on next sync';
                card.createEl('p', { text: expiryText, cls: 'pensio-token-status' });
            }
        });

        // Quick actions
        new Setting(containerEl)
            .setName('Open Pensio')
            .setDesc('View your journal, insights, and AI chat on the web')
            .addButton(button => button
                .setButtonText('Open web app')
                .onClick(() => {
                    window.open(`${apiUrl}/dashboard/`);
                }));

        new Setting(containerEl)
            .setName('Manage devices')
            .setDesc('Review or revoke connected devices and tokens')
            .addButton(button => button
                .setButtonText('Token page')
                .onClick(() => {
                    window.open(`${apiUrl}/tokens/`);
                }));

        // Logout
        new Setting(containerEl)
            .setName('Logout')
            .setDesc('Clear tokens and sync state from this device')
            .addButton(button => button
                .setButtonText('Logout')
                .setWarning()
                .onClick(async () => {
                    await this.plugin.logout();
                    this.display();
                }));
    }

    /**
     * Tokens present but not yet verified — show test button prominently.
     */
    private renderUnverifiedState(containerEl: HTMLElement, apiUrl: string): void {
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u25CB', cls: 'pensio-status-dot pensio-status-pending' });
        statusRow.createSpan({ text: 'Tokens entered \u2014 not yet verified', cls: 'pensio-account-email' });

        this.renderTestButton(containerEl);
    }

    /**
     * Session dead (server-confirmed): tokens are kept, nothing was deleted —
     * a new setup code reconnects without touching sync state.
     */
    private renderReconnectState(containerEl: HTMLElement, apiUrl: string): void {
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u26A0', cls: 'pensio-status-dot pensio-status-pending' });
        statusRow.createSpan({ text: 'Session expired \u2014 reconnect to resume syncing', cls: 'pensio-account-email' });
        card.createEl('p', {
            text: 'Your notes and sync history are untouched. Enter a new setup code to reconnect.',
            cls: 'pensio-token-status',
        });

        this.renderPairingSetting(containerEl, apiUrl);
    }

    /**
     * Disconnected: getting-started onboarding + setup-code pairing.
     */
    private renderDisconnectedState(containerEl: HTMLElement, apiUrl: string): void {
        const gettingStarted = containerEl.createDiv({ cls: 'pensio-getting-started' });
        const steps = gettingStarted.createEl('p');
        steps.appendText('To connect this plugin you need a Pensio account and a setup code.');

        const stepList = gettingStarted.createEl('ol');

        const step1 = stepList.createEl('li');
        const signupLink = step1.createEl('a', {
            text: 'Create a free Pensio account',
            href: `${apiUrl}/register/`,
        });
        signupLink.setAttr('target', '_blank');
        step1.appendText(' (if you don\u2019t have one)');

        const step2 = stepList.createEl('li');
        step2.appendText('Open ');
        const pairLink = step2.createEl('a', {
            text: 'Connect Obsidian',
            href: `${apiUrl}/tokens/pair-obsidian/`,
        });
        pairLink.setAttr('target', '_blank');
        step2.appendText(' and generate a setup code');

        const step3 = stepList.createEl('li');
        step3.appendText('Enter the code below and click Connect');

        this.renderPairingSetting(containerEl, apiUrl);
    }

    /**
     * The setup-code field + Connect button (shared by the disconnected and
     * reconnect states). Exchanges the code for a fresh per-device token
     * family via POST /api/v1/auth/pair/.
     */
    private renderPairingSetting(containerEl: HTMLElement, apiUrl: string): void {
        let code = '';
        new Setting(containerEl)
            .setName('Setup code')
            .setDesc('One-time code from the Connect Obsidian page \u2014 expires in 5 minutes')
            .addText(text => {
                text
                    .setPlaceholder('XXXX-XXXX')
                    .onChange((value) => {
                        code = value.trim();
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Connect')
                    .setCta()
                    .onClick(async () => {
                        if (!code) {
                            new Notice('Enter the setup code from your Pensio settings page');
                            return;
                        }
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Connecting...');

                            const deviceId = await this.plugin.ensureDeviceId();
                            const deviceName = `Obsidian \u2014 ${this.app.vault.getName()}`;
                            const result = await this.plugin.apiClient.pair(code, deviceId, deviceName);
                            await this.plugin.setTokens(result.access, result.refresh);

                            const verified = await this.plugin.verifyAccountBeforeSync();
                            const account = this.plugin.accountGuard.getAccount();
                            if (verified && account) {
                                new Notice(`Connected as ${account.email}`);
                            } else {
                                new Notice('Connected \u2014 verifying account on first sync');
                            }
                            this.display();
                        } catch (error) {
                            new Notice(`Pairing failed: ${errorMessage(error)}`);
                            console.error('Pairing failed:', error);
                            button.setDisabled(false);
                            button.setButtonText('Connect');
                        }
                    });
            });
    }

    /**
     * Render the test connection button (shared between disconnected and unverified states).
     */
    private renderTestButton(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc('Verify your tokens and account identity')
            .addButton(button => {
                button
                    .setButtonText('Test connection')
                    .setCta()
                    .onClick(async () => {
                        if (!this.plugin.getAccessToken() || !this.plugin.getRefreshToken()) {
                            new Notice('Please paste both tokens above first');
                            return;
                        }
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Testing...');

                            const verified = await this.plugin.verifyAccountBeforeSync();
                            if (!verified) {
                                new Notice('Connection failed: could not verify account');
                                button.setButtonText('Failed');
                                return;
                            }

                            const status = await this.plugin.apiClient.getSyncStatus();
                            const acct = this.plugin.accountGuard.getAccount();
                            const acctInfo = acct ? ` (${acct.email})` : '';
                            new Notice(`Connected${acctInfo}! ${status.total_entries} entries on server`);
                            button.setButtonText('Connected \u2713');

                            // Refresh to show connected state
                            window.setTimeout(() => this.display(), 1500);
                        } catch (error) {
                            new Notice(`Connection failed: ${errorMessage(error)}`);
                            button.setButtonText('Failed');
                            console.error('Connection test failed:', error);
                        } finally {
                            window.setTimeout(() => {
                                button.setDisabled(false);
                                button.setButtonText('Test connection');
                            }, 3000);
                        }
                    });
            });
    }
}
