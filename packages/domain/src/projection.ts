/**
 * Need-to-provider projection. Build plan §10.2, §16.1.
 *
 * A provider is told what it needs in order to answer, and nothing else. A transport service has no
 * business knowing the person needs dementia-trained staff or same-gender care, so it is not told.
 *
 * The subtle rule, and the reason this is a function rather than a spread: a capability the provider
 * does not deal in is **omitted**, never sent as `false`. Sending `false` still discloses that the
 * question was asked, and "does this person need same-gender staff: no" is information about the
 * person. Minimisation means the field is absent, not negative.
 */

import type { NeedProfile, ProviderQuery, SupportKind } from '@threshold/contracts';
import { KIND_ROLE } from '@threshold/contracts';

/** Which capabilities are meaningful for each kind of service. */
const RELEVANT_CAPABILITIES: Readonly<Record<SupportKind, readonly string[]>> = {
  respite_bed: [
    'dementia_trained',
    'wheelchair_access',
    'hoist_available',
    'same_gender_staff_available',
    'accepts_pets',
    'spoken_language',
  ],
  overnight_homecare: [
    'dementia_trained',
    'wheelchair_access',
    'hoist_available',
    'same_gender_staff_available',
    'accepts_pets',
    'spoken_language',
  ],
  // A van needs to be physically able to carry the person and to have a driver who can talk to
  // them. It does not need to know about dementia training, pets, or staff gender.
  accessible_transport: ['wheelchair_access', 'hoist_available', 'spoken_language'],
};

export type ProviderCapabilityProfile = {
  /** The kinds this provider actually offers. Used to decide relevance and to skip the call. */
  supportKinds: readonly SupportKind[];
};

/**
 * Build the query for one provider.
 *
 * Returns `null` when the provider offers nothing the need asks for, and the caller skips it
 * entirely. Not calling an organisation is stronger minimisation than calling it with an empty
 * question, and it is also less traffic against an organisation that cannot help.
 */
export function projectNeedForProvider(
  need: NeedProfile,
  provider: ProviderCapabilityProfile,
): ProviderQuery | null {
  const wanted = provider.supportKinds.filter((kind) => need.support_kinds.includes(kind));
  if (wanted.length === 0) return null;

  const relevant = new Set(wanted.flatMap((kind) => RELEVANT_CAPABILITIES[kind]));

  const required: Record<string, unknown> = {};

  // Only *positive* requirements are sent. A `false` requirement is not a requirement, it is a
  // disclosure, and it narrows nothing on the provider's side.
  if (need.dementia_trained && relevant.has('dementia_trained')) {
    required['dementia_trained'] = true;
  }
  if (need.wheelchair_access && relevant.has('wheelchair_access')) {
    required['wheelchair_access'] = true;
  }
  if (need.hoist_required && relevant.has('hoist_available')) {
    required['hoist_available'] = true;
  }
  if (need.same_gender_staff_required && relevant.has('same_gender_staff_available')) {
    required['same_gender_staff_available'] = true;
  }
  if (need.accepts_pets_required && relevant.has('accepts_pets')) {
    required['accepts_pets'] = true;
  }
  if (relevant.has('spoken_language')) {
    // Language is sent even when it is the default, because a service that cannot speak to the
    // person cannot serve them, and omitting it would return offers that are not usable.
    required['spoken_language'] = need.spoken_language;
  }

  return {
    service_area: need.service_area,
    support_kinds: wanted,
    required_capabilities: required as ProviderQuery['required_capabilities'],
    starts_within_hours: need.starts_within_hours,
    min_duration_hours: need.duration_hours,
  };
}

/** Which roles a need is asking to fill. Drives the missing-role reporting in `find_support`. */
export function rolesRequested(need: NeedProfile): readonly ('placement' | 'transport' | 'cover')[] {
  return [...new Set(need.support_kinds.map((kind) => KIND_ROLE[kind]))];
}

/**
 * Field names that crossed to a given provider, for the boundary log.
 *
 * The log records *names*, never values (§16.4). "Threshold sent four typed fields to Northgate
 * Transport" is a true and useful thing for a person to read; printing the values would make the log
 * itself a disclosure.
 */
export function projectedFieldNames(query: ProviderQuery): readonly string[] {
  return [
    'service_area',
    'support_kinds',
    ...Object.keys(query.required_capabilities ?? {}),
    ...(query.starts_within_hours !== undefined ? ['starts_within_hours'] : []),
    ...(query.min_duration_hours !== undefined ? ['min_duration_hours'] : []),
  ];
}
