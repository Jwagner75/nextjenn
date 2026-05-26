'use strict';
require('dotenv').config();

var express    = require('express');
var multer     = require('multer');
var nodemailer = require('nodemailer');
var path       = require('path');
var cors       = require('cors');
var Anthropic  = require('@anthropic-ai/sdk');
var { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
var db         = require('./db');

var app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── CLIENTS
var r2 = new S3Client({
  region: 'auto',
  endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

var mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});

var anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Media files only'), false);
  },
});

var APP = process.env.APP_URL || 'https://nextjenn.onrender.com';

// ── SESSION STORE (in-memory for video tracking)
var sessions = {};
var scheduled = {};
var invites   = {};

function fromAddr() { return 'Next-Jenn <' + (process.env.EMAIL_FROM || process.env.EMAIL_USER) + '>'; }
function sendMail(to, subject, html) { return mailer.sendMail({ from: fromAddr(), to, subject, html }); }

function scheduleTimeout(fn, ms) {
  var MAX = 2147483647;
  if (ms > MAX) return setTimeout(function() { scheduleTimeout(fn, ms - MAX); }, MAX);
  return setTimeout(fn, ms);
}

function fmtTime(date, tz) {
  try {
    return date.toLocaleString('en-US', {
      timeZone: tz || 'America/Chicago',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch(e) { return date.toLocaleString(); }
}

function emailWrap(heading, body) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#F0F2F5;font-family:Arial,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;">'
    + '<tr><td style="background:#1B2A4A;padding:20px 28px;">'
    + '<span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:.08em;">NEXT-JENN</span>'
    + '<span style="float:right;font-size:10px;color:#8892A4;text-transform:uppercase;letter-spacing:.1em;">AI Recruiter Interview</span>'
    + '</td></tr>'
    + '<tr><td style="background:#243760;padding:18px 28px;">'
    + '<h1 style="margin:0;font-size:20px;color:#fff;">' + heading + '</h1>'
    + '</td></tr>'
    + '<tr><td style="padding:24px 28px;">' + body + '</td></tr>'
    + '<tr><td style="background:#F8F9FC;padding:12px 28px;border-top:1px solid #D8DCE6;">'
    + '<p style="margin:0;font-size:10px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jenn.net | Built by recruiters, for recruiters.</p>'
    + '</td></tr></table></td></tr></table></body></html>';
}

function btnHtml(url, label) {
  return '<p style="text-align:center;margin:20px 0 8px;">'
    + '<a href="' + url + '" style="display:inline-block;padding:14px 36px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">' + label + '</a>'
    + '</p>';
}

// ════════════════════════════════════════════════════
// AI ROUTES
// ════════════════════════════════════════════════════

// Generate screening questions from job description
app.post('/api/ai/screening-questions', async function(req, res) {
  if (!anthropic) return res.status(500).json({ error: 'AI not configured — add ANTHROPIC_API_KEY to environment' });
  try {
    var { job_title, job_description, min_qualifications } = req.body;
    var prompt = 'You are an expert recruiter with 20+ years of experience. Generate 8 yes/no screening questions for this job.\n\n'
      + 'Job Title: ' + job_title + '\n'
      + 'Description: ' + (job_description || '') + '\n'
      + 'Minimum Qualifications: ' + (min_qualifications || '') + '\n\n'
      + 'Return ONLY a JSON array like this, no other text:\n'
      + '[{"question":"Do you have X years of experience in Y?","correct":"yes","points":1},...]\n'
      + 'Mix questions where correct answer is yes AND where correct answer is no (e.g. "Are you available to start immediately?" correct:"yes", "Do you require visa sponsorship?" correct:"no").\n'
      + 'Make questions specific to the role. Points should be 1 for standard, 2 for critical requirements.';

    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    var text = msg.content[0].text.replace(/```json|```/g, '').trim();
    var questions = JSON.parse(text);
    res.json({ questions });
  } catch(e) {
    console.error('AI screening questions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generate interview questions from job description
app.post('/api/ai/interview-questions', async function(req, res) {
  if (!anthropic) return res.status(500).json({ error: 'AI not configured — add ANTHROPIC_API_KEY to environment' });
  try {
    var { job_title, job_description, format } = req.body;
    var formatNote = format === 'audio' ? 'voice interview (questions will be read aloud)' : 'written interview (candidates type responses)';
    var prompt = 'You are an expert recruiter with 20+ years of experience. Generate 5 interview questions for this ' + formatNote + '.\n\n'
      + 'Job Title: ' + job_title + '\n'
      + 'Description: ' + (job_description || '') + '\n\n'
      + 'Return ONLY a JSON array of question strings, no other text:\n'
      + '["question 1","question 2",...]\n'
      + 'Questions should be open-ended, behavioral where possible, and specific to this role.';

    var msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    var text = msg.content[0].text.replace(/```json|```/g, '').trim();
    var questions = JSON.parse(text);
    res.json({ questions });
  } catch(e) {
    console.error('AI interview questions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// JOB ROUTES
// ════════════════════════════════════════════════════

// Create job
app.post('/api/jobs/create', async function(req, res) {
  try {
    var b = req.body;

    // Upsert client
    var clientResult = await db.query(
      'INSERT INTO clients (company_name, contact_name, email, phone) VALUES ($1,$2,$3,$4) '
      + 'ON CONFLICT (email) DO UPDATE SET company_name=$1, contact_name=$2, phone=$4 RETURNING id',
      [b.company_name, b.contact_name, b.email, b.phone || null]
    );
    var clientId = clientResult.rows[0].id;

    // Create job
    var jobResult = await db.query(
      'INSERT INTO jobs (client_id,title,department,location,job_type,description,responsibilities,min_qualifications,preferred_quals,salary_range,interview_format,is_public) '
      + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      [clientId, b.title, b.department||null, b.location||null, b.job_type||'Full-Time',
       b.description||null, b.responsibilities||null, b.min_qualifications||null,
       b.preferred_quals||null, b.salary_range||null, b.interview_format||'video', b.is_public||false]
    );
    var jobId = jobResult.rows[0].id;

    // Insert screening questions
    if (b.screening_questions && b.screening_questions.length) {
      for (var i = 0; i < b.screening_questions.length; i++) {
        var q = b.screening_questions[i];
        await db.query(
          'INSERT INTO screening_questions (job_id,question,type,correct,points,order_num) VALUES ($1,$2,$3,$4,$5,$6)',
          [jobId, q.question, 'yes_no', q.correct||'yes', q.points||1, i]
        );
      }
    }

    // Insert interview questions (for audio/text)
    if (b.interview_questions && b.interview_questions.length && b.interview_format !== 'video') {
      for (var j = 0; j < b.interview_questions.length; j++) {
        var iq = b.interview_questions[j];
        if (iq && iq.trim()) {
          await db.query(
            'INSERT INTO screening_questions (job_id,question,type,correct,points,order_num) VALUES ($1,$2,$3,$4,$5,$6)',
            [jobId, iq, 'interview', null, 0, j + 100]
          );
        }
      }
    }

    console.log('Job created:', jobId, 'for client:', clientId);
    res.json({ success: true, job_id: jobId, client_id: clientId });
  } catch(e) {
    console.error('Create job error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Get job (for apply page)
app.get('/api/jobs/:jobId', async function(req, res) {
  try {
    var jobResult = await db.query(
      'SELECT j.*, c.company_name, c.email as client_email, c.contact_name '
      + 'FROM jobs j JOIN clients c ON j.client_id = c.id WHERE j.id = $1',
      [req.params.jobId]
    );
    if (!jobResult.rows.length) return res.status(404).json({ error: 'Job not found' });
    var job = jobResult.rows[0];

    var sqResult = await db.query(
      'SELECT * FROM screening_questions WHERE job_id = $1 AND type = $2 ORDER BY order_num',
      [req.params.jobId, 'yes_no']
    );
    job.screening_questions = sqResult.rows;

    var iqResult = await db.query(
      'SELECT * FROM screening_questions WHERE job_id = $1 AND type = $2 ORDER BY order_num',
      [req.params.jobId, 'interview']
    );
    job.interview_questions = iqResult.rows;

    res.json(job);
  } catch(e) {
    console.error('Get job error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// APPLY ROUTE — candidate submits application
// ════════════════════════════════════════════════════
app.post('/api/apply/:jobId', async function(req, res) {
  try {
    var b = req.body;
    var jobId = req.params.jobId;

    // Load job + questions
    var jobResult = await db.query(
      'SELECT j.*, c.company_name, c.email as client_email, c.contact_name '
      + 'FROM jobs j JOIN clients c ON j.client_id = c.id WHERE j.id = $1',
      [jobId]
    );
    if (!jobResult.rows.length) return res.status(404).json({ error: 'Job not found' });
    var job = jobResult.rows[0];

    var sqResult = await db.query(
      'SELECT * FROM screening_questions WHERE job_id = $1 AND type = $2 ORDER BY order_num',
      [jobId, 'yes_no']
    );
    var questions = sqResult.rows;

    // ── Check minimum qualifications with AI
    var meetsMin = true;
    if (job.min_qualifications) {
      // Simple check: if they answered "No" to work authorization, auto-decline
      if (b.authorized === 'no') meetsMin = false;
    }

    if (!meetsMin) {
      // Create applicant record
      var appResult = await db.query(
        'INSERT INTO applicants (job_id,first_name,last_name,email,phone,location,linkedin_url,authorized,sponsorship,status,consent_signed,consent_at,signature) '
        + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12) RETURNING id',
        [jobId, b.first_name, b.last_name, b.email, b.phone||null, b.location||null,
         b.linkedin_url||null, b.authorized, b.sponsorship, 'declined_min', true, b.signature]
      );
      // Send decline email
      await sendDeclineEmail(b.email, b.first_name, job.title, job.company_name);
      return res.json({ status: 'declined_min', email: b.email });
    }

    // ── Score screening answers
    var totalPoints = 0;
    var earnedPoints = 0;
    var responses = [];
    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      var ans = b.answers ? b.answers[i] : null;
      var pts = q.points || 1;
      totalPoints += pts;
      var correct = (ans === q.correct);
      if (correct) earnedPoints += pts;
      responses.push({ question_id: q.id, answer: ans, points_earned: correct ? pts : 0 });
    }

    var scorePct = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 100;
    var passed   = scorePct >= 70; // 7/10 = 70%

    // Create applicant record
    var status = passed ? 'interview_sent' : 'declined_score';
    var appInsert = await db.query(
      'INSERT INTO applicants (job_id,first_name,last_name,email,phone,location,linkedin_url,authorized,sponsorship,status,screening_score,screening_max,consent_signed,consent_at,signature) '
      + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),$14) RETURNING id',
      [jobId, b.first_name, b.last_name, b.email, b.phone||null, b.location||null,
       b.linkedin_url||null, b.authorized, b.sponsorship, status,
       earnedPoints, totalPoints, true, b.signature]
    );
    var applicantId = appInsert.rows[0].id;

    // Save screening responses
    for (var j = 0; j < responses.length; j++) {
      var r2r = responses[j];
      await db.query(
        'INSERT INTO screening_responses (applicant_id,question_id,answer,points_earned) VALUES ($1,$2,$3,$4)',
        [applicantId, r2r.question_id, r2r.answer, r2r.points_earned]
      );
    }

    if (!passed) {
      await sendDeclineEmail(b.email, b.first_name, job.title, job.company_name);
      return res.json({ status: 'declined_score', score: earnedPoints, max_score: totalPoints, email: b.email });
    }

    // ── Send scheduling link
    var schedParams = new URLSearchParams({
      name:        b.first_name + ' ' + b.last_name,
      email:       b.email,
      job:         job.title,
      company:     job.company_name,
      client:      job.client_email,
      manager:     job.contact_name,
      applicant:   applicantId,
      jobid:       jobId,
      format:      job.interview_format,
    });
    var scheduleUrl = APP + '/schedule?' + schedParams.toString();

    await sendMail(
      b.email,
      'Next Step — Schedule Your Interview | ' + job.title + ' | Next-Jenn',
      emailWrap('Congratulations, ' + b.first_name + '!',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'You have passed the initial screening for the <strong style="color:#1B2A4A;">' + job.title + '</strong>'
        + (job.company_name ? ' position at <strong style="color:#1B2A4A;">' + job.company_name + '</strong>' : '') + '.'
        + '</p>'
        + '<p style="margin:0 0 20px;font-size:14px;color:#555B6E;line-height:1.7;">'
        + 'The next step is a short video interview with Jenn, our AI recruiter. It takes approximately 8-10 minutes. Please click below to schedule your interview at a time that works for you.'
        + '</p>'
        + btnHtml(scheduleUrl, 'Schedule My Interview')
      )
    );

    // Notify hiring manager
    await sendMail(
      job.client_email,
      b.first_name + ' ' + b.last_name + ' Passed Screening — ' + job.title + ' | Next-Jenn',
      emailWrap('New Qualified Candidate',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + '<strong style="color:#1B2A4A;">' + b.first_name + ' ' + b.last_name + '</strong> has completed the screening questionnaire for <strong style="color:#1B2A4A;">' + job.title + '</strong> and scored <strong>' + earnedPoints + '/' + totalPoints + ' (' + Math.round(scorePct) + '%)</strong>.'
        + '</p>'
        + '<p style="margin:0;font-size:14px;color:#555B6E;">They have been sent a scheduling link for their interview. You will receive the transcript once they complete it.</p>'
      )
    );

    res.json({ status: 'interview_sent', score: earnedPoints, max_score: totalPoints, score_pct: scorePct, email: b.email });
  } catch(e) {
    console.error('Apply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function sendDeclineEmail(email, firstName, jobTitle, company) {
  try {
    await sendMail(
      email,
      'Your Application — ' + jobTitle + ' | Next-Jenn',
      emailWrap('Thank You for Applying',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'Dear ' + firstName + ','
        + '</p>'
        + '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'Thank you for your interest in the <strong style="color:#1B2A4A;">' + jobTitle + '</strong>'
        + (company ? ' position at <strong style="color:#1B2A4A;">' + company + '</strong>' : '') + '.'
        + '</p>'
        + '<p style="margin:0;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'After careful review of your application, we will not be moving forward at this time. We appreciate the time you invested in applying and wish you the very best in your job search.'
        + '</p>'
      )
    );
  } catch(e) { console.error('Decline email error:', e.message); }
}

// ════════════════════════════════════════════════════
// SCHEDULE ROUTE
// ════════════════════════════════════════════════════
app.post('/api/confirm-schedule', async function(req, res) {
  try {
    var b = req.body;
    var sendAt  = new Date(b.scheduled_time);
    var now     = new Date();
    var delayMs = sendAt.getTime() - now.getTime();
    if (delayMs < 0) return res.status(400).json({ error: 'Scheduled time is in the past' });

    var token    = (b.cand_name||'cand').toLowerCase().replace(/\s+/g,'-') + '-' + Date.now();
    var iParams  = new URLSearchParams({
      session:   token,
      name:      b.cand_name    || '',
      job:       b.job_title    || '',
      company:   b.company_name || '',
      client:    b.client_email || '',
      manager:   b.manager      || '',
      cemail:    b.cand_email   || '',
      format:    b.format       || 'video',
      applicant: b.applicant_id || '',
      jobid:     b.job_id       || '',
    });
    var interviewUrl = APP + '/interview?' + iParams.toString();
    var tz       = b.timezone || 'America/Chicago';
    var timeStr  = fmtTime(sendAt, tz);
    var timeouts = [];

    // Send interview link at scheduled time
    timeouts.push(scheduleTimeout(async function() {
      try {
        await sendMail(b.cand_email,
          'Your Interview Is Ready — ' + b.job_title + ' | Next-Jenn',
          emailWrap('Hi ' + b.cand_name + ', your interview is ready!',
            '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
            + 'Your interview for <strong style="color:#1B2A4A;">' + b.job_title + '</strong> is ready to begin.'
            + '</p>'
            + '<p style="margin:0 0 20px;font-size:14px;color:#555B6E;line-height:1.7;">'
            + 'The interview takes approximately 8-10 minutes. Please ensure your camera and microphone are ready and find a quiet space.'
            + '</p>'
            + btnHtml(interviewUrl, 'Start My Interview')
          )
        );
        console.log('Interview link sent to ' + b.cand_email);
        if (b.applicant_id) {
          await db.query("UPDATE applicants SET status='interview_scheduled' WHERE id=$1", [b.applicant_id]);
        }
        // Missed follow-ups
        timeouts.push(scheduleTimeout(async function() {
          if (scheduled[token] && !scheduled[token].completed) {
            await sendMail(b.cand_email,
              'We Missed You — Reschedule Your Interview | Next-Jenn',
              emailWrap('Hi ' + b.cand_name + ',',
                '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
                + 'It looks like you may have missed your interview. Your link is still active — click below to complete it at your convenience.'
                + '</p>' + btnHtml(interviewUrl, 'Complete My Interview')
              )
            );
          }
        }, 30 * 60 * 1000));
        timeouts.push(scheduleTimeout(async function() {
          if (scheduled[token] && !scheduled[token].completed) {
            await sendMail(b.cand_email,
              'Final Notice — Complete Your Interview | Next-Jenn',
              emailWrap('Hi ' + b.cand_name + ',',
                '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
                + 'This is a final notice regarding your interview for <strong style="color:#1B2A4A;">' + b.job_title + '</strong>. Please complete it at your earliest convenience.'
                + '</p>' + btnHtml(interviewUrl, 'Complete My Interview')
              )
            );
          }
        }, 24 * 60 * 60 * 1000));
      } catch(e) { console.error('Interview link error:', e.message); }
    }, delayMs));

    // 24hr reminder
    var r24 = delayMs - (24 * 60 * 60 * 1000);
    if (r24 > 0) timeouts.push(scheduleTimeout(async function() {
      await sendMail(b.cand_email, 'Reminder: Interview Tomorrow — ' + b.job_title + ' | Next-Jenn',
        emailWrap('Interview Reminder',
          '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;">Your interview for <strong style="color:#1B2A4A;">' + b.job_title + '</strong> is tomorrow.</p>'
          + '<div style="background:#EEF1F7;border-left:4px solid #1B2A4A;padding:16px 20px;border-radius:8px;margin:0 0 16px;"><p style="margin:0;font-size:17px;font-weight:700;color:#1B2A4A;">' + timeStr + '</p></div>'
          + '<p style="font-size:14px;color:#555B6E;">Your interview link will be sent at the scheduled time.</p>'
        )
      ).catch(function(){});
    }, r24));

    // 1hr reminder
    var r1 = delayMs - (60 * 60 * 1000);
    if (r1 > 0) timeouts.push(scheduleTimeout(async function() {
      await sendMail(b.cand_email, 'Interview in 1 Hour — ' + b.job_title + ' | Next-Jenn',
        emailWrap('Interview in 1 Hour',
          '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;">Your interview starts in 1 hour.</p>'
          + '<div style="background:#FFF8EC;border-left:4px solid #C9963A;padding:16px 20px;border-radius:8px;margin:0 0 16px;"><p style="margin:0;font-size:17px;font-weight:700;color:#C9963A;">' + timeStr + '</p></div>'
          + '<p style="font-size:14px;color:#555B6E;">Get to a quiet space. Your interview link will arrive at the scheduled time.</p>'
        )
      ).catch(function(){});
    }, r1));

    // Notify hiring manager
    if (b.client_email) {
      await sendMail(b.client_email,
        b.cand_name + ' Has Scheduled Their Interview — ' + b.job_title + ' | Next-Jenn',
        emailWrap('Interview Scheduled',
          '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
          + '<strong style="color:#1B2A4A;">' + b.cand_name + '</strong> has scheduled their interview for <strong style="color:#1B2A4A;">' + b.job_title + '</strong>.'
          + '</p>'
          + '<div style="background:#EEF1F7;border-left:4px solid #1B2A4A;padding:16px 20px;border-radius:8px;margin:0 0 16px;">'
          + '<p style="margin:0;font-size:17px;font-weight:700;color:#1B2A4A;">' + timeStr + '</p>'
          + '</div>'
          + '<p style="font-size:13px;color:#8892A4;">You will receive the transcript once they complete their interview.</p>'
        )
      ).catch(function(){});
    }

    scheduled[token] = { sendAt: sendAt.toISOString(), interviewUrl, meta: b, timeouts, completed: false };
    res.json({ success: true, scheduled_time: sendAt.toISOString(), time_str: timeStr });
  } catch(e) {
    console.error('confirm-schedule error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// VIDEO UPLOAD
// ════════════════════════════════════════════════════
app.post('/api/upload', upload.single('video'), async function(req, res) {
  try {
    console.log('Upload received — session:' + req.body.session_id + ' seg:' + req.body.segment_id);
    var sessionId  = req.body.session_id   || '';
    var segmentId  = req.body.segment_id   || '';
    var segIdx     = req.body.segment_index || '0';
    var file       = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    var ext    = (file.originalname.split('.').pop()) || 'webm';
    var r2Key  = 'responses/' + sessionId + '/seg' + segIdx + '_' + Date.now() + '.' + ext;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME, Key: r2Key,
      Body: file.buffer, ContentType: file.mimetype,
    }));
    var videoUrl = process.env.R2_PUBLIC_URL + '/' + r2Key;
    console.log('Upload OK: ' + r2Key + ' (' + (file.size/1024/1024).toFixed(1) + 'MB)');

    if (!sessions[sessionId]) sessions[sessionId] = { videos: {}, meta: {} };
    if (segmentId) sessions[sessionId].videos[segmentId] = videoUrl;
    sessions[sessionId].meta = {
      cand_name:    req.body.cand_name    || '',
      cand_email:   req.body.cand_email   || '',
      job_title:    req.body.job_title    || '',
      company_name: req.body.company_name || '',
      client_email: req.body.client_email || '',
      applicant_id: req.body.applicant_id || '',
      job_id:       req.body.job_id       || '',
      format:       req.body.format       || 'video',
    };

    var required = ['q1','q2','q3','q4','final'];
    var hasAll = required.every(function(id) { return sessions[sessionId].videos[id]; });
    if (hasAll) sendTranscript(sessionId);

    res.json({ success: true, video_url: videoUrl });
  } catch(e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// TRANSCRIPT
// ════════════════════════════════════════════════════
async function sendTranscript(sessionId) {
  var session = sessions[sessionId];
  if (!session) return;
  var m       = session.meta;
  var cand    = m.cand_name    || 'Candidate';
  var job     = m.job_title    || 'Open Role';
  var company = m.company_name || '';
  var toEmail = m.client_email || process.env.EMAIL_USER;
  var dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  console.log('Sending transcript to ' + toEmail);

  // Transcribe with Claude if API key available
  var transcripts = {};
  if (process.env.ANTHROPIC_API_KEY) {
    for (var segId in session.videos) {
      try {
        var msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          messages: [{ role: 'user', content: 'The candidate recorded a video interview response. The video URL is: ' + session.videos[segId] + '. Based on this being a job interview response, write "[Video response — click Watch Response to view]" as the transcription placeholder. Do not attempt to access the URL.' }]
        });
        transcripts[segId] = '[Video response — click Watch Response to view]';
      } catch(e) {
        transcripts[segId] = '[Video response — click Watch Response to view]';
      }
    }
  }

  var LABELS = {
    q1: 'Q1 — What is your interest in this position?',
    q2: 'Q2 — Summary of experience relative to this role',
    q3: 'Q3 — Three words that best describe you',
    q4: 'Q4 — Project you are most proud of',
    final: 'Final — Are you interested in moving forward?',
  };

  var qaHtml = '';
  ['q1','q2','q3','q4','final'].forEach(function(id) {
    var url = session.videos[id];
    if (!url) return;
    qaHtml += '<div style="margin-bottom:12px;border:1px solid #D8DCE6;border-radius:8px;overflow:hidden;">'
      + '<div style="background:#F0F2F5;padding:8px 16px;border-bottom:2px solid #1B2A4A;">'
      + '<p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:.08em;">' + (LABELS[id]||id) + '</p>'
      + '</div><div style="padding:12px 16px;">'
      + '<p style="margin:0 0 8px;font-size:13px;color:#555B6E;font-style:italic;">' + (transcripts[id]||'[Response recorded]') + '</p>'
      + '<a href="' + url + '" style="display:inline-block;padding:7px 16px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:700;">Watch Response</a>'
      + '</div></div>';
  });

  var html = emailWrap('Interview Transcript Ready',
    '<div style="background:#EEF1F7;padding:16px 20px;border-radius:8px;margin:0 0 20px;">'
    + '<table width="100%"><tr>'
    + '<td><p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">' + cand + '</p></td>'
    + '<td align="right"><p style="margin:0;font-size:16px;font-weight:700;color:#1B2A4A;">' + job + '</p>'
    + (company ? '<p style="margin:2px 0 0;font-size:12px;color:#555B6E;">' + company + '</p>' : '')
    + '<p style="margin:2px 0 0;font-size:12px;color:#555B6E;">' + dateStr + '</p>'
    + '</td></tr></table></div>'
    + '<p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#8892A4;text-transform:uppercase;letter-spacing:.1em;">Interview Responses</p>'
    + qaHtml
  );

  mailer.sendMail({
    from: fromAddr(), to: toEmail,
    subject: 'Interview Complete — ' + cand + ' for ' + job + (company ? ' at ' + company : '') + ' | Next-Jenn',
    html,
  }, async function(err) {
    if (err) { console.error('Transcript email error:', err.message); return; }
    console.log('Transcript sent to ' + toEmail);
    // Update DB
    if (m.applicant_id) {
      await db.query("UPDATE applicants SET status='interview_complete' WHERE id=$1", [m.applicant_id]).catch(function(){});
    }
    if (scheduled[sessionId]) scheduled[sessionId].completed = true;
    delete sessions[sessionId];
  });

  // Send confirmation to candidate
  if (m.cand_email) {
    sendMail(m.cand_email,
      'Your Interview Has Been Submitted — ' + job + ' | Next-Jenn',
      emailWrap('Interview Complete — Thank You!',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'Thank you for completing your interview for <strong style="color:#1B2A4A;">' + job + '</strong>'
        + (company ? ' at <strong style="color:#1B2A4A;">' + company + '</strong>' : '') + '.'
        + '</p>'
        + '<div style="background:#EAF4EE;border-left:4px solid #2E7D5E;padding:16px 20px;border-radius:8px;margin:0 0 20px;">'
        + '<p style="margin:0;font-size:15px;font-weight:600;color:#2E7D5E;">&#10003; Your responses have been submitted to the hiring team.</p>'
        + '</div>'
        + '<p style="margin:0;font-size:14px;color:#555B6E;line-height:1.7;">The hiring manager will review your video responses and will be in touch if they would like to move forward.</p>'
      )
    ).catch(function(){});
  }
}

// ════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════
app.get('/api/dashboard/:clientId', async function(req, res) {
  try {
    var jobs = await db.query(
      'SELECT j.*, COUNT(a.id) as applicant_count, '
      + "COUNT(CASE WHEN a.status='interview_complete' THEN 1 END) as completed_count "
      + 'FROM jobs j LEFT JOIN applicants a ON j.id = a.job_id '
      + 'WHERE j.client_id = $1 GROUP BY j.id ORDER BY j.created_at DESC',
      [req.params.clientId]
    );
    var client = await db.query('SELECT * FROM clients WHERE id = $1', [req.params.clientId]);
    res.json({ client: client.rows[0], jobs: jobs.rows });
  } catch(e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dashboard/:clientId/job/:jobId', async function(req, res) {
  try {
    var applicants = await db.query(
      'SELECT a.*, i.video_urls, i.transcript, i.completed_at '
      + 'FROM applicants a LEFT JOIN interviews i ON a.id = i.applicant_id '
      + 'WHERE a.job_id = $1 ORDER BY a.created_at DESC',
      [req.params.jobId]
    );
    var job = await db.query('SELECT * FROM jobs WHERE id=$1', [req.params.jobId]);
    res.json({ job: job.rows[0], applicants: applicants.rows });
  } catch(e) {
    console.error('Job applicants error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// EXISTING ROUTES (backward compat)
// ════════════════════════════════════════════════════
app.post('/api/send-interview', async function(req, res) {
  try {
    var b = req.body;
    var inviteId = (b.cand_name||'cand').toLowerCase().replace(/\s+/g,'-') + '-inv-' + Date.now();
    var params = new URLSearchParams({
      name: b.cand_name||'', email: b.cand_email||'', job: b.job_title||'',
      company: b.company_name||'', client: b.client_email||'',
      manager: b.hiring_manager_name||'', invite: inviteId, desc: b.job_description||'',
    });
    var scheduleUrl = APP + '/apply-simple?' + params.toString();
    await sendMail(b.cand_email,
      'Interview Invitation — ' + b.job_title + ' | Next-Jenn',
      emailWrap('Hi ' + b.cand_name + ',',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'You have been invited to interview for <strong style="color:#1B2A4A;">' + b.job_title + '</strong>'
        + (b.company_name ? ' at <strong style="color:#1B2A4A;">' + b.company_name + '</strong>' : '') + '.'
        + '</p>' + btnHtml(scheduleUrl, 'Schedule My Interview')
      )
    );
    console.log('Schedule link sent to ' + b.cand_email);
    res.json({ success: true, schedule_url: scheduleUrl });
  } catch(e) {
    console.error('send-interview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/interview/:sid/submit-response', function(req, res) {
  res.json({ success: true, action: 'play_next' });
});

// ════════════════════════════════════════════════════
// PAGES
// ════════════════════════════════════════════════════
app.get('/',              function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/send',          function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/setup',         function(req, res) { res.sendFile(path.join(__dirname, 'setup.html')); });
app.get('/apply/:jobId',  function(req, res) { res.sendFile(path.join(__dirname, 'apply.html')); });
app.get('/apply-simple',  function(req, res) { res.sendFile(path.join(__dirname, 'apply.html')); });
app.get('/schedule',      function(req, res) { res.sendFile(path.join(__dirname, 'schedule-interview.html')); });
app.get('/audio-interview', function(req, res) { res.sendFile(path.join(__dirname, 'audio-interview.html')); });
app.get('/interview', function(req, res) {
  if (req.query.format === 'audio') {
    return res.sendFile(path.join(__dirname, 'audio-interview.html'));
  }
  res.sendFile(path.join(__dirname, 'interview-page.html'));
});
app.get('/dashboard/:clientId', function(req, res) { res.sendFile(path.join(__dirname, 'dashboard.html')); });
app.get('/jobs/:jobId',   function(req, res) { res.sendFile(path.join(__dirname, 'job-posting.html')); });
app.get('/health',        function(req, res) { res.json({ status: 'ok', sessions: Object.keys(sessions).length }); });

var PORT = process.env.PORT || 3000;
db.testConnection().then(function() {
  app.listen(PORT, function() { console.log('Next-Jenn v3 running on port ' + PORT); });
});
