import React from 'react';

export default function IdeaSidebar({ summary }) {
  return (
    <div style={{
      minWidth: 280, maxWidth: 320, alignSelf: 'stretch',
      backdropFilter: 'blur(12px)',
      background: 'rgba(255,255,255,.05)',
      border: '1px solid rgba(255,255,255,.15)',
      borderRadius: 14, padding: 12
    }}>
      <div style={{ fontWeight: 800, marginBottom: 6 }}>Idea Board</div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, color: '#dfe3e8' }}>
        {summary || 'No ideas yet — start brainstorming!'}
      </div>
    </div>
  );
}
