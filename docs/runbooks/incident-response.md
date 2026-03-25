# Incident Response Runbook

## Purpose
Use this runbook when platform health alerts, incidents, or customer-impacting failures are detected.

## Severity Levels
- `CRITICAL`: Widespread outage, data loss risk, or security event.
- `HIGH`: Major degradation with active customer impact.
- `WARN`: Partial degradation with mitigations available.
- `INFO`: Low-risk issue or maintenance update.

## RTO/RPO Targets
- Target RTO: 240 minutes
- Target RPO: 60 minutes

## First 15 Minutes
1. Acknowledge the incident and assign incident commander.
2. Open a status event (`/super-admin/status/events`) with current state.
3. Confirm blast radius (orgs, licenses, sites, room activity).
4. Start timeline capture (request IDs, deploy IDs, error spikes).

## Containment
1. Pause risky rollouts and feature toggles if required.
2. Escalate support tickets beyond SLA using `/super-admin/support/escalate-overdue`.
3. Route customer-facing updates to status page every 30 minutes until stable.

## Recovery
1. Apply remediation and verify health (`/health`, app metrics, support queue).
2. Validate data integrity for impacted org/license/site scopes.
3. Mark incident `MONITORING` then `RESOLVED` with status updates.

## Post-Incident
1. Publish postmortem summary and remediation tasks.
2. Track follow-up owners and due dates.
3. Update runbooks and alert thresholds where needed.
