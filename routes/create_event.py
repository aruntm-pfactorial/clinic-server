from calendar_service import (
    get_calendar_service, CALENDAR_ID,
    parse_ist_datetime, format_ist_date, format_ist_time,
    now_ist,
)
from datetime import timedelta


def handle(parameters: dict, tool_call_id: str) -> dict:
    patient_name = parameters.get("patient_name")
    patient_phone = parameters.get("patient_phone")
    appointment_date = parameters.get("appointment_date")
    appointment_time = parameters.get("appointment_time")
    reason = parameters.get("reason", "")

    service = get_calendar_service()

    start = parse_ist_datetime(appointment_date, appointment_time)
    if start < now_ist():
        return {
            "success": False,
            "error": "past_time",
            "message": "Cannot book an appointment in the past. Please choose a future date and time.",
        }

    end = start + timedelta(minutes=30)

    event = service.events().insert(
        calendarId=CALENDAR_ID,
        body={
            "summary": f"Appointment — {patient_name}",
            "description": f"Patient: {patient_name}\nPhone: {patient_phone}\nReason: {reason}",
            "start": {"dateTime": start.isoformat(), "timeZone": "Asia/Kolkata"},
            "end":   {"dateTime": end.isoformat(),   "timeZone": "Asia/Kolkata"},
            "colorId": "2",
        },
    ).execute()

    print(f"Event created: {event['id']}")

    return {
        "success": True,
        "eventId": event["id"],
        "message": "Appointment booked successfully",
        "booked_date": format_ist_date(start),
        "booked_time": format_ist_time(start),
    }
