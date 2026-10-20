import { SettingDefinition } from 'obsidian';
import PensioPlugin from './main';
import { isThrottled, quotaSummaryLine } from './sync/quotaNotice';
import { ProcessingStatus } from './types';

/** How long a quota reading is shown before it is fetched again. */
const QUOTA_TTL_MS = 60 * 1000;

/**
 * The Account group's Emotion analysis row: the free tier analyzes a fixed
 * number of entries a day, so a freshly imported vault drains over weeks.
 * This is the durable answer to "why is nothing happening?"; the once-a-day
 * notice is the prompt, this is the reference.
 *
 * ⭐ The reading is kept here and the row draws from it, so a redraw costs no
 * request. ⛔ In 0.7.0 every redraw of the tab fetched it again, a late answer
 * could add a second Upgrade to Pro button to a reused row, and Obsidian's own
 * visibility pass undid the row's hide() (review F28). Now: at most one fetch
 * a minute, and the row is simply not drawn until there is something to say
 * (`visible`).
 *
 * Fetched fresh rather than read from the sync engine's cache: after the
 * initial import there is nothing left to push, so syncs stop calling the
 * bulk endpoint entirely and the cached reading would stay frozen at
 * import-day numbers for the whole drain. Silent on failure: a server too old
 * to report the quota, or briefly unreachable, shows nothing.
 */
export class QuotaRow {
    private status: ProcessingStatus | null = null;
    private fetchedAt = 0;
    private fetching = false;

    constructor(private readonly plugin: PensioPlugin, private readonly changed: () => void) {}

    private line(): string | null {
        return quotaSummaryLine(this.status ?? this.plugin.syncEngine.getLastProcessingStatus());
    }

    /** Fetch a reading if the last one is older than a minute. */
    refreshIfStale(): void {
        if (this.fetching || Date.now() - this.fetchedAt < QUOTA_TTL_MS) return;
        this.fetching = true;
        const before = this.line();
        void this.plugin.apiClient.getSyncStatus()
            .then((fresh) => {
                if (fresh.processing_status) this.status = fresh.processing_status;
            })
            .catch(() => {
                // Keep whatever is known.
            })
            .finally(() => {
                this.fetching = false;
                this.fetchedAt = Date.now();
                if (this.line() !== before) this.changed();
            });
    }

    definition(apiUrl: string): SettingDefinition {
        return {
            name: 'Emotion analysis',
            visible: () => this.line() !== null,
            render: (setting) => {
                const status = this.status ?? this.plugin.syncEngine.getLastProcessingStatus();
                const line = quotaSummaryLine(status);
                if (!line) return;
                if (status && isThrottled(status)) {
                    setting.setName('Analysis is rate-limited');
                    setting.setDesc(
                        `${line} Your notes are synced and safe. Free accounts analyze ` +
                        `${status.daily_limit} entries per day — Pro analyzes them all at once.`
                    );
                    setting.addButton(button => button
                        .setButtonText('Upgrade to Pro')
                        .setCta()
                        .onClick(() => {
                            window.open(`${apiUrl}/pricing/`);
                        }));
                } else {
                    setting.setDesc(line);
                }
            },
        };
    }
}
