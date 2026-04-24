from calendar_service import get_calendar_service, CALENDAR_ID


def handle(parameters: dict, tool_call_id: str) -> dict:
    event_id = parameters.get("eventId")
    service = get_calendar_service()

    service.events().delete(
        calendarId=CALENDAR_ID,
        eventId=event_id,
    ).execute()

    print(f"Event deleted: {event_id}")

    return {
        "success": True,
        "message": "Old appointment cancelled successfully.",
    }