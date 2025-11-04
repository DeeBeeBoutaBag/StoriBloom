import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, getIdToken } from 'firebase/auth';
import { getFirestore, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCP7-pgc-alcGP7Nt0sEugPMpY-tFiMbtQ",
  authDomain: "asemacollab-lite.firebaseapp.com",
  projectId: "asemacollab-lite"
  // storageBucket, messagingSenderId, appId optional
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const ts = serverTimestamp;

export async function ensureAnon() {
  if (!auth.currentUser) await signInAnonymously(auth);
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) { unsub(); resolve(u); }
    });
  });
}

export async function bearer() {
  const t = await getIdToken(auth.currentUser, true);
  return { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } };
}
