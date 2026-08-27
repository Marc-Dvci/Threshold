/**
 * What the boundary refused, and why there is nowhere left to hide an instruction. §11.4, §46.
 *
 * Two halves, and the second is the one that matters.
 *
 * The first half is the behavioural one: a payload was rejected, here is the rule that rejected it
 * and the field it was in. Note what is absent. The rejected string is not shown, and there is no
 * code path by which it could be: `SearchSession.rejections` has nowhere to put a value. A panel
 * that displayed a provider's malicious string in order to prove it had been blocked would have put
 * the string on the page, which is the thing being prevented.
 *
 * The second half is structural and is on screen whether or not anything was rejected. "We showed an
 * attack failing" is a demonstration of one attack somebody thought of. "No field of that kind
 * exists" is a property of the contracts, and it is the claim worth making. The counts here come
 * from the compiled registry, so they cannot drift from what the build actually enforces.
 */

import { PROVIDER_OUTPUT_SCHEMAS, compiledContracts } from '@threshold/contracts';

import { displayNameFor } from '../broker/registry';
import type { SearchSession } from '../session/session';

export function SecurityPanel({ session }: { session: SearchSession | undefined }) {
  const rejections = session?.rejections ?? [];
  const contractCount = compiledContracts().length;
  const providerContracts = Object.keys(PROVIDER_OUTPUT_SCHEMAS);

  return (
    <section aria-labelledby="sec-h" className="panel security-panel">
      <h2 id="sec-h">The boundary</h2>

      {rejections.length > 0 ? (
        <>
          <p className="verdict bad">
            {rejections.length === 1
              ? 'One organisation’s response was refused.'
              : `${rejections.length} organisations’ responses were refused.`}
          </p>
          <ul className="rejections">
            {rejections.map((r) => (
              <li key={`${r.provider_id}:${r.rule}`}>
                <strong>{displayNameFor(r.provider_id)}</strong>: response rejected —{' '}
                <span className="rule">{r.rule}</span>
                {r.path && (
                  <>
                    {' '}
                    at <code>{r.path}</code>
                  </>
                )}
                .
                <br />
                <span className="note">
                  The whole payload was discarded. Nothing from it reached your assistant, and the
                  rejected content is not printed here or anywhere else.
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="note">
          Nothing has been refused in this session. Everything below is true regardless.
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>Contracts compiled and enforced</dt>
          <dd>{contractCount}</dd>
        </div>
        <div>
          <dt>Of those, describing data written outside this system</dt>
          <dd>{providerContracts.length}</dd>
        </div>
        <div>
          <dt>Unconstrained string fields in those {providerContracts.length}</dt>
          <dd className="ok">none</dd>
        </div>
      </dl>

      <p className="note">
        Every field an organisation can return is an enum, a boolean, an integer, or a string under a
        pattern. An instruction to a model does not fit in <code>^[A-Z]&#123;1,3&#125;[0-9]&#123;1,4&#125;$</code>, and
        it does not fit in an enum. The failure path is the same: an organisation reports a code, not
        a sentence, so this page owns every message you read.
      </p>
      <p className="note">
        This is not a claim that prompt injection is impossible. It is a claim that this page does not
        carry provider-authored text into your assistant’s context, and it is checked by a test that
        walks all {providerContracts.length} contracts rather than by trying attacks somebody thought
        of.
      </p>
      <p className="note">
        <strong>What it does not solve:</strong> an organisation can return a well-formed lie. A bed
        that claims a hoist it does not have passes every control here, because the payload is
        correct. Nothing in a browser can attest that. Claims are labelled by where they came from,
        and that is the whole of the available defence.
      </p>
    </section>
  );
}
