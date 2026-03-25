# Billing Overage Response Runbook

## Purpose
Operational playbook for usage cap overages, hard cap enforcement, and invoice escalation.

## Triggers
- License overage event created (`METER` or `ALERT` event in billing table).
- Admin reports blocked usage with `license_usage_hard_cap_reached`.
- Unexpected metered unit spike for an org/license.

## Triage
1. Identify org/license affected.
2. Verify seat cap, active user cap, and usage cap from admin billing summary.
3. Confirm overage policy (`NOTIFY_ONLY`, `AUTO_INVOICE`, `HARD_CAP`).

## Response Paths
- `NOTIFY_ONLY`: notify org admin with current usage and projected invoice.
- `AUTO_INVOICE`: ensure invoice record creation succeeded and send confirmation.
- `HARD_CAP`: coordinate with revenue/support for temporary increase or renewal action.

## Communication
1. Create support ticket and assign owner.
2. Add status note with expected resolution timeline.
3. Provide exact cap/usage numbers in customer update.

## Exit Criteria
- Overage state resolved or customer-approved billing action recorded.
- License state is `ACTIVE` and user workflows unblocked.
- Audit trail includes decision + actor + timestamps.
