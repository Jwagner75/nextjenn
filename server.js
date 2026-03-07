/**
 * NEXT-JENN -- MAIN SERVER
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const nodemailer = require('nodemailer');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ROOT = __dirname;
app.use(express.static(ROOT));

// Try to load API routes safely
try { app.use('/api/upload', require('./upload-handler')); } catch(e) { console.log('upload-handler error:', e.message); }
try { app.use('/api/interview', require('./interview-engine')); } catch(e) { console.log('interview-engine error:', e.message); }
try { app.use('/api/schedule', require('./scheduling-backend')); } catch(e) { console.log('scheduling-backend error:', e.message); }

// ── EMAIL TRANSPORTER (Gmail)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// QUESTION LABELS
const QUESTION_LABELS = {
  q1:    'Question 1 - What is your interest in this position?',
  q2:    'Question 2 - Summary of experience relative to this role',
  q3:    'Question 3 - Three words that best describe you',
  q4:    'Question 4 - Project you are most proud of',
  final: 'Final Question - Are you interested in moving forward?',
};

// ── TRANSCRIPT EMAIL ROUTE
app.post('/api/send-transcript', async (req, res) => {
  try {
    const { candidate_name, candidate_email, job_title, client_email, interview_date_str, transcripts } = req.body;

    // Build Q&A HTML
    let qaHtml = '';
    for (const item of transcripts) {
      const label = QUESTION_LABELS[item.segment_id] || item.segment_id;
      const watchBtn = item.video_url
        ? `<a href="${item.video_url}" style="display:inline-block;margin-top:10px;padding:8px 18px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:8px;font-size:12px;font-weight:700;">Watch Response</a>`
        : '';
      qaHtml += `
        <div style="margin-bottom:16px;border:1px solid #D8DCE6;border-radius:10px;overflow:hidden;">
          <div style="background:#F0F2F5;padding:10px 18px;border-bottom:2px solid #1B2A4A;">
            <p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:0.1em;">${label}</p>
          </div>
          <div style="padding:14px 18px;background:#fff;">
            <p style="margin:0;font-size:14px;color:#1A1D2E;font-style:italic;">${item.transcript || '[No response recorded]'}</p>
            ${watchBtn}
          </div>
        </div>`;
    }

    const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F0F2F5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;">
  <tr><td style="background:#1B2A4A;padding:24px 32px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:0.08em;">NEXT-JENN</span>
    <span style="float:right;font-size:11px;color:#8892A4;letter-spacing:0.1em;text-transform:uppercase;">AI Recruiter Interview</span>
  </td></tr>
  <tr><td style="background:#1B2A4A;padding:24px 32px;">
    <h1 style="margin:0 0 6px;font-size:22px;color:#fff;">Interview Transcript Ready</h1>
    <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.7);">Review the candidate responses below</p>
  </td></tr>
  <tr><td style="background:#EEF1F7;padding:18px 32px;border-bottom:2px solid #1B2A4A;">
    <table width="100%"><tr>
      <td><p style="margin:0;font-size:20px;font-weight:700;color:#1B2A4A;">${candidate_name}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#555B6E;">${candidate_email || ''}</p></td>
      <td align="right"><p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">${job_title}</p>
          <p style="margin:2px 0 0;font-size:13px;color:#555B6E;">${interview_date_str}</p></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px 32px;">
    <p style="margin:0 0 16px;font-size:11px;font-weight:700;color:#8892A4;text-transform:uppercase;letter-spacing:0.15em;">Interview Responses</p>
    ${qaHtml}
    <p style="margin:16px 0 0;font-size:12px;color:#8892A4;padding:12px;background:#F8F9FC;border-radius:8px;border:1px solid #D8DCE6;">
      Click Watch Response to view each video clip. Interview conducted by Jenn, AI Recruiter - Next-Jenn Platform.
    </p>
  </td></tr>
  <tr><td style="background:#F8F9FC;padding:16px 32px;border-top:1px solid #D8DCE6;">
    <p style="margin:0;font-size:11px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jennconsulting.com</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    await transporter.sendMail({
      from: `Next-Jenn AI Recruiter <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: client_email,
      subject: `Interview Complete - ${candidate_name} for ${job_title} | Next-Jenn`,
      html: html,
    });

    console.log('Transcript email sent to', client_email);
    res.json({ sent: true });
  } catch (err) {
    console.error('Transcript email error:', err.message);
    res.status(500).json({ sent: false, error: err.message });
  }
});

// PAGE ROUTES
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'scheduling-page.html'));
});

app.get('/schedule', (req, res) => {
  res.sendFile(path.join(ROOT, 'scheduling-page.html'));
});

app.get('/interview', (req, res) => {
  res.sendFile(path.join(ROOT, 'interview-page.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'nextjenn', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Next-Jenn server running on port ' + PORT);
});
