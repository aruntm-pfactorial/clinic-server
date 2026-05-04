from fastapi import APIRouter
from calendar_service import (
    get_calendar_service, CALENDAR_ID,
    CLINIC_START_HOUR, CLINIC_END_HOUR,
    is_break_time, get_session,
    parse_ist_datetime, find_next_free_slots,
    now_ist, ceil_to_next_half_hour,
)
from datetime import timedelta

router = APIRouter()


def handle(parameters: dict, tool_call_id: str) -> dict:
    requested_date = parameters.get("requested_date")
    requested_time = parameters.get("requested_time")

    service = get_calendar_service()
    start = parse_ist_datetime(requested_date, requested_time)
    hour = start.hour
    current_ist = now_ist()

    # Past date/time check (including earlier time today)
    if start < current_ist:
        alternatives = find_next_free_slots(
            service,
            ceil_to_next_half_hour(current_ist + timedelta(minutes=1)),
            3
        )
        return {
            "available": False,
            "reason": "past_time",
            "message": "That requested slot is in the past. Please choose a future date and time.",
            "alternatives": alternatives,
        }

    # Outside clinic hours
    if hour < CLINIC_START_HOUR or hour >= CLINIC_END_HOUR:
        alternatives = find_next_free_slots(
            service,
            parse_ist_datetime(requested_date, "09:00"),
            3
        )
        return {
            "available": False,
            "reason": "outside_clinic_hours",
            "message": "That time is outside clinic hours. Clinic is open 9 AM to 6 PM.",
            "alternatives": alternatives,
        }

    # Break time
    if is_break_time(hour):
        alternatives = find_next_free_slots(
            service,
            parse_ist_datetime(requested_date, "14:00"),
            3
        )
        return {
            "available": False,
            "reason": "break_time",
            "message": "That time is the lunch break from 1 PM to 2 PM.",
            "alternatives": alternatives,
        }

    # Sunday check
    if start.weekday() == 6:
        alternatives = find_next_free_slots(
            service,
            parse_ist_datetime(requested_date, "09:00"),
            3
        )
        return {
            "available": False,
            "reason": "clinic_closed",
            "message": "The clinic is closed on Sundays.",
            "alternatives": alternatives,
        }

    end = start + timedelta(minutes=30)

    events_result = service.events().list(
        calendarId=CALENDAR_ID,
        timeMin=start.isoformat(),
        timeMax=end.isoformat(),
        singleEvents=True,
    ).execute()

    if not events_result.get("items"):
        return {
            "available": True,
            "confirmed_date": requested_date,
            "confirmed_time": requested_time,
            "session": get_session(hour),
        }

    # Slot busy — get alternatives
    alternatives = find_next_free_slots(service, end, 3)
    return {
        "available": False,
        "reason": "slot_busy",
        "message": "That slot is already booked.",
        "alternatives": alternatives,
    }
