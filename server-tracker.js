/**
 * NEXT-JENN — SESSION TRACKER
 * Tracks video uploads per session and fires transcript email when all 5 are done.
 */

'use strict';

const nodemailer = require('nodemailer');

const sessions = {}; // { [session_id]: { videos: {q1,q2,q3,q4,final}, meta: {...} } }

const LABELS = {
  q1:    'Q1 — What is your interest in this position?',
  q2:    'Q2 — Summary of experience relative to this role',
  q3:    'Q3 — Three words that best describe you',
  q4:    'Q4 — Project you are most proud of',
  final: 'Final — Are you interested in moving forward?',
};

function track(sessionId, segmentId, videoUrl, meta) {
  if (!sessionId || !segmentId) {
    console.log('Tracker: missing sessionId or segmentId');
    return;
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = { videos: {}, meta: {} };
  }

  sessions[sessionId].videos[segmentId] = videoUrl;
  sessions[sessionId].meta = meta;

  var count = Object.keys(sessions[sessionId].videos).length;
  console.log('Tracker: session=' + sessionId + ' seg=' + segmentId + ' count=' + count + '/5');

  if (count >= 5) {
    sendEmail(sessionId);
  }
}

function sendEmail(sessionId) {
  var session = sessions[sessionId];
  if (!session) return;

  var meta       = session.meta;
  var candName   = meta.cand_name    || 'Candidate';
  var jobTitle   = meta.job_title    || 'Open Role';
  var company    = meta.company_name || '';
  var toEmail    = meta.client_email || process.env.EMAIL_USER;
  var dateStr    = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  console.log('Tracker: sending transcript email to ' + toEmail);

  var qaHtml = '';
  ['q1','q2','q3','q4','final'].forEach(function(id) {
    var url = session.videos[id];
    if (!url) return;
    qaHtml += '<div style="margin-bottom:14px;border:1px solid #D8DCE6;border-radius:8px;overflow:hidden;">'
      + '<div style="background:#F0F2F5;padding:8px 16px;border-bottom:2px solid #1B2A4A;">'
      + '<p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:.08em;">' + (LABELS[id]||id) + '</p>'
      + '</div><div style="padding:12px 16px;background:#fff;">'
      + '<p style="margin:0 0 8px;font-size:13px;color:#555B6E;font-style:italic;">[Video response]</p>'
      + '<a href="' + url + '" style="display:inline-block;padding:7px 16px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:700;">Watch Response</a>'
      + '</div></div>';
  });

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#F0F2F5;font-family:Arial,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;">'
    + '<tr><td style="background:#1B2A4A;padding:22px 30px;">'
    + '<span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:.08em;">NEXT-JENN</span>'
    + '<span style="float:right;font-size:10px;color:#8892A4;text-transform:uppercase;letter-spacing:.1em;">AI Recruiter Interview</span>'
    + '</td></tr>'
    + '<tr><td style="background:#243760;padding:20px 30px;">'
    + '<h1 style="margin:0 0 4px;font-size:20px;color:#fff;">Interview Transcript Ready</h1>'
    + '<p style="margin:0;font-size:13px;color:rgba(255,255,255,.7);">Review the candidate responses below</p>'
    + '</td></tr>'
    + '<tr><td style="background:#EEF1F7;padding:16px 30px;border-bottom:2px solid #1B2A4A;">'
    + '<table width="100%"><tr>'
    + '<td><p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">' + candName + '</p></td>'
    + '<td align="right"><p style="margin:0;font-size:16px;font-weight:700;color:#1B2A4A;">' + jobTitle + '</p>'
    + (company ? '<p style="margin:2px 0 0;font-size:12px;color:#555B6E;">' + company + '</p>' : '')
    + '<p style="margin:2px 0 0;font-size:12px;color:#555B6E;">' + dateStr + '</p>'
    + '</td></tr></table>'
    + '</td></tr>'
    + '<tr><td style="padding:22px 30px;">'
    + '<p style="margin:0 0 14px;font-size:10px;font-weight:700;color:#8892A4;text-transform:uppercase;letter-spacing:.12em;">Interview Responses</p>'
    + qaHtml
    + '</td></tr>'
    + '<tr><td style="background:#F8F9FC;padding:14px 30px;border-top:1px solid #D8DCE6;">'
    + '<p style="margin:0;font-size:10px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jennconsulting.com</p>'
    + '</td></tr>'
    + '</table></td></tr></table></body></html>';

  var transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });

  var subject = 'Interview Complete — ' + candName + ' for ' + jobTitle
    + (company ? ' at ' + company : '') + ' | Next-Jenn';

  transporter.sendMail({
    from:    'Next-Jenn <' + (process.env.EMAIL_FROM || process.env.EMAIL_USER) + '>',
    to:      toEmail,
    subject: subject,
    html:    html,
  }, function(err, info) {
    if (err) {
      console.error('Tracker: email error — ' + err.message);
    } else {
      console.log('Tracker: transcript email sent to ' + toEmail);
      delete sessions[sessionId];
    }
  });
}

module.exports = { track: track };
