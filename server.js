/**
 * NEXT-JENN — MAIN SERVER
 * Entry point for Render deployment
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// STATIC FILES — serve everything from root directory
app.use(express.static(__dirname));

// API ROUTES
app.use('/api/interview', require('./interview-engine'));
app.use('/api/interview', require('./scheduling-backend'));
app.use('/api/upload',    require('./upload-handler'));

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

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nextjenn', time: new Date().toISOString() });
});

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Next-Jenn server running on port ' + PORT);
});
