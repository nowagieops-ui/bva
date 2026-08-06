const express      = require('express');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY||'');
const sqlite3      = require('sqlite3').verbose();
const { open }     = require('sqlite');
const multer       = require('multer');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Dirs ──────────────────────────────────────────────────────
// Ensure all required directories exist
const REQUIRED_DIRS = ['uploads/books','uploads/covers','uploads/ads','db'];
REQUIRED_DIRS.forEach(d => {
  try { fs.mkdirSync(d, {recursive:true}); }
  catch(e) { console.error('Could not create dir', d, e.message); }
});

// ── DB ────────────────────────────────────────────────────────
let db;
async function initDB() {
  db = await open({ filename:'db/pagebound.db', driver:sqlite3.Database });
  await db.exec('PRAGMA journal_mode=WAL');
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
      word_count INTEGER
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
      ip TEXT,
      user_agent TEXT,
      country TEXT,
      first_seen INTEGER DEFAULT (strftime('%s','now')),
      last_seen INTEGER DEFAULT (strftime('%s','now')),
      total_visits INTEGER DEFAULT 1
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
    CREATE TABLE IF NOT EXISTS reading_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      episode_number INTEGER NOT NULL,
      secs_read INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS watch_progress (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      current_ep INTEGER DEFAULT 0,
      done_eps TEXT DEFAULT '[]',
      UNIQUE(session_id, content_id)
    );
    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      path TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS paid_unlocks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      stripe_session_id TEXT UNIQUE,
      words_unlocked INTEGER DEFAULT 10000,
      words_used INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  console.log('DB ready');
}

// ── Multer ────────────────────────────────────────────────────
function store(dest) {
  return multer.diskStorage({
    destination: (_,__,cb) => cb(null,dest),
    filename:    (_,file,cb) => cb(null,uuid()+path.extname(file.originalname))
  });
}
const bookUp  = multer({storage:store('uploads/books'), limits:{fileSize:50*1024*1024}});
const coverUp = multer({storage:store('uploads/covers'),limits:{fileSize:5*1024*1024}});
const adUp    = multer({storage:store('uploads/ads'),   limits:{fileSize:500*1024*1024}});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// Serve uploads with proper headers — video needs range request support
app.use('/uploads', (req, res, next) => {
  const filePath = path.join(__dirname, 'uploads', req.path);
  const ext = path.extname(req.path).toLowerCase();
  const videoExts = ['.mp4','.mov','.webm','.m4v','.avi'];
  if (videoExts.includes(ext)) {
    // Serve video with range support for proper playback
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const stat = fs.statSync(filePath);
    const mimeTypes = {'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4','.avi':'video/x-msvideo'};
    const mime = mimeTypes[ext] || 'video/mp4';
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]);
      const end = parts[1] ? parseInt(parts[1]) : Math.min(start + 1024*1024*2, stat.size - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      });
      fs.createReadStream(filePath, {start, end}).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    next();
  }
}, express.static('uploads'));

// ── Admin guard ───────────────────────────────────────────────
function admin(req,res,next) {
  if((req.headers['x-admin-pass']||req.body?.adminPass)!==ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function getIP(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'; }

// ── Session ───────────────────────────────────────────────────
app.post('/api/session', async (req,res) => {
  const { sessionId } = req.body;
  const ip = getIP(req);
  const ua = req.headers['user-agent']||'';
  if (sessionId) {
    const s = await db.get('SELECT id FROM sessions WHERE id=?', sessionId);
    if (s) {
      await db.run('UPDATE sessions SET last_seen=strftime(\'%s\',\'now\'), total_visits=total_visits+1 WHERE id=?', sessionId);
      // Log page view
      await db.run('INSERT INTO page_views (id,session_id,path) VALUES (?,?,?)', uuid(), sessionId, req.body.path||'/');
      return res.json({sessionId:s.id});
    }
  }
  const id = uuid();
  await db.run('INSERT INTO sessions (id,ip,user_agent) VALUES (?,?,?)', id, ip, ua);
  await db.run('INSERT INTO page_views (id,session_id,path) VALUES (?,?,?)', uuid(), id, req.body.path||'/');
  res.json({sessionId:id});
});

// ── Daily state ───────────────────────────────────────────────
async function getOrCreateDaily(sessionId) {
  const t = today();
  let s = await db.get('SELECT * FROM daily_state WHERE session_id=? AND date=?', sessionId, t);
  if (!s) {
    const id=uuid();
    await db.run('INSERT INTO daily_state (id,session_id,date) VALUES (?,?,?)', id, sessionId, t);
    s = await db.get('SELECT * FROM daily_state WHERE id=?', id);
  }
  return s;
}

app.get('/api/daily', async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const s = await getOrCreateDaily(sid);
  res.json({...s, ads_hit:JSON.parse(s.ads_hit||'[]'), effectiveTimeLimit:3600+(s.bonus_secs||0), effectiveEpLimit:6+(s.bonus_eps||0)});
});

app.post('/api/daily/tick', async (req,res) => {
  const sid = req.headers['x-session-id'];
  const {delta=10, bookId, episodeNumber} = req.body;
  const s = await getOrCreateDaily(sid);
  await db.run('UPDATE daily_state SET secs_watched=? WHERE session_id=? AND date=?', (s.secs_watched||0)+delta, sid, today());
  // Track reading event for analytics
  if (bookId) {
    const existing = await db.get('SELECT id FROM reading_events WHERE session_id=? AND book_id=? AND episode_number=? AND date=?', sid, bookId, episodeNumber||0, today());
    if (existing) await db.run('UPDATE reading_events SET secs_read=secs_read+? WHERE id=?', delta, existing.id);
    else await db.run('INSERT INTO reading_events (id,session_id,book_id,episode_number,secs_read,date) VALUES (?,?,?,?,?,?)', uuid(), sid, bookId, episodeNumber||0, delta, today());
  }
  res.json({ok:true});
});

app.post('/api/daily/ad-hit', async (req,res) => {
  const sid=req.headers['x-session-id'], {trigger}=req.body;
  const s=await getOrCreateDaily(sid);
  const hits=JSON.parse(s.ads_hit||'[]');
  if(!hits.includes(trigger)){hits.push(trigger);await db.run('UPDATE daily_state SET ads_hit=? WHERE session_id=? AND date=?',JSON.stringify(hits),sid,today());}
  res.json({ok:true});
});

app.post('/api/daily/episode-done', async (req,res) => {
  const sid=req.headers['x-session-id'];
  const s=await getOrCreateDaily(sid);
  await db.run('UPDATE daily_state SET eps_today=? WHERE session_id=? AND date=?',(s.eps_today||0)+1,sid,today());
  res.json({ok:true});
});

app.post('/api/daily/earn', async (req,res) => {
  const sid=req.headers['x-session-id'],{action}=req.body;
  const te={ad:900,share:1800,both:2700},ee={ad:0,share:1,both:2};
  const s=await getOrCreateDaily(sid);
  await db.run('UPDATE daily_state SET bonus_secs=?,bonus_eps=? WHERE session_id=? AND date=?',(s.bonus_secs||0)+(te[action]||0),(s.bonus_eps||0)+(ee[action]||0),sid,today());
  res.json({ok:true});
});

// ── Progress ──────────────────────────────────────────────────
app.get('/api/progress/:contentId', async (req,res) => {
  const sid=req.headers['x-session-id'];
  let p=await db.get('SELECT * FROM watch_progress WHERE session_id=? AND content_id=?',sid,req.params.contentId);
  if(!p){const id=uuid();await db.run('INSERT INTO watch_progress (id,session_id,content_id) VALUES (?,?,?)',id,sid,req.params.contentId);p=await db.get('SELECT * FROM watch_progress WHERE id=?',id);}
  res.json({...p,done_eps:JSON.parse(p.done_eps||'[]')});
});

app.post('/api/progress/:contentId', async (req,res) => {
  const sid=req.headers['x-session-id'],{currentEp,doneEps}=req.body;
  await db.run(`INSERT INTO watch_progress (id,session_id,content_id,current_ep,done_eps) VALUES (?,?,?,?,?)
    ON CONFLICT(session_id,content_id) DO UPDATE SET current_ep=excluded.current_ep,done_eps=excluded.done_eps`,
    uuid(),sid,req.params.contentId,currentEp,JSON.stringify(doneEps||[]));
  res.json({ok:true});
});

// ── Books ─────────────────────────────────────────────────────
function parseBook(text,wpe){
  try {
    // Limit to 5MB of text to prevent memory issues
    if(text.length>5*1024*1024) text=text.slice(0,5*1024*1024);
    const cleaned=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
    const paras=cleaned.split(/\n\n+/).map(p=>p.trim()).filter(Boolean);
    const eps=[];let cur=[],cw=0,n=1;
    for(const p of paras){
      const wc=p.split(/\s+/).length;
      if(cw>0&&cw+wc>wpe*1.15){eps.push(makeEp(n,cur));n++;cur=[p];cw=wc;}
      else{cur.push(p);cw+=wc;}
    }
    if(cur.length)eps.push(makeEp(n,cur));
    if(eps.length===0) throw new Error('No content found in file');
    return eps;
  } catch(e) {
    console.error('parseBook error:',e.message);
    throw e;
  }
}
function makeEp(n,paras){
  try {
    const content=paras.join('\n\n');
    let title='';
    for(const p of paras){
      const t=p.trim();
      if(t.length>10&&t.length<200&&!/^(chapter|part|book|section|prologue|epilogue|introduction|preface|\d+\.?\s*$)/i.test(t)){
        title=t.split(/\s+/).slice(0,6).join(' ').replace(/[,;:!?—–]$/,'')+(t.split(/\s+/).length>6?'...':'');
        break;
      }
    }
    return{n,title:title||'Episode '+n,content,wordCount:content.split(/\s+/).length};
  } catch(e) {
    return{n,title:'Episode '+n,content:paras.join('\n\n'),wordCount:0};
  }
}

app.post('/api/books/upload', admin, (req,res,next)=>{
  bookUp.single('book')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message||'Upload failed'});
    next();
  });
}, async (req,res) => {
  const filePath = req.file?.path;
  try{
    const {title,author,wordsPerEpisode=2000}=req.body;
    if(!req.file||!title){
      if(filePath) try{fs.unlinkSync(filePath);}catch{}
      return res.status(400).json({error:'Missing file or title'});
    }
    // Read file safely
    let text;
    try{
      text=fs.readFileSync(filePath,'utf8');
    }catch(e){
      try{text=fs.readFileSync(filePath,'latin1');}catch(e2){
        return res.status(400).json({error:'Could not read file — try saving as UTF-8 text'});
      }
    }
    try{fs.unlinkSync(filePath);}catch{}

    const wpe=Math.max(500,Math.min(5000,parseInt(wordsPerEpisode)||2000));
    const eps=parseBook(text,wpe);
    const id=uuid();

    await db.run('INSERT INTO books (id,title,author,words_per_episode,total_episodes) VALUES (?,?,?,?,?)',
      id,title,author||'',wpe,eps.length);

    // Insert episodes in batches to avoid timeouts on large books
    const BATCH=20;
    for(let i=0;i<eps.length;i+=BATCH){
      const batch=eps.slice(i,i+BATCH);
      await Promise.all(batch.map(ep=>
        db.run('INSERT INTO book_episodes (id,book_id,episode_number,title,content,word_count) VALUES (?,?,?,?,?,?)',
          uuid(),id,ep.n,ep.title,ep.content,ep.wordCount)
      ));
    }
    res.json({bookId:id,title,totalEpisodes:eps.length});
  }catch(e){
    console.error('Book upload error:',e);
    if(filePath) try{fs.unlinkSync(filePath);}catch{}
    res.status(500).json({error:e.message||'Upload failed'});
  }
});

app.post('/api/books/:id/cover', admin, coverUp.single('cover'), async (req,res) => {
  await db.run('UPDATE books SET cover_file=? WHERE id=?',req.file.filename,req.params.id);
  res.json({coverUrl:'/uploads/covers/'+req.file.filename});
});

app.get('/api/books', async (_,res) => {
  const books=await db.all('SELECT * FROM books ORDER BY created_at DESC');
  res.json(books.map(b=>({...b,coverUrl:b.cover_file?'/uploads/covers/'+b.cover_file:null})));
});

app.get('/api/books/:id', async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(!b) return res.status(404).json({error:'Not found'});
  const eps=await db.all('SELECT id,episode_number,title,word_count FROM book_episodes WHERE book_id=? ORDER BY episode_number',req.params.id);
  res.json({...b,coverUrl:b.cover_file?'/uploads/covers/'+b.cover_file:null,episodes:eps});
});

app.get('/api/books/:id/episodes/:num', async (req,res) => {
  const ep=await db.get('SELECT * FROM book_episodes WHERE book_id=? AND episode_number=?',req.params.id,req.params.num);
  if(!ep) return res.status(404).json({error:'Not found'});
  res.json(ep);
});

app.delete('/api/books/:id', admin, async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(b?.cover_file){try{fs.unlinkSync('uploads/covers/'+b.cover_file);}catch{}}
  await db.run('DELETE FROM book_episodes WHERE book_id=?',req.params.id);
  await db.run('DELETE FROM books WHERE id=?',req.params.id);
  res.json({ok:true});
});

// ── Ads ───────────────────────────────────────────────────────
app.post('/api/ads', admin, (req,res,next) => {
  adUp.single('ad')(req,res,(err)=>{
    if(err){
      if(err.code==='LIMIT_FILE_SIZE') return res.status(413).json({error:'File too large — max 500 MB'});
      return res.status(400).json({error:err.message||'Upload failed'});
    }
    next();
  });
}, async (req,res) => {
  try {
    if(!req.file) return res.status(400).json({error:'No file received'});
    const type=req.file.mimetype.startsWith('video')?'video':'image';
    const id=uuid();
    await db.run('INSERT INTO ads (id,name,file,type) VALUES (?,?,?,?)',id,req.body.name||req.file.originalname,req.file.filename,type);
    res.json({id,name:req.body.name||req.file.originalname});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/ads', async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC');
  res.json(ads.map(a=>({...a,url:'/uploads/ads/'+a.file})));
});
app.get('/api/ads/random', async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1');
  if(!ads.length) return res.json(null);
  const ad=ads[Math.floor(Math.random()*ads.length)];
  res.json({...ad,url:'/uploads/ads/'+ad.file});
});
app.delete('/api/ads/:id', admin, async (req,res) => {
  const ad=await db.get('SELECT * FROM ads WHERE id=?',req.params.id);
  if(ad?.file){try{fs.unlinkSync('uploads/ads/'+ad.file);}catch{}}
  await db.run('DELETE FROM ads WHERE id=?',req.params.id);
  res.json({ok:true});
});

// ── Stripe ────────────────────────────────────────────────────
// Create checkout session
app.post('/api/purchase/checkout', async (req,res) => {
  const sid = req.headers['x-session-id'];
  const { bookId } = req.body;
  if (!sid || !bookId) return res.status(400).json({error:'Missing params'});
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({error:'Stripe not configured'});
  try {
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Pagebound — Unlock next 10,000 words',
            description: 'Read on without waiting until tomorrow.',
          },
          unit_amount: 99, // $0.99
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/book/${bookId}?paid=1&cs={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/book/${bookId}?paid=0`,
      metadata: { sessionId: sid, bookId },
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// Stripe webhook — confirm payment and activate unlock
app.post('/api/stripe/webhook',
  express.raw({type:'application/json'}),
  async (req,res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      event = webhookSecret
        ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
        : JSON.parse(req.body);
    } catch(e) {
      console.error('Webhook sig error:', e.message);
      return res.status(400).send('Webhook Error');
    }
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object;
      const { sessionId, bookId } = cs.metadata||{};
      if (sessionId && bookId) {
        try {
          await db.run(
            `INSERT OR IGNORE INTO paid_unlocks (id,session_id,book_id,stripe_session_id,words_unlocked,words_used,active)
             VALUES (?,?,?,?,10000,0,1)`,
            uuid(), sessionId, bookId, cs.id
          );
          console.log('Paid unlock created for session', sessionId, 'book', bookId);
        } catch(e) { console.error('DB unlock error:', e.message); }
      }
    }
    res.json({received:true});
  }
);

// Check if session has active paid unlock for a book
app.get('/api/purchase/status/:bookId', async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const unlock = await db.get(
    'SELECT * FROM paid_unlocks WHERE session_id=? AND book_id=? AND active=1 ORDER BY created_at DESC LIMIT 1',
    sid, req.params.bookId
  );
  res.json({ active: !!unlock, wordsUnlocked: unlock?.words_unlocked||0, wordsUsed: unlock?.words_used||0 });
});

// Record words consumed from paid unlock (called as reader progresses)
app.post('/api/purchase/consume', async (req,res) => {
  const sid = req.headers['x-session-id'];
  const { bookId, wordsRead } = req.body;
  const unlock = await db.get(
    'SELECT * FROM paid_unlocks WHERE session_id=? AND book_id=? AND active=1 ORDER BY created_at DESC LIMIT 1',
    sid, bookId
  );
  if (!unlock) return res.json({active:false});
  const newUsed = (unlock.words_used||0) + (wordsRead||0);
  const exhausted = newUsed >= unlock.words_unlocked;
  await db.run(
    'UPDATE paid_unlocks SET words_used=?, active=? WHERE id=?',
    newUsed, exhausted ? 0 : 1, unlock.id
  );
  res.json({ active: !exhausted, wordsUsed: newUsed, wordsUnlocked: unlock.words_unlocked });
});

// ── Admin verify ──────────────────────────────────────────────
// Health check — always returns 200 so you know server is up
app.get('/api/health', (_,res) => res.json({ok:true, time:new Date().toISOString()}));

app.post('/api/admin/verify', (req,res) => {
  res.json(req.body.password===ADMIN_PASS?{ok:true}:{error:'Wrong password'});
});

// ── Analytics ─────────────────────────────────────────────────
app.get('/api/analytics', admin, async (req,res) => {
  const t=today();

  // Visitors
  const totalVisitors    = (await db.get('SELECT COUNT(DISTINCT id) as c FROM sessions')).c;
  const todayVisitors    = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE date(created_at,\'unixepoch\')=?',t)).c;
  const weekVisitors     = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE created_at>=strftime(\'%s\',\'now\',\'-7 days\')')).c;

  // Readers (people who actually read something)
  const totalReaders     = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM reading_events')).c;
  const todayReaders     = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM reading_events WHERE date=?',t)).c;

  // Time spent
  const avgSecsPerDay    = (await db.get('SELECT AVG(secs_watched) as a FROM daily_state WHERE secs_watched>0')).a||0;
  const totalSecsRead    = (await db.get('SELECT SUM(secs_read) as s FROM reading_events')).s||0;
  const todaySecsRead    = (await db.get('SELECT SUM(secs_read) as s FROM reading_events WHERE date=?',t)).s||0;

  // Episodes
  const totalEpsDone     = (await db.get('SELECT SUM(eps_today) as s FROM daily_state')).s||0;
  const todayEpsDone     = (await db.get('SELECT SUM(eps_today) as s FROM daily_state WHERE date=?',t)).s||0;

  // Popular books
  const popularBooks = await db.all(`
    SELECT b.title, b.author, COUNT(DISTINCT re.session_id) as readers,
           SUM(re.secs_read) as total_secs, COUNT(re.id) as events
    FROM books b
    LEFT JOIN reading_events re ON b.id=re.book_id
    GROUP BY b.id ORDER BY readers DESC LIMIT 10
  `);

  // Daily visitors last 14 days
  const dailyVisitors = await db.all(`
    SELECT date(created_at,'unixepoch') as date, COUNT(DISTINCT session_id) as visitors
    FROM page_views
    WHERE created_at>=strftime('%s','now','-14 days')
    GROUP BY date(created_at,'unixepoch')
    ORDER BY date ASC
  `);

  // Daily reading time last 14 days
  const dailyReading = await db.all(`
    SELECT date, SUM(secs_read) as secs, COUNT(DISTINCT session_id) as readers
    FROM reading_events
    WHERE created_at>=strftime('%s','now','-14 days')
    GROUP BY date ORDER BY date ASC
  `);

  // Recent sessions
  const recentSessions = await db.all(`
    SELECT s.id, s.ip, s.first_seen, s.last_seen, s.total_visits,
           ds.secs_watched, ds.eps_today
    FROM sessions s
    LEFT JOIN daily_state ds ON s.id=ds.session_id AND ds.date=?
    ORDER BY s.last_seen DESC LIMIT 20
  `, t);

  res.json({
    totalVisitors, todayVisitors, weekVisitors,
    totalReaders, todayReaders,
    avgSecsPerDay: Math.round(avgSecsPerDay),
    totalSecsRead, todaySecsRead,
    totalEpsDone, todayEpsDone,
    popularBooks, dailyVisitors, dailyReading, recentSessions
  });
});

// ── Frontend ──────────────────────────────────────────────────
// All these serve index.html — JS router handles the rest
app.get('/admin',    (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/book/:id', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',         (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// Global error handlers — server must never crash
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`Pagebound running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  // Start server anyway so it returns errors instead of being blank
  app.listen(PORT, () => console.log(`Pagebound started WITHOUT DB on port ${PORT}`));
});
