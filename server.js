/**
 * NEXT-JENN — MAIN SERVER
 */

'use strict';

require('dotenv').config();

var express      = require('express');
var cors         = require('cors');
var path         = require('path');
var nodemailer   = require('nodemailer');
var app          = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── UPLOAD HANDLER
try {
  app.use('/api/upload', require('./upload-handler'));
  console.log('upload-handler loaded OK');
} catch (e) {
  console.error('upload-handler FAILED: ' + e.message);
}

// ── EMAIL TRANSPORTER
var transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ── CREATE INTERVIEW — hiring manager sends candidate a link
app.post('/api/create-interview', async function(req, res) {
  try {
    var job_title           = req.body.job_title           || '';
    var cand_name           = req.body.cand_name           || '';
    var cand_email          = req.body.cand_email          || '';
    var client_email        = req.body.client_email        || '';
    var company_name        = req.body.company_name        || '';
    var hiring_manager_name = req.body.hiring_manager_name || '';

    if (!job_title || !cand_name || !cand_email || !client_email) {
      return res.status(400).json({ error: 'All fields required' });
    }

    var session_id = cand_name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now();
    var APP        = process.env.APP_URL || 'https://nextjenn.onrender.com';

    var params = new URLSearchParams({
      session: session_id,
      job:     job_title,
      name:    cand_name,
      client:  client_email,
      company: company_name,
      manager: hiring_manager_name,
    });

    var interview_url = APP + '/interview?' + params.toString();

    // Send candidate email
    await transporter.sendMail({
      from:    'Next-Jenn <' + (process.env.EMAIL_FROM || process.env.EMAIL_USER) + '>',
      to:      cand_email,
      subject: 'Your Interview — ' + job_title + (company_name ? ' at ' + company_name : '') + ' | Next-Jenn',
      html: '<html><body style="font-family:Arial,sans-serif;background:#F0F2F5;padding:32px;">'
        + '<div style="max-width:580px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;">'
        + '<div style="background:#1B2A4A;padding:22px 30px;">'
        + '<span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:.08em;">NEXT-JENN</span>'
        + '</div>'
        + '<div style="padding:32px 30px;">'
        + '<h2 style="margin:0 0 16px;color:#1B2A4A;">Hi ' + cand_name + ',</h2>'
        + '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'You have been invited to complete an AI video interview for the <strong style="color:#1B2A4A;">' + job_title + '</strong>'
        + (company_name ? ' position at <strong style="color:#1B2A4A;">' + company_name + '</strong>.' : ' position.')
        + '</p>'
        + '<p style="margin:0 0 24px;font-size:14px;color:#555B6E;line-height:1.7;">'
        + 'The interview takes approximately 8-10 minutes. Please have your camera and microphone ready and find a quiet space with good lighting.'
        + '</p>'
        + '<p style="text-align:center;margin:0 0 8px;">'
        + '<a href="' + interview_url + '" style="display:inline-block;padding:15px 40px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">Start My Interview</a>'
        + '</p>'
        + '<p style="text-align:center;margin:8px 0 24px;font-size:12px;color:#8892A4;">Click the button above to begin</p>'
        + '<p style="margin:0;font-size:13px;color:#8892A4;font-style:italic;">Good luck! — The Next-Jenn Team</p>'
        + '</div>'
        + '<div style="background:#F8F9FC;padding:14px 30px;border-top:1px solid #D8DCE6;">'
        + '<p style="margin:0;font-size:11px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jennconsulting.com</p>'
        + '</div></div></body></html>',
    });

    console.log('Interview link sent to ' + cand_email);
    res.json({ success: true, interview_url: interview_url, session_id: session_id });

  } catch (err) {
    console.error('Create interview error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── INTERVIEW SESSION ROUTES (stubs — upload handler does the real work)
app.post('/api/interview/:session_id/submit-response', function(req, res) {
  res.json({ success: true, action: 'play_next' });
});

app.post('/api/interview/:session_id/complete', function(req, res) {
  res.json({ success: true });
});

app.get('/api/interview/:session_id/next-segment', function(req, res) {
  res.json({ success: true });
});

// ── INTERVIEW SESSION STUBS (interview-engine not used — upload handler does real work)
app.post('/api/interview/:sid/submit-response', function(req, res) {
  res.json({ success: true, action: 'play_next' });
});
app.post('/api/interview/:sid/complete', function(req, res) {
  res.json({ success: true });
});
app.get('/api/interview/:sid/next-segment', function(req, res) {
  res.json({ success: true });
});

// ── PAGES
app.get('/',          function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/send',      function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/interview', function(req, res) { res.sendFile(path.join(__dirname, 'interview-page.html')); });
app.get('/health',    function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Next-Jenn running on port ' + PORT);
});
