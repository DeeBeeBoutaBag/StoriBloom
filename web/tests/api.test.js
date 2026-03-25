import assert from 'node:assert/strict';
import test from 'node:test';

import { API_BASE, buildSseUrl, getToken, setAuthSession } from '../src/api.js';

function makeSessionStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

test.beforeEach(() => {
  globalThis.sessionStorage = makeSessionStorage();
});

test.afterEach(() => {
  delete globalThis.sessionStorage;
});

test('uses /api as default base path', () => {
  assert.equal(API_BASE, '/api');
});

test('setAuthSession stores token and role fields', () => {
  setAuthSession({
    token: 'tok-1',
    userId: 'u-1',
    role: 'PRESENTER',
    licenseId: 'LIC-1',
    siteId: 'E1',
  });
  assert.equal(getToken(), 'tok-1');
  assert.equal(sessionStorage.getItem('role'), 'PRESENTER');
  assert.equal(sessionStorage.getItem('siteId'), 'E1');
});

test('buildSseUrl appends token query safely', () => {
  setAuthSession({ token: 'abc.123' });
  assert.equal(buildSseUrl('/rooms/E1-1/events'), '/api/rooms/E1-1/events?token=abc.123');
  assert.equal(
    buildSseUrl('/presenter/events?siteId=E1'),
    '/api/presenter/events?siteId=E1&token=abc.123'
  );
});
