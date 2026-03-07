/**
 * NEXT-JENN -- MAIN SERVER
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from root
app.use(express.static(__dirname));

// Try to load API routes safely
try { app.use('/api/upload', require('./upload-handler')); } catch(e) { console.log('upload-handler not loaded:', e.message); }
try { app.use('/api/interview', require('./interview-engine')); } catch(e) { console.log('interview-engine not loaded:', e.message); }
try { app.use('/api/schedule', require('./scheduling-backend')); } catch(e) { console.log('scheduling-backend not loaded:', e.message); }

// PAGE ROUTES
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'scheduling-page.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(__dirname, 'scheduling-page.html'));
});

app.get('/interview', (req, res) => {
  res.sendFile(path.join(__dirname, 'interview-page.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nextjenn', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Next-Jenn server running on port ' + PORT);
});
