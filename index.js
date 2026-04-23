const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

// Google Calendar Auth
// On your computer it reads the file
// On Render it reads from environment variable
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

// Your Google Calendar ID — paste yours here
const CALENDAR_ID = '0ae3663f12e4f83aac4f8b2203b3ea54fa0d8ce450d7b846260b07b9cae326d8@group.calendar.google.com';

// Clinic working hours
const CLINIC_START_HOUR = 9;  // 9 AM
const CLINIC_END_HOUR = 18;   // 6 PM

// Find next available free slots
async function findNextFreeSlots(fromTime, count) {
  const slots = [];
  let check = new Date(fromTime);

  while (slots.length < count) {
    // Skip non-working hours
    const hour = check.getHours();
    if (hour < CLINIC_START_HOUR) {
      check.setHours(CLINIC_START_HOUR, 0, 0, 0);
    }
    if (hour >= CLINIC_END_HOUR) {
      // Move to next day 9am
      check.setDate(check.getDate() + 1);
      check.setHours(CLINIC_START_HOUR, 0, 0, 0);
    }

    // Skip Sundays (0 = Sunday)
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
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        time: check.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
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
  let parameters = toolCall?.toolCall?.function?.arguments || {};
  
  // Parse if it came as a string
  if (typeof parameters === 'string') {
    try { parameters = JSON.parse(parameters); } catch(e) {}
  }

  console.log('Tool called:', name);
  console.log('Parameters:', JSON.stringify(parameters));

  try {

    // ── TOOL 1: Check if a slot is available ──
    if (name === 'check_calendar_availability') {
      const { requested_date, requested_time } = parameters;

      // Convert to proper date object
      const start = new Date(`${requested_date}T${requested_time}:00`);
      const end = new Date(start.getTime() + 30 * 60000);

      // Check if time is within clinic hours
      const hour = start.getHours();
      if (hour < CLINIC_START_HOUR || hour >= CLINIC_END_HOUR) {
        const alternatives = await findNextFreeSlots(
          new Date(`${requested_date}T09:00:00`), 3
        );
        return res.json({ result: JSON.stringify({
          available: false,
          reason: 'outside_clinic_hours',
          message: 'That time is outside clinic hours.',
          alternatives,
        })});
      }

      // Check if Sunday
      if (start.getDay() === 0) {
        const nextDay = new Date(start);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(CLINIC_START_HOUR, 0, 0, 0);
        const alternatives = await findNextFreeSlots(nextDay, 3);
        return res.json({ result: JSON.stringify({
          available: false,
          reason: 'clinic_closed',
          message: 'The clinic is closed on Sundays.',
          alternatives,
        })});
      }

      // Check Google Calendar for existing events
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
        const result = {
          available: true,
          confirmed_date: start.toLocaleDateString('en-IN', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          }),
          confirmed_time: start.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true
          }),
        };
        console.log('Sending response:', JSON.stringify(result));
        return res.json({ result: JSON.stringify(result) });
      }

      // Slot is busy — find alternatives
      // const alternatives = await findNextFreeSlots(end, 3);
      console.log('Slot is busy, returning unavailable');
      return res.json({ result: JSON.stringify({
        available: false,
        reason: 'slot_busy',
        message: 'That slot is already booked. Please ask the patient for another preferred time.',
      })});
    }

    // ── TOOL 2: Book the appointment ──
    if (name === 'create_calendar_event') {
      const {
        patient_name,
        patient_phone,
        appointment_date,
        appointment_time,
        reason,
      } = parameters;

      const start = new Date(`${appointment_date}T${appointment_time}:00`);
      const end = new Date(start.getTime() + 30 * 60000);

      const event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `Appointment — ${patient_name}`,
          description: `Patient: ${patient_name}\nPhone: ${patient_phone}\nReason: ${reason}`,
          start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
          end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
          colorId: '2', // Green color for easy identification
        },
      });

      return res.json({ result: JSON.stringify({
        success: true,
        eventId: event.data.id,
        message: 'Appointment booked successfully',
        booked_date: start.toLocaleDateString('en-IN', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        booked_time: start.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }),
      })});
    }

    // ── TOOL 3: Find existing appointment ──
    if (name === 'find_existing_appointment') {
      const { patient_phone } = parameters;

      console.log('Calling Google Calendar API for:', CALENDAR_ID);
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
      console.log('Google Calendar responded successfully');

      const match = events.data.items.find(e =>
        e.description && e.description.includes(patient_phone)
      );

      if (match) {
        const apptDate = new Date(match.start.dateTime);
        return res.json({ result: JSON.stringify({
          found: true,
          eventId: match.id,
          patient_name: match.summary.replace('Appointment — ', ''),
          current_date: apptDate.toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          current_time: apptDate.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          }),
        })});
      }

      return res.json({ result: JSON.stringify({ found: false }) });
    }

    // ── TOOL 4: Transfer call ──
    if (name === 'transfer_call') {
      return res.json({ transfer: true });
    }

    return res.json({ error: 'Unknown tool name: ' + name });

  } catch (err) {
    console.error('FULL ERROR:', err.message);
    console.error('ERROR STACK:', err.stack);
    console.error('ERROR CODE:', err.code);
    console.error('ERROR STATUS:', err.status);
    return res.json({ result: JSON.stringify({
      available: true,
      error_debug: err.message
    })});
  }
});

// Health check — open this in browser to confirm server is live
app.get('/', (req, res) => {
  res.send('Clinic server is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic server running on port ${PORT}`);
});