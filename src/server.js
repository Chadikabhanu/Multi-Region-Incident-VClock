const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const REGION_ID = process.env.REGION_ID;
const PORT = process.env.PORT || 3000;
const PEER_URLS = (process.env.PEER_URLS || '').split(',').filter(Boolean);
const ALL_REGIONS = ['us', 'eu', 'apac'];

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
});

function initClock() {
  return ALL_REGIONS.reduce((c, r) => ({ ...c, [r]: 0 }), {});
}

function incrementClock(vc, region) {
  const c = { ...vc };
  c[region] = (c[region] || 0) + 1;
  return c;
}

function mergeClock(vc1, vc2) {
  const merged = {};
  for (const r of ALL_REGIONS) merged[r] = Math.max(vc1[r] || 0, vc2[r] || 0);
  return merged;
}

function compareClock(vc1, vc2) {
  let lt = false, gt = false;
  for (const r of ALL_REGIONS) {
    const a = vc1[r] || 0, b = vc2[r] || 0;
    if (a < b) lt = true;
    if (a > b) gt = true;
  }
  if (!lt && !gt) return 'EQUAL';
  if (lt && !gt) return 'BEFORE';
  if (gt && !lt) return 'AFTER';
  return 'CONCURRENT';
}

async function getIncident(id) {
  const { rows } = await pool.query('SELECT * FROM incidents WHERE id = $1', [id]);
  return rows[0] || null;
}

app.get('/health', (_req, res) => res.json({ status: 'ok', region: REGION_ID }));

app.post('/incidents', async (req, res) => {
  try {
    const { title, description, severity } = req.body;
    if (!title || !severity) return res.status(400).json({ error: 'title and severity required' });
    const id = uuidv4();
    const vc = incrementClock(initClock(), REGION_ID);
    const { rows } = await pool.query(
      `INSERT INTO incidents (id,title,description,status,severity,vector_clock)
       VALUES ($1,$2,$3,'OPEN',$4,$5) RETURNING *`,
      [id, title, description || null, severity, JSON.stringify(vc)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/incidents', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM incidents ORDER BY updated_at DESC');
  res.json(rows);
});

app.get('/incidents/:id', async (req, res) => {
  const inc = await getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'not found' });
  res.json(inc);
});

app.put('/incidents/:id', async (req, res) => {
  try {
    const { vector_clock, ...fields } = req.body;
    if (!vector_clock) return res.status(400).json({ error: 'vector_clock required' });
    const inc = await getIncident(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    const relation = compareClock(vector_clock, inc.vector_clock);
    if (relation === 'BEFORE') {
      return res.status(409).json({ error: 'Conflict: stale update', stored_clock: inc.vector_clock });
    }
    const newClock = incrementClock(mergeClock(vector_clock, inc.vector_clock), REGION_ID);
    const allowed = ['title', 'description', 'status', 'severity', 'assigned_team'];
    const updates = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 3}`).join(', ');
    const values = [JSON.stringify(newClock), req.params.id, ...Object.values(updates)];
    const { rows } = await pool.query(
      `UPDATE incidents SET vector_clock=$1, updated_at=NOW()${setClauses ? ', ' + setClauses : ''} WHERE id=$2 RETURNING *`,
      values
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/incidents/:id/resolve', async (req, res) => {
  try {
    const inc = await getIncident(req.params.id);
    if (!inc) return res.status(404).json({ error: 'not found' });
    const newClock = incrementClock(inc.vector_clock, REGION_ID);
    const { status, assigned_team } = req.body;
    const { rows } = await pool.query(
      `UPDATE incidents SET version_conflict=false, vector_clock=$1,
       status=COALESCE($2,status), assigned_team=COALESCE($3,assigned_team), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [JSON.stringify(newClock), status || null, assigned_team || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/internal/replicate', async (req, res) => {
  try {
    const incoming = req.body;
    const vc_in = incoming.vector_clock;
    const local = await getIncident(incoming.id);

    if (!local) {
      await pool.query(
        `INSERT INTO incidents (id,title,description,status,severity,assigned_team,vector_clock,version_conflict,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [incoming.id, incoming.title, incoming.description, incoming.status, incoming.severity,
         incoming.assigned_team, JSON.stringify(vc_in), incoming.version_conflict || false,
         incoming.updated_at || new Date()]
      );
      return res.sendStatus(200);
    }

    const relation = compareClock(vc_in, local.vector_clock);
    const mergedVC = mergeClock(vc_in, local.vector_clock);

    if (relation === 'BEFORE' || relation === 'EQUAL') {
      return res.sendStatus(200);
    }

    if (relation === 'AFTER') {
      await pool.query(
        `UPDATE incidents SET title=$2,description=$3,status=$4,severity=$5,
         assigned_team=$6,vector_clock=$7,version_conflict=$8,updated_at=$9 WHERE id=$1`,
        [incoming.id, incoming.title, incoming.description, incoming.status, incoming.severity,
         incoming.assigned_team, JSON.stringify(mergedVC), incoming.version_conflict || false,
         incoming.updated_at || new Date()]
      );
    } else {
      await pool.query(
        `UPDATE incidents SET version_conflict=true, vector_clock=$2, updated_at=NOW() WHERE id=$1`,
        [incoming.id, JSON.stringify(mergedVC)]
      );
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

let lastReplicatedAt = new Date(0);

async function replicate() {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM incidents WHERE updated_at > $1 ORDER BY updated_at',
      [lastReplicatedAt]
    );
    if (!rows.length) return;
    const now = new Date();
    for (const inc of rows) {
      for (const peer of PEER_URLS) {
        try {
          await fetch(`${peer}/internal/replicate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(inc),
            signal: AbortSignal.timeout(5000),
          });
        } catch (_) {}
      }
    }
    lastReplicatedAt = now;
  } catch (err) {
    console.error('Replication error:', err.message);
  }
}

async function waitForDB(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try { await pool.query('SELECT 1'); return; } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Cannot connect to DB');
}

waitForDB().then(() => {
  app.listen(PORT, () => console.log(`[${REGION_ID}] listening on :${PORT}`));
  setInterval(replicate, 5000);
});