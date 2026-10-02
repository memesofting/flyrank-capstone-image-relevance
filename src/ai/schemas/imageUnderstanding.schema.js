/**
 * The canonical vision output schema.
 *
 * Requirement 1 of the capstone is that a provider response is never trusted
 * before it has been validated here. That holds even though the Gemini request
 * already pins the output with `responseSchema` and an `enum` for `subject`:
 * the provider's guarantee is a convenience, and requirement 1 is this
 * project's to prove, not the provider's to satisfy. A local provider, a
 * future model, or a provider bug must not be able to write a bad row.
 *
 * Strictness is deliberate. `attributes` is `min(1)` because an empty attribute
 * list makes the guard's rule 5 ("expected attribute present / absent")
 * unevaluable, and a guard that cannot evaluate its own rules is not a guard.
 */

import { z } from 'zod';

/**
 * Subject vocabulary offered to the model.
 *
 * These are the corpus's species-level categories. Phase 3's guard has to tell
 * a fox from a wolf, and it compares `subject` — so `subject` needs a closed
 * set. `category` is deliberately NOT closed: a live call returned
 * "wildlife" for a fox image, which is more informative than the brief's
 * "animal" example, and pinning it would throw away real signal.
 *
 * This is the project's own taxonomy, not the corpus manifest's ground truth.
 * The manifest category comes from the photographer's written description;
 * asking a model to choose from a list is not the same as telling it the
 * answer, and Phase 4 measures against the manifest, not against this list.
 */
export const SUBJECT_VOCABULARY = Object.freeze([
  'bear',
  'deer',
  'dog',
  'fox',
  'wolf',
  'other',
]);

export const imageUnderstandingSchema = z
  .object({
    subject: z
      .string()
      .trim()
      // The controlled vocabulary is enforced in three places — this prompt,
      // Gemini's responseSchema enum, and here — because each can fail
      // independently. The prompt is advisory and the wire enum only binds
      // providers that honour responseSchema (Ollama does not). This is the
      // trust boundary, so it is the one that has to be authoritative: with the
      // enum absent here, classifyVisionOutput({ subject: 'dragon', ... })
      // returned VALID, and the Ollama path would persist a made-up subject as a
      // trusted classification. Derived from SUBJECT_VOCABULARY so the three
      // copies cannot drift apart.
      .min(1, 'subject must not be empty')
      .refine(
        (value) => SUBJECT_VOCABULARY.includes(value),
        {
          message: `subject must be one of: ${SUBJECT_VOCABULARY.join(', ')}`,
        },
      ),

    category: z
      .string()
      .trim()
      .min(1, 'category must not be empty')
      .max(120, 'category must be 120 characters or fewer'),

    attributes: z
      .array(
        z
          .string()
          .trim()
          .min(1, 'attribute must not be empty')
          .max(120, 'attribute must be 120 characters or fewer'),
      )
      .min(1, 'attributes must contain at least one entry')
      .max(20, 'attributes must contain 20 entries or fewer'),

    caption: z
      .string()
      .trim()
      .min(1, 'caption must not be empty')
      .max(1_000, 'caption must be 1000 characters or fewer'),

    confidence: z
      .number()
      .finite('confidence must be a finite number')
      .min(0, 'confidence must be between 0 and 1')
      .max(1, 'confidence must be between 0 and 1'),
  })
  // Rejects unexpected keys instead of dropping them. An extra field means the
  // provider's contract moved, and that is worth seeing rather than absorbing.
  .strict();

/**
 * Structured-output schema sent to Gemini's `responseSchema`.
 *
 * Kept separate from the Zod schema on purpose: this one is a dialect subset
 * with no `.trim()`, no custom messages, and no `.max()`, because the Gemini
 * API rejects those. Duplicating a few constraints in a compatible dialect is
 * better than pretending one schema can serve both the wire format and local
 * validation.
 *
 * The `enum` is the second of two vocabularies enforcements; the prompt is the
 * first, and this Zod schema the last.
 */
export const geminiResponseSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string', enum: [...SUBJECT_VOCABULARY] },
    category: { type: 'string' },
    attributes: { type: 'array', items: { type: 'string' } },
    caption: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['subject', 'category', 'attributes', 'caption', 'confidence'],
  propertyOrdering: ['subject', 'category', 'attributes', 'caption', 'confidence'],
};

/**
 * Validate a provider's decoded response.
 *
 * @param {unknown} output
 * @returns {{ success: true, data: z.infer<typeof imageUnderstandingSchema> }
 *          | { success: false, issues: { path: string, message: string }[] }}
 */
export function validateImageUnderstanding(output) {
  const result = imageUnderstandingSchema.safeParse(output);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}