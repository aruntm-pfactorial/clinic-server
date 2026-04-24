from datetime import timezone
from calendar_service import (
    get_calendar_service, CALENDAR_ID,
    format_ist_date, format_ist_time,
)
from datetime import datetime


def handle(parameters: dict, tool_call_id: str) -> dict:
    patient_phone = parameters.get("patient_phone")
    service = get_calendar_service()

    print(f"Searching for appointment with phone: {patient_phone}")

    now = datetime.now(tz=timezone.utc).isoformat()

    events_result = service.events().list(
        calendarId=CALENDAR_ID,
        timeMin=now,
        maxResults=100,
        singleEvents=True,
        orderBy="startTime",
    ).execute()

    match = None
    for event in events_result.get("items", []):
        desc = event.get("description", "")
        if patient_phone in desc:
            match = event
            break

    if match:
        appt_date = datetime.fromisoformat(match["start"]["dateTime"])
        return {
            "found": True,
            "eventId": match["id"],
            "patient_name": match["summary"].replace("Appointment — ", ""),
            "current_date": format_ist_date(appt_date),
            "current_time": format_ist_time(appt_date),
        }

    return {"found": False}