#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import process from 'process';
import admin from 'firebase-admin';

/* ---------- Admin Init (same pattern you used) ---------- */
function initAdmin() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    if (!json.project_id) throw new Error('Service account json missing project_id');
    admin.initializeApp({ credential: admin.credential.cert(json) });
  } else {
    // falls back to GOOGLE_APPLICATION_CREDENTIALS file path
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin.firestore();
}

/* ---------- Helpers ---------- */
function rnd(len = 4) {
  // 8 hex chars by default
  return crypto.randomBytes(len).toString('hex');
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

async function upsert(docRef, data, overwrite = false) {
  const snap = await docRef.get();
  if (snap.exists && !overwrite) return { existed: true, ref: docRef };
  await docRef.set(data, { merge: true });
  return { existed: snap.exists, ref: docRef };
}

/* ---------- Main ---------- */
async function main() {
  const db = initAdmin();
  const configPath = path.resolve(process.cwd(), 'seed.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`seed.config.json not found at ${configPath}`);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const { waves, roomsPerSite, participantCodesPerSite, codePrefixes, overwrite } = cfg;
  const allSites = [...(waves.A || []), ...(waves.B || []), ...(waves.C || [])];
  const siteToWave = {};
  (waves.A || []).forEach(id => siteToWave[id] = 'A');
  (waves.B || []).forEach(id => siteToWave[id] = 'B');
  (waves.C || []).forEach(id => siteToWave[id] = 'C');

  /** Collections shape (matches what your app expects)
   * sites/{siteId} => { wave, presenterCode, createdAt }
   * rooms/{siteId-index} => { siteId, index, stage:'LOBBY', inputLocked:false, createdAt }
   * codes/{autoId} => { siteId, value, role: 'PRESENTER'|'PARTICIPANT', consumed:false, createdAt }
   */

  const sitesOut = [];
  const roomsOut = [];
  const codesOut = [];

  console.log(`\nSeeding ${allSites.length} sites…\n`);

  for (const siteId of allSites) {
    const wave = siteToWave[siteId] || 'A';
    const siteRef = db.collection('sites').doc(siteId);

    // presenter code (stable unless overwrite=true)
    let presenterCode = `${codePrefixes.presenter || 'P-'}${rnd(4)}`;

    if (!overwrite) {
      const snap = await siteRef.get();
      if (snap.exists && snap.data()?.presenterCode) {
        presenterCode = snap.data().presenterCode;
      }
    }

    await upsert(siteRef, {
      wave,
      presenterCode,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, overwrite);

    sitesOut.push({ siteId, wave, presenterCode });

    // Rooms
    for (let i = 1; i <= (roomsPerSite || 5); i++) {
      const roomId = `${siteId}-${i}`;
      const roomRef = db.collection('rooms').doc(roomId);
      await upsert(roomRef, {
        siteId,
        index: i,
        stage: 'LOBBY',
        inputLocked: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, overwrite);
      roomsOut.push({ roomId, siteId, index: i, stage: 'LOBBY' });
    }

    // Codes (presenter in codes too — handy for one-stop distribution)
    // Ensure exactly ONE presenter code per site in codes collection.
    const codesRef = db.collection('codes');
    if (overwrite) {
      // purge existing codes of this site, if desired
      // (comment out if you prefer additive)
      const existing = await codesRef.where('siteId', '==', siteId).get();
      const batch = db.batch();
      existing.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // Recreate presenter code entry
    await codesRef.add({
      siteId,
      value: presenterCode,
      role: 'PRESENTER',
      consumed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    codesOut.push({ siteId, value: presenterCode, role: 'PRESENTER' });

    // Participant codes
    const n = participantCodesPerSite || 50;
    const batchSize = 500; // safety for big writes
    let batch = db.batch(); let countInBatch = 0;

    for (let k = 0; k < n; k++) {
      const val = `${codePrefixes.participant || 'U-'}${rnd(4)}`;
      const ref = codesRef.doc(); // auto-id
      batch.set(ref, {
        siteId,
        value: val,
        role: 'PARTICIPANT',
        consumed: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      codesOut.push({ siteId, value: val, role: 'PARTICIPANT' });

      countInBatch++;
      if (countInBatch >= batchSize) {
        await batch.commit();
        batch = db.batch(); countInBatch = 0;
      }
    }
    if (countInBatch > 0) await batch.commit();
  }

  /* ---------- Output ---------- */
  // Console pretty print
  console.log('Sites:');
  console.table(sitesOut);

  console.log('\nRooms (first 20 shown):');
  console.table(roomsOut.slice(0, 20));
  if (roomsOut.length > 20) console.log(`… and ${roomsOut.length - 20} more`);

  console.log('\nCodes (first 30 shown):');
  console.table(codesOut.slice(0, 30));
  if (codesOut.length > 30) console.log(`… and ${codesOut.length - 30} more`);

  // CSV files
  const outDir = path.resolve(process.cwd(), 'seed-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  fs.writeFileSync(path.join(outDir, 'seed_sites.csv'), asCsv(sitesOut));
  fs.writeFileSync(path.join(outDir, 'seed_rooms.csv'), asCsv(roomsOut));
  fs.writeFileSync(path.join(outDir, 'seed_codes.csv'), asCsv(codesOut));

  // Also JSON for programmatic reuse
  fs.writeFileSync(path.join(outDir, 'seed_sites.json'), JSON.stringify(sitesOut, null, 2));
  fs.writeFileSync(path.join(outDir, 'seed_rooms.json'), JSON.stringify(roomsOut, null, 2));
  fs.writeFileSync(path.join(outDir, 'seed_codes.json'), JSON.stringify(codesOut, null, 2));

  console.log(`\n✔ Done. CSV/JSON written to ${outDir}\n`);
}

main().catch((e) => {
  console.error('Seeder failed:', e);
  process.exit(1);
});
