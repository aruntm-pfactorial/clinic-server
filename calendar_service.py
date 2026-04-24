import os
import json
from datetime import datetime, timezone, timedelta
from googleapiclient.discovery import build
from google.oauth2 import service_account

# Constants
CALENDAR_ID = "0ae3663f12e4f83aac4f8b2203b3ea54fa0d8ce450d7b846260b07b9cae326d8@group.calendar.google.com"

CLINIC_START_HOUR = 9    # 9 AM
CLINIC_END_HOUR   = 18   # 6 PM
BREAK_START_HOUR  = 13   # 1 PM
BREAK_END_HOUR    = 14   # 2 PM

IST = timezone(timedelta(hours=5, minutes=30))

SCOPES = ["https://www.googleapis.com/auth/calendar"]


# Google Calendar Client
def get_calendar_service():
    creds_env = os.getenv("GOOGLE_CREDENTIALS")
    if creds_env:
        info = json.loads(creds_env)
        creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    else:
        creds = service_account.Credentials.from_service_account_file(
            "service-account.json", scopes=SCOPES
        )
    return build("calendar", "v3", credentials=creds)


# Helpers
def is_break_time(hour: int) -> bool:
    return BREAK_START_HOUR <= hour < BREAK_END_HOUR


def get_session(hour: int) -> str:
    if 9 <= hour < 12:
        return "Morning (9 AM - 12 PM)"
    if 12 <= hour < 13:
        return "Noon (12 PM - 1 PM)"
    if 14 <= hour < 18:
        return "Evening (2 PM - 6 PM)"
    return "Unknown"


def format_ist_date(dt: datetime) -> str:
    ist_dt = dt.astimezone(IST)
    return ist_dt.strftime("%A, %d %B %Y")


def format_ist_time(dt: datetime) -> str:
    ist_dt = dt.astimezone(IST)
    return ist_dt.strftime("%I:%M %p")


def parse_ist_datetime(date_str: str, time_str: str) -> datetime:
    """Parse date and time strings into a timezone-aware IST datetime."""
    return datetime.fromisoformat(f"{date_str}T{time_str}:00+05:30")


def find_next_free_slots(service, from_time: datetime, count: int = 3) -> list:
    """Find the next N free 30-minute slots after from_time."""
    slots = []
    check = from_time.astimezone(IST)
    safety = 200

    while len(slots) < count and safety > 0:
        safety -= 1
        hour = check.hour

        # Before clinic opens
        if hour < CLINIC_START_HOUR:
            check = check.replace(hour=CLINIC_START_HOUR, minute=0, second=0, microsecond=0)
            continue

        # After clinic closes — move to next day 9 AM
        if hour >= CLINIC_END_HOUR:
            check = (check + timedelta(days=1)).replace(
                hour=CLINIC_START_HOUR, minute=0, second=0, microsecond=0
            )
            continue

        # During break time — jump to 2 PM
        if is_break_time(hour):
            check = check.replace(hour=BREAK_END_HOUR, minute=0, second=0, microsecond=0)
            continue

        # Skip Sundays
        if check.weekday() == 6:
            check = (check + timedelta(days=1)).replace(
                hour=CLINIC_START_HOUR, minute=0, second=0, microsecond=0
            )
            continue

        check_end = check + timedelta(minutes=30)

        # Don't let slot run into break time
        if check.hour < BREAK_START_HOUR and check_end.hour >= BREAK_START_HOUR:
            check = check.replace(hour=BREAK_END_HOUR, minute=0, second=0, microsecond=0)
            continue

        events_result = service.events().list(
            calendarId=CALENDAR_ID,
            timeMin=check.isoformat(),
            timeMax=check_end.isoformat(),
            singleEvents=True,
        ).execute()

        if not events_result.get("items"):
            slots.append({
                "date": format_ist_date(check),
                "time": format_ist_time(check),
                "session": get_session(hour),
            })

        check = check_end

    return slots