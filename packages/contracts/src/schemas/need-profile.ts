/**
 * The need profile: the typed capability vector that replaces a narrative.
 *
 * Invariant A (build plan §34): no property here is a general-purpose `text`, `story`, `notes`,
 * `description`, `reason` or equivalent. Every property is an enum, a boolean, or a structured
 * instant.
 *
 * What this is NOT: a guarantee that the site learns nothing. The enums below reconstruct a
 * clinical picture fairly precisely, and the claim retired in §2.2 said otherwise. This is
 * narrative *minimisation*, verifiable by reading the schema, and nothing more than that.
 *
 * Every `description` is under the 150-character parameter budget Chrome documents, because the
 * agent reads these and a truncated description is a mis-selected tool.
 */

import { DURATION_HOURS, STARTS_WITHIN_HOURS } from '../vocabulary';
import {
  instantSchema,
  serviceAreaSchema,
  spokenLanguageSchema,
  supportKindSchema,
} from './common';

export const needProfileSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'service_area',
    'support_kinds',
    'starts_within_hours',
    'duration_hours',
    'deadline',
    'dementia_trained',
    'wheelchair_access',
    'hoist_required',
    'same_gender_staff_required',
    'accepts_pets_required',
    'spoken_language',
  ],
  properties: {
    service_area: {
      ...serviceAreaSchema,
      description: 'Which of the three demo service areas the person needs support in.',
    },
    support_kinds: {
      type: 'array',
      items: supportKindSchema,
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      description:
        'Which kinds of support to look for. Ask for all the kinds the plan needs, not just one.',
    },
    starts_within_hours: {
      type: 'integer',
      enum: STARTS_WITHIN_HOURS,
      description: 'How soon support must be able to start. A coarse filter, not an exact time.',
    },
    duration_hours: {
      type: 'integer',
      enum: DURATION_HOURS,
      description: 'How many hours of support are needed in total. A coarse filter.',
    },
    deadline: {
      ...instantSchema,
      description:
        'The moment the whole plan must be in place by. Day 0 is today. Used to check the plan, not to filter.',
    },
    dementia_trained: {
      type: 'boolean',
      description: 'True if staff must be dementia trained.',
    },
    wheelchair_access: {
      type: 'boolean',
      description: 'True if the person needs wheelchair access.',
    },
    hoist_required: {
      type: 'boolean',
      description:
        'True if a hoist is needed. Checked at both ends of a journey, not only at the placement.',
    },
    same_gender_staff_required: {
      type: 'boolean',
      description: 'True if the person requires same-gender care staff.',
    },
    accepts_pets_required: {
      type: 'boolean',
      description: 'True if a pet must be accommodated.',
    },
    spoken_language: {
      ...spokenLanguageSchema,
      description:
        'The language care staff must speak. This is a capability of the service, not the language of this conversation.',
    },
  },
} as const;
