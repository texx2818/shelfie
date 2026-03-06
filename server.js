'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/shelfie.db';

// Make sure the data directory exists before opening the db
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    creator    TEXT,
    type       TEXT NOT NULL,
    year       TEXT,
    barcode    TEXT,
    cover_url  TEXT,
    description TEXT,
    genre      TEXT,
    format     TEXT,
    rating     INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
    notes      TEXT,
    status     TEXT NOT NULL DEFAULT 'owned',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_type    ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_title   ON items(title);
  CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
`);

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Allowed sort columns — validated before use in query
const SORTABLE = new Set(['title', 'creator', 'type', 'year', 'created_at', 'rating']);

// Media types we recognise
const VALID_TYPES = new Set(['book', 'movie', 'music', 'game', 'tv', 'other']);

// Fields that can be updated via PUT
const MUTABLE_FIELDS = [
  'title', 'creator', 'type', 'year', 'barcode',
  'cover_url', 'description', 'genre', 'format',
  'rating', 'notes', 'status',
];


// Lookup -----------------------------------------------------------------------

// ISBN / barcode lookup. Tries Open Library first (books), falls back to
// UPC Item DB for everything else.
app.get('/api/lookup/barcode/:barcode', async (req, res) => {
  const { barcode } = req.params;

  try {
    const olRes = await fetch(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${barcode}&format=json&jscmd=data`
    );
    const olData = await olRes.json();
    const book = olData[`ISBN:${barcode}`];

    if (book) {
      return res.json({
        found: true,
        data: {
          title:     book.title,
          creator:   book.authors?.map(a => a.name).join(', ') || '',
          type:      'book',
          year:      book.publish_date || '',
          cover_url: book.cover?.large || book.cover?.medium || '',
          genre:     book.subjects?.slice(0, 3).map(s => s.name).join(', ') || '',
          barcode,
        },
      });
    }

    const upcRes = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    const upcData = await upcRes.json();
    const upcItem = upcData.items?.[0];

    if (upcItem) {
      return res.json({
        found: true,
        data: {
          title:     upcItem.title || '',
          creator:   upcItem.brand || '',
          type:      inferTypeFromStrings(upcItem.title, upcItem.category),
          year:      '',
          cover_url: upcItem.images?.[0] || '',
          genre:     upcItem.category || '',
          barcode,
        },
      });
    }

    res.json({ found: false });
  } catch (err) {
    console.error('barcode lookup failed:', err.message);
    res.status(502).json({ found: false, error: 'Upstream lookup failed' });
  }
});

// Title search across Open Library, OMDb, MusicBrainz, and RAWG.
// Pass ?type= to restrict to a single source.
app.get('/api/lookup/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const type = req.query.type || '';

  if (!q) return res.json({ results: [] });

  const searches = [];

  if (!type || type === 'book') {
    searches.push(
      fetch(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=5` +
        `&fields=key,title,author_name,first_publish_year,isbn,subject,cover_i`
      )
        .then(r => r.json())
        .then(d =>
          (d.docs || []).map(b => ({
            title:     b.title,
            creator:   b.author_name?.join(', ') || '',
            type:      'book',
            year:      b.first_publish_year ? String(b.first_publish_year) : '',
            cover_url: b.cover_i
              ? `https://covers.openlibrary.org/b/id/${b.cover_i}-L.jpg`
              : '',
            genre:   b.subject?.slice(0, 3).join(', ') || '',
            barcode: b.isbn?.[0] || '',
          }))
        )
        .catch(() => [])
    );
  }

  if (!type || type === 'movie' || type === 'tv') {
    const omdbType = type === 'tv' ? 'series' : 'movie';
    searches.push(
      fetch(`https://www.omdbapi.com/?s=${encodeURIComponent(q)}&apikey=trilogy&type=${omdbType}`)
        .then(r => r.json())
        .then(d =>
          (d.Search || []).map(m => ({
            title:     m.Title,
            creator:   '',
            type:      m.Type === 'series' ? 'tv' : 'movie',
            year:      m.Year || '',
            cover_url: m.Poster !== 'N/A' ? m.Poster : '',
            genre:     '',
            barcode:   '',
          }))
        )
        .catch(() => [])
    );
  }

  if (!type || type === 'music') {
    searches.push(
      fetch(
        `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&limit=5&fmt=json`,
        { headers: { 'User-Agent': 'Shelfie/1.0 (https://github.com/youruser/shelfie)' } }
      )
        .then(r => r.json())
        .then(d =>
          (d.releases || []).map(rel => ({
            title:     rel.title,
            creator:   rel['artist-credit']?.[0]?.name || '',
            type:      'music',
            year:      rel.date?.slice(0, 4) || '',
            cover_url: '',
            genre:     '',
            barcode:   rel.barcode || '',
          }))
        )
        .catch(() => [])
    );
  }

  if (!type || type === 'game') {
    searches.push(
      fetch(`https://api.rawg.io/api/games?search=${encodeURIComponent(q)}&page_size=5`)
        .then(r => r.json())
        .then(d =>
          (d.results || []).map(g => ({
            title:     g.name,
            creator:   '',
            type:      'game',
            year:      g.released?.slice(0, 4) || '',
            cover_url: g.background_image || '',
            genre:     g.genres?.map(x => x.name).join(', ') || '',
            barcode:   '',
          }))
        )
        .catch(() => [])
    );
  }

  const batches = await Promise.all(searches);
  const results = batches.flat().slice(0, 20);

  res.json({ results });
});


// Items ------------------------------------------------------------------------

app.get('/api/items', (req, res) => {
  const {
    type,
    status,
    q,
    sort  = 'created_at',
    order = 'desc',
    page  = '1',
    limit = '500',
  } = req.query;

  const conditions = [];
  const params = [];

  if (type && type !== 'all') {
    conditions.push('type = ?');
    params.push(type);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (q) {
    conditions.push('(title LIKE ? OR creator LIKE ? OR genre LIKE ? OR notes LIKE ?)');
    const term = `%${q}%`;
    params.push(term, term, term, term);
  }

  const where     = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortCol   = SORTABLE.has(sort) ? sort : 'created_at';
  const sortDir   = order === 'asc' ? 'ASC' : 'DESC';
  const pageNum   = Math.max(1, parseInt(page, 10));
  const limitNum  = Math.min(1000, Math.max(1, parseInt(limit, 10)));
  const offset    = (pageNum - 1) * limitNum;

  const { count: total } = db
    .prepare(`SELECT COUNT(*) AS count FROM items ${where}`)
    .get(...params);

  const items = db
    .prepare(
      `SELECT * FROM items ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limitNum, offset);

  const stats = db
    .prepare('SELECT type, COUNT(*) AS count FROM items GROUP BY type ORDER BY count DESC')
    .all();

  res.json({ items, total, stats });
});

app.get('/api/items/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

app.post('/api/items', (req, res) => {
  const {
    title,
    creator     = '',
    type        = 'other',
    year        = '',
    barcode     = '',
    cover_url   = '',
    description = '',
    genre       = '',
    format      = '',
    rating      = null,
    notes       = '',
    status      = 'owned',
  } = req.body;

  if (!title?.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const id = uuidv4();

  db.prepare(`
    INSERT INTO items
      (id, title, creator, type, year, barcode, cover_url, description, genre, format, rating, notes, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title.trim(), creator, type, year, barcode, cover_url, description, genre, format, rating || null, notes, status);

  res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
});

app.put('/api/items/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updates = {};
  for (const field of MUTABLE_FIELDS) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided' });
  }

  updates.updated_at = new Date().toISOString();

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE items SET ${setClauses} WHERE id = ?`)
    .run(...Object.values(updates), req.params.id);

  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id));
});

app.delete('/api/items/:id', (req, res) => {
  const result = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).end();
});

app.post('/api/items/bulk-delete', (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > 500) {
    return res.status(400).json({ error: 'Cannot delete more than 500 items at once' });
  }

  const placeholders = ids.map(() => '?').join(', ');
  const result = db.prepare(`DELETE FROM items WHERE id IN (${placeholders})`).run(...ids);

  res.json({ deleted: result.changes });
});


// CSV --------------------------------------------------------------------------

app.post('/api/import/csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO items
      (id, title, creator, type, year, barcode, cover_url, description, genre, format, rating, notes, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importAll = db.transaction(rows => {
    let imported = 0;
    for (const row of rows) {
      const title = (row.title || '').trim();
      if (!title) continue;

      const type = VALID_TYPES.has(row.type) ? row.type : 'other';
      const rating = row.rating ? parseInt(row.rating, 10) : null;

      stmt.run(
        uuidv4(),
        title,
        row.creator || row.author || row.artist || '',
        type,
        row.year || row.published || '',
        row.barcode || row.isbn || '',
        row.cover_url || '',
        row.description || '',
        row.genre || '',
        row.format || '',
        rating && rating >= 1 && rating <= 5 ? rating : null,
        row.notes || '',
        row.status || 'owned',
      );
      imported++;
    }
    return imported;
  });

  const imported = importAll(records);
  res.json({ imported, total: records.length });
});

app.get('/api/export/csv', (req, res) => {
  const cols = [
    'id', 'title', 'creator', 'type', 'year', 'barcode',
    'cover_url', 'description', 'genre', 'format',
    'rating', 'notes', 'status', 'created_at',
  ];

  const items = db.prepare('SELECT * FROM items ORDER BY type, title').all();

  const escape = val => {
    if (val == null) return '';
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const lines = [
    cols.join(','),
    ...items.map(item => cols.map(c => escape(item[c])).join(',')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="shelfie-export.csv"');
  res.send(lines.join('\r\n'));
});


// Frontend ---------------------------------------------------------------------

// The frontend is a single HTML file baked in at build time.
// This avoids needing a separate static file server or volume mount.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

// Catch-all so the SPA can handle client-side routing if needed later
app.get('*', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});


// Helpers ----------------------------------------------------------------------

// Best-effort type inference from a UPC item's title/category string.
// Only used as a fallback when the API doesn't tell us the type directly.
function inferTypeFromStrings(...strings) {
  const haystack = strings.join(' ').toLowerCase();

  if (/blu-ray|dvd|\bmovie\b|\bfilm\b/.test(haystack))        return 'movie';
  if (/\bcd\b|vinyl|\balbum\b|\bmusic\b/.test(haystack))      return 'music';
  if (/\bgame\b|playstation|xbox|nintendo|steam/.test(haystack)) return 'game';
  if (/\bbook\b|\bnovel\b|\bhardcover\b|\bpaperback\b/.test(haystack)) return 'book';

  return 'other';
}


// Boot -------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`shelfie listening on :${PORT}`);
  console.log(`database: ${DB_PATH}`);
});
