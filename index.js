const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

// Google Calendar Auth
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: './service-account.json',
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

const calendar = google.calendar({ version: 'v3', auth });

const CALENDAR_ID = '0ae3663f12e4f83aac4f8b2203b3ea54fa0d8ce450d7b846260b07b9cae326d8@group.calendar.google.com';

const CLINIC_START_HOUR = 9;
const CLINIC_END_HOUR = 18;

async function findNextFreeSlots(fromTime, count) {
  const slots = [];
  let check = new Date(fromTime);

  while (slots.length < count) {
    const hour = check.getHours();
    if (hour < CLINIC_START_HOUR) {
      check.setHours(CLINIC_START_HOUR, 0, 0, 0);
    }
    if (hour >= CLINIC_END_HOUR) {
      check.setDate(check.getDate() + 1);
      check.setHours(CLINIC_START_HOUR, 0, 0, 0);
    }
    if (check.getDay() === 0) {
      check.setDate(check.getDate() + 1);
      check.setHours(CLINIC_START_HOUR, 0, 0, 0);
      continue;
    }

    const checkEnd = new Date(check.getTime() + 30 * 60000);
    const r = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: check.toISOString(),
      timeMax: checkEnd.toISOString(),
      singleEvents: true,
    });

    if (r.data.items.length === 0) {
      slots.push({
        date: check.toLocaleDateString('en-IN', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }),
        time: check.toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true
        }),
        iso: check.toISOString(),
      });
    }
    check = checkEnd;
  }
  return slots;
}

// ─────────────────────────────────────────
// MAIN ENDPOINT — VAPI calls this
// ─────────────────────────────────────────
app.post('/vapi-tools', async (req, res) => {

  const toolCall = req.body.message?.toolWithToolCallList?.[0];

  const name = toolCall?.tool?.function?.name
            || toolCall?.toolCall?.function?.name
            || req.body.message?.toolCalls?.[0]?.function?.name;

  const toolCallId = toolCall?.toolCall?.id
                  || req.body.message?.toolCalls?.[0]?.id
                  || 'call_unknown';

  let parameters = toolCall?.toolCall?.function?.arguments || {};
  if (typeof parameters === 'string') {
    try { parameters = JSON.parse(parameters); } catch(e) {}
  }

  console.log('Tool called:', name);
  console.log('Tool call ID:', toolCallId);
  console.log('Parameters:', JSON.stringify(parameters));

  // Helper — sends response in correct VAPI format
  const sendResult = (data) => {
    const payload = {
      results: [{
        toolCallId: toolCallId,
        result: typeof data === 'string' ? data : JSON.stringify(data)
      }]
    };
    console.log('Sending to VAPI:', JSON.stringify(payload));
    return res.json(payload);
  };

  try {

    // ── TOOL 1: Check if a slot is available ──
    if (name === 'check_calendar_availability') {
      const { requested_date, requested_time } = parameters;

      const start = new Date(`${requested_date}T${requested_time}:00+05:30`);
      const end = new Date(start.getTime() + 30 * 60000);

      // Use IST hour directly from the requested_time string
      const hour = parseInt(requested_time.split(':')[0]);
      if (hour < CLINIC_START_HOUR || hour >= CLINIC_END_HOUR) {
        return sendResult({
          available: false,
          reason: 'outside_clinic_hours',
          message: 'That time is outside clinic hours. Clinic is open 9 AM to 6 PM.',
        });
      }
      const istDate = new Date(`${requested_date}T${requested_time}:00+05:30`);
      if (istDate.getDay() === 0) {
        return sendResult({
          available: false,
          reason: 'clinic_closed',
          message: 'The clinic is closed on Sundays.',
        });
      }

      console.log('Calling Google Calendar API for:', CALENDAR_ID);
      const events = await Promise.race([
        calendar.events.list({
          calendarId: CALENDAR_ID,
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: Google Calendar took too long')), 8000)
        )
      ]);
      console.log('Google Calendar responded successfully');
      console.log('Events found:', events.data.items.length);

     if (events.data.items.length === 0) {
        return sendResult({
          available: true,
          confirmed_date: `${requested_date}`,
          confirmed_time: `${requested_time}`,
        });
      }

      return sendResult({
        available: false,
        reason: 'slot_busy',
        message: 'That slot is already booked. Please ask the patient for another preferred time.',
      });
    }

    // ── TOOL 2: Book the appointment ──
    if (name === 'create_calendar_event') {
      const { patient_name, patient_phone, appointment_date, appointment_time, reason } = parameters;

      const start = new Date(`${appointment_date}T${appointment_time}:00+05:30`);
      const end = new Date(start.getTime() + 30 * 60000);

      const event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `Appointment — ${patient_name}`,
          description: `Patient: ${patient_name}\nPhone: ${patient_phone}\nReason: ${reason}`,
          start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
          end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
          colorId: '2',
        },
      });

      console.log('Event created:', event.data.id);
      return sendResult({
        success: true,
        eventId: event.data.id,
        message: 'Appointment booked successfully',
        booked_date: start.toLocaleDateString('en-IN', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }),
        booked_time: start.toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true,
          timeZone: 'Asia/Kolkata'
        }),
      });
    }

    // ── TOOL 3: Find existing appointment ──
    if (name === 'find_existing_appointment') {
      const { patient_phone } = parameters;

      console.log('Searching for appointment with phone:', patient_phone);
      const events = await Promise.race([
        calendar.events.list({
          calendarId: CALENDAR_ID,
          timeMin: new Date().toISOString(),
          maxResults: 100,
          singleEvents: true,
          orderBy: 'startTime',
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: Google Calendar took too long')), 8000)
        )
      ]);

      const match = events.data.items.find(e =>
        e.description && e.description.includes(patient_phone)
      );

      if (match) {
        const apptDate = new Date(match.start.dateTime);
        return sendResult({
          found: true,
          eventId: match.id,
          patient_name: match.summary.replace('Appointment — ', ''),
          current_date: apptDate.toLocaleDateString('en-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          }),
          current_time: apptDate.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: 'Asia/Kolkata'
          }),
        });
      }

      return sendResult({ found: false });
    }

    // TOOL 3B: Delete_calender event
    if (name === 'delete_calendar_event') {
      const { eventId } = parameters;
      
      await calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId: eventId,
      });

      console.log('Event deleted:', eventId);
      return sendResult({
        success: true,
        message: 'Old appointment cancelled successfully.',
      });
    }

    // ── TOOL 4: Transfer call ──
    if (name === 'transfer_call') {
      return sendResult({ transfer: true, message: 'Transferring to human receptionist.' });
    }

    return sendResult({ error: 'Unknown tool name: ' + name });

  } catch (err) {
    console.error('FULL ERROR:', err.message);
    console.error('ERROR CODE:', err.code);
    console.error('ERROR STATUS:', err.status);
    return sendResult({ error: true, message: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('Clinic server is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic server running on port ${PORT}`);
});