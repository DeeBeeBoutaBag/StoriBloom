# StoriBloom DynamoDB Schema (Enterprise)

This schema supports strict tenant isolation (`orgId -> licenseId -> siteId`), admin/super-admin operations, approvals, billing, and status/support workflows.

## Core collaboration tables

1. `storibloom_rooms`
- PK: `roomId` (S)
- GSIs:
  - `bySiteIndex` (`siteId` HASH, `index` RANGE)
  - `bySiteUpdatedAt` (`siteId` HASH, `updatedAt` RANGE)
  - `byOrgUpdatedAt` (`orgId` HASH, `updatedAt` RANGE)

2. `storibloom_messages`
- PK: `roomId` (S)
- SK: `createdAt` (N)
- GSI:
  - `byUidCreatedAt` (`uid` HASH, `createdAt` RANGE)
- TTL: `expiresAt`

3. `storibloom_drafts`
- PK: `roomId` (S)
- SK: `createdAt` (N)
- TTL: `expiresAt`

4. `storibloom_codes`
- PK: `code` (S)
- GSIs:
  - `bySiteCreatedAt` (`siteId` HASH, `createdAt` RANGE)
  - `byLicenseCreatedAt` (`licenseId` HASH, `createdAt` RANGE)
  - `byRoleCreatedAt` (`role` HASH, `createdAt` RANGE)
  - `byOrgCreatedAt` (`orgId` HASH, `createdAt` RANGE)
- Lifecycle fields:
  - `expiresAt`, `revoked`, `revokedAt`, `revokedBy`, `codeHash`

5. `storibloom_workshops`
- PK: `licenseId` (S)
- GSI:
  - `byOrgUpdatedAt` (`orgId` HASH, `updatedAt` RANGE)
- Key fields:
  - `mode`, `siteIds`, `phases`, `topicCatalog`, `aiBehavior`
  - `licenseStatus`, `licenseExpiresAt`, `expectedUsers`, `activeUserCap`

6. `storibloom_gallery`
- PK: `siteId` (S)
- SK: `closedAtRoom` (S)
- GSIs:
  - `byLicenseClosedAt` (`licenseId` HASH, `closedAtRoom` RANGE)
  - `byOrgClosedAt` (`orgId` HASH, `closedAtRoom` RANGE)

7. `storibloom_sessions`
- PK: `uid` (S)
- GSIs:
  - `bySiteLastSeen` (`siteId` HASH, `lastSeenAt` RANGE)
  - `byRoleLastSeen` (`role` HASH, `lastSeenAt` RANGE)
  - `byOrgLastSeen` (`orgId` HASH, `lastSeenAt` RANGE)
- TTL: `expiresAt`

8. `storibloom_auth_sessions`
- PK: `uid` (S)
- SK: `sessionId` (S)
- GSIs:
  - `byLicenseUpdatedAt` (`licenseId` HASH, `updatedAt` RANGE)
  - `byOrgUpdatedAt` (`orgId` HASH, `updatedAt` RANGE)
- TTL: `expiresAt`

9. `storibloom_audit`
- PK: `scopeId` (S)
- SK: `createdAtAudit` (S)
- GSIs:
  - `byActorCreatedAt` (`actorUid` HASH, `createdAt` RANGE)
  - `byActionCreatedAt` (`action` HASH, `createdAt` RANGE)
  - `byOrgCreatedAt` (`orgId` HASH, `createdAt` RANGE)
- TTL: `expiresAt`

## Enterprise operations tables

10. `storibloom_orgs`
- PK: `orgId` (S)
- GSI:
  - `byStatusUpdatedAt` (`status` HASH, `updatedAt` RANGE)

11. `storibloom_org_users`
- PK: `orgId` (S)
- SK: `userId` (S)
- GSI:
  - `byEmailUpdatedAt` (`email` HASH, `updatedAt` RANGE)

12. `storibloom_licenses`
- PK: `licenseId` (S)
- GSIs:
  - `byOrgUpdatedAt` (`orgId` HASH, `updatedAt` RANGE)
  - `byStatusUpdatedAt` (`status` HASH, `updatedAt` RANGE)

13. `storibloom_feature_flags`
- PK: `scopeId` (S)
- SK: `flagKey` (S)

14. `storibloom_policies`
- PK: `scopeId` (S)
- SK: `policyType` (S)

15. `storibloom_templates`
- PK: `orgId` (S)
- SK: `templateKey` (S) where key format is `<templateId>#v<version>`
- GSIs:
  - `byStatusUpdatedAt` (`status` HASH, `updatedAt` RANGE)
  - `byTemplateIdUpdatedAt` (`templateId` HASH, `updatedAt` RANGE)

16. `storibloom_approvals`
- PK: `orgId` (S)
- SK: `approvalId` (S)
- GSI:
  - `byStatusRequestedAt` (`status` HASH, `requestedAt` RANGE)

17. `storibloom_billing`
- PK: `orgId` (S)
- SK: `billingEventId` (S)
- GSIs:
  - `byLicenseCreatedAt` (`licenseId` HASH, `createdAt` RANGE)
  - `byEventTypeCreatedAt` (`eventType` HASH, `createdAt` RANGE)

18. `storibloom_support`
- PK: `orgId` (S)
- SK: `ticketId` (S)
- GSI:
  - `byTicketStatusUpdatedAt` (`ticketStatus` HASH, `updatedAt` RANGE)

19. `storibloom_status`
- PK: `scopeId` (S)
- SK: `statusKey` (S)
- GSI:
  - `byScopeUpdatedAt` (`scopeId` HASH, `updatedAt` RANGE)

## Existing optional table

- `storibloom_personas`
  - Keep as optional. Core flow does not require it.

## Apply / validate

1. Dry run:
```bash
npm run ddb:plan
```

2. Apply:
```bash
npm run ddb:apply
```

3. Backfill tenant IDs on existing data:
```bash
npm run tenant:backfill:plan
npm run tenant:backfill:apply
```
