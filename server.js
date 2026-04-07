'use strict';
require('dotenv').config();

var express    = require('express');
var multer     = require('multer');
var nodemailer = require('nodemailer');
var path       = require('path');
var cors       = require('cors');
var { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

var app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── R2
var r2 = new S3Client({
  region:   'auto',
  endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ── EMAIL
var mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});

function fromAddr() {
  return 'Next-Jenn <' + (process.env.EMAIL_FROM || process.env.EMAIL_USER) + '>';
}

function sendMail(to, subject, html) {
  return mailer.sendMail({ from: fromAddr(), to: to, subject: subject, html: html });
}

// ── MULTER
var upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 150 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'audio/webm') cb(null, true);
    else cb(new Error('Video only'), false);
  },
});

// ── SESSION STORE
var sessions = {};

// ── INVITE STORE — tracks candidates who were sent scheduling links
// invites[inviteId] = { meta, scheduleUrl, sentAt, scheduled: false, timeouts: [] }
var invites = {};

// ── SCHEDULED STORE
// scheduled[token] = { sendAt, interviewUrl, meta, timeouts: [], completed: false }
var scheduled = {};

var APP = process.env.APP_URL || 'https://nextjenn.onrender.com';

var LABELS = {
  q1:    'Q1 — What is your interest in this position?',
  q2:    'Q2 — Summary of experience relative to this role',
  q3:    'Q3 — Three words that best describe you',
  q4:    'Q4 — Project you are most proud of',
  final: 'Final — Are you interested in moving forward?',
};

// ── HELPERS
function scheduleTimeout(fn, ms) {
  // Cap at ~24 days to avoid Node.js overflow
  var MAX = 2147483647;
  if (ms > MAX) {
    return setTimeout(function() { scheduleTimeout(fn, ms - MAX); }, MAX);
  }
  return setTimeout(fn, ms);
}

function clearAllTimeouts(timeouts) {
  if (!timeouts) return;
  timeouts.forEach(function(id) { clearTimeout(id); });
}

function fmtTime(date, tz) {
  try {
    return date.toLocaleString('en-US', {
      timeZone: tz || 'America/Chicago',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch(e) {
    return date.toLocaleString();
  }
}

function jobDescHtml(jobDesc) {
  if (!jobDesc) return '';
  return '<div style="margin:20px 0;padding:16px 20px;background:#F8F9FC;border:1px solid #D8DCE6;border-radius:8px;border-left:4px solid #1B2A4A;">'
    + '<p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:.1em;">Job Description</p>'
    + '<p style="margin:0;font-size:13px;color:#555B6E;line-height:1.8;white-space:pre-wrap;">' + jobDesc + '</p>'
    + '</div>';
}

// ════════════════════════════════════════════════════════
// 1. HIRING MANAGER SENDS INTERVIEW
// POST /api/send-interview
// ════════════════════════════════════════════════════════
app.post('/api/send-interview', async function(req, res) {
  try {
    var company    = req.body.company_name        || '';
    var manager    = req.body.hiring_manager_name || '';
    var clientEmail= req.body.client_email        || '';
    var jobTitle   = req.body.job_title           || '';
    var jobDesc    = req.body.job_description     || '';
    var candName   = req.body.cand_name           || '';
    var candEmail  = req.body.cand_email          || '';

    if (!clientEmail || !jobTitle || !candName || !candEmail) {
      return res.status(400).json({ error: 'All fields required' });
    }

    var inviteId = candName.toLowerCase().replace(/\s+/g,'-') + '-inv-' + Date.now();

    var params = new URLSearchParams({
      name:    candName,
      email:   candEmail,
      job:     jobTitle,
      company: company,
      client:  clientEmail,
      manager: manager,
      invite:  inviteId,
      desc:    jobDesc,
    });
    var scheduleUrl = APP + '/schedule?' + params.toString();

    // Send initial scheduling email
    await sendMail(
      candEmail,
      'Interview Invitation — ' + jobTitle + (company ? ' at ' + company : '') + ' | Next-Jenn',
      emailWrap('Hi ' + candName + ',',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'You have been invited to interview for the <strong style="color:#1B2A4A;">' + jobTitle + '</strong>'
        + (company ? ' position at <strong style="color:#1B2A4A;">' + company + '</strong>.' : ' position.')
        + '</p>'
        + '<p style="margin:0 0 20px;font-size:14px;color:#555B6E;line-height:1.7;">'
        + 'The interview takes approximately 8-10 minutes and is conducted by Jenn, our AI recruiter. Please click below to choose your interview time.'
        + '</p>'
        + jobDescHtml(jobDesc)
        + btnHtml(scheduleUrl, 'Schedule My Interview')
        + '<p style="text-align:center;margin:8px 0 0;font-size:12px;color:#8892A4;">Pick a time that works best for you</p>'
      )
    );

    // Store invite for follow-up tracking
    var meta = { candName, candEmail, jobTitle, jobDesc, company, clientEmail, manager, scheduleUrl };
    var timeouts = [];

    // Follow-up 1 — after 4 hours if not scheduled
    timeouts.push(scheduleTimeout(function() {
      if (invites[inviteId] && !invites[inviteId].scheduled) {
        sendFollowupNotScheduled(inviteId, 1);
      }
    }, 4 * 60 * 60 * 1000));

    // Follow-up 2 — after 48 hours (day 2)
    timeouts.push(scheduleTimeout(function() {
      if (invites[inviteId] && !invites[inviteId].scheduled) {
        sendFollowupNotScheduled(inviteId, 2);
      }
    }, 48 * 60 * 60 * 1000));

    // Follow-up 3 — after 72 hours (day 3) then expire
    timeouts.push(scheduleTimeout(function() {
      if (invites[inviteId] && !invites[inviteId].scheduled) {
        sendFollowupNotScheduled(inviteId, 3);
        delete invites[inviteId];
      }
    }, 72 * 60 * 60 * 1000));

    invites[inviteId] = { meta: meta, scheduleUrl: scheduleUrl, sentAt: new Date().toISOString(), scheduled: false, timeouts: timeouts };

    console.log('Schedule link sent to ' + candEmail + ' [invite:' + inviteId + ']');
    res.json({ success: true, schedule_url: scheduleUrl, invite_id: inviteId });

  } catch (err) {
    console.error('send-interview error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Follow-up: never scheduled
async function sendFollowupNotScheduled(inviteId, attempt) {
  var inv = invites[inviteId];
  if (!inv) return;
  var m = inv.meta;
  var subjects = [
    'Reminder: Schedule Your Interview — ' + m.jobTitle + ' | Next-Jenn',
    'Following Up: Your Interview Is Still Available — ' + m.jobTitle + ' | Next-Jenn',
    'Final Reminder: Interview Opportunity — ' + m.jobTitle + ' | Next-Jenn',
  ];
  var intros = [
    'Just a friendly reminder that your interview for <strong style="color:#1B2A4A;">' + m.jobTitle + '</strong> is still waiting to be scheduled.',
    'We noticed you haven\'t scheduled your interview yet for <strong style="color:#1B2A4A;">' + m.jobTitle + '</strong>. We\'d love to hear from you!',
    'This is a final reminder for your interview opportunity for <strong style="color:#1B2A4A;">' + m.jobTitle + '</strong>. The link expires soon.',
  ];
  var idx = attempt - 1;
  try {
    await sendMail(
      m.candEmail,
      subjects[idx],
      emailWrap('Hi ' + m.candName + ',',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">' + intros[idx] + '</p>'
        + (m.jobDesc ? jobDescHtml(m.jobDesc) : '')
        + btnHtml(m.scheduleUrl, 'Schedule My Interview')
      )
    );
    console.log('Follow-up ' + attempt + ' sent to ' + m.candEmail);
  } catch(e) {
    console.error('Follow-up email error: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════
// 2. CANDIDATE CONFIRMS SCHEDULE
// POST /api/confirm-schedule
// ════════════════════════════════════════════════════════
app.post('/api/confirm-schedule', async function(req, res) {
  try {
    var candName    = req.body.cand_name      || '';
    var candEmail   = req.body.cand_email     || '';
    var jobTitle    = req.body.job_title      || '';
    var jobDesc     = req.body.job_desc       || '';
    var company     = req.body.company_name   || '';
    var clientEmail = req.body.client_email   || '';
    var manager     = req.body.manager        || '';
    var inviteId    = req.body.invite_id      || '';
    var schedTime   = req.body.scheduled_time;
    var tz          = req.body.timezone       || 'America/Chicago';

    if (!candEmail || !schedTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    var sendAt  = new Date(schedTime);
    var now     = new Date();
    var delayMs = sendAt.getTime() - now.getTime();

    if (delayMs < 0) {
      return res.status(400).json({ error: 'Scheduled time is in the past' });
    }

    // Mark invite as scheduled — stop follow-up emails
    if (inviteId && invites[inviteId]) {
      clearAllTimeouts(invites[inviteId].timeouts);
      invites[inviteId].scheduled = true;
    }

    // Build interview URL
    var token    = candName.toLowerCase().replace(/\s+/g,'-') + '-' + Date.now();
    var iParams  = new URLSearchParams({
      session: token,
      name:    candName,
      job:     jobTitle,
      company: company,
      client:  clientEmail,
      manager: manager,
      desc:    jobDesc,
    });
    var interviewUrl = APP + '/interview?' + iParams.toString();
    var timeStr      = fmtTime(sendAt, tz);
    var timeouts     = [];

    // ── Send interview link at scheduled time
    timeouts.push(scheduleTimeout(async function() {
      try {
        await sendMail(
          candEmail,
          'Your Interview Is Ready — ' + jobTitle + ' | Next-Jenn',
          emailWrap('Hi ' + candName + ', your interview is ready!',
            '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
            + 'Your interview for <strong style="color:#1B2A4A;">' + jobTitle + '</strong>'
            + (company ? ' at <strong style="color:#1B2A4A;">' + company + '</strong>' : '')
            + ' is ready to begin.'
            + '</p>'
            + (jobDesc ? jobDescHtml(jobDesc) : '')
            + '<p style="margin:0 0 20px;font-size:14px;color:#555B6E;line-height:1.7;">'
            + 'The interview takes approximately 8-10 minutes. Please ensure your camera and microphone are working and find a quiet space with good lighting.'
            + '</p>'
            + btnHtml(interviewUrl, 'Start My Interview')
          )
        );
        console.log('Interview link sent to ' + candEmail);

        // Mark as notified — start missed interview tracking
        if (scheduled[token]) {
          scheduled[token].notified = true;

          // Missed follow-up 1 — 30 min after scheduled time
          timeouts.push(scheduleTimeout(function() {
            if (scheduled[token] && !scheduled[token].completed) {
              sendMissedFollowup(token, 1);
            }
          }, 30 * 60 * 1000));

          // Missed follow-up 2 — 24 hours after scheduled time
          timeouts.push(scheduleTimeout(function() {
            if (scheduled[token] && !scheduled[token].completed) {
              sendMissedFollowup(token, 2);
              delete scheduled[token];
            }
          }, 24 * 60 * 60 * 1000));
        }

      } catch (e) {
        console.error('Interview link email error: ' + e.message);
      }
    }, delayMs));

    // ── Reminder 24hr before
    var reminder24Ms = delayMs - (24 * 60 * 60 * 1000);
    if (reminder24Ms > 0) {
      timeouts.push(scheduleTimeout(async function() {
        try {
          await sendMail(
            candEmail,
            'Reminder: Your Interview Tomorrow — ' + jobTitle + ' | Next-Jenn',
            emailWrap('Interview Reminder — Tomorrow',
              '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
              + 'Your interview for <strong style="color:#1B2A4A;">' + jobTitle + '</strong> is tomorrow.</p>'
              + '<div style="background:#EEF1F7;border-left:4px solid #1B2A4A;padding:16px 20px;border-radius:8px;margin:0 0 20px;">'
              + '<p style="margin:0;font-size:17px;font-weight:700;color:#1B2A4A;">' + timeStr + '</p>'
              + '</div>'
              + '<p style="margin:0;font-size:14px;color:#555B6E;line-height:1.7;">Make sure your camera and microphone are ready. Your interview link will be sent at the scheduled time.</p>'
            )
          );
          console.log('24hr reminder sent to ' + candEmail);
        } catch(e) { console.error('24hr reminder error: ' + e.message); }
      }, reminder24Ms));
    }

    // ── Reminder 1hr before
    var reminder1Ms = delayMs - (60 * 60 * 1000);
    if (reminder1Ms > 0) {
      timeouts.push(scheduleTimeout(async function() {
        try {
          await sendMail(
            candEmail,
            'Your Interview Starts in 1 Hour — ' + jobTitle + ' | Next-Jenn',
            emailWrap('Interview in 1 Hour',
              '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
              + 'Your interview for <strong style="color:#1B2A4A;">' + jobTitle + '</strong> starts in 1 hour.</p>'
              + '<div style="background:#FFF8EC;border-left:4px solid #C9963A;padding:16px 20px;border-radius:8px;margin:0 0 20px;">'
              + '<p style="margin:0;font-size:17px;font-weight:700;color:#C9963A;">' + timeStr + '</p>'
              + '</div>'
              + '<p style="margin:0;font-size:14px;color:#555B6E;line-height:1.7;">Get to a quiet space with good lighting. Your interview link will arrive shortly.</p>'
            )
          );
          console.log('1hr reminder sent to ' + candEmail);
        } catch(e) { console.error('1hr reminder error: ' + e.message); }
      }, reminder1Ms));
    }

    scheduled[token] = {
      sendAt:       sendAt.toISOString(),
      interviewUrl: interviewUrl,
      meta:         { candName, candEmail, jobTitle, jobDesc, company, clientEmail, manager },
      timeouts:     timeouts,
      completed:    false,
      notified:     false,
    };

    // ── Send confirmation email immediately
    await sendMail(
      candEmail,
      'Interview Confirmed — ' + jobTitle + ' | Next-Jenn',
      emailWrap('Your interview is confirmed!',
        '<p style="margin:0 0 16px;font-size:15px;color:#555B6E;line-height:1.7;">'
        + 'Your interview for <strong style="color:#1B2A4A;">' + jobTitle + '</strong>'
        + (company ? ' at <strong style="color:#1B2A4A;">' + company + '</strong>' : '')
        + ' is scheduled for:'
        + '</p>'
        + '<div style="background:#EEF1F7;border-left:4px solid #1B2A4A;padding:16px 20px;border-radius:8px;margin:0 0 20px;">'
        + '<p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">' + timeStr + '</p>'
        + '</div>'
        + (jobDesc ? jobDescHtml(jobDesc) : '')
        + '<p style="margin:0;font-size:14px;color:#555B6E;line-height:1.7;">'
        + 'You will receive your interview link by email at this time. You\'ll also receive a reminder 24 hours and 1 hour before. Please be ready with your camera and microphone.'
        + '</p>'
      )
    );

    console.log('Confirmation sent to ' + candEmail + ' — scheduled for ' + sendAt.toISOString());
    res.json({ success: true, scheduled_time: sendAt.toISOString(), time_str: timeStr });

  } catch (err) {
    console.error('confirm-schedule error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Missed interview follow-up
async function sendMissedFollowup(token, attempt) {
  var s = scheduled[token];
  if (!s) return;
  var m = s.meta;
  var subjects = [
    'We Missed You — Reschedule Your Interview | Next-Jenn',
    'Final Notice: Reschedule Your Interview — ' + m.jobTitle + ' | Next-Jenn',
  ];
  var msgs = [
    'It looks like you may have missed your interview for <strong style="color:#1B2A4A;">' + m.jobTitle + '</strong>. No worries — you can still complete it using the link below.',
    'This is a final notice regarding your interview for <strong style="color:#1B2A4A;">' + m.jobTitle + '</strong>. Please complete your interview at your earliest convenience.',
  ];
  try {
    await sendMail(
      m.candEmail,
      subjects[attempt - 1],
      emailWrap('Hi ' + m.candName + ',',
        '<p style="margin:0 0 20px;font-size:15px;color:#555B6E;line-height:1.7;">' + msgs[attempt - 1] + '</p>'
        + btnHtml(s.interviewUrl, 'Complete My Interview')
      )
    );
    console.log('Missed follow-up ' + attempt + ' sent to ' + m.candEmail);
  } catch(e) {
    console.error('Missed follow-up error: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════
// 3. VIDEO UPLOAD
// POST /api/upload
// ════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('video'), async function(req, res) {
  try {
    console.log('Upload received — session:' + req.body.session_id + ' seg:' + req.body.segment_id);

    var sessionId = req.body.session_id  || '';
    var segmentId = req.body.segment_id  || '';
    var segIdx    = req.body.segment_index || '0';
    var file      = req.file;

    if (!file) return res.status(400).json({ error: 'No file' });

    var ext   = (file.originalname.split('.').pop()) || 'webm';
    var r2Key = 'responses/' + sessionId + '/seg' + segIdx + '_' + Date.now() + '.' + ext;

    await r2.send(new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET_NAME,
      Key:         r2Key,
      Body:        file.buffer,
      ContentType: file.mimetype,
    }));

    var videoUrl = process.env.R2_PUBLIC_URL + '/' + r2Key;
    console.log('Upload OK: ' + r2Key + ' (' + (file.size/1024/1024).toFixed(1) + 'MB)');

    if (!sessions[sessionId]) sessions[sessionId] = { videos: {}, meta: {} };
    if (segmentId) sessions[sessionId].videos[segmentId] = videoUrl;
    sessions[sessionId].meta = {
      cand_name:    req.body.cand_name    || '',
      job_title:    req.body.job_title    || '',
      company_name: req.body.company_name || '',
      client_email: req.body.client_email || '',
    };

    var required = ['q1','q2','q3','q4','final'];
    var hasAll = required.every(function(id) { return sessions[sessionId].videos[id]; });
    console.log('Session ' + sessionId + ': ' + Object.keys(sessions[sessionId].videos).length + '/5 — hasAll:' + hasAll);

    if (hasAll) {
      // Mark as completed to stop missed follow-ups
      if (scheduled[sessionId]) scheduled[sessionId].completed = true;
      sendTranscript(sessionId);
    }

    res.json({ success: true, video_url: videoUrl });

  } catch (err) {
    console.error('Upload error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// 4. TRANSCRIPT EMAIL
// ════════════════════════════════════════════════════════
function sendTranscript(sessionId) {
  var session = sessions[sessionId];
  if (!session) return;

  var cand    = session.meta.cand_name    || 'Candidate';
  var job     = session.meta.job_title    || 'Open Role';
  var company = session.meta.company_name || '';
  var toEmail = session.meta.client_email || process.env.EMAIL_USER;
  var dateStr = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  console.log('Sending transcript to ' + toEmail + ' for ' + cand);

  var qaHtml = '';
  ['q1','q2','q3','q4','final'].forEach(function(id) {
    var url = session.videos[id];
    if (!url) return;
    qaHtml += '<div style="margin-bottom:12px;border:1px solid #D8DCE6;border-radius:8px;overflow:hidden;">'
      + '<div style="background:#F0F2F5;padding:8px 16px;border-bottom:2px solid #1B2A4A;">'
      + '<p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:.08em;">' + (LABELS[id]||id) + '</p>'
      + '</div><div style="padding:12px 16px;">'
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
    from:    fromAddr(),
    to:      toEmail,
    subject: 'Interview Complete — ' + cand + ' for ' + job + (company ? ' at ' + company : '') + ' | Next-Jenn',
    html:    html,
  }, function(err) {
    if (err) console.error('Transcript email error: ' + err.message);
    else { console.log('Transcript sent to ' + toEmail); delete sessions[sessionId]; }
  });
}

// ════════════════════════════════════════════════════════
// STUB ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/interview/:sid/submit-response', function(req, res) {
  res.json({ success: true, action: 'play_next' });
});

// ════════════════════════════════════════════════════════
// PAGES
// ════════════════════════════════════════════════════════
app.get('/',          function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/send',      function(req, res) { res.sendFile(path.join(__dirname, 'send-interview.html')); });
app.get('/schedule',  function(req, res) { res.sendFile(path.join(__dirname, 'schedule-interview.html')); });
app.get('/interview', function(req, res) { res.sendFile(path.join(__dirname, 'interview-page.html')); });
app.get('/health',    function(req, res) { res.json({ status: 'ok', invites: Object.keys(invites).length, scheduled: Object.keys(scheduled).length, sessions: Object.keys(sessions).length }); });

// ════════════════════════════════════════════════════════
// EMAIL HELPERS
// ════════════════════════════════════════════════════════
function btnHtml(url, label) {
  return '<p style="text-align:center;margin:20px 0 8px;">'
    + '<a href="' + url + '" style="display:inline-block;padding:14px 36px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;">' + label + '</a>'
    + '</p>';
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
    + '<p style="margin:0;font-size:10px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jenn.net</p>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';
}

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Next-Jenn v2 running on port ' + PORT); });
