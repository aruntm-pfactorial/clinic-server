def handle(parameters: dict, tool_call_id: str) -> dict:
    return {
        "transfer": True,
        "message": "Transferring to human receptionist.",
    }
 