import React from 'react';
const order = ['LOBBY','DISCOVERY','IDEA_DUMP','PLANNING','ROUGH_DRAFT','EDITING','FINAL'];
export default function StageRibbon({ stage }) {
  return (
    <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
      {order.map(s => (
        <span key={s} style={{
          padding:'4px 8px',
          borderRadius:12,
          background: s===stage ? '#111' : '#e5e7eb',
          color: s===stage ? '#fff' : '#111',
          fontSize:12
        }}>{s.replace('_',' ')}</span>
      ))}
    </div>
  );
}
