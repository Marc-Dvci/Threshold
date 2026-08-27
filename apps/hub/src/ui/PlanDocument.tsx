/**
 * The printable plan. Build plan §9.6, §17, §18.
 *
 * What the carer takes away. It works with no interactive controls and prints on one page, because
 * the person this is for is going to be awake at six in the morning holding a piece of paper, not
 * scrolling a status board.
 *
 * Provenance is here rather than in the primary UI (§17): which values the assistant proposed and
 * which the person corrected. It matters after the fact — the phone number on this page is the one
 * the organisation will actually ring.
 */

import { formatInstant } from '@threshold/contracts';

import { displayNameFor, providerById } from '../broker/registry';
import type { ReferralReceipt } from '../session/session';

const NEXT_STEP_TEXT: Record<string, string> = {
  provider_will_call: 'They will call you.',
  provider_will_email: 'They will email you.',
  arrive_at_stated_time: 'Arrive at the time above.',
};

export function PlanDocument({ receipt }: { receipt: ReferralReceipt }) {
  const entry = providerById(receipt.provider_id);
  return (
    <section aria-labelledby="doc-h" className="panel plan-document">
      <h2 id="doc-h">The plan</h2>

      <p className="referred">
        Referred to <strong>{displayNameFor(receipt.provider_id)}</strong> ·{' '}
        <code>{receipt.referral_id}</code>
      </p>
      {receipt.next_step && <p className="next-step">{NEXT_STEP_TEXT[receipt.next_step]}</p>}

      <table className="plan-parts">
        <caption className="visually-hidden">Each part of the plan and who holds it.</caption>
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Organisation</th>
            <th scope="col">Reference</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {receipt.parts.map((part) => (
            <tr key={`${part.provider_id}:${part.resource_id}`}>
              <th scope="row">{part.role}</th>
              <td>{displayNameFor(part.provider_id)}</td>
              <td>
                <code>{part.resource_id}</code>
              </td>
              <td>
                {formatInstant(part.window.from)} to {formatInstant(part.window.to)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="provenance-detail">
        <summary>What was sent, and where each value came from</summary>
        <ul>
          {receipt.fields_sent.map((field) => (
            <li key={field}>
              <code>{field}</code> —{' '}
              {receipt.human_edited.includes(field)
                ? 'you corrected this before sending'
                : 'as your assistant proposed it'}
            </li>
          ))}
        </ul>
        <p className="note">
          Field names only. This page does not keep the values it sent, and never held them for
          longer than the panel was open.
        </p>
        {entry && <p className="note">{entry.displayName}: {entry.retention}</p>}
      </details>

      <p className="note">
        The other organisations in this plan received nothing identifying. Each was told only the
        typed capabilities it needed in order to answer.
      </p>
    </section>
  );
}
