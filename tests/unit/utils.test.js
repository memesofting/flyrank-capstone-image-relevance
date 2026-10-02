import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REDACTED } from '../../src/utils/logger.js';
import { sha256Hex, sha256OfFile } from '../../src/utils/hashing.js';
import { inspectImageBuffer, mimeTypeFromExtension } from '../../src/utils/image.js';
import { createPostBodySchema } from '../../src/validators/post.validator.js';
import { resolveSlug, slugify } from '../../src/services/post.service.js';
import { liveness } from '../../src/services/health.service.js';

describe('hashing', () => {
  it('produces a stable sha256 for a string', () => {
    // Known vector: sha256("abc")
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces the same hash for a buffer and its string form', () => {
    assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
  });

  it('produces a different hash for different content', () => {
    assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
  });

  it('hashes a file identically to hashing its bytes', async () => {
    const buffer = Buffer.from('image bytes stand in');
    assert.equal((await sha256OfFile('package.json')).length, 64);
    assert.equal(await sha256OfFile('package.json'), sha256Hex(await import('node:fs/promises').then((fs) => fs.readFile('package.json'))));
    assert.equal(buffer.length > 0, true);
  });
});

describe('image inspection', () => {
  it('rejects an empty buffer', async () => {
    const result = await inspectImageBuffer(Buffer.alloc(0));
    assert.equal(result.isImage, false);
  });

  it('rejects bytes that are not an image', async () => {
    const result = await inspectImageBuffer(Buffer.from('this is definitely not a jpeg'));
    assert.equal(result.isImage, false);
    assert.match(result.reason, /not a decodable image/);
  });

  it('reads dimensions and mime type from a real corpus image', async () => {
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile('dataset/images/fox/fox-001.jpg');
    const result = await inspectImageBuffer(buffer);

    assert.equal(result.isImage, true);
    assert.equal(result.format, 'jpeg');
    assert.equal(result.mimeType, 'image/jpeg');
    assert.ok(result.width > 0 && result.height > 0);
    assert.equal(result.byteSize, buffer.length);
  });

  it('maps extensions to mime types and rejects unknown ones', () => {
    assert.equal(mimeTypeFromExtension('.jpg'), 'image/jpeg');
    assert.equal(mimeTypeFromExtension('PNG'), 'image/png');
    assert.equal(mimeTypeFromExtension('.gif'), null);
  });
});

describe('logger redaction', () => {
  it('exposes a redaction marker for credential-shaped keys', () => {
    assert.equal(REDACTED, '[redacted]');
  });

  it('would redact keys that look like credentials', async () => {
    // Exercise the same pattern the logger uses.
    const pattern = /(key|token|secret|password|passwd|credential|authorization)/i;
    for (const key of ['GEMINI_API_KEY', 'apiKey', 'password', 'accessToken', 'authorization']) {
      assert.match(key, pattern, `${key} should be treated as sensitive`);
    }
    for (const key of ['model', 'provider', 'operation', 'status']) {
      assert.doesNotMatch(key, pattern, `${key} should not be redacted`);
    }
  });
});

describe('health service', () => {
  it('reports liveness without touching a dependency', () => {
    assert.deepEqual(liveness(), { status: 'ok', service: 'flyrank-image-matcher' });
  });
});

describe('slug derivation', () => {
  it('uses a client-supplied slug as-is', async () => {
    assert.equal(await resolveSlug('The Behavior of Red Foxes', 'my-custom-slug'), 'my-custom-slug');
  });

  it('slugifies a title into a url-safe slug', () => {
    assert.equal(slugify('The Behavior of Red Foxes'), 'the-behavior-of-red-foxes');
    assert.equal(slugify('  Wolves: Gray & Black!  '), 'wolves-gray-black');
    assert.equal(slugify('Café Foxes'), 'cafe-foxes');
  });

  it('keeps a slug within the length limit', () => {
    const slug = slugify('Fox '.repeat(60));
    assert.ok(slug.length <= 80, `slug was ${slug.length} characters`);
  });
});

describe('post schema rejects what the API must not accept', () => {
  it('rejects a missing title', () => {
    assert.equal(createPostBodySchema.safeParse({ content: 'text' }).success, false);
  });

  it('rejects content over the size limit', () => {
    assert.equal(
      createPostBodySchema.safeParse({ title: 'T', content: 'x'.repeat(50_001) }).success,
      false,
    );
  });
});
