const express      = require('express');
const stripe       = require('stripe')(process.env.STRIPE_SECRET_KEY||'');
const mysql        = require('mysql2/promise');
const cloudinary   = require('cloudinary').v2;
const multer       = require('multer');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Cloudinary ────────────────────────────────────────────────
// File uploads (covers, ads) live on Cloudinary so they survive redeploys —
// the app filesystem is ephemeral and gets wiped on every deploy.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadBuffer(buffer, folder, resourceType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: resourceType }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
    stream.end(buffer);
  });
}

// ── DB ────────────────────────────────────────────────────────
// MySQL (Hostinger) instead of local SQLite — SQLite's file was getting
// wiped on every redeploy since it lived on the ephemeral app filesystem.
let pool, db;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS books (
    id VARCHAR(36) PRIMARY KEY,
    title TEXT NOT NULL,
    author VARCHAR(255),
    cover_file TEXT,
    cover_public_id VARCHAR(255),
    words_per_episode INT DEFAULT 2000,
    total_episodes INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS book_episodes (
    id VARCHAR(36) PRIMARY KEY,
    book_id VARCHAR(36) NOT NULL,
    episode_number INT NOT NULL,
    title VARCHAR(500),
    content MEDIUMTEXT NOT NULL,
    word_count INT,
    INDEX idx_book_episodes_book (book_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS ads (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    file TEXT NOT NULL,
    public_id VARCHAR(255),
    type VARCHAR(20) NOT NULL,
    active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(36) PRIMARY KEY,
    ip VARCHAR(64),
    user_agent VARCHAR(500),
    country VARCHAR(100),
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_visits INT DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS daily_state (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    date VARCHAR(10) NOT NULL,
    secs_watched INT DEFAULT 0,
    bonus_secs INT DEFAULT 0,
    eps_today INT DEFAULT 0,
    bonus_eps INT DEFAULT 0,
    ads_hit TEXT,
    UNIQUE KEY uk_daily_state (session_id, date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS reading_events (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    book_id VARCHAR(36) NOT NULL,
    episode_number INT NOT NULL,
    secs_read INT DEFAULT 0,
    date VARCHAR(10) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS watch_progress (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    content_id VARCHAR(36) NOT NULL,
    current_ep INT DEFAULT 0,
    done_eps TEXT,
    UNIQUE KEY uk_watch_progress (session_id, content_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS page_views (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    path VARCHAR(500),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS paid_unlocks (
    id VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL,
    book_id VARCHAR(36) NOT NULL,
    stripe_session_id VARCHAR(255) UNIQUE,
    words_unlocked INT DEFAULT 10000,
    words_used INT DEFAULT 0,
    active TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function initDB() {
  pool = await mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 8000, // fail fast instead of hanging until the platform's own gateway times out
  });
  for (const stmt of SCHEMA) await pool.query(stmt);

  // Thin wrapper so the rest of the file can keep using the
  // db.get/db.all/db.run(sql, ...params) shape it already used with sqlite.
  db = {
    async get(sql, ...params) {
      const [rows] = await pool.execute(sql, params);
      return rows[0];
    },
    async all(sql, ...params) {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    async run(sql, ...params) {
      const [result] = await pool.execute(sql, params);
      return result;
    },
  };
  console.log('DB ready');
}

// ── Multer ────────────────────────────────────────────────────
// Books/covers are small enough to buffer in memory and stream straight to
// Cloudinary. Ads can be up to 500MB video, so those go through a tmp file
// on disk (deleted right after upload) instead of buffering in RAM.
const bookUp  = multer({storage: multer.memoryStorage(), limits:{fileSize:50*1024*1024}});
const coverUp = multer({storage: multer.memoryStorage(), limits:{fileSize:5*1024*1024}});
const adUp    = multer({
  storage: multer.diskStorage({
    destination: (_,__,cb) => cb(null, os.tmpdir()),
    filename:    (_,file,cb) => cb(null, uuid()+path.extname(file.originalname)),
  }),
  limits:{fileSize:500*1024*1024},
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Wrap async route handlers so a rejected promise (e.g. a DB error) reaches
// Express's error handling instead of leaving the request hanging with no
// response until the platform's own gateway times out.
const ah = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

// Respond immediately if the DB isn't connected instead of hanging on every
// query until the pool's connectTimeout (or the platform's gateway) gives up.
const DB_EXEMPT_PATHS = ['/health', '/admin/verify'];
app.use('/api', (req,res,next) => {
  if (DB_EXEMPT_PATHS.includes(req.path)) return next();
  if (!db) return res.status(503).json({error:'Database not connected — check DB_HOST/DB_NAME/DB_USER/DB_PASS and that this server\'s IP is allowed to connect remotely.'});
  next();
});

// ── Admin guard ───────────────────────────────────────────────
function admin(req,res,next) {
  if((req.headers['x-admin-pass']||req.body?.adminPass)!==ADMIN_PASS) return res.status(401).json({error:'Unauthorized'});
  next();
}

// ── Helpers ───────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function getIP(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'; }

// ── Session ───────────────────────────────────────────────────
app.post('/api/session', ah(async (req,res) => {
  const { sessionId } = req.body;
  const ip = getIP(req);
  const ua = req.headers['user-agent']||'';
  if (sessionId) {
    const s = await db.get('SELECT id FROM sessions WHERE id=?', sessionId);
    if (s) {
      await db.run('UPDATE sessions SET last_seen=NOW(), total_visits=total_visits+1 WHERE id=?', sessionId);
      // Log page view
      await db.run('INSERT INTO page_views (id,session_id,path) VALUES (?,?,?)', uuid(), sessionId, req.body.path||'/');
      return res.json({sessionId:s.id});
    }
  }
  const id = uuid();
  await db.run('INSERT INTO sessions (id,ip,user_agent) VALUES (?,?,?)', id, ip, ua);
  await db.run('INSERT INTO page_views (id,session_id,path) VALUES (?,?,?)', uuid(), id, req.body.path||'/');
  res.json({sessionId:id});
}));

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

app.get('/api/daily', ah(async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const s = await getOrCreateDaily(sid);
  res.json({...s, ads_hit:JSON.parse(s.ads_hit||'[]'), effectiveTimeLimit:3600+(s.bonus_secs||0), effectiveEpLimit:3+(s.bonus_eps||0)});
}));

app.post('/api/daily/tick', ah(async (req,res) => {
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
}));

app.post('/api/daily/ad-hit', ah(async (req,res) => {
  const sid=req.headers['x-session-id'], {trigger}=req.body;
  const s=await getOrCreateDaily(sid);
  const hits=JSON.parse(s.ads_hit||'[]');
  if(!hits.includes(trigger)){hits.push(trigger);await db.run('UPDATE daily_state SET ads_hit=? WHERE session_id=? AND date=?',JSON.stringify(hits),sid,today());}
  res.json({ok:true});
}));

app.post('/api/daily/episode-done', ah(async (req,res) => {
  const sid=req.headers['x-session-id'];
  const s=await getOrCreateDaily(sid);
  await db.run('UPDATE daily_state SET eps_today=? WHERE session_id=? AND date=?',(s.eps_today||0)+1,sid,today());
  res.json({ok:true});
}));

const MAX_BONUS_EPS = 2; // caps the daily episode total at 3 base + 2 earned = 5
app.post('/api/daily/earn', ah(async (req,res) => {
  const sid=req.headers['x-session-id'],{action}=req.body;
  const te={ad:900,share:1800,both:2700},ee={ad:0,share:1,both:2};
  const s=await getOrCreateDaily(sid);
  const newBonusEps=Math.min((s.bonus_eps||0)+(ee[action]||0), MAX_BONUS_EPS);
  await db.run('UPDATE daily_state SET bonus_secs=?,bonus_eps=? WHERE session_id=? AND date=?',(s.bonus_secs||0)+(te[action]||0),newBonusEps,sid,today());
  res.json({ok:true});
}));

// ── Progress ──────────────────────────────────────────────────
app.get('/api/progress/:contentId', ah(async (req,res) => {
  const sid=req.headers['x-session-id'];
  let p=await db.get('SELECT * FROM watch_progress WHERE session_id=? AND content_id=?',sid,req.params.contentId);
  if(!p){const id=uuid();await db.run('INSERT INTO watch_progress (id,session_id,content_id) VALUES (?,?,?)',id,sid,req.params.contentId);p=await db.get('SELECT * FROM watch_progress WHERE id=?',id);}
  res.json({...p,done_eps:JSON.parse(p.done_eps||'[]')});
}));

app.post('/api/progress/:contentId', ah(async (req,res) => {
  const sid=req.headers['x-session-id'],{currentEp,doneEps}=req.body;
  await db.run(`INSERT INTO watch_progress (id,session_id,content_id,current_ep,done_eps) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE current_ep=VALUES(current_ep),done_eps=VALUES(done_eps)`,
    uuid(),sid,req.params.contentId,currentEp,JSON.stringify(doneEps||[]));
  res.json({ok:true});
}));

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
  try{
    const {title,author,wordsPerEpisode=2000}=req.body;
    if(!req.file||!title){
      return res.status(400).json({error:'Missing file or title'});
    }
    const text=req.file.buffer.toString('utf8');

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
    res.status(500).json({error:e.message||'Upload failed'});
  }
});

// Rebuild a book's episodes from a fresh file upload, keeping the same book id —
// watch_progress/reading_events/paid_unlocks are keyed by book_id, not episode
// content, so readers' progress and purchases stay linked across the rebuild.
app.post('/api/books/:id/update', admin, (req,res,next)=>{
  bookUp.single('book')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message||'Upload failed'});
    next();
  });
}, async (req,res) => {
  const conn = await pool.getConnection();
  try{
    const [existingRows] = await conn.execute('SELECT * FROM books WHERE id=?', [req.params.id]);
    const existing = existingRows[0];
    if(!existing) return res.status(404).json({error:'Book not found'});
    if(!req.file) return res.status(400).json({error:'Missing file'});

    const title = (req.body.title||'').trim() || existing.title;
    const author = (req.body.author||'').trim() || existing.author;
    const wpe = Math.max(500,Math.min(5000,parseInt(req.body.wordsPerEpisode)||existing.words_per_episode||2000));
    const text = req.file.buffer.toString('utf8');
    const eps = parseBook(text, wpe);

    await conn.beginTransaction();
    await conn.execute('DELETE FROM book_episodes WHERE book_id=?', [req.params.id]);
    for(const ep of eps){
      await conn.execute('INSERT INTO book_episodes (id,book_id,episode_number,title,content,word_count) VALUES (?,?,?,?,?,?)',
        [uuid(),req.params.id,ep.n,ep.title,ep.content,ep.wordCount]);
    }
    await conn.execute('UPDATE books SET title=?,author=?,words_per_episode=?,total_episodes=? WHERE id=?',
      [title,author,wpe,eps.length,req.params.id]);
    await conn.commit();

    res.json({bookId:req.params.id,title,totalEpisodes:eps.length});
  }catch(e){
    try{ await conn.rollback(); }catch{}
    console.error('Book update error:',e);
    res.status(500).json({error:e.message||'Update failed'});
  }finally{
    conn.release();
  }
});

app.post('/api/books/:id/cover', admin, coverUp.single('cover'), async (req,res) => {
  try {
    const result = await uploadBuffer(req.file.buffer, 'pagebound/covers', 'image');
    await db.run('UPDATE books SET cover_file=?,cover_public_id=? WHERE id=?', result.secure_url, result.public_id, req.params.id);
    res.json({coverUrl: result.secure_url});
  } catch(e) {
    console.error('Cover upload error:', e.message);
    res.status(500).json({error: e.message||'Cover upload failed'});
  }
});

app.get('/api/books', ah(async (_,res) => {
  const books=await db.all('SELECT * FROM books ORDER BY created_at DESC');
  res.json(books.map(b=>({...b,coverUrl:b.cover_file||null})));
}));

app.get('/api/books/:id', ah(async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(!b) return res.status(404).json({error:'Not found'});
  const eps=await db.all('SELECT id,episode_number,title,word_count FROM book_episodes WHERE book_id=? ORDER BY episode_number',req.params.id);
  res.json({...b,coverUrl:b.cover_file||null,episodes:eps});
}));

app.get('/api/books/:id/episodes/:num', ah(async (req,res) => {
  const ep=await db.get('SELECT * FROM book_episodes WHERE book_id=? AND episode_number=?',req.params.id,req.params.num);
  if(!ep) return res.status(404).json({error:'Not found'});
  res.json(ep);
}));

app.delete('/api/books/:id', admin, ah(async (req,res) => {
  const b=await db.get('SELECT * FROM books WHERE id=?',req.params.id);
  if(b?.cover_public_id){try{await cloudinary.uploader.destroy(b.cover_public_id);}catch{}}
  await db.run('DELETE FROM book_episodes WHERE book_id=?',req.params.id);
  await db.run('DELETE FROM books WHERE id=?',req.params.id);
  res.json({ok:true});
}));

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
  const tmpPath = req.file?.path;
  try {
    if(!req.file) return res.status(400).json({error:'No file received'});
    const type=req.file.mimetype.startsWith('video')?'video':'image';
    const result = await cloudinary.uploader.upload(tmpPath, {folder:'pagebound/ads', resource_type: type});
    const id=uuid();
    await db.run('INSERT INTO ads (id,name,file,public_id,type) VALUES (?,?,?,?,?)',id,req.body.name||req.file.originalname,result.secure_url,result.public_id,type);
    res.json({id,name:req.body.name||req.file.originalname});
  } catch(e){
    console.error('Ad upload error:', e.message);
    res.status(500).json({error:e.message});
  } finally {
    if(tmpPath) fs.unlink(tmpPath, ()=>{});
  }
});
app.get('/api/ads', ah(async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC');
  res.json(ads.map(a=>({...a,url:a.file})));
}));
app.get('/api/ads/random', ah(async (_,res) => {
  const ads=await db.all('SELECT * FROM ads WHERE active=1');
  if(!ads.length) return res.json(null);
  const ad=ads[Math.floor(Math.random()*ads.length)];
  res.json({...ad,url:ad.file});
}));
app.delete('/api/ads/:id', admin, ah(async (req,res) => {
  const ad=await db.get('SELECT * FROM ads WHERE id=?',req.params.id);
  if(ad?.public_id){try{await cloudinary.uploader.destroy(ad.public_id, {resource_type: ad.type==='video'?'video':'image'});}catch{}}
  await db.run('DELETE FROM ads WHERE id=?',req.params.id);
  res.json({ok:true});
}));

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
            `INSERT IGNORE INTO paid_unlocks (id,session_id,book_id,stripe_session_id,words_unlocked,words_used,active)
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
app.get('/api/purchase/status/:bookId', ah(async (req,res) => {
  const sid = req.headers['x-session-id'];
  if (!sid) return res.status(400).json({error:'No session'});
  const unlock = await db.get(
    'SELECT * FROM paid_unlocks WHERE session_id=? AND book_id=? AND active=1 ORDER BY created_at DESC LIMIT 1',
    sid, req.params.bookId
  );
  res.json({ active: !!unlock, wordsUnlocked: unlock?.words_unlocked||0, wordsUsed: unlock?.words_used||0 });
}));

// Record words consumed from paid unlock (called as reader progresses)
app.post('/api/purchase/consume', ah(async (req,res) => {
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
}));

// ── Admin verify ──────────────────────────────────────────────
// Health check — always returns 200 so you know server is up
app.get('/api/health', (_,res) => res.json({ok:true, time:new Date().toISOString()}));

app.post('/api/admin/verify', (req,res) => {
  res.json(req.body.password===ADMIN_PASS?{ok:true}:{error:'Wrong password'});
});

// ── Analytics ─────────────────────────────────────────────────
app.get('/api/analytics', admin, ah(async (req,res) => {
  const t=today();

  // Visitors
  const totalVisitors    = (await db.get('SELECT COUNT(DISTINCT id) as c FROM sessions')).c;
  const todayVisitors    = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE DATE(created_at)=?',t)).c;
  const weekVisitors     = (await db.get('SELECT COUNT(DISTINCT session_id) as c FROM page_views WHERE created_at>=(NOW() - INTERVAL 7 DAY)')).c;

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
    SELECT DATE(created_at) as date, COUNT(DISTINCT session_id) as visitors
    FROM page_views
    WHERE created_at>=(NOW() - INTERVAL 14 DAY)
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);

  // Daily reading time last 14 days
  const dailyReading = await db.all(`
    SELECT date, SUM(secs_read) as secs, COUNT(DISTINCT session_id) as readers
    FROM reading_events
    WHERE created_at>=(NOW() - INTERVAL 14 DAY)
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
}));

// ── Frontend ──────────────────────────────────────────────────
// All these serve index.html — JS router handles the rest
app.get('/admin',    (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/book/:id', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*',         (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// Catches errors passed via next(err) from ah()-wrapped routes — makes sure
// a DB/query failure always gets a fast JSON response instead of a hang.
app.use((err, req, res, next) => {
  console.error('Route error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({error: err.message||'Server error'});
});

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
