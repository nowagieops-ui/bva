const express      = require('express');
const sqlite3      = require('sqlite3').verbose();
const { open }     = require('sqlite');
const multer       = require('multer');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directories ───────────────────────────────────────────────
const DIRS = ['uploads/books','uploads/covers','uploads/ads','uploads/videos','uploads/thumbnails','db'];
DIRS.forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Database ──────────────────────────────────────────────────
let db;
async function initDB() {
  db = await open({ filename: 'db/pagebound.db', driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      cover_file TEXT,
      words_per_episode INTEGER DEFAULT 2000,
      total_episodes INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
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
      created_at INTEGER DEFAULT (strftime('%s','now'))
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
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (strftime('%s','now'))
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
      UNIQUE(session_id, date)
    );
    CREATE TABLE IF NOT EXISTS watch_progress (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      current_ep INTEGER DEFAULT 0,
      done_eps TEXT DEFAULT '[]',
      UNIQUE(session_id, content_id)
    );
  `);
  console.log('Database ready');
}

// ── Multer ────────────────────────────────────────────────────
function makeStorage(dest) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dest),
    filename:    (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
  });
}
const bookUpload  = multer({ storage: makeStorage('uploads/books'),      limits: { fileSize: 50  * 1024 * 1024 } });
const coverUpload = multer({ storage: makeStorage('uploads/covers'),     limits: { fileSize: 5   * 1024 * 1024 } });
const adUpload    = multer({ storage: makeStorage('uploads/ads'),        limits: { fileSize: 500 * 1024 * 1024 } });
const videoUpload = multer({ storage: makeStorage('uploads/videos'),     limits: { fileSize: 2000* 1024 * 1024 } });
const thumbUpload = multer({ storage: makeStorage('uploads/thumbnails'), limits: { fileSize: 5   * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ── Admin auth ────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-pass'] || req.body?.adminPass;
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Session ───────────────────────────────────────────────────
app.post('/api/session', async (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    const s = await db.get('SELECT id FROM sessions WHERE id = ?', sessionId);
    if (s) return res.json({ sessionId: s.id });
  }
  const id = uuid();
  await db.run('INSERT INTO sessions (id) VALUES (?)', id);
  res.json({ sessionId: id });
});

// ── Daily state ───────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }

async function getOrCreateDaily(sessionId) {
  const today = todayStr();
  let state = await db.get('SELECT * FROM daily_state WHERE session_id = ? AND date = ?', sessionId, today);
  if (!state) {
    const id = uuid();
    await db.run('INSERT INTO daily_state (id, session_id, date) VALUES (?,?,?)', id, sessionId, today);
    state = await db.get('SELECT * FROM daily_state WHERE id = ?', id);
  }
  return state;
}

app.get('/api/daily', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error: 'No session' });
  const state = await getOrCreateDaily(sessionId);
  res.json({ ...state, ads_hit: JSON.parse(state.ads_hit || '[]'), dailyLimit: 3600, epDailyMax: 6, effectiveTimeLimit: 3600 + (state.bonus_secs||0), effectiveEpLimit: 6 + (state.bonus_eps||0) });
});

app.post('/api/daily/tick', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { delta = 10 } = req.body;
  const state = await getOrCreateDaily(sessionId);
  await db.run('UPDATE daily_state SET secs_watched = ? WHERE session_id = ? AND date = ?', (state.secs_watched||0)+delta, sessionId, todayStr());
  res.json({ ok: true });
});

app.post('/api/daily/ad-hit', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { trigger } = req.body;
  const state = await getOrCreateDaily(sessionId);
  const hits = JSON.parse(state.ads_hit || '[]');
  if (!hits.includes(trigger)) { hits.push(trigger); await db.run('UPDATE daily_state SET ads_hit = ? WHERE session_id = ? AND date = ?', JSON.stringify(hits), sessionId, todayStr()); }
  res.json({ ok: true });
});

app.post('/api/daily/episode-done', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const state = await getOrCreateDaily(sessionId);
  await db.run('UPDATE daily_state SET eps_today = ? WHERE session_id = ? AND date = ?', (state.eps_today||0)+1, sessionId, todayStr());
  res.json({ ok: true });
});

app.post('/api/daily/earn', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { action } = req.body;
  const timeEarn = { ad:900, share:1800, both:2700 };
  const epEarn   = { ad:0,   share:1,    both:2    };
  const state = await getOrCreateDaily(sessionId);
  await db.run('UPDATE daily_state SET bonus_secs = ?, bonus_eps = ? WHERE session_id = ? AND date = ?',
    (state.bonus_secs||0)+(timeEarn[action]||0), (state.bonus_eps||0)+(epEarn[action]||0), sessionId, todayStr());
  res.json({ ok: true });
});

// ── Progress ──────────────────────────────────────────────────
app.get('/api/progress/:type/:contentId', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  let p = await db.get('SELECT * FROM watch_progress WHERE session_id=? AND content_id=? AND content_type=?', sessionId, req.params.contentId, req.params.type);
  if (!p) {
    const id = uuid();
    await db.run('INSERT INTO watch_progress (id,session_id,content_id,content_type) VALUES (?,?,?,?)', id, sessionId, req.params.contentId, req.params.type);
    p = await db.get('SELECT * FROM watch_progress WHERE id=?', id);
  }
  res.json({ ...p, done_eps: JSON.parse(p.done_eps||'[]') });
});

app.post('/api/progress/:type/:contentId', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { currentEp, doneEps } = req.body;
  await db.run(`INSERT INTO watch_progress (id,session_id,content_id,content_type,current_ep,done_eps) VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id,content_id) DO UPDATE SET current_ep=excluded.current_ep, done_eps=excluded.done_eps`,
    uuid(), sessionId, req.params.contentId, req.params.type, currentEp, JSON.stringify(doneEps||[]));
  res.json({ ok: true });
});

// ── BOOKS ─────────────────────────────────────────────────────
function parseBook(text, wpe) {
  const cleaned = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
  const paragraphs = cleaned.split(/\n\n+/).map(p=>p.trim()).filter(Boolean);
  const eps=[]; let cur=[],cw=0,n=1;
  for (const para of paragraphs) {
    const wc=para.split(/\s+/).length;
    if(cw>0&&cw+wc>wpe*1.15){eps.push({n,paras:cur,wc:cw});n++;cur=[para];cw=wc;}
    else{cur.push(para);cw+=wc;}
  }
  if(cur.length) eps.push({n,paras:cur,wc:cw});
  return eps.map(ep=>{
    const content=ep.paras.join('\n\n');let title='';
    for(const p of ep.paras){const t=p.trim();if(t.length>10&&!/^(chapter|part|book|section|prologue|epilogue|introduction|preface|\d+\.?\s*$)/i.test(t)){title=t.split(/\s+/).slice(0,6).join(' ').replace(/[,;:!?—–]$/,'')+(t.split(/\s+/).length>6?'...':'');break;}}
    return{n:ep.n,title:title||'Episode '+ep.n,content,wordCount:ep.wc};
  });
}

app.post('/api/books/upload', requireAdmin, bookUpload.single('book'), async (req, res) => {
  try {
    const { title, author, wordsPerEpisode=2000 } = req.body;
    if (!req.file||!title) return res.status(400).json({error:'Missing file or title'});
    const text = fs.readFileSync(req.file.path,'utf8');
    fs.unlinkSync(req.file.path);
    const episodes = parseBook(text, parseInt(wordsPerEpisode));
    const bookId = uuid();
    await db.run('INSERT INTO books (id,title,author,words_per_episode,total_episodes) VALUES (?,?,?,?,?)', bookId, title, author||'', parseInt(wordsPerEpisode), episodes.length);
    for (const ep of episodes) {
      await db.run('INSERT INTO book_episodes (id,book_id,episode_number,title,content,word_count) VALUES (?,?,?,?,?,?)', uuid(), bookId, ep.n, ep.title, ep.content, ep.wordCount);
    }
    res.json({ bookId, title, totalEpisodes: episodes.length });
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.post('/api/books/:id/cover', requireAdmin, coverUpload.single('cover'), async (req,res) => {
  await db.run('UPDATE books SET cover_file=? WHERE id=?', req.file.filename, req.params.id);
  res.json({ coverUrl:'/uploads/covers/'+req.file.filename });
});

app.get('/api/books', async (req,res) => {
  const books = await db.all('SELECT * FROM books ORDER BY created_at DESC');
  res.json(books.map(b=>({...b,coverUrl:b.cover_file?'/uploads/covers/'+b.cover_file:null})));
});

app.get('/api/books/:id', async (req,res) => {
  const book = await db.get('SELECT * FROM books WHERE id=?', req.params.id);
  if(!book) return res.status(404).json({error:'Not found'});
  const episodes = await db.all('SELECT id,episode_number,title,word_count FROM book_episodes WHERE book_id=? ORDER BY episode_number', req.params.id);
  res.json({...book,coverUrl:book.cover_file?'/uploads/covers/'+book.cover_file:null,episodes});
});

app.get('/api/books/:id/episodes/:num', async (req,res) => {
  const ep = await db.get('SELECT * FROM book_episodes WHERE book_id=? AND episode_number=?', req.params.id, req.params.num);
  if(!ep) return res.status(404).json({error:'Not found'});
  res.json(ep);
});

app.delete('/api/books/:id', requireAdmin, async (req,res) => {
  const book = await db.get('SELECT * FROM books WHERE id=?', req.params.id);
  if(book?.cover_file){try{fs.unlinkSync('uploads/covers/'+book.cover_file);}catch{}}
  await db.run('DELETE FROM book_episodes WHERE book_id=?', req.params.id);
  await db.run('DELETE FROM books WHERE id=?', req.params.id);
  res.json({ok:true});
});

// ── SHOWS ─────────────────────────────────────────────────────
app.post('/api/shows', requireAdmin, async (req,res) => {
  const { title, creator } = req.body;
  if(!title) return res.status(400).json({error:'Title required'});
  let show = await db.get('SELECT * FROM shows WHERE lower(title)=lower(?)', title);
  if(!show){const id=uuid();await db.run('INSERT INTO shows (id,title,creator) VALUES (?,?,?)',id,title,creator||'');show=await db.get('SELECT * FROM shows WHERE id=?',id);}
  res.json(show);
});

app.post('/api/shows/:id/thumb', requireAdmin, thumbUpload.single('thumb'), async (req,res) => {
  await db.run('UPDATE shows SET thumb_file=? WHERE id=?', req.file.filename, req.params.id);
  res.json({ thumbUrl:'/uploads/thumbnails/'+req.file.filename });
});

app.post('/api/shows/:id/episodes', requireAdmin, videoUpload.fields([{name:'video',maxCount:1},{name:'thumb',maxCount:1}]), async (req,res) => {
  const { title } = req.body;
  const videoFile = req.files?.video?.[0];
  const thumbFile = req.files?.thumb?.[0];
  if(!videoFile||!title) return res.status(400).json({error:'Missing video or title'});
  const count = await db.get('SELECT COUNT(*) as c FROM show_episodes WHERE show_id=?', req.params.id);
  const epNum = count.c+1;
  const id = uuid();
  await db.run('INSERT INTO show_episodes (id,show_id,episode_number,title,video_file,thumb_file) VALUES (?,?,?,?,?,?)',
    id, req.params.id, epNum, title, videoFile.filename, thumbFile?.filename||null);
  res.json({ id, episodeNumber:epNum, title, videoUrl:'/uploads/videos/'+videoFile.filename });
});

app.get('/api/shows', async (req,res) => {
  const shows = await db.all('SELECT * FROM shows ORDER BY created_at DESC');
  const result = await Promise.all(shows.map(async s => ({
    ...s,
    thumbUrl: s.thumb_file?'/uploads/thumbnails/'+s.thumb_file:null,
    episodeCount: (await db.get('SELECT COUNT(*) as c FROM show_episodes WHERE show_id=?',s.id)).c
  })));
  res.json(result);
});

app.get('/api/shows/:id', async (req,res) => {
  const show = await db.get('SELECT * FROM shows WHERE id=?', req.params.id);
  if(!show) return res.status(404).json({error:'Not found'});
  const episodes = await db.all('SELECT id,episode_number,title,thumb_file,duration_seconds FROM show_episodes WHERE show_id=? ORDER BY episode_number', req.params.id);
  res.json({...show,thumbUrl:show.thumb_file?'/uploads/thumbnails/'+show.thumb_file:null,episodes:episodes.map(ep=>({...ep,thumbUrl:ep.thumb_file?'/uploads/thumbnails/'+ep.thumb_file:null}))});
});

app.get('/api/shows/:showId/episodes/:epNum/video', async (req,res) => {
  const ep = await db.get('SELECT * FROM show_episodes WHERE show_id=? AND episode_number=?', req.params.showId, req.params.epNum);
  if(!ep) return res.status(404).send('Not found');
  const filePath = path.join(__dirname,'uploads/videos',ep.video_file);
  if(!fs.existsSync(filePath)) return res.status(404).send('File not found');
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  if(range){
    const [startStr,endStr] = range.replace(/bytes=/,'').split('-');
    const start = parseInt(startStr);
    const end = endStr?parseInt(endStr):Math.min(start+1024*1024*2,stat.size-1);
    res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Type':'video/mp4'});
    fs.createReadStream(filePath,{start,end}).pipe(res);
  } else {
    res.writeHead(200,{'Content-Length':stat.size,'Content-Type':'video/mp4','Accept-Ranges':'bytes'});
    fs.createReadStream(filePath).pipe(res);
  }
});

app.delete('/api/shows/:id', requireAdmin, async (req,res) => {
  const eps = await db.all('SELECT * FROM show_episodes WHERE show_id=?', req.params.id);
  eps.forEach(ep=>{
    if(ep.video_file){try{fs.unlinkSync('uploads/videos/'+ep.video_file);}catch{}}
    if(ep.thumb_file){try{fs.unlinkSync('uploads/thumbnails/'+ep.thumb_file);}catch{}}
  });
  const show = await db.get('SELECT * FROM shows WHERE id=?',req.params.id);
  if(show?.thumb_file){try{fs.unlinkSync('uploads/thumbnails/'+show.thumb_file);}catch{}}
  await db.run('DELETE FROM show_episodes WHERE show_id=?', req.params.id);
  await db.run('DELETE FROM shows WHERE id=?', req.params.id);
  res.json({ok:true});
});

// ── ADS ───────────────────────────────────────────────────────
app.post('/api/ads', requireAdmin, adUpload.single('ad'), async (req,res) => {
  const { name } = req.body;
  if(!req.file) return res.status(400).json({error:'No file'});
  const type = req.file.mimetype.startsWith('video')?'video':'image';
  const id = uuid();
  await db.run('INSERT INTO ads (id,name,file,type) VALUES (?,?,?,?)', id, name||req.file.originalname, req.file.filename, type);
  res.json({id,name:name||req.file.originalname});
});

app.get('/api/ads', async (req,res) => {
  const ads = await db.all('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC');
  res.json(ads.map(a=>({...a,url:'/uploads/ads/'+a.file})));
});

app.get('/api/ads/random', async (req,res) => {
  const ads = await db.all('SELECT * FROM ads WHERE active=1');
  if(!ads.length) return res.json(null);
  const ad = ads[Math.floor(Math.random()*ads.length)];
  res.json({...ad,url:'/uploads/ads/'+ad.file});
});

app.delete('/api/ads/:id', requireAdmin, async (req,res) => {
  const ad = await db.get('SELECT * FROM ads WHERE id=?', req.params.id);
  if(ad?.file){try{fs.unlinkSync('uploads/ads/'+ad.file);}catch{}}
  await db.run('DELETE FROM ads WHERE id=?', req.params.id);
  res.json({ok:true});
});

// ── Admin verify ──────────────────────────────────────────────
app.post('/api/admin/verify', (req,res) => {
  const { password } = req.body;
  if(password===ADMIN_PASS) res.json({ok:true});
  else res.status(401).json({error:'Wrong password'});
});

// ── Frontend ──────────────────────────────────────────────────
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Start ─────────────────────────────────────────────────────
initDB().then(()=>{
  app.listen(PORT, ()=>console.log(`Pagebound running on port ${PORT}`));
}).catch(err=>{
  console.error('Failed to start:', err);
  process.exit(1);
});
