function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function normalizeSiteId(siteId) {
  return String(siteId || '').trim().toUpperCase();
}

function normalizeLicenseId(licenseId) {
  return String(licenseId || '').trim().toUpperCase();
}

function normalizeOrgId(orgId) {
  return String(orgId || '').trim().toUpperCase();
}

function uniq(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSiteIds(siteIds) {
  return uniq(
    (Array.isArray(siteIds) ? siteIds : [])
      .map((siteId) => normalizeSiteId(siteId))
      .filter(Boolean)
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function splitSiteIdCandidates(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function roomSiteFromRoomId(roomId) {
  const value = String(roomId || '').trim();
  if (!value.includes('-')) return '';
  const [siteId] = value.split('-');
  return normalizeSiteId(siteId);
}

export function evaluateRoomAccess({
  role,
  tokenSiteId,
  roomSiteId,
  isSeatMember = false,
  adminAllowed = false,
} = {}) {
  const normalizedRoleValue = normalizeRole(role);
  const tokenSite = normalizeSiteId(tokenSiteId);
  const roomSite = normalizeSiteId(roomSiteId);

  if (normalizedRoleValue === 'SUPER_ADMIN') {
    return { allowed: true, reason: 'super_admin' };
  }

  if (normalizedRoleValue === 'PRESENTER') {
    if (tokenSite && tokenSite === roomSite) {
      return { allowed: true, reason: 'presenter_site_match' };
    }
    return { allowed: false, reason: 'room_forbidden' };
  }

  if (normalizedRoleValue === 'ADMIN') {
    if (adminAllowed) {
      return { allowed: true, reason: 'admin_scope_match' };
    }
    return { allowed: false, reason: 'room_forbidden' };
  }

  if (tokenSite && roomSite && tokenSite !== roomSite) {
    return { allowed: false, reason: 'room_forbidden' };
  }

  if (!isSeatMember) {
    return { allowed: false, reason: 'room_membership_required' };
  }

  return { allowed: true, reason: 'seat_member' };
}

export function evaluateTenantHierarchy({
  role,
  userOrgId,
  userLicenseId,
  userSiteId,
  targetOrgId,
  targetLicenseId,
  targetSiteId,
  licensedSiteIds = [],
} = {}) {
  const normalizedRoleValue = normalizeRole(role);
  if (normalizedRoleValue === 'SUPER_ADMIN') {
    return { allowed: true, reason: 'super_admin' };
  }

  const uOrg = normalizeOrgId(userOrgId);
  const uLicense = normalizeLicenseId(userLicenseId);
  const uSite = normalizeSiteId(userSiteId);
  const tOrg = normalizeOrgId(targetOrgId);
  const tLicense = normalizeLicenseId(targetLicenseId);
  const tSite = normalizeSiteId(targetSiteId);
  const licensedSites = Array.isArray(licensedSiteIds)
    ? licensedSiteIds.map(normalizeSiteId).filter(Boolean)
    : [];

  if (!uOrg || !uLicense) {
    return { allowed: false, reason: 'tenant_claims_required' };
  }
  if ((normalizedRoleValue === 'PARTICIPANT' || normalizedRoleValue === 'PRESENTER') && !uSite) {
    return { allowed: false, reason: 'tenant_site_required' };
  }

  if (tOrg && uOrg !== tOrg) {
    return { allowed: false, reason: 'tenant_org_mismatch' };
  }
  if (tLicense && uLicense !== tLicense) {
    return { allowed: false, reason: 'tenant_license_mismatch' };
  }
  if (licensedSites.length && tSite && !licensedSites.includes(tSite)) {
    return { allowed: false, reason: 'tenant_site_mismatch' };
  }
  if (normalizedRoleValue !== 'ADMIN' && tSite && uSite && tSite !== uSite) {
    return { allowed: false, reason: 'tenant_site_mismatch' };
  }

  return { allowed: true, reason: 'tenant_match' };
}

export function collectTenantTargetsFromRequest({
  params = {},
  query = {},
  body = {},
} = {}) {
  const roomId = firstNonEmpty(params.roomId, query.roomId, body.roomId);
  const roomSiteId = roomSiteFromRoomId(roomId);
  const siteIds = normalizeSiteIds([
    ...splitSiteIdCandidates(params.siteIds),
    ...splitSiteIdCandidates(query.siteIds),
    ...splitSiteIdCandidates(body.siteIds),
    params.siteId,
    query.siteId,
    body.siteId,
    roomSiteId,
  ]);
  const licenseId = normalizeLicenseId(
    firstNonEmpty(params.licenseId, query.licenseId, body.licenseId)
  );
  const orgId = normalizeOrgId(firstNonEmpty(params.orgId, query.orgId, body.orgId));
  return { orgId, licenseId, siteIds };
}
