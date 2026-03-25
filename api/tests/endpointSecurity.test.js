import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, '../server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

function routeSnippet(method, route) {
  const methodToken = `app.${String(method).toLowerCase()}(`;
  const quotedSingle = `'${route}'`;
  const quotedDouble = `"${route}"`;
  let routeIndex = serverSource.indexOf(quotedSingle);
  if (routeIndex < 0) routeIndex = serverSource.indexOf(quotedDouble);
  assert.ok(routeIndex >= 0, `Route not found in server.js: ${method.toUpperCase()} ${route}`);

  const startIndex = serverSource.lastIndexOf(methodToken, routeIndex);
  assert.ok(
    startIndex >= 0,
    `Route start not found in server.js: ${method.toUpperCase()} ${route}`
  );

  const snippetEnd = Math.min(serverSource.length, routeIndex + 1600);
  return serverSource.slice(startIndex, snippetEnd);
}

function assertRouteMiddleware(method, route, middlewareChain = []) {
  const snippet = routeSnippet(method, route);
  let cursor = -1;
  for (const middleware of middlewareChain) {
    const index = snippet.indexOf(middleware);
    assert.ok(
      index >= 0,
      `Expected middleware '${middleware}' on ${method.toUpperCase()} ${route}`
    );
    assert.ok(
      index > cursor,
      `Middleware order incorrect for ${method.toUpperCase()} ${route}: ${middleware}`
    );
    cursor = index;
  }
}

test('participant-sensitive room endpoints require room membership guard', () => {
  const participantRoutes = [
    ['get', '/rooms/:roomId/state'],
    ['get', '/rooms/:roomId/messages'],
    ['post', '/rooms/:roomId/messages'],
    ['get', '/rooms/:roomId/canvas'],
    ['put', '/rooms/:roomId/canvas'],
    ['get', '/rooms/:roomId/replay'],
    ['get', '/rooms/:roomId/presence'],
    ['post', '/rooms/:roomId/presence/typing'],
    ['post', '/rooms/:roomId/ask'],
    ['get', '/rooms/:roomId/draft'],
    ['post', '/rooms/:roomId/draft/edit'],
    ['post', '/rooms/:roomId/draft/generate'],
    ['post', '/rooms/:roomId/vote/ready'],
    ['get', '/rooms/:roomId/vote'],
    ['post', '/rooms/:roomId/vote/submit'],
    ['post', '/rooms/:roomId/final/ready'],
    ['get', '/rooms/:roomId/events'],
  ];

  for (const [method, route] of participantRoutes) {
    assertRouteMiddleware(method, route, ['requireAuth', 'requireRoomAccess']);
  }
});

test('facilitator-control endpoints enforce presenter scope', () => {
  const presenterRoutes = [
    ['post', '/rooms/:roomId/next'],
    ['post', '/rooms/:roomId/extend'],
    ['post', '/rooms/:roomId/redo'],
    ['post', '/rooms/:roomId/lock'],
    ['post', '/rooms/:roomId/vote/start'],
    ['post', '/rooms/:roomId/vote/close'],
    ['post', '/rooms/:roomId/final/close'],
    ['get', '/rooms/:roomId/share-links'],
    ['post', '/rooms/:roomId/share-links'],
    ['post', '/rooms/:roomId/share-links/:linkId/revoke'],
  ];

  for (const [method, route] of presenterRoutes) {
    assertRouteMiddleware(method, route, [
      'requireAuth',
      'requirePresenter',
      'requirePresenterRoomScope',
    ]);
  }
});

test('admin endpoints enforce admin role plus license scope', () => {
  const adminRoutes = [
    ['get', '/admin/console'],
    ['put', '/admin/workshop'],
    ['get', '/admin/outcomes'],
    ['get', '/admin/billing/summary'],
    ['post', '/admin/billing/run-cycle'],
    ['post', '/admin/support/tickets'],
  ];

  for (const [method, route] of adminRoutes) {
    assertRouteMiddleware(method, route, [
      'requireAuth',
      'requireAdmin',
      'requireAdminLicense',
    ]);
  }
});

test('super-admin endpoints enforce super-admin middleware', () => {
  const superAdminRoutes = [
    ['get', '/super-admin/overview'],
    ['get', '/super-admin/codes'],
    ['get', '/super-admin/audit'],
    ['get', '/super-admin/ops'],
    ['get', '/super-admin/orgs'],
    ['get', '/super-admin/licenses'],
    ['get', '/super-admin/outcomes'],
    ['get', '/super-admin/support'],
    ['post', '/super-admin/status/events'],
  ];

  for (const [method, route] of superAdminRoutes) {
    assertRouteMiddleware(method, route, ['requireAuth', 'requireSuperAdmin']);
  }
});
