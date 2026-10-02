/**
 * The image-understanding prompt.
 *
 * Written to feed the Phase 3 guard, per docs/ONE-PAGE-DESIGN.md: the guard
 * compares `subject` and `attributes`, so the prompt asks for exactly those and
 * nothing the guard would have to interpret or discard.
 *
 * Two rules shape the wording:
 *
 *  1. No speculation. Every instruction pushes toward describing only what is
 *     visible, because a hallucinated attribute becomes a guard input that
 *     silently reads as evidence.
 *
 *  2. `subject` is a closed set. The guard must separate fox from wolf, and a
 *     free-form subject ("red fox", "Vulpes vulpes", "fox") compares unequal to
 *     itself across images. `other` is offered explicitly and the model is told
 *     to prefer it over a guess — a low-confidence classification is visible
 *     and reviewable, whereas a wrong confident one is trusted.
 */

/**
 * @param {object} [options]
 * @param {readonly string[]} [options.vocabulary]
 * @returns {string}
 */
export function buildImageUnderstandingPrompt({
  vocabulary = [
    'bear',
    'deer',
    'dog',
    'fox',
    'wolf',
    'other',
  ],
} = {}) {
  const allowed = vocabulary.map((option) => `"${option}"`).join(', ');

  return [
    'You are labelling photographs for an image library. Describe only what is',
    'actually visible in this image.',
    '',
    'Rules:',
    '- Do not speculate about anything you cannot see. Do not infer the species,',
    '  breed, behaviour, location, or season from context or plausibility.',
    '- If the subject is unclear, ambiguous, partly hidden, or absent, say so',
    '  and lower your confidence. Do not guess to be helpful.',
    '- Do not mention filenames, watermarks, or anything about how the image',
    '  was provided to you.',
    '- Report only what is in the image, not what it might be used for.',
    '',
    'Return a single JSON object and nothing else. No prose, no code fences, no',
    'explanation before or after the JSON.',
    '',
    'Fields:',
    '- "subject": the primary subject, as one of exactly these strings: ' + allowed + '.',
    '  Choose "other" when none of them fits. Choose the closest fit only when',
    '  the subject is genuinely identifiable.',
    '- "category": a broad category in your own words, such as "wildlife",',
    '  "animal", "plant", "landscape", "person", "object".',
    '- "attributes": 3 to 8 short factual visual attributes of the primary',
    '  subject and its immediate surroundings, each a few words. Do not repeat',
    '  the subject. Do not include the species name as an attribute.',
    '- "caption": one factual sentence describing the image.',
    '- "confidence": a number between 0 and 1 reflecting how sure you are that',
    '  the subject is correctly identified and clearly visible. Use a high value',
    '  only when the subject is unambiguous.',
    '',
    'Example of the required shape:',
    '{"subject":"fox","category":"wildlife","attributes":["orange fur","bushy tail","forest floor"],',
    '"caption":"A red fox standing on a forest floor.","confidence":0.94}',
  ].join('\n');
}