import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { CATEGORIES, validateManifest } from '../../src/validators/manifest.validator.js';

const manifest = JSON.parse(await readFile('dataset/manifest.json', 'utf8'));

const validEntry = {
  id: 'fox-001',
  image: 'images/fox/fox-001.jpg',
  category: 'fox',
  categorySource: 'unsplash-photo-page-description',
  sourceDescription: 'Brown fox on green grass during daytime',
  source: 'unsplash',
  sourcePage: 'https://unsplash.com/photos/BNR4sS2LA10',
  sourceUrl: 'https://images.unsplash.com/photo-1619148189616-013b06952c04?w=1280',
  photographer: 'Charles Jackson',
  license: 'Unsplash License',
  licenseUrl: 'https://unsplash.com/license',
  provenance: 'verified',
  sha256: 'a'.repeat(64),
  width: 1280,
  height: 854,
  byteSize: 186536,
};

function withEntry(overrides = {}) {
  return {
    version: 1,
    description: 'test',
    categories: ['fox', 'wolf', 'dog', 'bear'],
    target: { minImages: 40, minCategories: 4 },
    images: [{ ...validEntry, ...overrides }],
  };
}

describe('manifest schema', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest(withEntry());
    assert.equal(result.success, true, JSON.stringify(result.issues));
  });

  it('accepts the real dataset/manifest.json', () => {
    const result = validateManifest(manifest);
    assert.equal(result.success, true, JSON.stringify(result.issues));
  });

  it('rejects a category outside the declared vocabulary', () => {
    const result = validateManifest(withEntry({ category: 'foxz' }));
    assert.equal(result.success, false);
  });

  it('rejects an id that is not lowercase-hyphenated', () => {
    const result = validateManifest(withEntry({ id: 'Fox_001' }));
    assert.equal(result.success, false);
  });

  it('rejects a malformed sha256', () => {
    const result = validateManifest(withEntry({ sha256: 'not-a-hash' }));
    assert.equal(result.success, false);
  });

  it('rejects an unknown provenance value', () => {
    const result = validateManifest(withEntry({ provenance: 'probably' }));
    assert.equal(result.success, false);
  });

  it('rejects a path outside images/ and unverified/', () => {
    const result = validateManifest(withEntry({ image: '../../etc/passwd' }));
    assert.equal(result.success, false);
  });

  it('requires at least four declared categories', () => {
    const result = validateManifest({ ...withEntry(), categories: ['fox', 'wolf', 'dog'] });
    assert.equal(result.success, false);
  });

  it('allows measurements to be null before a fetch has run', () => {
    const result = validateManifest(
      withEntry({ sha256: null, width: null, height: null, byteSize: null }),
    );
    assert.equal(result.success, true, JSON.stringify(result.issues));
  });

  it('exposes the categories used for evaluation', () => {
    assert.ok(CATEGORIES.includes('fox'));
    assert.ok(CATEGORIES.includes('wolf'));
    assert.ok(CATEGORIES.includes('unverified'));
  });
});

describe('real corpus manifest contents', () => {
  it('declares at least the 40+ image and 4+ category targets', () => {
    assert.ok(manifest.target.minImages >= 40);
    assert.ok(manifest.target.minCategories >= 4);
  });

  it('meets the image target with categorised entries', () => {
    const categorised = manifest.images.filter((entry) => entry.category !== 'unverified');
    assert.ok(
      categorised.length >= manifest.target.minImages,
      `only ${categorised.length} categorised images`,
    );
  });

  it('meets the category target with populated categories', () => {
    const counts = {};
    for (const entry of manifest.images) {
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    }
    const populated = Object.entries(counts)
      .filter(([category, count]) => category !== 'unverified' && count > 0);

    assert.ok(populated.length >= manifest.target.minCategories, JSON.stringify(counts));
  });

  it('contains the categories the Phase 3 gate depends on', () => {
    const categories = new Set(manifest.images.map((entry) => entry.category));
    assert.ok(categories.has('fox'), 'a fox image is required for the fox-first gate');
    assert.ok(categories.has('wolf'), 'a wolf image is required for the guard-rejection gate');
  });

  it('uses unique ids and unique paths', () => {
    assert.equal(new Set(manifest.images.map((entry) => entry.id)).size, manifest.images.length);
    assert.equal(new Set(manifest.images.map((entry) => entry.image)).size, manifest.images.length);
  });

  it('never derives a category from a filename', () => {
    for (const entry of manifest.images) {
      assert.notEqual(entry.categorySource, 'filename', `${entry.id} used the filename`);
    }
  });

  it('records provenance and a licence for every categorised image', () => {
    for (const entry of manifest.images.filter((item) => item.category !== 'unverified')) {
      assert.equal(entry.provenance, 'verified', `${entry.id} is not verified`);
      assert.ok(entry.sourcePage, `${entry.id} has no sourcePage`);
      assert.ok(entry.photographer, `${entry.id} has no photographer`);
      assert.equal(entry.license, 'Unsplash License', `${entry.id} has a different licence`);
    }
  });

  it('records real measurements for every entry on disk', () => {
    for (const entry of manifest.images) {
      assert.match(entry.sha256 ?? '', /^[0-9a-f]{64}$/, `${entry.id} has no sha256`);
      assert.ok(entry.byteSize > 0, `${entry.id} has no byteSize`);
      assert.ok(entry.width > 0 && entry.height > 0, `${entry.id} has no dimensions`);
    }
  });

  it('holds unidentifiable pre-existing files aside rather than guessing', () => {
    const unverified = manifest.images.filter((entry) => entry.category === 'unverified');
    for (const entry of unverified) {
      assert.equal(entry.sourcePage, null, `${entry.id} should have no sourcePage`);
      assert.equal(entry.license, 'unknown', `${entry.id} should not claim a licence`);
      assert.ok(entry.note, `${entry.id} should explain why it is unverified`);
    }
  });
});
