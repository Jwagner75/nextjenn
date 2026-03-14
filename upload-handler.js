/**
 * NEXT-JENN — VIDEO UPLOAD HANDLER
 */

const express    = require('express');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const router     = express.Router();

// ── R2 CLIENT
const r2 = new S3Client({
  region:   'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET        = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

// ── EMAIL TRANSPORTER
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ── MULTER
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'audio/webm') cb(null, true);
    else cb(new Error('Video files only'), false);
  },
});

// ── SESSION TRACKER — stores video URLs per session in memory
const sessionVideos = {};

const QUESTION_LABELS = {
  q1:    'Question 1 - What is your interest in this position?',
  q2:    'Question 2 - Summary of experience relative to this role',
  q3:    'Question 3 - Three words that best describe you',
  q4:    'Question 4 - Project you are most proud of',
  final: 'Final Question - Are you interested in moving forward?',
};

const TOTAL_RESPONSE_SEGMENTS = 5; // q1, q2, q3, q4, final

// ── UPLOAD ROUTE
router.post('/response-video', upload.single('video'), async (req, res) => {
  try {
    const { session_id, segment_index, segment_id, cand_name, job_title, company_name, client_email, hiring_manager_name } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No video file received' });

    const timestamp = Date.now();
    const ext       = file.originalname.split('.').pop() || 'webm';
    const r2Key     = `responses/${session_id}/seg${segment_index}_${timestamp}.${ext}`;

    await r2.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         r2Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));

    const videoUrl = `${R2_PUBLIC_URL}/${r2Key}`;
    console.log(`Video uploaded: ${r2Key} (${(file.size/1024/1024).toFixed(1)}MB)`);

    // Track this session's videos
    if (!sessionVideos[session_id]) {
      sessionVideos[session_id] = {
        videos: {},
        meta: { cand_name, job_title, company_name, client_email, hiring_manager_name }
      };
    }
    if (segment_id) sessionVideos[session_id].videos[segment_id] = videoUrl;

    // Check if all 5 response segments are uploaded
    const count = Object.keys(sessionVideos[session_id].videos).length;
    console.log(`Session ${session_id}: ${count}/${TOTAL_RESPONSE_SEGMENTS} segments uploaded`);

    if (count >= TOTAL_RESPONSE_SEGMENTS) {
      // Fire transcript email from server side
      sendTranscriptEmail(session_id).catch(e => console.error('Transcript email error:', e.message));
    }

    res.json({ success: true, video_url: videoUrl, r2_key: r2Key });

  } catch (err) {
    console.error('R2 upload error:', err.message);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

async function sendTranscriptEmail(session_id) {
  const session      = sessionVideos[session_id];
  if (!session) return;

  const { cand_name, job_title, company_name, client_email, hiring_manager_name } = session.meta;
  const toEmail = client_email || process.env.EMAIL_USER;

  console.log(`Sending transcript email to ${toEmail} for ${cand_name} - ${job_title}`);

  let qaHtml = '';
  const segOrder = ['q1', 'q2', 'q3', 'q4', 'final'];
  for (const seg_id of segOrder) {
    const video_url = session.videos[seg_id];
    if (!video_url) continue;
    const label    = QUESTION_LABELS[seg_id] || seg_id;
    const watchBtn = `<a href="${video_url}" style="display:inline-block;margin-top:10px;padding:8px 18px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:8px;font-size:12px;font-weight:700;">Watch Response</a>`;
    qaHtml += `
      <div style="margin-bottom:16px;border:1px solid #D8DCE6;border-radius:10px;overflow:hidden;">
        <div style="background:#F0F2F5;padding:10px 18px;border-bottom:2px solid #1B2A4A;">
          <p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:0.1em;">${label}</p>
        </div>
        <div style="padding:14px 18px;background:#fff;">
          <p style="margin:0;font-size:14px;color:#1A1D2E;font-style:italic;">[Video response — click Watch Response to view]</p>
          ${watchBtn}
        </div>
      </div>`;
  }

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!DOCTYPE html>
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
      <td><p style="margin:0;font-size:20px;font-weight:700;color:#1B2A4A;">${cand_name || 'Candidate'}</p></td>
      <td align="right">
        <p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">${job_title || 'Open Role'}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#555B6E;">${company_name || ''}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#555B6E;">${dateStr}</p>
      </td>
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
    from:    `Next-Jenn AI Recruiter <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to:      toEmail,
    subject: `Interview Complete - ${cand_name || 'Candidate'} for ${job_title || 'Open Role'}${company_name ? ' at ' + company_name : ''} | Next-Jenn`,
    html,
  });

  console.log(`Transcript email sent to ${toEmail}`);
  // Clean up session
  delete sessionVideos[session_id];
}

module.exports = router;
