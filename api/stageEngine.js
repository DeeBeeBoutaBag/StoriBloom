import { db } from './firebaseAdmin.js';

export async function setStage(roomId, action) {
  const roomRef = db.collection('rooms').doc(roomId);
  const doc = await roomRef.get();
  if (!doc.exists) return;

  const stage = doc.data().stage || 'LOBBY';
  let nextStage = stage;

  const stages = [
    'LOBBY',
    'DISCOVERY',
    'IDEA_DUMP',
    'PLANNING',
    'ROUGH_DRAFT',
    'EDITING',
    'FINAL',
    'CLOSED',
  ];

  const idx = stages.indexOf(stage);
  if (action === 'NEXT' && idx < stages.length - 1)
    nextStage = stages[idx + 1];
  if (action === 'REDO') nextStage = 'ROUGH_DRAFT';

  const endsAt = new Date(Date.now() + 10 * 60 * 1000); // +10 min
  await roomRef.update({ stage: nextStage, stageEndsAt: endsAt });
  console.log(`[stageEngine] ${roomId} → ${nextStage}`);
}

export async function extendStage(roomId, minutes) {
  const ref = db.collection('rooms').doc(roomId);
  const doc = await ref.get();
  if (!doc.exists) return;
  const cur = doc.data().stageEndsAt?.toDate() || new Date();
  const extended = new Date(cur.getTime() + minutes * 60 * 1000);
  await ref.update({ stageEndsAt: extended });
  console.log(`[stageEngine] extended ${roomId} by ${minutes}m`);
}

export function startStageLoop() {
  setInterval(async () => {
    const now = new Date();
    const snap = await db.collection('rooms').get();
    snap.forEach(async (doc) => {
      const d = doc.data();
      if (d.stageEndsAt && d.stageEndsAt.toDate() < now && d.stage !== 'CLOSED') {
        await setStage(doc.id, 'NEXT');
      }
    });
  }, 10000);
}
