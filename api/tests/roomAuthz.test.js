import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectTenantTargetsFromRequest,
  evaluateRoomAccess,
  evaluateTenantHierarchy,
} from '../authz.js';

test('participant must be seat member', () => {
  const out = evaluateRoomAccess({
    role: 'participant',
    tokenSiteId: 'E1',
    roomSiteId: 'E1',
    isSeatMember: false,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'room_membership_required');
});

test('participant cannot cross site boundary', () => {
  const out = evaluateRoomAccess({
    role: 'participant',
    tokenSiteId: 'E2',
    roomSiteId: 'E1',
    isSeatMember: true,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'room_forbidden');
});

test('presenter requires same site', () => {
  const allowed = evaluateRoomAccess({
    role: 'PRESENTER',
    tokenSiteId: 'E1',
    roomSiteId: 'E1',
  });
  assert.equal(allowed.allowed, true);

  const denied = evaluateRoomAccess({
    role: 'PRESENTER',
    tokenSiteId: 'E1',
    roomSiteId: 'E2',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'room_forbidden');
});

test('admin requires external scope approval', () => {
  const denied = evaluateRoomAccess({
    role: 'admin',
    tokenSiteId: 'E1',
    roomSiteId: 'E2',
    adminAllowed: false,
  });
  assert.equal(denied.allowed, false);

  const allowed = evaluateRoomAccess({
    role: 'admin',
    tokenSiteId: 'E1',
    roomSiteId: 'E2',
    adminAllowed: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'admin_scope_match');
});

test('super admin bypasses room checks', () => {
  const out = evaluateRoomAccess({
    role: 'super_admin',
    tokenSiteId: '',
    roomSiteId: 'X1',
    isSeatMember: false,
  });
  assert.equal(out.allowed, true);
  assert.equal(out.reason, 'super_admin');
});

test('tenant hierarchy rejects org mismatch', () => {
  const out = evaluateTenantHierarchy({
    role: 'PARTICIPANT',
    userOrgId: 'ORG-A',
    userLicenseId: 'LIC-1',
    userSiteId: 'E1',
    targetOrgId: 'ORG-B',
    targetLicenseId: 'LIC-1',
    targetSiteId: 'E1',
    licensedSiteIds: ['E1'],
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'tenant_org_mismatch');
});

test('tenant hierarchy rejects license mismatch', () => {
  const out = evaluateTenantHierarchy({
    role: 'PARTICIPANT',
    userOrgId: 'ORG-A',
    userLicenseId: 'LIC-1',
    userSiteId: 'E1',
    targetOrgId: 'ORG-A',
    targetLicenseId: 'LIC-2',
    targetSiteId: 'E1',
    licensedSiteIds: ['E1'],
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'tenant_license_mismatch');
});

test('tenant hierarchy rejects site outside licensed set', () => {
  const out = evaluateTenantHierarchy({
    role: 'ADMIN',
    userOrgId: 'ORG-A',
    userLicenseId: 'LIC-1',
    userSiteId: 'E1',
    targetOrgId: 'ORG-A',
    targetLicenseId: 'LIC-1',
    targetSiteId: 'E2',
    licensedSiteIds: ['E1'],
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'tenant_site_mismatch');
});

test('tenant hierarchy accepts matching tenant chain', () => {
  const out = evaluateTenantHierarchy({
    role: 'PRESENTER',
    userOrgId: 'ORG-A',
    userLicenseId: 'LIC-1',
    userSiteId: 'E1',
    targetOrgId: 'ORG-A',
    targetLicenseId: 'LIC-1',
    targetSiteId: 'E1',
    licensedSiteIds: ['E1', 'E2'],
  });
  assert.equal(out.allowed, true);
  assert.equal(out.reason, 'tenant_match');
});

test('collectTenantTargetsFromRequest derives tenant scope from route/query/body', () => {
  const out = collectTenantTargetsFromRequest({
    params: { roomId: 'e2-4' },
    query: { licenseId: 'lic-7', siteIds: 'E2,E3' },
    body: { orgId: 'org-7', siteId: 'e1' },
  });
  assert.equal(out.orgId, 'ORG-7');
  assert.equal(out.licenseId, 'LIC-7');
  assert.deepEqual(out.siteIds, ['E2', 'E3', 'E1']);
});

test('collectTenantTargetsFromRequest normalizes and deduplicates sites', () => {
  const out = collectTenantTargetsFromRequest({
    query: { siteId: 'e1', siteIds: ['e1', 'E2'] },
    body: { siteIds: ['e2', 'E3'] },
  });
  assert.deepEqual(out.siteIds, ['E1', 'E2', 'E3']);
});

test('cross-tenant request scope denies participant when room site differs', () => {
  const target = collectTenantTargetsFromRequest({
    params: { roomId: 'E2-1', licenseId: 'LIC-1', orgId: 'ORG-1' },
  });
  const out = evaluateTenantHierarchy({
    role: 'PARTICIPANT',
    userOrgId: 'ORG-1',
    userLicenseId: 'LIC-1',
    userSiteId: 'E1',
    targetOrgId: target.orgId,
    targetLicenseId: target.licenseId,
    targetSiteId: target.siteIds[0],
    licensedSiteIds: ['E1', 'E2'],
  });
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'tenant_site_mismatch');
});
