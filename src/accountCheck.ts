import { Explanation, explainFailure, FailureContext } from './notices';

/**
 * The one check of which account this vault's tokens belong to (GET
 * /api/v1/auth/me/), shared by everything that needs it: the status card, a
 * connect, a sync that just reached Pensio, the network coming back.
 *
 * ⛔ Before 0.7.1 the card and the connect each ran their own check, keyed on
 * the refresh-token string, so one Connect sent two parallel checks, an older
 * answer could overwrite a newer one, and a check that failed was never tried
 * again by itself (review F13, F15).
 *
 * ⭐ Every set of tokens is a new generation (`reset`). A check started under
 * an older generation still finishes, but what it learned is dropped.
 */
export class AccountCheck {
    private generation = 0;
    private checkedGeneration = -1;
    private inFlight: Promise<boolean> | null = null;
    private inFlightGeneration = -1;
    /** A check is running now. */
    checking = false;
    /** The last check failed, and why. */
    problem: Explanation | null = null;

    constructor(
        /** Runs the check; reports a failure through onError. */
        private readonly verify: (onError: (error: unknown) => void) => Promise<boolean>,
        private readonly context: () => FailureContext,
        /** Something the card shows changed. */
        private readonly changed: () => void,
    ) {}

    /** New tokens, or none: what was checked no longer applies. */
    reset(): void {
        this.generation++;
        this.inFlight = null;
        this.checking = false;
        this.problem = null;
        this.changed();
    }

    /** No check has run for these tokens yet. */
    unchecked(): boolean {
        return this.checkedGeneration !== this.generation && !this.checking;
    }

    /** Check now, joining a check already running for these tokens. */
    run(): Promise<boolean> {
        if (this.inFlight && this.inFlightGeneration === this.generation) return this.inFlight;
        const generation = this.generation;
        const current = () => generation === this.generation;
        const fail = (error: unknown) => {
            if (current()) this.problem = explainFailure(error, this.context());
        };
        this.checking = true;
        this.problem = null;
        this.inFlightGeneration = generation;
        this.changed();
        this.inFlight = this.verify(fail)
            .catch((error: unknown) => {
                fail(error);
                return false;
            })
            .then((verified) => {
                if (current()) {
                    this.checking = false;
                    this.checkedGeneration = generation;
                    this.inFlight = null;
                    if (verified) this.problem = null;
                    this.changed();
                }
                return verified;
            });
        return this.inFlight;
    }
}
