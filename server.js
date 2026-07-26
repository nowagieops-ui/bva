const express    = require('express');
const Database   = require('better-sqlite3');
const multer     = require('multer');
const cors       = require('cors');
const { v4: uuid } = require('uuid');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directories ───────────────────────────────────────────────
const DIRS = ['uploads/books','uploads/covers','uploads/ads','uploads/videos','uploads/thumbnails','db'];
DIRS.forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────
const db = new Database('db/pagebound.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    cover_file TEXT,
    words_per_episode INTEGER DEFAULT 2000,
    total_episodes INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS book_episodes (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    word_count INTEGER,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator TEXT,
    thumb_file TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS show_episodes (
    id TEXT PRIMARY KEY,
    show_id TEXT NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    video_file TEXT NOT NULL,
    thumb_file TEXT,
    duration_seconds INTEGER DEFAULT 0,
    FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    type TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS daily_state (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    date TEXT NOT NULL,
    secs_watched INTEGER DEFAULT 0,
    bonus_secs INTEGER DEFAULT 0,
    eps_today INTEGER DEFAULT 0,
    bonus_eps INTEGER DEFAULT 0,
    ads_hit TEXT DEFAULT '[]',
    UNIQUE(session_id, date),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS watch_progress (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    current_ep INTEGER DEFAULT 0,
    done_eps TEXT DEFAULT '[]',
    UNIQUE(session_id, content_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`);

// ── Multer storage configs ────────────────────────────────────
function makeStorage(dest) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename:    (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
  });
}

const bookUpload  = multer({ storage: makeStorage('uploads/books'),      limits: { fileSize: 50  * 1024 * 1024 } });
const coverUpload = multer({ storage: makeStorage('uploads/covers'),     limits: { fileSize: 5   * 1024 * 1024 } });
const adUpload    = multer({ storage: makeStorage('uploads/ads'),        limits: { fileSize: 200 * 1024 * 1024 } });
const videoUpload = multer({ storage: makeStorage('uploads/videos'),     limits: { fileSize: 500 * 1024 * 1024 } });
const thumbUpload = multer({ storage: makeStorage('uploads/thumbnails'), limits: { fileSize: 5   * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// ── Admin password check ──────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-pass'] || req.body?.adminPass;
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Session ───────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    const s = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (s) return res.json({ sessionId: s.id });
  }
  const id = uuid();
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(id);
  res.json({ sessionId: id });
});

// ── Daily state ───────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }

function getOrCreateDailyState(sessionId) {
  const today = todayStr();
  let state = db.prepare('SELECT * FROM daily_state WHERE session_id = ? AND date = ?').get(sessionId, today);
  if (!state) {
    const id = uuid();
    db.prepare('INSERT INTO daily_state (id, session_id, date) VALUES (?,?,?)').run(id, sessionId, today);
    state = db.prepare('SELECT * FROM daily_state WHERE id = ?').get(id);
  }
  return state;
}

app.get('/api/daily', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  const state = getOrCreateDailyState(sessionId);
  res.json({
    ...state,
    ads_hit: JSON.parse(state.ads_hit || '[]'),
    dailyLimit: 3600,
    epDailyMax: 6,
    effectiveTimeLimit: 3600 + (state.bonus_secs || 0),
    effectiveEpLimit:   6    + (state.bonus_eps  || 0)
  });
});

app.post('/api/daily/tick', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { delta = 10 } = req.body;
  const state = getOrCreateDailyState(sessionId);
  const newSecs = (state.secs_watched || 0) + delta;
  db.prepare('UPDATE daily_state SET secs_watched = ? WHERE session_id = ? AND date = ?')
    .run(newSecs, sessionId, todayStr());
  res.json({ secs_watched: newSecs });
});

app.post('/api/daily/ad-hit', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { trigger } = req.body;
  const state = getOrCreateDailyState(sessionId);
  const hits = JSON.parse(state.ads_hit || '[]');
  if (!hits.includes(trigger)) {
    hits.push(trigger);
    db.prepare('UPDATE daily_state SET ads_hit = ? WHERE session_id = ? AND date = ?')
      .run(JSON.stringify(hits), sessionId, todayStr());
  }
  res.json({ ok: true });
});

app.post('/api/daily/episode-done', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const state = getOrCreateDailyState(sessionId);
  db.prepare('UPDATE daily_state SET eps_today = ? WHERE session_id = ? AND date = ?')
    .run((state.eps_today || 0) + 1, sessionId, todayStr());
  res.json({ ok: true });
});

app.post('/api/daily/earn', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { action } = req.body;
  const timeEarn = { ad: 900, share: 1800, both: 2700 };
  const epEarn   = { ad: 0,   share: 1,    both: 2    };
  const state = getOrCreateDailyState(sessionId);
  db.prepare('UPDATE daily_state SET bonus_secs = ?, bonus_eps = ? WHERE session_id = ? AND date = ?')
    .run(
      (state.bonus_secs || 0) + (timeEarn[action] || 0),
      (state.bonus_eps  || 0) + (epEarn[action]   || 0),
      sessionId, todayStr()
    );
  res.json({ ok: true });
});

// ── Watch progress ────────────────────────────────────────────
app.get('/api/progress/:type/:contentId', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  let p = db.prepare('SELECT * FROM watch_progress WHERE session_id = ? AND content_id = ? AND content_type = ?')
    .get(sessionId, req.params.contentId, req.params.type);
  if (!p) {
    const id = uuid();
    db.prepare('INSERT INTO watch_progress (id,session_id,content_id,content_type) VALUES (?,?,?,?)').run(id, sessionId, req.params.contentId, req.params.type);
    p = db.prepare('SELECT * FROM watch_progress WHERE id = ?').get(id);
  }
  res.json({ ...p, done_eps: JSON.parse(p.done_eps || '[]') });
});

app.post('/api/progress/:type/:contentId', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { currentEp, doneEps } = req.body;
  db.prepare(`
    INSERT INTO watch_progress (id,session_id,content_id,content_type,current_ep,done_eps)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id,content_id) DO UPDATE SET current_ep=excluded.current_ep, done_eps=excluded.done_eps
  `).run(uuid(), sessionId, req.params.contentId, req.params.type, currentEp, JSON.stringify(doneEps || []));
  res.json({ ok: true });
});

// ── BOOKS ─────────────────────────────────────────────────────
function parseBook(text, wpe) {
  const cleaned = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
  const paragraphs = cleaned.split(/\n\n+/).map(p=>p.trim()).filter(Boolean);
  const eps = []; let cur = [], cw = 0, n = 1;
  for (const para of paragraphs) {
    const wc = para.split(/\s+/).length;
    if (cw > 0 && cw + wc > wpe * 1.15) { eps.push({ n, paras: cur, wc: cw }); n++; cur = [para]; cw = wc; }
    else { cur.push(para); cw += wc; }
  }
  if (cur.length) eps.push({ n, paras: cur, wc: cw });
  return eps.map(ep => {
    const content = ep.paras.join('\n\n'); let title = '';
    for (const p of ep.paras) { const t = p.trim(); if (t.length > 10 && !/^(chapter|part|book|section|prologue|epilogue|introduction|preface|\d+\.?\s*$)/i.test(t)) { title = t.split(/\s+/).slice(0,6).join(' ').replace(/[,;:!?—–]$/,'') + (t.split(/\s+/).length>6?'...':''); break; } }
    return { n: ep.n, title: title || 'Episode ' + ep.n, content, wordCount: ep.wc };
  });
}

// Upload book (admin)
app.post('/api/books/upload', requireAdmin, bookUpload.single('book'), async (req, res) => {
  try {
    const file = req.file;
    const { title, author, wordsPerEpisode = 2000 } = req.body;
    if (!file || !title) return res.status(400).json({ error: 'Missing file or title' });

    const text = fs.readFileSync(file.path, 'utf8');
    fs.unlinkSync(file.path);

    const episodes = parseBook(text, parseInt(wordsPerEpisode));
    const bookId = uuid();

    db.prepare('INSERT INTO books (id,title,author,words_per_episode,total_episodes) VALUES (?,?,?,?,?)')
      .run(bookId, title, author || '', parseInt(wordsPerEpisode), episodes.length);

    const insertEp = db.prepare('INSERT INTO book_episodes (id,book_id,episode_number,title,content,word_count) VALUES (?,?,?,?,?,?)');
    db.transaction(() => { for (const ep of episodes) insertEp.run(uuid(), bookId, ep.n, ep.title, ep.content, ep.wordCount); })();

    res.json({ bookId, title, totalEpisodes: episodes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload book cover (admin)
app.post('/api/books/:id/cover', requireAdmin, coverUpload.single('cover'), (req, res) => {
  const { id } = req.params;
  db.prepare('UPDATE books SET cover_file = ? WHERE id = ?').run(req.file.filename, id);
  res.json({ coverUrl: '/uploads/covers/' + req.file.filename });
});

// List books
app.get('/api/books', (req, res) => {
  const books = db.prepare('SELECT id,title,author,cover_file,total_episodes,created_at FROM books ORDER BY created_at DESC').all();
  res.json(books.map(b => ({ ...b, coverUrl: b.cover_file ? '/uploads/covers/'+b.cover_file : null })));
});

// Get book + episode list
app.get('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).json({ error: 'Not found' });
  const episodes = db.prepare('SELECT id,episode_number,title,word_count FROM book_episodes WHERE book_id = ? ORDER BY episode_number').all(req.params.id);
  res.json({ ...book, coverUrl: book.cover_file ? '/uploads/covers/'+book.cover_file : null, episodes });
});

// Get episode content
app.get('/api/books/:id/episodes/:num', (req, res) => {
  const ep = db.prepare('SELECT * FROM book_episodes WHERE book_id = ? AND episode_number = ?').get(req.params.id, req.params.num);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  res.json(ep);
});

// Delete book (admin)
app.delete('/api/books/:id', requireAdmin, (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (book?.cover_file) { try { fs.unlinkSync('uploads/covers/' + book.cover_file); } catch {} }
  db.prepare('DELETE FROM book_episodes WHERE book_id = ?').run(req.params.id);
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── SHOWS ─────────────────────────────────────────────────────
// Create / get show
app.post('/api/shows', requireAdmin, (req, res) => {
  const { title, creator } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  let show = db.prepare('SELECT * FROM shows WHERE lower(title) = lower(?)').get(title);
  if (!show) {
    const id = uuid();
    db.prepare('INSERT INTO shows (id,title,creator) VALUES (?,?,?)').run(id, title, creator || '');
    show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  }
  res.json(show);
});

// Upload show thumbnail
app.post('/api/shows/:id/thumb', requireAdmin, thumbUpload.single('thumb'), (req, res) => {
  db.prepare('UPDATE shows SET thumb_file = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ thumbUrl: '/uploads/thumbnails/' + req.file.filename });
});

// Upload episode video
app.post('/api/shows/:id/episodes', requireAdmin,
  videoUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  (req, res) => {
    const { title } = req.body;
    const videoFile = req.files?.video?.[0];
    const thumbFile = req.files?.thumb?.[0];
    if (!videoFile || !title) return res.status(400).json({ error: 'Missing video or title' });
    const showId = req.params.id;
    const count = db.prepare('SELECT COUNT(*) as c FROM show_episodes WHERE show_id = ?').get(showId).c;
    const epNum = count + 1;
    const id = uuid();
    db.prepare('INSERT INTO show_episodes (id,show_id,episode_number,title,video_file,thumb_file) VALUES (?,?,?,?,?,?)')
      .run(id, showId, epNum, title, videoFile.filename, thumbFile?.filename || null);
    res.json({ id, episodeNumber: epNum, title, videoUrl: '/uploads/videos/'+videoFile.filename });
  }
);

// List shows
app.get('/api/shows', (req, res) => {
  const shows = db.prepare('SELECT * FROM shows ORDER BY created_at DESC').all();
  res.json(shows.map(s => ({
    ...s,
    thumbUrl: s.thumb_file ? '/uploads/thumbnails/'+s.thumb_file : null,
    episodeCount: db.prepare('SELECT COUNT(*) as c FROM show_episodes WHERE show_id = ?').get(s.id).c
  })));
});

// Get show + episodes
app.get('/api/shows/:id', (req, res) => {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(req.params.id);
  if (!show) return res.status(404).json({ error: 'Not found' });
  const episodes = db.prepare('SELECT id,episode_number,title,thumb_file,duration_seconds FROM show_episodes WHERE show_id = ? ORDER BY episode_number').all(req.params.id);
  res.json({
    ...show,
    thumbUrl: show.thumb_file ? '/uploads/thumbnails/'+show.thumb_file : null,
    episodes: episodes.map(ep => ({ ...ep, thumbUrl: ep.thumb_file ? '/uploads/thumbnails/'+ep.thumb_file : null, videoUrl: null }))
  });
});

// Stream episode video
app.get('/api/shows/:showId/episodes/:epNum/video', (req, res) => {
  const ep = db.prepare('SELECT * FROM show_episodes WHERE show_id = ? AND episode_number = ?').get(req.params.showId, req.params.epNum);
  if (!ep) return res.status(404).send('Not found');
  const filePath = path.join(__dirname, 'uploads/videos', ep.video_file);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if (range) {
    const [start, end] = range.replace(/bytes=/, '').split('-').map(Number);
    const chunkEnd = end || Math.min(start + 1024*1024, stat.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${chunkEnd}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkEnd - start + 1,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath, { start, end: chunkEnd }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Delete show
app.delete('/api/shows/:id', requireAdmin, (req, res) => {
  const eps = db.prepare('SELECT * FROM show_episodes WHERE show_id = ?').all(req.params.id);
  eps.forEach(ep => {
    if (ep.video_file) { try { fs.unlinkSync('uploads/videos/'+ep.video_file); } catch {} }
    if (ep.thumb_file) { try { fs.unlinkSync('uploads/thumbnails/'+ep.thumb_file); } catch {} }
  });
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(req.params.id);
  if (show?.thumb_file) { try { fs.unlinkSync('uploads/thumbnails/'+show.thumb_file); } catch {} }
  db.prepare('DELETE FROM show_episodes WHERE show_id = ?').run(req.params.id);
  db.prepare('DELETE FROM shows WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── ADS ───────────────────────────────────────────────────────
app.post('/api/ads', requireAdmin, adUpload.single('ad'), (req, res) => {
  const { name } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });
  const type = file.mimetype.startsWith('video') ? 'video' : 'image';
  const id = uuid();
  db.prepare('INSERT INTO ads (id,name,file,type) VALUES (?,?,?,?)').run(id, name || file.originalname, file.filename, type);
  res.json({ id, name: name || file.originalname });
});

app.get('/api/ads', (req, res) => {
  res.json(db.prepare('SELECT id,name,file,type,created_at FROM ads WHERE active=1 ORDER BY created_at DESC').all()
    .map(a => ({ ...a, url: '/uploads/ads/'+a.file })));
});

app.get('/api/ads/random', (req, res) => {
  const ads = db.prepare('SELECT * FROM ads WHERE active=1').all();
  if (!ads.length) return res.json(null);
  const ad = ads[Math.floor(Math.random() * ads.length)];
  res.json({ ...ad, url: '/uploads/ads/'+ad.file });
});

app.delete('/api/ads/:id', requireAdmin, (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (ad?.file) { try { fs.unlinkSync('uploads/ads/'+ad.file); } catch {} }
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Admin verify ──────────────────────────────────────────────
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASS) res.json({ ok: true });
  else res.status(401).json({ error: 'Wrong password' });
});

// ── Serve frontend ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Pagebound running on port ${PORT}`));
