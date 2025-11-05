// /opt/StoriBloom/api/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Optional deps (don’t crash if missing)
let compression = null;
let morgan = null;
try { ({ default: compression } = await import('compression')); } catch { console.warn('[warn] no compression'); }
try { ({ default: morgan } = await import('morgan')); } catch { console.warn('[warn] no morgan'); }

// AWS SDK v3 (DynamoDB)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// ---------- ENV ----------
/*
Example .env:

PORT=4000
AWS_REGION=us-west-2
CORS_ORIGINS=http://localhost:5173,http://ec2-54-187-77-195.us-west-2.compute.amazonaws.com:4000
WEB_DIST_DIR=/opt/StoriBloom/web-dist
TABLE_CODES=storibloom_codes
STATIC_INDEX=1
*/
const PORT = Number(process.env.PORT || 4000);
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const TABLE_CODES = process.env.TABLE_CODES || 'storibloom_codes';
const ENABLE_SPA = String(process.env.STATIC_INDEX || '1') === '1';

// ---------- AWS ----------
const ddb = new DynamoDBClient({ region: AWS_REGION });
const ddbDoc = DynamoDBDocumentClient.from(ddb);

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.set('trust proxy', true); // behind nginx

// DO NOT set COOP/COEP here (causes warnings on HTTP)
app.disable('x-powered-by');

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same-origin
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  })
);
app.options('*', cors());

// JSON body
app.use(express.json({ limit: '1mb' }));

// Optional middleware
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

// Tiny logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Auth ----------
/**
 * Accepts:
 *  - Authorization: Bearer <token>  (exposed as req.userToken)
 *  - x-user-id: <uid>               (exposed as req.user.uid)
 */
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const uid = req.headers['x-user-id'] ? String(req.headers['x-user-id']) : null;

  if (!bearer && !uid) {
    return res.status(401).json({ error: 'Missing Authorization or x-user-id' });
  }
  req.user = { uid: uid || null };
  req.userToken = bearer || null;
  next();
}

// ---------- Health / Version ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    region: AWS_REGION,
    time: new Date().toISOString(),
  });
});

app.get('/version', (_req, res) => {
  res.json({
    commit: process.env.GIT_COMMIT || null,
    build: process.env.BUILD_ID || null,
    time: new Date().toISOString(),
  });
});

// ---------- Codes: consume (LOGIN) ----------
/**
 * Body: { code: "P-1234" | "U-ABCD" }
 * Table: TABLE_CODES (PK: code)
 * Returns: { siteId, role }
 * (Optional) If you store "consumed" flag, this will mark it consumed by uid if present.
 */
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }

    const getRes = await ddbDoc.send(new GetCommand({
      TableName: TABLE_CODES,
      Key: { code: code.trim() },
    }));

    const item = getRes.Item;
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });

    // Optionally mark consumed (only if you put these attributes in your schema)
    try {
      await ddbDoc.send(new UpdateCommand({
        TableName: TABLE_CODES,
        Key: { code: item.code },
        UpdateExpression: 'SET consumed = :c, usedBy = :u, consumedAt = :t',
        ExpressionAttributeValues: {
          ':c': true,
          ':u': req.user.uid || '(unknown)',
          ':t': Date.now(),
        },
      }));
    } catch (e) {
      // If attributes don’t exist in your table, ignore
      console.warn('[codes/consume] update skipped:', e?.message || e);
    }

    return res.json({
      siteId: item.siteId,
      role: item.role || 'PARTICIPANT',
    });
  } catch (err) {
    console.error('[/codes/consume] error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------- Voting (placeholder stubs to avoid 404s) ----------
app.get('/rooms/:roomId/vote', requireAuth, async (_req, res) => {
  res.json({ votingOpen: false, options: [], votesReceived: 0, counts: [] });
});
app.post('/rooms/:roomId/vote/start', requireAuth, async (_req, res) => {
  res.json({ ok: true, started: true });
});
app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  const { choice } = req.body || {};
  if (typeof choice !== 'number') return res.status(400).json({ error: 'choice must be a number' });
  res.json({ ok: true });
});
app.post('/rooms/:roomId/vote/close', requireAuth, async (_req, res) => {
  res.json({ ok: true, closed: true });
});

// ---------- Static Frontend (SPA) ----------
// Serve both at "/" and "/app" so you can access either.
// If WEB_DIST_DIR is missing, we fall back to simple API text.

function hasIndex(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.html'));
  } catch { return false; }
}

const distDir = WEB_DIST_DIR;
const distHasIndex = hasIndex(distDir);

// Serve assets if present
if (distHasIndex) {
  app.use('/assets', express.static(path.join(distDir, 'assets'), {
    fallthrough: true,
    index: false,
    maxAge: '1h',
  }));
  app.use('/app/assets', express.static(path.join(distDir, 'assets'), {
    fallthrough: true,
    index: false,
    maxAge: '1h',
  }));
}

// Root – if SPA exists, serve it; else text
app.get('/', (req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, err => {
    if (err) {
      console.error('[static /] index error:', err?.message || err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

// Explicit /app entry (also SPA)
app.get('/app', (req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, err => {
    if (err) {
      console.error('[static /app] index error:', err?.message || err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

// SPA fallback for deep links under /app and /
if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, err => {
      if (err) {
        console.error('[static fallback /app/*] error:', err?.message || err);
        res.status(404).send(`Error: index.html not found at '${indexPath}'`);
      }
    });
  });

  app.get(/^\/(?!api|health|version|rooms|codes|assets).*/, (req, res, next) => {
    // Don’t hijack API paths; otherwise serve SPA
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, err => {
      if (err) {
        console.error('[static fallback /*] error:', err?.message || err);
        next(); // fallback to 404 below
      }
    });
  });
}

// Favicon (avoid noisy 404 in logs)
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
});

// ---------- Error handler ----------
app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ---------- Listen ----------
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(`[env] CORS_ORIGINS=${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'}`);
  console.log(`[env] static dir=${distDir} (present=${distHasIndex}) SPA=${ENABLE_SPA}`);
});
