#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const now = Date.now();
const iso = new Date(now).toISOString();
const stamp = iso.replace(/[-:]/g, '').replace(/\..+/, '');
const region = process.env.AWS_REGION || 'us-west-2';
const backupDir = path.resolve(process.cwd(), 'ops/reliability/backups');

const tables = [
  process.env.DDB_TABLE_CODES || 'storibloom_codes',
  process.env.DDB_TABLE_ROOMS || 'storibloom_rooms',
  process.env.DDB_TABLE_MESSAGES || 'storibloom_messages',
  process.env.DDB_TABLE_DRAFTS || 'storibloom_drafts',
  process.env.DDB_TABLE_PERSONAS || 'storibloom_personas',
  process.env.DDB_TABLE_WORKSHOPS || 'storibloom_workshops',
  process.env.DDB_TABLE_LICENSES || 'storibloom_licenses',
  process.env.DDB_TABLE_ORGS || 'storibloom_orgs',
  process.env.DDB_TABLE_AUDIT || 'storibloom_audit',
  process.env.DDB_TABLE_SUPPORT || 'storibloom_support',
  process.env.DDB_TABLE_STATUS || 'storibloom_status',
];

const manifest = {
  generatedAt: iso,
  backupId: `backup-${stamp}`,
  region,
  tableCount: tables.length,
  tables,
  mode: 'checkpoint',
  notes:
    'Checkpoint manifest only. Execute infrastructure backup automation for immutable snapshots.',
};

fs.mkdirSync(backupDir, { recursive: true });
const outPath = path.join(backupDir, `${manifest.backupId}.json`);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

console.log(`Backup checkpoint manifest written: ${outPath}`);
console.log('Next step: run platform backup job and store artifact references in this manifest.');
