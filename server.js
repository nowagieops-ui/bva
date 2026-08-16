const express      = require('express');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY||'');
const mysql        = require('mysql2/promise');
const multer       = require('multer');
const cloudinary   = require('cloudinary').v2;
const { Readable } = require('stream');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Cloudinary ────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadToCloudinary(buffer, filename, folder, resourceType='auto') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `pagebound/${folder}`, public_id: filename, resource_type: resourceType, overwrite: true },
      (err, result) => err ? reject(err) : resolve(result)
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(publicId, resourceType='image') {
  try { await cloudinary.uploader.destroy(publicId, {resource_type: resourceType}); } catch(e) {}
}

// ── DB ────────────────────────────────────────────────────────
let db;
async function initDB() {
  db = await mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    database: process.env.DB_NAME     || 'pagebound',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  });

  db.get = async (sql, ...args) => {
    const [rows] = await db.execute(sql, args.flat());
    return rows[0] || null;
  };
  db.all = async (sql, ...args) => {
    const [rows] = await db.execute(sql, args.flat());
    return rows;
  };
  db.run = async (sql, ...args) => {
    const [result] = await db.execute(sql, args.flat());
    return result;
  };

  await db.run(`CREATE TABLE IF NOT EXISTS books (
    id VARCHAR(36) PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    cover_url TEXT,
    cover_public_id TEXT,
    words_per_episode INT DEFAULT 2000,
    total_episodes INT DEFAULT 0,
    created_at INT DEFAULT (UNIX_TIMESTAMP())
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS book_episodes (
    id VARCHAR(36) PRIMARY KEY,
    book_id VARCHAR(36) NOT NULL,
    episode_number INT NOT NULL,
    title TEXT,
    content MEDIUMTEXT NOT NULL,
    word_count INT,
    INDEX idx_book_ep (book_id, episode_number)
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS ads (
    id VARCHAR(36) PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    public_id TEXT,
    type VARCHAR(20) NOT NULL,
    active TINYINT DEFAULT 1,
    created_at INT DEFAULT (UNIX_TIMESTAMP())
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    ip VARCHAR(100),
    user_agent TEXT,
    country VARCHAR(10),
    first_seen INT DEFAULT (UNIX_TIMESTAMP()),
    last_seen INT DEFAULT (UNIX_TIMESTAMP()),
    total_visits INT DEFAULT 1
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS daily_state (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    date VARCHAR(10) NOT NULL,
    secs_watched INT DEFAULT 0,
    bonus_secs INT DEFAULT 0,
    eps_today INT DEFAULT 0,
    bonus_eps INT DEFAULT 0,
    ads_hit TEXT DEFAULT '[]',
    UNIQUE KEY uq_sess_date (session_id, date)
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS reading_events (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    book_id VARCHAR(36) NOT NULL,
    episode_number INT NOT NULL,
    secs_read INT DEFAULT 0,
    date VARCHAR(10) NOT NULL,
    created_at INT DEFAULT (UNIX_TIMESTAMP()),
    INDEX idx_re_sess (session_id),
    INDEX idx_re_book (book_id),
    INDEX idx_re_date (date)
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS watch_progress (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    content_id VARCHAR(36) NOT NULL,
    current_ep INT DEFAULT 0,
    done_eps TEXT DEFAULT '[]',
    UNIQUE KEY uq_sess_content (session_id, content_id)
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS page_views (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    path TEXT,
    created_at INT DEFAULT (UNIX_TIMESTAMP()),
    INDEX idx_pv_sess (session_id),
    INDEX idx_pv_created (created_at)
  ) CHARACTER SET utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS paid_unlocks (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    book_id VARCHAR(36) NOT NULL,
    stripe_session_id VARCHAR(200),
    words_unlocked INT DEFAULT 10000,
    words_used INT DEFAULT 0,
    active TINYINT DEFAULT 1,
    created_at INT DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uq_stripe_sess (stripe_session_id)
  ) CHARACTER SET utf8mb4`);

  console.log('MySQL DB ready');
}

// ── Multer (memory storage — files go to Cloudinary not disk) ─
const memUpload = (limit) => multer({ storage: multer.memoryStorage(), limits: { fileSize: limit } });
const bookUp  = memUpload(50*1024*1024);
const coverUp = memUpload(5*1024*1024);
const adUp    = memUpload(500*1024*1024);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Admin guard ───────────────────────────────────────────────
function admin(req,res,next) {
  if((req.headers['x-admin-pass']||req.body?.adminPass)!==ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function getIP(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'; }
function unixNow() { return Math.floor(Date.now()/1000); }

// ── Session ───────────────────────────────────────────────────
app.post('/api/session', async (req,res) => {
  const { sessionId } = req.body;
  const ip = getIP(req);
  const ua = req.headers['user-agent']||'';
  if (sessionId) {
    const s = await db.get('SELECT id FROM sessions WHERE id=?', sessionId);
    if (s) {
      await db.run('UPDATE sessions SET last_seen=?, total_visits=total_visits+1 WHERE id=?', unixNow(), sessionId);
      await db.run('INSERT INTO page_views (id,session_id,path,created_at) VALUES (?,?,?,?)', uuid(), sessionId, req.body.path||'/', unixNow());
      return res.json({sessionId:s.id});
    }
  }
  const id = uuid();
  await db.run('INSERT INTO sessions (id,ip,user_agent,first_seen,last_seen) VALUES (?,?,?,?,?)', id, ip, ua, unixNow(), unixNow());
  await db.run('INSERT INTO page_views (id,session_id,path,created_at) VALUES (?,?,?,?)', uuid(), id, req.body.path||'/', unixNow());
  res.json({sessionId:id});
});

// ── Daily state ───────────────────────────────────────────────
async function getOrCreateDaily(sessionId) {
  const t = today();
  let s = await db.get('SELECT * FROM daily_state WHERE session_id=? AND date=?', sessionId, t);
  if (!s) {
    const id = uuid();
    try { await db.run('INSERT INTO daily_state (id,session_id,date) VALUES (?,?,?)', id, sessionId, t); } catch(e) {}
    s = await db.get('SELECT * FROM daily_state WHERE session_id=? AND date=?', sessionId, t);
  }
  return s;
}

app.get('/api/daily', async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const s = await getOrCreateDaily(sid);
  res.json({...s, ads_hit:JSON.parse(s.ads_hit||'[]'), effectiveTimeLimit:3600+(s.bonus_secs||0), effectiveEpLimit:3+(s.bonus_eps||0)});
});

app.post('/api/daily/tick', async (req,res) => {
  const sid = req.headers['x-session-id'];
  const {delta=10, bookId, episodeNumber} = req.body;
  const s = await getOrCreateDaily(sid);
  await db.run('UPDATE daily_state SET secs_watched=? WHERE session_id=? AND date=?', (s.secs_watched||0)+delta, sid, today());
  if (bookId) {
    const existing = await db.get('SELECT id FROM reading_events WHERE session_id=? AND book_id=? AND episode_number=? AND date=?', sid, bookId, episodeNumber||0, today());
    if (existing) await db.run('UPDATE reading_events SET secs_read=secs_read+? WHERE id=?', delta, existing.id);
    else await db.run('INSERT INTO reading_events (id,session_id,book_id,episode_number,secs_read,date,created_at) VALUES (?,?,?,?,?,?,?)', uuid(), sid, bookId, episodeNumber||0, delta, today(), unixNow());
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
  if(!p){
    try { await db.run('INSERT INTO watch_progress (id,session_id,content_id) VALUES (?,?,?)',uuid(),sid,req.params.contentId); } catch(e){}
    p=await db.get('SELECT * FROM watch_progress WHERE session_id=? AND content_id=?',sid,req.params.contentId);
  }
  res.json({...p,done_eps:JSON.parse(p.done_eps||'[]')});
});

app.post('/api/progress/:contentId', async (req,res) => {
  const sid=req.headers['x-session-id'],{currentEp,doneEps}=req.body;
  await db.run(
    `INSERT INTO watch_progress (id,session_id,content_id,current_ep,done_eps) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE current_ep=VALUES(current_ep), done_eps=VALUES(done_eps)`,
    uuid(),sid,req.params.contentId,currentEp,JSON.stringify(doneEps||[]));
  res.json({ok:true});
});

// ── Books ─────────────────────────────────────────────────────
function parseBook(text,wpe){
  try {
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
  } catch(e) { console.error('parseBook error:',e.message); throw e; }
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
  } catch(e) { return{n,title:'Episode '+n,content:paras.join('\n\n'),wordCount:0}; }
}

app.post('/api/books/upload', admin, (req,res,next)=>{
  bookUp.single('book')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message||'Upload failed'});
    next();
  });
}, async (req,res) => {
  try{
    const {title,author,wordsPerEpisode=2000}=req.body;
    if(!req.file||!title) return res.status(400).json({error:'Missing file or title'});

    let text;
    try{ text=req.file.buffer.toString('utf8'); }
    catch(e){ text=req.file.buffer.toString('latin1'); }

    const wpe=Math.max(500,Math.min(5000,parseInt(wordsPerEpisode)||2000));
    const eps=parseBook(text,wpe);
    const id=uuid();

    await db.run('INSERT INTO books (id,title,author,words_per_episode,total_episodes,created_at) VALUES (?,?,?,?,?,?)',
      id,title,author||'',wpe,eps.length,unixNow());

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
    res.status(500).json({error:e.message||'Upload failed'});
  }
});

app.post('/api/books/:id/cover', admin, (req,res,next)=>{
  coverUp.single('cover')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message||'Upload failed'});
    next();
  });
}, async (req,res) => {
  try {
    const book = await db.get('SELECT * FROM books WHERE id=?', req.params.id);
    // Delete old cover from Cloudinary if exists
    if(book?.cover_public_id) await deleteFromCloudinary(book.cover_public_id, 'image');

    const publicId = `cover_${req.params.id}`;
    const result = await uploadToCloudinary(req.file.buffer, publicId, 'covers', 'image');
    await db.run('UPDATE books SET cover_url=?, cover_public_id=? WHERE id=?', result.secure_url, result.public_id, req.params.id);
    res.json({coverUrl: result.secure_url});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/books', async (_,res) => {
  const books=await db.all('SELECT * FROM books ORDER BY created_at DESC');
  res.json(books.map(b=>({...b,coverUrl:b.cover_url||null})));
});

app.get('/api/books/:id', async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(!b) return res.status(404).json({error:'Not found'});
  const eps=await db.all('SELECT id,episode_number,title,word_count FROM book_episodes WHERE book_id=? ORDER BY episode_number',req.params.id);
  res.json({...b,coverUrl:b.cover_url||null,episodes:eps});
});

app.get('/api/books/:id/episodes/:num', async (req,res) => {
  const ep=await db.get('SELECT * FROM book_episodes WHERE book_id=? AND episode_number=?',req.params.id,req.params.num);
  if(!ep) return res.status(404).json({error:'Not found'});
  res.json(ep);
});

app.delete('/api/books/:id', admin, async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(b?.cover_public_id) await deleteFromCloudinary(b.cover_public_id, 'image');
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
    const isVideo = req.file.mimetype.startsWith('video');
    const type = isVideo ? 'video' : 'image';
    const id = uuid();
    const publicId = `ad_${id}`;
    const result = await uploadToCloudinary(req.file.buffer, publicId, 'ads', type);
    await db.run('INSERT INTO ads (id,name,url,public_id,type,created_at) VALUES (?,?,?,?,?,?)',
      id, req.body.name||req.file.originalname, result.secure_url, result.public_id, type, unixNow());
    res.json({id, name:req.body.name||req.file.originalname, url:result.secure_url});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/ads', async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC');
  res.json(ads.map(a=>({...a})));
});
app.get('/api/ads/random', async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1');
  if(!ads.length) return res.json(null);
  res.json(ads[Math.floor(Math.random()*ads.length)]);
});
app.delete('/api/ads/:id', admin, async (req,res) => {
  const ad=await db.get('SELECT * FROM ads WHERE id=?',req.params.id);
  if(ad?.public_id) await deleteFromCloudinary(ad.public_id, ad.type==='video'?'video':'image');
  await db.run('DELETE FROM ads WHERE id=?',req.params.id);
  res.json({ok:true});
});

// ── Stripe ────────────────────────────────────────────────────
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
          product_data: { name: 'Pagebound — Unlock next 10,000 words', description: 'Read on without waiting until tomorrow.' },
          unit_amount: 99,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${origin}/book/${bookId}?paid=1&cs={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/book/${bookId}?paid=0`,
      metadata: { sessionId: sid, bookId },
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/stripe/webhook',
  express.raw({type:'application/json'}),
  async (req,res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = process.env.STRIPE_WEBHOOK_SECRET
        ? stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
        : JSON.parse(req.body);
    } catch(e) { return res.status(400).send('Webhook Error'); }
    if (event.type === 'checkout.session.completed') {
      const cs = event.data.object;
      const { sessionId, bookId } = cs.metadata||{};
      if (sessionId && bookId) {
        try {
          await db.run(
            `INSERT IGNORE INTO paid_unlocks (id,session_id,book_id,stripe_session_id,words_unlocked,words_used,active,created_at)
             VALUES (?,?,?,?,10000,0,1,?)`,
            uuid(), sessionId, bookId, cs.id, unixNow()
          );
        } catch(e) { console.error('DB unlock error:', e.message); }
      }
    }
    res.json({received:true});
  }
);

app.get('/api/purchase/status/:bookId', async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const unlock = await db.get(
    'SELECT * FROM paid_unlocks WHERE session_id=? AND book_id=? AND active=1 ORDER BY created_at DESC LIMIT 1',
    sid, req.params.bookId
  );
  res.json({ active: !!unlock, wordsUnlocked: unlock?.words_unlocked||0, wordsUsed: unlock?.words_used||0 });
});

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
  await db.run('UPDATE paid_unlocks SET words_used=?, active=? WHERE id=?', newUsed, exhausted?0:1, unlock.id);
  res.json({ active: !exhausted, wordsUsed: newUsed, wordsUnlocked: unlock.words_unlocked });
});

// ── Admin + Health ────────────────────────────────────────────
app.get('/api/health', (_,res) => res.json({ok:true, time:new Date().toISOString()}));
app.post('/api/admin/verify', (req,res) => {
  res.json(req.body.password===ADMIN_PASS?{ok:true}:{error:'Wrong password'});
});

// ── Analytics ─────────────────────────────────────────────────
app.get('/api/analytics', admin, async (req,res) => {
  const t=today();
  const tsWeekAgo = unixNow()-7*86400;
  const ts14Ago   = unixNow()-14*86400;

  const totalVisitors  = (await db.get('SELECT COUNT(DISTINCT id) as c FROM sessions')).c;
  const todayVisitors  = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE FROM_UNIXTIME(created_at,"%Y-%m-%d")=?',t)).c;
  const weekVisitors   = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE created_at>=?',tsWeekAgo)).c;
  const totalReaders   = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM reading_events')).c;
  const todayReaders   = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM reading_events WHERE date=?',t)).c;
  const avgSecsPerDay  = (await db.get('SELECT AVG(secs_watched) as a FROM daily_state WHERE secs_watched>0')).a||0;
  const totalSecsRead  = (await db.get('SELECT SUM(secs_read) as s FROM reading_events')).s||0;
  const todaySecsRead  = (await db.get('SELECT SUM(secs_read) as s FROM reading_events WHERE date=?',t)).s||0;
  const totalEpsDone   = (await db.get('SELECT SUM(eps_today) as s FROM daily_state')).s||0;
  const todayEpsDone   = (await db.get('SELECT SUM(eps_today) as s FROM daily_state WHERE date=?',t)).s||0;

  const popularBooks = await db.all(`
    SELECT b.title, b.author, COUNT(DISTINCT re.session_id) as readers,
           SUM(re.secs_read) as total_secs, COUNT(re.id) as events
    FROM books b LEFT JOIN reading_events re ON b.id=re.book_id
    GROUP BY b.id ORDER BY readers DESC LIMIT 10
  `);
  const dailyVisitors = await db.all(`
    SELECT FROM_UNIXTIME(created_at,'%Y-%m-%d') as date, COUNT(DISTINCT session_id) as visitors
    FROM page_views WHERE created_at>=? GROUP BY FROM_UNIXTIME(created_at,'%Y-%m-%d') ORDER BY date ASC
  `, ts14Ago);
  const dailyReading = await db.all(`
    SELECT date, SUM(secs_read) as secs, COUNT(DISTINCT session_id) as readers
    FROM reading_events WHERE created_at>=? GROUP BY date ORDER BY date ASC
  `, ts14Ago);
  const recentSessions = await db.all(`
    SELECT s.id, s.ip, s.first_seen, s.last_seen, s.total_visits, ds.secs_watched, ds.eps_today
    FROM sessions s LEFT JOIN daily_state ds ON s.id=ds.session_id AND ds.date=?
    ORDER BY s.last_seen DESC LIMIT 20
  `, t);

  res.json({ totalVisitors, todayVisitors, weekVisitors, totalReaders, todayReaders,
    avgSecsPerDay:Math.round(avgSecsPerDay), totalSecsRead, todaySecsRead,
    totalEpsDone, todayEpsDone, popularBooks, dailyVisitors, dailyReading, recentSessions });
});

// ── Frontend ──────────────────────────────────────────────────
app.get('/admin',    (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/book/:id', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',         (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

process.on('uncaughtException',  (err)    => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

initDB().then(() => {
  app.listen(PORT, () => console.log(`Pagebound running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  app.listen(PORT, () => console.log(`Pagebound started WITHOUT DB on port ${PORT}`));
});
