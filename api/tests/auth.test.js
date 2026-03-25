import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionToken, verifySessionToken } from '../auth.js';

const SECRET = 'test-secret';

test('creates and verifies participant session token', () => {
  const token = createSessionToken(
    { uid: 'user-123' },
    { secret: SECRET, ttlSeconds: 600 }
  );
  const claims = verifySessionToken(token, {
    secret: SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  assert.equal(claims.uid, 'user-123');
  assert.equal(claims.role, 'PARTICIPANT');
});

test('preserves presenter role and site claims', () => {
  const token = createSessionToken(
    { uid: 'user-456', role: 'presenter', siteId: 'e1' },
    { secret: SECRET, ttlSeconds: 600 }
  );
  const claims = verifySessionToken(token, {
    secret: SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  assert.equal(claims.uid, 'user-456');
  assert.equal(claims.role, 'PRESENTER');
  assert.equal(claims.siteId, 'E1');
});

test('preserves admin role and license claims', () => {
  const token = createSessionToken(
    { uid: 'admin-1', role: 'admin', licenseId: 'lic-22', orgId: 'org-7' },
    { secret: SECRET, ttlSeconds: 600 }
  );
  const claims = verifySessionToken(token, {
    secret: SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  assert.equal(claims.uid, 'admin-1');
  assert.equal(claims.role, 'ADMIN');
  assert.equal(claims.licenseId, 'LIC-22');
  assert.equal(claims.orgId, 'ORG-7');
});

test('preserves super-admin role and email claims', () => {
  const token = createSessionToken(
    {
      uid: 'sa-1',
      role: 'super_admin',
      email: 'Demetrious@HiddenGeniusProject.org',
    },
    { secret: SECRET, ttlSeconds: 600 }
  );
  const claims = verifySessionToken(token, {
    secret: SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  assert.equal(claims.uid, 'sa-1');
  assert.equal(claims.role, 'SUPER_ADMIN');
  assert.equal(claims.email, 'demetrious@hiddengeniusproject.org');
});

test('rejects tampered tokens', () => {
  const token = createSessionToken(
    { uid: 'user-789', role: 'PARTICIPANT' },
    { secret: SECRET, ttlSeconds: 600 }
  );
  const tampered = token.replace(/\.[^.]+$/, '.invalidsig');

  assert.throws(
    () => verifySessionToken(tampered, { secret: SECRET }),
    /token_invalid_signature/
  );
});

test('rejects expired tokens', () => {
  const token = createSessionToken(
    { uid: 'user-999', role: 'PARTICIPANT' },
    { secret: SECRET, ttlSeconds: 1 }
  );

  assert.throws(
    () =>
      verifySessionToken(token, {
        secret: SECRET,
        nowSeconds: Math.floor(Date.now() / 1000) + 120,
      }),
    /token_expired/
  );
});
