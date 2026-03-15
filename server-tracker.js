/**
 * NEXT-JENN — SESSION TRACKER
 * Shared module to track video uploads and trigger transcript email
 */

const nodemailer = require('nodemailer');

const sessionVideos  = {};
const TOTAL_SEGMENTS = 5;

const QUESTION_LABELS = {
  q1:    'Question 1 - What is your interest in this position?',
  q2:    'Question 2 - Summary of experience relative to this role',
  q3:    'Question 3 - Three words that best describe you',
  q4:    'Question 4 - Project you are most proud of',
  final: 'Final Question - Are you interested in moving forward?',
};

function trackUpload(data) {
  const { session_id, segment_id, video_url, cand_name, job_title, company_name, client_email, hiring_manager_name } = data;
  if (!session_id || !segment_id) return;

  if (!sessionVideos[session_id]) sessionVideos[session_id] = { videos: {}, meta: {} };
  sessionVideos[session_id].videos[segment_id] = video_url;
  sessionVideos[session_id].meta = { cand_name, job_title, company_name, client_email, hiring_manager_name };

  const count = Object.keys(sessionVideos[session_id].videos).length;
  console.log('Session ' + session_id + ': ' + count + '/' + TOTAL_SEGMENTS + ' segments');

  if (count >= TOTAL_SEGMENTS) {
    sendTranscriptEmail(session_id).catch(function(e) {
      console.error('Transcript email error:', e.message);
    });
  }
}

async function sendTranscriptEmail(session_id) {
  const session = sessionVideos[session_id];
  if (!session) return;

  const cand_name    = session.meta.cand_name    || 'Candidate';
  const job_title    = session.meta.job_title    || 'Open Role';
  const company_name = session.meta.company_name || '';
  const client_email = session.meta.client_email || process.env.EMAIL_USER;

  console.log('Sending transcript email to ' + client_email + ' for ' + cand_name);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });

  var segOrder = ['q1', 'q2', 'q3', 'q4', 'final'];
  var qaHtml = '';
  for (var i = 0; i < segOrder.length; i++) {
    var seg_id    = segOrder[i];
    var video_url = session.videos[seg_id];
    if (!video_url) continue;
    var label = QUESTION_LABELS[seg_id] || seg_id;
    qaHtml += '<div style="margin-bottom:16px;border:1px solid #D8DCE6;border-radius:10px;overflow:hidden;">'
            + '<div style="background:#F0F2F5;padding:10px 18px;border-bottom:2px solid #1B2A4A;">'
            + '<p style="margin:0;font-size:11px;font-weight:700;color:#1B2A4A;text-transform:uppercase;letter-spacing:0.1em;">' + label + '</p>'
            + '</div><div style="padding:14px 18px;background:#fff;">'
            + '<p style="margin:0;font-size:14px;color:#1A1D2E;font-style:italic;">[Video response — click Watch Response to view]</p>'
            + '<a href="' + video_url + '" style="display:inline-block;margin-top:10px;padding:8px 18px;background:#1B2A4A;color:#fff;text-decoration:none;border-radius:8px;font-size:12px;font-weight:700;">Watch Response</a>'
            + '</div></div>';
  }

  var dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
    + '<body style="margin:0;padding:0;background:#F0F2F5;font-family:Arial,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;max-width:600px;">'
    + '<tr><td style="background:#1B2A4A;padding:24px 32px;"><span style="font-size:20px;font-weight:700;color:#fff;">NEXT-JENN</span>'
    + '<span style="float:right;font-size:11px;color:#8892A4;text-transform:uppercase;">AI Recruiter Interview</span></td></tr>'
    + '<tr><td style="background:#1B2A4A;padding:24px 32px;"><h1 style="margin:0 0 6px;font-size:22px;color:#fff;">Interview Transcript Ready</h1>'
    + '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.7);">Review the candidate responses below</p></td></tr>'
    + '<tr><td style="background:#EEF1F7;padding:18px 32px;border-bottom:2px solid #1B2A4A;"><table width="100%"><tr>'
    + '<td><p style="margin:0;font-size:20px;font-weight:700;color:#1B2A4A;">' + cand_name + '</p></td>'
    + '<td align="right"><p style="margin:0;font-size:18px;font-weight:700;color:#1B2A4A;">' + job_title + '</p>'
    + (company_name ? '<p style="margin:2px 0 0;font-size:13px;color:#555B6E;">' + company_name + '</p>' : '')
    + '<p style="margin:2px 0 0;font-size:13px;color:#555B6E;">' + dateStr + '</p>'
    + '</td></tr></table></td></tr>'
    + '<tr><td style="padding:24px 32px;">'
    + '<p style="margin:0 0 16px;font-size:11px;font-weight:700;color:#8892A4;text-transform:uppercase;letter-spacing:0.15em;">Interview Responses</p>'
    + qaHtml
    + '<p style="margin:16px 0 0;font-size:12px;color:#8892A4;padding:12px;background:#F8F9FC;border-radius:8px;border:1px solid #D8DCE6;">'
    + 'Click Watch Response to view each video clip. Interview conducted by Jenn, AI Recruiter - Next-Jenn Platform.</p>'
    + '</td></tr><tr><td style="background:#F8F9FC;padding:16px 32px;border-top:1px solid #D8DCE6;">'
    + '<p style="margin:0;font-size:11px;color:#8892A4;text-align:center;">Next-Jenn AI Recruiter Platform | next-jennconsulting.com</p>'
    + '</td></tr></table></td></tr></table></body></html>';

  await transporter.sendMail({
    from:    'Next-Jenn AI Recruiter <' + (process.env.EMAIL_FROM || process.env.EMAIL_USER) + '>',
    to:      client_email,
    subject: 'Interview Complete - ' + cand_name + ' for ' + job_title + (company_name ? ' at ' + company_name : '') + ' | Next-Jenn',
    html:    html,
  });

  console.log('Transcript email sent to ' + client_email);
  delete sessionVideos[session_id];
}

module.exports = { trackUpload };
