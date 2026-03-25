#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argMap = Object.fromEntries(
  args
    .map((arg) => arg.trim())
    .filter(Boolean)
    .map((arg) => {
      const [k, v = ''] = arg.replace(/^--/, '').split('=');
      return [k, v];
    })
);

const now = Date.now();
const iso = new Date(now).toISOString();
const stamp = iso.replace(/[-:]/g, '').replace(/\..+/, '');
const drillDir = path.resolve(process.cwd(), 'ops/reliability/drills');

const observedRtoMinutes = Math.max(0, Number(argMap.observedRtoMinutes || 0));
const observedRpoMinutes = Math.max(0, Number(argMap.observedRpoMinutes || 0));
const targetRtoMinutes = Math.max(1, Number(process.env.RELIABILITY_RTO_TARGET_MINUTES || 240));
const targetRpoMinutes = Math.max(1, Number(process.env.RELIABILITY_RPO_TARGET_MINUTES || 60));

const report = {
  generatedAt: iso,
  drillId: `restore-drill-${stamp}`,
  backupManifest: argMap.backupManifest || '',
  target: {
    rtoMinutes: targetRtoMinutes,
    rpoMinutes: targetRpoMinutes,
  },
  observed: {
    rtoMinutes: observedRtoMinutes,
    rpoMinutes: observedRpoMinutes,
  },
  passed:
    observedRtoMinutes > 0 &&
    observedRpoMinutes > 0 &&
    observedRtoMinutes <= targetRtoMinutes &&
    observedRpoMinutes <= targetRpoMinutes,
  notes: argMap.notes || '',
};

fs.mkdirSync(drillDir, { recursive: true });
const outPath = path.join(drillDir, `${report.drillId}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`Restore drill report written: ${outPath}`);
console.log('Log observed values to /super-admin/reliability/restore-drill for dashboard visibility.');
