/**
 * The human consent gate. Build plan §14, §17.
 *
 * `make_referral.execute()` returns a Promise that does not resolve on its own. It resolves when a
 * person acts. In between, the agent's tool call is genuinely pending — not polled, not faked with a
 * timeout — and that is the whole mechanism this product is built around.
 *
 * **What this gate is for, stated precisely, because the obvious answer is wrong.** It is not "ask
 * permission". The judged environment already safety-reviews every tool invocation and confirms
 * consequential actions, so a panel whose only job is to ask is the *second* dialog a person sees
 * and adds nothing. What a host-level dialog structurally cannot do is show the person the payload
 * and let them **change it**. It can approve or refuse an opaque call; it cannot offer to correct
 * the phone number inside it. Editing is the differentiator (§2.2), and everything in this file
 * exists to make editing safe.
 *
 * **Single settlement.** Five events race for one Promise: Send, Cancel, the agent's AbortSignal,
 * the lease lapsing, and a provider failure. Exactly one may win. The `settled` flag here is the
 * only guard, and it is checked before every terminal path rather than at the call sites, because a
 * guard that each of five call sites is expected to remember is a guard that will be forgotten at
 * midnight.
 */

import { mintId } from '@threshold/domain';
import type {
  ErrorCode,
  Instant,
  PlanPartRole,
  ProviderId,
  ReferralFieldName,
} from '@threshold/contracts';

/** The four fields, and nothing else. There is no notes field; a referral is a structured act. */
export type ReferralDraft = {
  person_name: string;
  contact_method: 'phone' | 'email';
  contact_value: string;
  preferred_contact_window: 'now' | 'morning' | 'afternoon' | 'evening';
};

export const REFERRAL_FIELDS: readonly ReferralFieldName[] = [
  'person_name',
  'contact_method',
  'contact_value',
  'preferred_contact_window',
];

/** §17. Where each value came from, tracked so the printable plan can say. */
export type FieldSource = 'agent_proposed' | 'human_edited' | 'human_entered';

export type SubmitFailure = {
  code: ErrorCode;
  message: string;
  /**
   * Whether the panel should close.
   *
   * A lapsed lease is fatal: there is nothing left to refer against and Send must not be offered
   * again. A provider that did not answer is not: the person can try again, and closing the panel
   * would throw away the values they just checked.
   */
  fatal: boolean;
};

export type SubmitResult =
  | {
      ok: true;
      referral_id: string;
      next_step?: 'provider_will_call' | 'provider_will_email' | 'arrive_at_stated_time';
    }
  | { ok: false; failure: SubmitFailure };

export type ConsentOutcome =
  | {
      kind: 'sent';
      referral_id: string;
      fields_sent: readonly ReferralFieldName[];
      human_edited: readonly ReferralFieldName[];
      next_step?: 'provider_will_call' | 'provider_will_email' | 'arrive_at_stated_time';
    }
  | { kind: 'cancelled' }
  | { kind: 'aborted' }
  | { kind: 'expired' }
  | { kind: 'failed'; code: ErrorCode; message: string };

/** What the panel renders. Everything here comes from the hub, never from provider tool output. */
export type ConsentRequest = {
  id: string;
  hold_id: string;
  provider_id: ProviderId;
  /** From the registry. A provider does not get to name itself in a consent dialog. */
  providerName: string;
  providerOrigin: string;
  resource_id: string;
  role: PlanPartRole;
  window: { from: Instant; to: Instant };
  /** From trusted static configuration (§9.5). A retention promise is a legal statement. */
  retention: string;
  /** The provider's clock, not ours. The countdown is a rendering of this. */
  expiresAtEpochMs: number;
  /** What the agent proposed. Kept so provenance can distinguish edited from accepted. */
  proposed: ReferralDraft;
  /** The other parts of the plan, for context. No identifying data goes to any of them. */
  planContext: ReadonlyArray<{ role: PlanPartRole; providerName: string; resource_id: string }>;
};

export type ConsentPhase = 'editing' | 'sending' | 'settled';

export type ConsentView = {
  request: ConsentRequest;
  draft: ReferralDraft;
  phase: ConsentPhase;
  /** Field-level validation messages, keyed by field. Rendered beside the input, per §18. */
  fieldErrors: Partial<Record<keyof ReferralDraft, string>>;
  /** A failed submission that did not close the panel. */
  submitError?: string;
  provenance: Record<keyof ReferralDraft, FieldSource>;
};

type Pending = {
  request: ConsentRequest;
  draft: ReferralDraft;
  phase: ConsentPhase;
  settled: boolean;
  settle: (outcome: ConsentOutcome) => void;
  submit: (draft: ReferralDraft, edited: readonly ReferralFieldName[]) => Promise<SubmitResult>;
  fieldErrors: Partial<Record<keyof ReferralDraft, string>>;
  submitError?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
};

type ViewListener = (view: ConsentView | null) => void;

/**
 * Validation of the edited payload.
 *
 * Runs on Send, against the same bounds the provider contract states, so a person cannot be told
 * their referral was sent and then have it rejected at the far end for a reason nobody surfaced.
 * Deliberately permissive about *format* — a phone number has more shapes than a regex knows — and
 * strict about presence and length, which is what the contract actually requires.
 */
export function validateDraft(draft: ReferralDraft): Partial<Record<keyof ReferralDraft, string>> {
  const errors: Partial<Record<keyof ReferralDraft, string>> = {};
  const name = draft.person_name.trim();
  if (name.length < 1) errors.person_name = 'A name is needed so the organisation knows who to expect.';
  else if (name.length > 80) errors.person_name = 'That name is longer than the referral form accepts.';

  const value = draft.contact_value.trim();
  if (value.length < 3) {
    errors.contact_value =
      draft.contact_method === 'phone' ? 'A phone number is needed.' : 'An email address is needed.';
  } else if (value.length > 120) {
    errors.contact_value = 'That is longer than the referral form accepts.';
  } else if (draft.contact_method === 'email' && !value.includes('@')) {
    errors.contact_value = 'That does not look like an email address.';
  }
  return errors;
}

/**
 * Which fields the person changed from what the agent proposed.
 *
 * Compared trimmed, so adding a trailing space is not reported to the agent as a correction. The
 * agent needs this list for a real reason: if it proposed a phone number and the person fixed it,
 * the agent is now holding a stale value and must not repeat it back as fact.
 */
export function editedFields(proposed: ReferralDraft, draft: ReferralDraft): ReferralFieldName[] {
  return REFERRAL_FIELDS.filter((f) => String(proposed[f]).trim() !== String(draft[f]).trim());
}

export class ConsentController {
  private pending: Pending | null = null;
  private readonly listeners = new Set<ViewListener>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }

  view(): ConsentView | null {
    if (!this.pending) return null;
    const p = this.pending;
    return {
      request: p.request,
      draft: p.draft,
      phase: p.phase,
      fieldErrors: p.fieldErrors,
      ...(p.submitError !== undefined ? { submitError: p.submitError } : {}),
      provenance: provenanceOf(p.request.proposed, p.draft),
    };
  }

  isPending(): boolean {
    return this.pending !== null && !this.pending.settled;
  }

  pendingHoldId(): string | undefined {
    return this.pending?.request.hold_id;
  }

  private emit(): void {
    const view = this.view();
    for (const l of this.listeners) l(view);
  }

  /**
   * Open the gate and return the Promise the agent is waiting on.
   *
   * The lease expiry is armed here as a real timer against the *provider's* absolute expiry. The UI
   * countdown is a rendering; this is the thing that actually stops a referral going out against a
   * lease that lapsed while somebody was reading. The provider re-checks it server-side as well
   * (§14.5), because a browser clock is not a fact.
   */
  open(
    input: Omit<ConsentRequest, 'id'> & {
      submit: (draft: ReferralDraft, edited: readonly ReferralFieldName[]) => Promise<SubmitResult>;
      signal?: AbortSignal;
    },
  ): Promise<ConsentOutcome> {
    const { submit, signal, ...rest } = input;
    const request: ConsentRequest = { ...rest, id: mintId('consent') };

    return new Promise<ConsentOutcome>((resolve) => {
      const pending: Pending = {
        request,
        draft: { ...request.proposed },
        phase: 'editing',
        settled: false,
        settle: resolve,
        submit,
        fieldErrors: {},
      };
      this.pending = pending;

      const msLeft = request.expiresAtEpochMs - this.now();
      if (msLeft <= 0) {
        this.finish({ kind: 'expired' });
        return;
      }
      pending.expiryTimer = setTimeout(() => this.expire(), msLeft);

      if (signal) {
        if (signal.aborted) {
          this.finish({ kind: 'aborted' });
          return;
        }
        const onAbort = () => this.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      this.emit();
    });
  }

  /** A person typing. Never validated on every keystroke: that scolds while someone is still typing. */
  edit<K extends keyof ReferralDraft>(field: K, value: ReferralDraft[K]): void {
    const p = this.pending;
    if (!p || p.settled || p.phase !== 'editing') return;
    p.draft = { ...p.draft, [field]: value };
    // Clear only this field's error. Clearing all of them would hide a problem the person has not
    // touched yet and then surprise them on Send.
    if (p.fieldErrors[field]) {
      const { [field]: _removed, ...rest } = p.fieldErrors;
      p.fieldErrors = rest;
    }
    p.submitError = undefined;
    this.emit();
  }

  /**
   * Send.
   *
   * Validate, then hand the payload to the submit function, which is where the provider call lives.
   * The panel stays open and disabled during the call: a person who has just pressed Send on their
   * mother's phone number should see what is happening, not a closed dialog and a hope.
   */
  async send(): Promise<void> {
    const p = this.pending;
    if (!p || p.settled || p.phase !== 'editing') return;

    const trimmed: ReferralDraft = {
      ...p.draft,
      person_name: p.draft.person_name.trim(),
      contact_value: p.draft.contact_value.trim(),
    };
    const errors = validateDraft(trimmed);
    if (Object.keys(errors).length > 0) {
      p.fieldErrors = errors;
      this.emit();
      return;
    }

    if (p.request.expiresAtEpochMs <= this.now()) {
      this.expire();
      return;
    }

    p.draft = trimmed;
    p.phase = 'sending';
    p.submitError = undefined;
    this.emit();

    const edited = editedFields(p.request.proposed, trimmed);
    const result = await p.submit(trimmed, edited);

    // The panel may have been settled by an abort or an expiry while the call was in flight. First
    // terminal event wins; a late success does not resurrect it.
    if (p.settled) return;

    if (result.ok) {
      this.finish({
        kind: 'sent',
        referral_id: result.referral_id,
        fields_sent: REFERRAL_FIELDS,
        human_edited: edited,
        ...(result.next_step !== undefined ? { next_step: result.next_step } : {}),
      });
      return;
    }

    if (result.failure.fatal) {
      this.finish({ kind: 'failed', code: result.failure.code, message: result.failure.message });
      return;
    }

    p.phase = 'editing';
    p.submitError = result.failure.message;
    this.emit();
  }

  /**
   * Is a terminal event allowed to win right now?
   *
   * No, once the payload is in flight. This is the one exception to "first event wins", and it is
   * there because the alternative is a lie: a cancel arriving while `accept_referral` is on the wire
   * cannot un-send it, so settling as cancelled would tell a person nothing was sent when something
   * was. Once Send has been pressed, the submission's own outcome is the truth, and the panel waits
   * for it. The Cancel button is disabled during that window, so this guard is for the two events a
   * person does not control: the agent's abort and the expiry timer.
   *
   * Nothing is lost by waiting. An expiry mid-flight is re-checked by the provider server-side and
   * comes back as HOLD_EXPIRED (§14.5), which settles the panel with the same verdict — arrived at
   * from what actually happened rather than from what this browser's clock guessed.
   */
  private canSettleNow(): boolean {
    return this.pending !== null && !this.pending.settled && this.pending.phase !== 'sending';
  }

  /** The person decided not to. The hold stays, unless they release it separately. */
  cancel(): void {
    if (!this.canSettleNow()) return;
    this.finish({ kind: 'cancelled' });
  }

  /** The agent cancelled its own call. §14.4: close, clear the draft, send nothing. */
  abort(): void {
    if (!this.canSettleNow()) return;
    this.finish({ kind: 'aborted' });
  }

  /** The lease lapsed while the panel was open. §14.5: Send is never offered again. */
  expire(): void {
    if (!this.canSettleNow()) return;
    this.finish({ kind: 'expired' });
  }

  /**
   * Settle exactly once, and clear the draft.
   *
   * The identifying values are dropped here on every path, including the successful one. The hub
   * keeps which field *names* were sent, and nothing else: after this returns there is no copy of a
   * person's phone number anywhere in the coordinating page (§16.2).
   */
  private finish(outcome: ConsentOutcome): void {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    p.phase = 'settled';
    if (p.expiryTimer) clearTimeout(p.expiryTimer);
    p.detachAbort?.();
    p.draft = emptyDraft();
    this.pending = null;
    this.emit();
    p.settle(outcome);
  }
}

function emptyDraft(): ReferralDraft {
  return {
    person_name: '',
    contact_method: 'phone',
    contact_value: '',
    preferred_contact_window: 'now',
  };
}

/** §17. `human_entered` is distinct from `human_edited`: the agent proposed nothing to change. */
function provenanceOf(
  proposed: ReferralDraft,
  draft: ReferralDraft,
): Record<keyof ReferralDraft, FieldSource> {
  const source = (field: keyof ReferralDraft): FieldSource => {
    const before = String(proposed[field] ?? '').trim();
    const after = String(draft[field] ?? '').trim();
    if (before === after) return 'agent_proposed';
    return before.length === 0 ? 'human_entered' : 'human_edited';
  };
  return {
    person_name: source('person_name'),
    contact_method: source('contact_method'),
    contact_value: source('contact_value'),
    preferred_contact_window: source('preferred_contact_window'),
  };
}
