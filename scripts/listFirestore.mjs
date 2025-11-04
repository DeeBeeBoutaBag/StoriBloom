#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import admin from 'firebase-admin';

function initAdmin() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(json) });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin.firestore();
}

function asCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

async function main() {
  const db = initAdmin();

  const sitesSnap = await db.collection('sites').get();
  const sites = sitesSnap.docs.map(d => ({ siteId: d.id, ...(d.data()||{}) }));

  const roomsSnap = await db.collection('rooms').get();
  const rooms = roomsSnap.docs.map(d => ({ roomId: d.id, ...(d.data()||{}) }));

  const codesSnap = await db.collection('codes').get();
  const codes = codesSnap.docs.map(d => ({ codeId: d.id, ...(d.data()||{}) }));

  console.log('\nSites:'); console.table(sites);
  console.log('\nRooms (first 30):'); console.table(rooms.slice(0,30));
  console.log('\nCodes (first 30):'); console.table(codes.slice(0,30));

  const outDir = path.resolve(process.cwd(), 'seed-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'list_sites.csv'), asCsv(sites));
  fs.writeFileSync(path.join(outDir, 'list_rooms.csv'), asCsv(rooms));
  fs.writeFileSync(path.join(outDir, 'list_codes.csv'), asCsv(codes));
  console.log(`\n✔ Exported to ${outDir}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
