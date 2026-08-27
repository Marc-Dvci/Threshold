/**
 * The consent gate, as a person sees it. Build plan §14.1, §18.
 *
 * This is the emotional and technical climax of the demo, and the thing it must do that a host
 * dialog cannot is let the person **change the payload**. Everything in the layout serves that: the
 * four values are inputs, not text; each is labelled; each carries where it came from; and the
 * primary button is disabled while anything about the request has stopped being true.
 *
 * Accessibility is load-bearing rather than decorative here, because this is the one screen where a
 * keyboard user who gets stuck cannot complete the task at all:
 *
 *  - `role="dialog"` with `aria-modal`, labelled by its own heading;
 *  - focus moves to the first field on open and is trapped until the panel settles;
 *  - errors are associated with their fields by `aria-describedby`, not by colour;
 *  - the countdown lives in a `polite` live region and is also written out in words, because a
 *    ticking `assertive` region read aloud every second is unusable;
 *  - Escape cancels, which is the same as pressing Cancel: nothing is sent.
 */

import { useEffect, useRef } from 'react';

import type { ConsentController, ConsentView, ReferralDraft } from '../consent/controller';
import { formatCountdown, useNow } from './hooks';
import { formatInstant } from '@threshold/contracts';

const WINDOW_LABELS: Record<ReferralDraft['preferred_contact_window'], string> = {
  now: 'As soon as possible',
  morning: 'In the morning',
  afternoon: 'In the afternoon',
  evening: 'In the evening',
};

const SOURCE_LABELS: Record<string, string> = {
  agent_proposed: 'proposed by your assistant',
  human_edited: 'you changed this',
  human_entered: 'you entered this',
};

export function ConsentPanel({
  view,
  controller,
}: {
  view: ConsentView;
  controller: ConsentController;
}) {
  const now = useNow();
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const expired = view.request.expiresAtEpochMs <= now;
  const busy = view.phase !== 'editing';

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [view.request.id]);

  // Focus containment. A modal a keyboard user can tab out of is a modal that has quietly stopped
  // being modal, and this is the screen where that matters most.
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        controller.cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [controller, busy]);

  const countdown = formatCountdown(view.request.expiresAtEpochMs, now);

  return (
    <div className="consent-scrim">
      <div
        className="consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-heading"
        ref={panelRef}
      >
        <h2 id="consent-heading">Review before anything identifying is sent</h2>

        <p className="consent-lede">
          Nothing about {view.draft.person_name.trim() || 'this person'} has left this page. The
          search used typed capabilities only. These four fields are the first identifying
          information to cross an origin, and they cross only when you press Send.
        </p>

        <dl className="consent-facts">
          <div>
            <dt>Going to</dt>
            <dd>
              {view.request.providerName}
              <br />
              <code>{view.request.providerOrigin}</code>
            </dd>
          </div>
          <div>
            <dt>Against</dt>
            <dd>
              <code>{view.request.resource_id}</code> · {view.request.role}
              <br />
              {formatInstant(view.request.window.from)} to {formatInstant(view.request.window.to)}
            </dd>
          </div>
          <div>
            <dt>Hold expires in</dt>
            <dd aria-live="polite">
              <span className={expired ? 'countdown expired' : 'countdown'}>{countdown}</span>
              <span className="visually-hidden">
                {expired
                  ? 'The hold has expired. Nothing can be sent.'
                  : `${countdown} remaining on this hold.`}
              </span>
            </dd>
          </div>
          <div>
            <dt>They keep it</dt>
            <dd>{view.request.retention}</dd>
          </div>
        </dl>

        {view.request.planContext.length > 0 && (
          <p className="consent-context">
            The rest of this plan —{' '}
            {view.request.planContext
              .map((p) => `${p.providerName} (${p.resource_id})`)
              .join(', ')}{' '}
            — receives none of this. Each organisation is told only what it needs.
          </p>
        )}

        <form
          className="consent-form"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.send();
          }}
        >
          <Field
            id="consent-name"
            label="Name"
            value={view.draft.person_name}
            error={view.fieldErrors.person_name}
            source={view.provenance.person_name}
            disabled={busy || expired}
            inputRef={firstFieldRef}
            onChange={(v) => controller.edit('person_name', v)}
          />

          <div className="field">
            <label htmlFor="consent-method">How they should get in touch</label>
            <select
              id="consent-method"
              value={view.draft.contact_method}
              disabled={busy || expired}
              onChange={(e) =>
                controller.edit('contact_method', e.target.value as ReferralDraft['contact_method'])
              }
            >
              <option value="phone">By phone</option>
              <option value="email">By email</option>
            </select>
            <p className="provenance">{SOURCE_LABELS[view.provenance.contact_method]}</p>
          </div>

          <Field
            id="consent-value"
            label={view.draft.contact_method === 'phone' ? 'Phone number' : 'Email address'}
            value={view.draft.contact_value}
            error={view.fieldErrors.contact_value}
            source={view.provenance.contact_value}
            disabled={busy || expired}
            inputMode={view.draft.contact_method === 'phone' ? 'tel' : 'email'}
            onChange={(v) => controller.edit('contact_value', v)}
          />

          <div className="field">
            <label htmlFor="consent-window">When</label>
            <select
              id="consent-window"
              value={view.draft.preferred_contact_window}
              disabled={busy || expired}
              onChange={(e) =>
                controller.edit(
                  'preferred_contact_window',
                  e.target.value as ReferralDraft['preferred_contact_window'],
                )
              }
            >
              {Object.entries(WINDOW_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="provenance">{SOURCE_LABELS[view.provenance.preferred_contact_window]}</p>
          </div>

          {view.submitError && (
            <p className="consent-error" role="alert">
              {view.submitError}
            </p>
          )}
          {expired && (
            <p className="consent-error" role="alert">
              The hold ran out while this was open. Nothing was sent. Search again to see whether the
              place is still free.
            </p>
          )}

          <div className="consent-actions">
            <button type="submit" className="primary" disabled={busy || expired}>
              {view.phase === 'sending' ? 'Sending…' : 'Send referral'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={view.phase === 'sending'}
              onClick={() => controller.cancel()}
            >
              Cancel
            </button>
          </div>
          <p className="consent-footnote">
            Cancelling sends nothing and keeps the hold, so you can decide again in a moment.
          </p>
        </form>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  error,
  source,
  disabled,
  inputMode,
  inputRef,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  source: string;
  disabled: boolean;
  inputMode?: 'tel' | 'email';
  inputRef?: React.RefObject<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        {...(inputMode ? { inputMode } : {})}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
      <p className="provenance">{SOURCE_LABELS[source]}</p>
    </div>
  );
}
