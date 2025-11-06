// /opt/StoriBloom/api/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------- Optional deps (don’t crash if missing) ----------
let compression = null;
let morgan = null;
try {
  ({ default: compression } = await import('compression'));
} catch {
  console.warn('[warn] compression not installed');
}
try {
  ({ default: morgan } = await import('morgan'));
} catch {
  console.warn('[warn] morgan not installed');
}

// ---------- AWS SDK v3 (DynamoDB) ----------
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// ---------- ENV ----------
/*
Example .env (local dev only; use Render env vars in prod):

PORT=4000
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=...            # (local or Render)
AWS_SECRET_ACCESS_KEY=...        # (local or Render)
AWS_DYNAMO_ENDPOINT=http://localhost:8000   # (optional for DynamoDB Local)
CORS_ORIGINS=http://localhost:5173
WEB_DIST_DIR=/opt/StoriBloom/web-dist
TABLE_CODES=storibloom_codes
STATIC_INDEX=0
*/
const PORT = Number(process.env.PORT || 4000);
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const AWS_DYNAMO_ENDPOINT = process.env.AWS_DYNAMO_ENDPOINT || undefined;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WEB_DIST_DIR = process.env.WEB_DIST_DIR || '/opt/StoriBloom/web-dist';
const TABLE_CODES = process.env.TABLE_CODES || 'storibloom_codes';

// Default SPA serving OFF because frontend is on Render Static:
const ENABLE_SPA = String(process.env.STATIC_INDEX || '0') === '1';

// ---------- AWS ----------
const ddb = new DynamoDBClient({
  region: AWS_REGION,
  ...(AWS_DYNAMO_ENDPOINT ? { endpoint: AWS_DYNAMO_ENDPOINT } : {}),
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

// Log whether credentials/region resolved (helps diagnose CredentialsProviderError)
(async () => {
  try {
    const creds = await ddb.config.credentials();
    if (creds && creds.accessKeyId) {
      console.log('[aws] Credentials resolved');
    } else {
      console.error('[aws] No AWS credentials resolved');
    }
  } catch (e) {
    console.error('[aws] Failed resolving credentials:', e?.message || e);
  }
  console.log(`[aws] region=${AWS_REGION} endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`);
})();

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App ----------
const app = express();
app.set('trust proxy', true); // behind Render proxy
app.disable('x-powered-by');

// ---------- CORS ----------
// If your Static Site rewrites /api/* → this API, CORS can be wide open (or left empty).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same-origin / proxy rewrite
      if (CORS_ORIGINS.length === 0) return cb(null, true); // allow all if unset
      if (CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
    credentials: true,
  })
);
app.options('*', cors());

// ---------- Body parsing ----------
app.use(express.json({ limit: '1mb' }));

// ---------- Optional middleware ----------
if (compression) app.use(compression());
if (morgan) app.use(morgan('tiny'));

// ---------- Tiny logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ---------- Auth Helpers ----------
/**
 * Simple guest token issuer.
 * Response: { token: "guest-<uuid>", userId: "<uuid>" }
 * Usage on client: send "Authorization: Bearer guest-<uuid>"
 */
function handleGuestAuth(_req, res) {
  try {
    const id = crypto.randomUUID();
    const token = `guest-${id}`;
    res.json({ token, userId: id });
  } catch (e) {
    console.error('[auth/guest] error:', e);
    res.status(500).json({ error: 'guest auth failed' });
  }
}
app.post('/auth/guest', handleGuestAuth);
// Optional alias in case your proxy doesn’t strip /api
app.post('/api/auth/guest', handleGuestAuth);

/**
 * Middleware requires:
 *   Authorization: Bearer guest-<uuid>
 * Attaches: req.user = { uid }
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !token.startsWith('guest-')) {
      return res.status(401).json({ error: 'Missing or invalid token' });
    }
    const uid = token.replace('guest-', '');
    if (!uid) return res.status(401).json({ error: 'Invalid uid' });
    req.user = { uid };
    req.userToken = token;
    return next();
  } catch (err) {
    console.error('[requireAuth] error:', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ---------- Health / Version ----------
function healthPayload() {
  return { ok: true, region: AWS_REGION, time: new Date().toISOString() };
}
app.get('/health', (_req, res) => res.json(healthPayload()));
// Optional alias if you ever want /api/health without a proxy rewrite:
app.get('/api/health', (_req, res) => res.json(healthPayload()));

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
 * (Optional) marks consumed if attributes exist.
 */
app.post('/codes/consume', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }

    const getRes = await ddbDoc.send(
      new GetCommand({
        TableName: TABLE_CODES,
        Key: { code: code.trim() },
      })
    );

    const item = getRes.Item;
    if (!item) return res.status(404).json({ error: 'Code not found or invalid' });

    // Optionally mark consumed (ignore if attributes don’t exist)
    try {
      await ddbDoc.send(
        new UpdateCommand({
          TableName: TABLE_CODES,
          Key: { code: item.code },
          UpdateExpression: 'SET consumed = :c, usedBy = :u, consumedAt = :t',
          ExpressionAttributeValues: {
            ':c': true,
            ':u': req.user.uid || '(unknown)',
            ':t': Date.now(),
          },
        })
      );
    } catch (e) {
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

// ---------- Voting (placeholder stubs) ----------
app.get('/rooms/:roomId/vote', requireAuth, async (_req, res) => {
  res.json({ votingOpen: false, options: [], votesReceived: 0, counts: [] });
});
app.post('/rooms/:roomId/vote/start', requireAuth, async (_req, res) => {
  res.json({ ok: true, started: true });
});
app.post('/rooms/:roomId/vote/submit', requireAuth, async (req, res) => {
  const { choice } = req.body || {};
  if (typeof choice !== 'number')
    return res.status(400).json({ error: 'choice must be a number' });
  res.json({ ok: true });
});
app.post('/rooms/:roomId/vote/close', requireAuth, async (_req, res) => {
  res.json({ ok: true, closed: true });
});

// ---------- Static Frontend (SPA) ----------
// You’re hosting the frontend on Render Static, so ENABLE_SPA is false by default.
// These handlers remain in case you later choose to serve a build from this service.
function hasIndex(dir) {
  try {
    return fs.existsSync(path.join(dir, 'index.html'));
  } catch {
    return false;
  }
}
const distDir = WEB_DIST_DIR;
const distHasIndex = hasIndex(distDir);

// Serve assets if present
if (distHasIndex) {
  app.use(
    '/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
  app.use(
    '/app/assets',
    express.static(path.join(distDir, 'assets'), {
      fallthrough: true,
      index: false,
      maxAge: '1h',
    })
  );
}

// Root – if SPA exists, serve it; else text
app.get('/', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
    }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /] index error:', err?.message || err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

// Explicit /app entry (also SPA)
app.get('/app', (_req, res) => {
  if (!ENABLE_SPA || !distHasIndex) {
    return res.status(200).send('StoriBloom API (DynamoDB) ✅');
  }
  const indexPath = path.join(distDir, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('[static /app] index error:', err?.message || err);
      res.status(404).send(`Error: index.html not found at '${indexPath}'`);
    }
  });
});

// SPA fallback for deep links under /app and /
if (ENABLE_SPA && distHasIndex) {
  app.get(/^\/app\/(.*)/, (_req, res) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[static fallback /app/*] error:', err?.message || err);
        res.status(404).send(`Error: index.html not found at '${indexPath}'`);
      }
    });
  });

  // Don't hijack API-like paths
  app.get(/^\/(?!api|health|version|rooms|codes|assets).*/, (_req, res, next) => {
    const indexPath = path.join(distDir, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error('[static fallback /*] error:', err?.message || err);
        next(); // proceed to 404
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
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`[env] region=${AWS_REGION}`);
  console.log(`[env] endpoint=${AWS_DYNAMO_ENDPOINT || '(default)'}`);
  console.log(`[env] CORS_ORIGINS=${CORS_ORIGINS.length ? CORS_ORIGINS.join(',') : '(all)'}`);
  console.log(`[env] static dir=${distDir} (present=${distHasIndex}) SPA=${ENABLE_SPA}`);
});
