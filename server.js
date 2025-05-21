// server.js (Backend)
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');

const MAX_ACTIVE_POSTS = 50;
const MAX_CORE_POSTS   = 12;
const PORT             = process.env.PORT || 3001;
const DB_FILE          = 'database.db';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Debug-Middleware für alle Requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  if (req.method === 'POST') {
    console.log('Request Body:', req.body);
  }
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const fileFilter = (req, file, cb) =>
  file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Nur Bilddateien sind erlaubt!'), false);
const upload = multer({ storage, fileFilter });

// Datenbank-Initialisierung
console.log('Initialisiere Datenbank...');
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('Fehler beim Verbinden mit der Datenbank:', err.message);
    process.exit(1);
  }
  console.log('Erfolgreich mit der SQLite-Datenbank verbunden:', DB_FILE);
  
  // Tabellenerstellung
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT,
      imageUrl TEXT,
      description TEXT,
      createdAt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      posX REAL,
      posY REAL
    );
  `, (err) => {
    if (err) {
      console.error('Fehler beim Erstellen der Tabelle:', err.message);
    } else {
      console.log('Tabelle "posts" erfolgreich erstellt/überprüft');
    }
  });
});

// Helfer
function insertPost(data, cb) {
  console.log('Füge neuen Beitrag ein:', data);
  const sql = `
    INSERT INTO posts (type, content, imageUrl, description, createdAt, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const params = [
    data.type,
    data.content,
    data.imageUrl,
    data.description,
    new Date().toISOString(),
    data.status || 'active'
  ];
  console.log('SQL-Parameter:', params);
  
  db.run(sql, params, function(err) {
    if (err) {
      console.error('Fehler beim Einfügen des Beitrags:', err);
      return cb(err);
    }
    console.log('Beitrag erfolgreich eingefügt, ID:', this.lastID);
    db.get('SELECT * FROM posts WHERE id = ?', [this.lastID], (err, row) => {
      if (err) {
        console.error('Fehler beim Abrufen des eingefügten Beitrags:', err);
        return cb(err);
      }
      console.log('Eingefügter Beitrag:', row);
      cb(null, row);
    });
  });
}
function countPostsByStatus(status, cb) {
  db.get('SELECT COUNT(*) AS count FROM posts WHERE status = ?', [status], cb);
}
function findOldestActivePost(cb) {
  db.get(`
    SELECT id, type, content, imageUrl, description, createdAt
    FROM posts WHERE status = 'active'
    ORDER BY createdAt ASC LIMIT 1
  `, [], cb);
}

// Routes
app.get('/api/posts', (req, res) => {
  console.log('\n=== GET /api/posts ===');
  console.log('Hole alle aktiven und Kern-Beiträge...');
  
  db.all(`
    SELECT id AS displayNumber, type, content, imageUrl, description, createdAt, status, posX, posY
    FROM posts
    WHERE status IN ('active','core')
    ORDER BY createdAt ASC
  `, [], (e, rows) => {
    if (e) {
      console.error('Fehler beim Abrufen der Beiträge:', e);
      return res.status(500).json({message:'Error'});
    }
    console.log(`Gefundene Beiträge: ${rows.length}`);
    console.log('Beiträge:', rows);
    console.log('GET /api/posts - Response:', rows.map(post => ({
      id: post.id,
      title: post.type,
      posX: post.posX,
      posY: post.posY
    })));
    res.json(rows);
  });
});

app.get('/api/posts/archive', (req, res) => {
  console.log('\n=== GET /api/posts/archive ===');
  console.log('Hole alle Archiv-Beiträge...');
  
  db.all(`
    SELECT id AS displayNumber, type, description, status, createdAt
    FROM posts
    ORDER BY id ASC
  `, [], (e, rows) => {
    if (e) {
      console.error('Fehler beim Abrufen der Archiv-Beiträge:', e);
      return res.status(500).json({message:'Error'});
    }
    console.log(`Gefundene Archiv-Beiträge: ${rows.length}`);
    console.log('Archiv-Beiträge:', rows);
    res.json(rows);
  });
});

app.post('/api/posts', upload.single('postImage'), (req, res) => {
  console.log('POST /api/posts - New post request:', req.body);
  const postType = req.file ? 'image' : 'text';
  const newPostData = {
    type: postType,
    content: req.body.content?.trim() || null,
    imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
    description: req.body.description?.trim() || null,
    status: 'active'
  };
  console.log('New post data:', newPostData);

  countPostsByStatus('active', (err, row) => {
    if (err) {
      console.error('Error counting active posts:', err);
      return res.status(500).json({message:'Error'});
    }
    console.log('Current active posts count:', row.count);
    
    if (row.count < MAX_ACTIVE_POSTS) {
      insertPost(newPostData, (err, post) => {
        if (err) {
          console.error('Error inserting post:', err);
          return res.status(500).json({message:'Error'});
        }
        console.log('Successfully inserted post:', post);
        res.status(201).json(post);
      });
    } else {
      findOldestActivePost((err2, oldest) => {
        if (err2 || !oldest) {
          console.error('Error finding oldest post:', err2);
          return res.status(409).json({ limitReached: true, newPostData });
        }
        console.log('Found oldest post:', oldest);
        res.status(409).json({ limitReached: true, actionRequired: true, oldestPost: oldest, newPostData });
      });
    }
  });
});

app.post('/api/posts/confirm', (req, res) => {
  const { action, oldestPostId, newPostData } = req.body;
  if (action === 'deleteOldest') {
    db.run("UPDATE posts SET status='deleted' WHERE id=?", [oldestPostId], err => {
      if (err) return res.status(500).json({message:'Error'});
      insertPost(newPostData, (e,p)=> e?res.status(500).json({}):res.status(201).json(p));
    });
  } else if (action === 'moveToCore') {
    countPostsByStatus('core', (err,row) => {
      if (err) return res.status(500).json({message:'Error'});
      if (row.count >= MAX_CORE_POSTS) {
        return res.status(409).json({message:'Core full'});
      }
      db.run("UPDATE posts SET status='core' WHERE id=?", [oldestPostId], err2 => {
        if (err2) return res.status(500).json({message:'Error'});
        insertPost(newPostData, (e,p)=> e?res.status(500).json({}):res.status(201).json(p));
      });
    });
  } else if (action === 'addDirectly') {
    insertPost(newPostData, (e,p)=> e?res.status(500).json({}):res.status(201).json(p));
  } else {
    res.status(400).json({message:'Invalid action'});
  }
});

// Neue Route: PATCH /api/posts/:id/position
app.patch('/api/posts/:id/position', (req, res) => {
  const id = req.params.id;
  const { posX, posY } = req.body;
  
  console.log('PATCH /api/posts/:id/position - Request:', {
    id,
    posX,
    posY,
    body: req.body
  });
  
  if (typeof posX !== 'number' || typeof posY !== 'number') {
    console.error('Invalid position values:', { posX, posY });
    return res.status(400).json({ message: 'posX und posY müssen Zahlen sein.' });
  }
  
  db.run('UPDATE posts SET posX = ?, posY = ? WHERE id = ?', [posX, posY, id], function(err) {
    if (err) {
      console.error('Fehler beim Aktualisieren der Position:', err);
      return res.status(500).json({ message: 'Fehler beim Aktualisieren der Position.' });
    }
    
    console.log('Position erfolgreich aktualisiert:', {
      id,
      posX,
      posY,
      changes: this.changes
    });
    
    res.json({ success: true });
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n=== Server-Status ===`);
  console.log(`Server läuft auf http://localhost:${PORT}`);
  console.log(`Datenbank: ${DB_FILE}`);
  console.log(`Max. aktive Beiträge: ${MAX_ACTIVE_POSTS}`);
  console.log(`Max. Kern-Beiträge: ${MAX_CORE_POSTS}`);
  console.log(`===================\n`);
});
