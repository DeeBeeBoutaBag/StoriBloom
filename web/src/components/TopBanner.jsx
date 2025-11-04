import React from 'react';

export default function TopBanner({ siteId, roomIndex, stage }) {
  return (
    <div className="banner">
      <div className="dot" />
      <div className="tag">Site <b>{siteId}</b></div>
      <div className="tag">Room <b>{roomIndex}</b></div>
      <div className="tag" style={{ marginLeft: 'auto' }}>
        Stage: <span className="stage-badge" style={{ marginLeft: 6 }}>{stage}</span>
      </div>
    </div>
  );
}
