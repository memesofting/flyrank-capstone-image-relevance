# Dataset

The corpus is small on purpose. This capstone is about whether the system can
tell a relevant image from an irrelevant one and refuse to guess — not about
corpus size. `40+` images across `4+` categories is the target and the system is
built to be correct at that scale.

## Summary

| | |
|---|---|
| Manifest entries | 61 |
| Verified, categorised images | **45** |
| Unverified (held aside) | 16 |
| Source | Unsplash, Unsplash License |
| Total size | 11,687,716 bytes (≈ 11.1 MiB) |
| Duplicate content hashes | 0 |
| Categories populated | 6 |

Target check: `45 ≥ 40` images ✓ and `6 ≥ 4` categories ✓

## Category distribution

| Category | Images |
|---|---|
| other | 11 |
| dog | 8 |
| wolf | 7 |
| deer | 7 |
| fox | 6 |
| bear | 6 |
| unverified | 16 (not part of the verified corpus) |

`fox` and `wolf` are deliberately populated as separate categories. The Phase 3
gate requires that a fox post ranks a fox image first *and* that a wolf image is
rejected by the mismatch guard with an explanation. A corpus without a
confusable wolf category could not demonstrate that gate.

`other` holds verified images whose subject does not map to a species category
(scenes, textures, landscapes). They are real, licensed images and they are
useful as negative examples.

## Where categories come from

**Never from filenames.**

`categorySource` is recorded on every entry:

- `unsplash-photo-page-description` — assigned from the human-written
  description on the Unsplash photo page, which is authored by the photographer
  alongside the upload.
- `none` — unverified entries carry no category claim at all.

This distinction is deliberate. Most of the 16 pre-existing repository images
had names like `IMG_4823.jpg` and `download (7).jpg`, which assert nothing about
content. Inferring a category from such a name would mean inventing ground truth
and then measuring precision against that invention — the evaluation set in
Phase 4 would be measuring the inference, not the system.

The vision model in Phase 2 will produce an *independent* label. Agreement
between the source description and the model's label is itself a useful signal,
and disagreement is a candidate for the `low_confidence` flag.

## Licences and provenance

All 45 verified images are from Unsplash under the
[Unsplash License](https://unsplash.com/license), which permits commercial and
non-commercial use without attribution. Attribution is recorded anyway, because
it is the correct thing to do to a photographer:

| Field | Meaning |
|---|---|
| `sourcePage` | Human-viewable Unsplash photo page |
| `sourceUrl` | Exact image URL the file was downloaded from |
| `photographer` | Photographer credited on that page |
| `license` / `licenseUrl` | Licence name and its text |

Every entry also records `fetchedBy: "scripts/fetch-corpus.js"` so a reviewer can
tell how a file reached the repository.

### Unsplash+ was excluded

Unsplash+ (Unsplash Prime) images are a paid tier with **different** terms from
the free Unsplash License. Including them would have quietly invalidated the
licence claim, so they were excluded. This is also why the manifest holds 45
verified images rather than the 70+ that were screened: 16 pre-existing files
could not be attributed at all, and the remainder that were attributable were
de-duplicated by content hash and licence.

## The 16 unverified files

The repository arrived with 34 loose images. Sixteen could not be traced to a
source, a licence, or a subject with any confidence, so they were **not
discarded and not guessed at**:

- they are preserved under `dataset/unverified/`
- they carry `category: "unverified"`, `categorySource: "none"`,
  `source: "unknown"`, `license: "unknown"`, and a `note` explaining why
- they are excluded from the 40+ image count

This is the honest outcome. A corpus that hides unverifiable files behind
plausible-looking metadata would fail the evaluation for the wrong reason.

## Reproducibility

The manifest is the source of truth, and the corpus is rebuilt from it:

```bash
npm run corpus:fetch     # download missing entries, verify existing ones
npm run corpus:verify    # integrity + provenance + licence + target checks
```

`corpus:verify` is the check that matters, and it is enforced by
`tests/unit/manifest.test.js`. It verifies, per entry:

1. the file exists and its SHA-256 matches `sha256`
2. `byteSize` matches the file on disk
3. `width`/`height` match the actual decoded image
4. no two entries share a content hash
5. every entry's path stays inside `dataset/images/` or `dataset/unverified/`
   (no path traversal)
6. every categorised entry has a `sourcePage`, `photographer`, and a licence of
   `Unsplash License`
7. the corpus meets `minImages: 40` and `minCategories: 4`
8. both `fox` and `wolf` are present, as the Phase 3 gate requires

Re-running `corpus:fetch` on a complete corpus fetches nothing: files are
matched by SHA-256, so the operation is idempotent.

## Schema

`dataset/manifest.schema.json` is a published JSON Schema, enforced at runtime by
`src/validators/manifest.validator.js` (Zod) and exercised by
`tests/unit/manifest.test.js`. The schema is the contract, the validator is the
enforcement, and the corpus checks are the measurement.

## Licence

Repository code is MIT (`LICENSE`). Images are covered by the Unsplash License
recorded per entry in `dataset/manifest.json`. Images are not relicensed by this
repository.