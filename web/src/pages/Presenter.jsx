import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { db, ensureAnon, bearer as bearerHeaders } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import PresenterHUD from '../components/PresenterHUD.jsx';

export default function Presenter() {
  const { siteId } = useParams();
  const [rooms, setRooms] = useState([]);

  useEffect(() => {
    ensureAnon();
    const unsub = onSnapshot(
      query(collection(db, 'rooms'), where('siteId','==', siteId)),
      (qs) => setRooms(qs.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    return () => unsub();
  }, [siteId]);

  async function post(path, body) {
    const r = await fetch(import.meta.env.VITE_API_URL + path, {
      method: 'POST',
      ...(await bearerHeaders()),
      body: JSON.stringify(body || {})
    });
    if (!r.ok) alert('Action failed');
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
      <h1>Presenter — {siteId}</h1>
      <div style={{ display:'grid', gap:12, gridTemplateColumns:'repeat(auto-fill, minmax(280px,1fr))' }}>
        {rooms.sort((a,b)=>(a.index||0)-(b.index||0)).map((r) => (
          <div key={r.id} style={{ border:'1px solid rgba(255,255,255,.15)', borderRadius:12, padding:12, background:'rgba(255,255,255,.04)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
              <div><b>Room {r.index}</b></div>
              <div>Stage: <b>{r.stage}</b></div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>post(`/rooms/${r.id}/extend`, { by: 120 })}>+2m</button>
              <button onClick={()=>post(`/rooms/${r.id}/next`, {})}>Next</button>
              <button onClick={()=>post(`/rooms/${r.id}/redo`, {})}>Redo</button>
            </div>
          </div>
        ))}
      </div>

      {/* 🔥 Global overlay HUD with hotkeys */}
      <PresenterHUD siteId={siteId} rooms={rooms} />
    </div>
  );
}
