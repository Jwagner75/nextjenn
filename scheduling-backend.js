/**
 * NEXT-JENN — SCHEDULING BACKEND
 * Node.js
 *
 * Handles:
 *   - Creating Daily.co meeting rooms per interview
 *   - Saving scheduled interviews to database
 *   - Scheduling reminder emails (24hr and 1hr before)
 *   - Triggering thank-you + transcript emails after interview
 *
 * Install: npm install express axios node-cron uuid dotenv
 */

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const DAILY_API   = 'https://api.daily.co/v1';
const DAILY_KEY   = process.env.DAILY_API_KEY;
const EMAIL_SVC   = process.env.EMAIL_SERVICE_URL || 'http://localhost:5002';
const APP_URL     = process.env.APP_URL || 'https://next-jenn.com';

// In-memory schedule store
// Replace with your MySQL DB calls when ready
const scheduledInterviews = new Map();

// ─────────────────────────────────────────────────────────────
// ROUTE: Schedule an interview
// POST /api/interview/schedule
//
// Body: {
//   session_id, candidate_name, candidate_email,
//   job_title, scheduled_time (ISO string), timezone
// }
// ─────────────────────────────────────────────────────────────
router.post('/schedule', async (req, res) => {
  const {
    session_id, candidate_name, candidate_email,
    job_title, scheduled_time, timezone,
  } = req.body;

  if (!candidate_email || !scheduled_time) {
    return res.status(400).json({ error: 'candidate_email and scheduled_time required' });
  }

  try {
    const scheduledAt = new Date(scheduled_time);

    // Create Daily.co room — set to only open at scheduled time
    const room = await createDailyRoom(session_id, scheduledAt);

    // Build join URL — this is what goes in all emails
    const joinUrl = `${APP_URL}/interview/join/${session_id}?room=${room.name}`;

    // Format time for email display
    const timeStr = formatScheduledTime(scheduledAt, timezone);

    // Save to schedule store
    const interview = {
      id:              uuidv4(),
      session_id,
      candidate_name,
      candidate_email,
      job_title,
      scheduled_at:    scheduledAt.toISOString(),
      timezone,
      daily_room_name: room.name,
      daily_room_url:  room.url,
      join_url:        joinUrl,
      status:          'scheduled',   // scheduled | active | complete | missed
      reminders_sent:  [],
      created_at:      new Date().toISOString(),
    };

    scheduledInterviews.set(session_id, interview);

    // Send confirmation email immediately
    await triggerEmail('confirmation', {
      candidate_name,
      candidate_email,
      job_title,
      scheduled_time_str: timeStr,
      timezone_str:       timezone,
      join_url:           joinUrl,
    });

    // Schedule the two reminder emails
    scheduleReminder(interview, 24);
    scheduleReminder(interview, 1);

    res.json({
      success:  true,
      join_url: joinUrl,
      room:     room.name,
      scheduled_time_str: timeStr,
    });

  } catch (err) {
    console.error('Schedule error:', err.message);
    res.status(500).json({ error: 'Failed to schedule interview', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Candidate joins — validate time window
// GET /api/interview/join/:session_id
// ─────────────────────────────────────────────────────────────
router.get('/join/:session_id', (req, res) => {
  const interview = scheduledInterviews.get(req.params.session_id);

  if (!interview) {
    return res.status(404).json({ error: 'Interview not found' });
  }

  const now       = new Date();
  const scheduled = new Date(interview.scheduled_at);
  const diffMins  = (now - scheduled) / 1000 / 60;

  // Allow joining from 5 minutes before to 15 minutes after scheduled time
  if (diffMins < -5) {
    const minsUntil = Math.ceil(Math.abs(diffMins));
    return res.json({
      status:     'early',
      message:    `Your interview starts in ${minsUntil} minutes.`,
      starts_at:  interview.scheduled_at,
      join_url:   interview.join_url,
    });
  }

  if (diffMins > 15) {
    return res.json({
      status:  'expired',
      message: 'This interview window has passed. Please contact us to reschedule.',
    });
  }

  // Within window — return Daily.co room URL
  res.json({
    status:        'ready',
    daily_room_url: interview.daily_room_url,
    candidate_name: interview.candidate_name,
    job_title:      interview.job_title,
    session_id:     interview.session_id,
  });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Interview complete — send thank-you + transcript
// POST /api/interview/complete-session
//
// Called by the interview engine when all segments are done
// Body: { session_id, transcripts: [], interview_date_str, client_email }
// ─────────────────────────────────────────────────────────────
router.post('/complete-session', async (req, res) => {
  const {
    session_id, transcripts,
    interview_date_str, client_email,
  } = req.body;

  const interview = scheduledInterviews.get(session_id);

  if (interview) {
    interview.status = 'complete';
  }

  // Send both emails simultaneously
  await Promise.allSettled([

    // Thank-you to candidate
    triggerEmail('thank-you', {
      candidate_name:  interview?.candidate_name || 'Candidate',
      candidate_email: interview?.candidate_email,
      job_title:       interview?.job_title || 'Open Role',
    }),

    // Transcript to client
    triggerEmail('transcript', {
      candidate_name:      interview?.candidate_name || 'Candidate',
      candidate_email:     interview?.candidate_email || '',
      job_title:           interview?.job_title || 'Open Role',
      client_email,
      interview_date_str:  interview_date_str || new Date().toLocaleDateString(),
      transcripts,
    }),

  ]);

  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
// ROUTE: Get interview details (for waiting room page)
// GET /api/interview/details/:session_id
// ─────────────────────────────────────────────────────────────
router.get('/details/:session_id', (req, res) => {
  const interview = scheduledInterviews.get(req.params.session_id);
  if (!interview) return res.status(404).json({ error: 'Not found' });
  res.json({
    candidate_name:  interview.candidate_name,
    job_title:       interview.job_title,
    scheduled_at:    interview.scheduled_at,
    timezone:        interview.timezone,
    status:          interview.status,
  });
});

// ─────────────────────────────────────────────────────────────
// DAILY.CO — CREATE MEETING ROOM
// One room per interview session
// ─────────────────────────────────────────────────────────────
async function createDailyRoom(session_id, scheduledAt) {
  // Room is available from 5 min before to 30 min after scheduled time
  const notBefore = Math.floor((scheduledAt.getTime() - 5 * 60000) / 1000);
  const expiresAt = Math.floor((scheduledAt.getTime() + 30 * 60000) / 1000);

  const response = await axios.post(
    `${DAILY_API}/rooms`,
    {
      name:       `nextjenn-${session_id}`,
      privacy:    'private',
      properties: {
        nbf:                    notBefore,    // not before scheduled time
        exp:                    expiresAt,    // expires 30min after
        enable_recording:       'cloud',      // Daily.co cloud recording
        recording_bucket_config: {
          bucket_name:   process.env.R2_BUCKET_NAME,
          bucket_region: 'auto',
          endpoint:      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          access_key_id: process.env.R2_ACCESS_KEY_ID,
          secret_access_key: process.env.R2_SECRET_ACCESS_KEY,
          assume_role_arn: '',
        },
        max_participants: 2,                  // candidate + Jenn bot
        enable_chat:      false,
        enable_screenshare: false,
        start_video_off:  false,
        start_audio_off:  false,
        lang:             'en',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${DAILY_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

// ─────────────────────────────────────────────────────────────
// REMINDER SCHEDULER
// Uses node-cron to fire reminder emails at the right time
// ─────────────────────────────────────────────────────────────
function scheduleReminder(interview, hoursBeforeInterview) {
  const scheduledAt   = new Date(interview.scheduled_at);
  const reminderTime  = new Date(scheduledAt.getTime() - hoursBeforeInterview * 60 * 60 * 1000);
  const now           = new Date();

  // Don't schedule reminders in the past
  if (reminderTime <= now) {
    console.log(`Reminder ${hoursBeforeInterview}hr skipped — already past for session ${interview.session_id}`);
    return;
  }

  // Build cron expression for this exact time
  const cronExpr = `${reminderTime.getMinutes()} ${reminderTime.getHours()} ${reminderTime.getDate()} ${reminderTime.getMonth() + 1} *`;

  const task = cron.schedule(cronExpr, async () => {
    console.log(`Sending ${hoursBeforeInterview}hr reminder for session ${interview.session_id}`);

    const current = scheduledInterviews.get(interview.session_id);
    if (!current || current.status !== 'scheduled') {
      task.stop();
      return;
    }

    await triggerEmail('reminder', {
      candidate_name:     interview.candidate_name,
      candidate_email:    interview.candidate_email,
      job_title:          interview.job_title,
      scheduled_time_str: formatScheduledTime(scheduledAt, interview.timezone),
      timezone_str:       interview.timezone,
      join_url:           interview.join_url,
      hours_until:        hoursBeforeInterview,
    });

    current.reminders_sent.push({
      hours: hoursBeforeInterview,
      sent_at: new Date().toISOString(),
    });

    task.stop(); // One-time job
  }, { scheduled: true, timezone: 'UTC' });

  console.log(`Reminder ${hoursBeforeInterview}hr scheduled: ${reminderTime.toISOString()} for ${interview.candidate_email}`);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function triggerEmail(type, payload) {
  try {
    await axios.post(`${EMAIL_SVC}/email/${type}`, payload, { timeout: 10000 });
  } catch (err) {
    console.error(`Email trigger failed (${type}):`, err.message);
  }
}

function formatScheduledTime(date, timezone) {
  try {
    return date.toLocaleString('en-US', {
      timeZone:  timezone || 'America/New_York',
      weekday:   'long',
      month:     'long',
      day:       'numeric',
      year:      'numeric',
      hour:      'numeric',
      minute:    '2-digit',
      hour12:    true,
    });
  } catch {
    return date.toLocaleString();
  }
}

module.exports = router;
