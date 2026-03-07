/**
 * NEXT-JENN -- MAIN SERVER
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log what directory we are running from
const ROOT = __dirname;
console.log('Server root directory:', ROOT);
console.log('Files in root:', fs.readdirSync(ROOT).join(', '));

// Serve static files
app.use(express.static(ROOT));

// Try to load API routes safely
try { app.use('/api/upload', require('./upload-handler')); } catch(e) { console.log('upload-handler error:', e.message); }
try { app.use('/api/interview', require('./interview-engine')); } catch(e) { console.log('interview-engine error:', e.message); }
try { app.use('/api/schedule', require('./scheduling-backend')); } catch(e) { console.log('scheduling-backend error:', e.message); }

// PAGE ROUTES
app.get('/', (req, res) => {
  const f = path.join(ROOT, 'scheduling-page.html');
  console.log('Serving scheduling page from:', f, 'exists:', fs.existsSync(f));
  res.sendFile(f);
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(ROOT, 'scheduling-page.html'));
});

app.get('/interview', (req, res) => {
  const f = path.join(ROOT, 'interview-page.html');
  console.log('Serving interview page from:', f, 'exists:', fs.existsSync(f));
  res.sendFile(f);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nextjenn', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Next-Jenn server running on port ' + PORT);
});
