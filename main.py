import json
import os
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from routes import check_availability, create_event, find_appointment, delete_event, transfer_call

app = FastAPI(title="ABC Clinic VAPI Server")


# Tool router
TOOL_HANDLERS = {
    "check_calendar_availability": check_availability.handle,
    "create_calendar_event": create_event.handle,
    "find_existing_appointment": find_appointment.handle,
    "delete_calendar_event": delete_event.handle,
    "transfer_call": transfer_call.handle,
}


def send_result(tool_call_id: str, data: dict) -> JSONResponse:
    """Wrap response in VAPI's required format."""
    payload = {
        "results": [
            {
                "toolCallId": tool_call_id,
                "result": json.dumps(data),
            }
        ]
    }
    print(f"Sending to VAPI: {json.dumps(payload)}")
    return JSONResponse(content=payload)


# Health check
@app.api_route("/", methods=["GET", "HEAD"])
def health_check():
    return {"status": "Clinic server is running!"}


# Main VAPI endpoint
@app.post("/vapi-tools")
async def vapi_tools(request: Request):
    body = await request.json()

    # Extract tool name and ID from VAPI request
    tool_with_call_list = body.get("message", {}).get("toolWithToolCallList", [])
    tool_entry = tool_with_call_list[0] if tool_with_call_list else {}

    name = (
        tool_entry.get("tool", {}).get("function", {}).get("name")
        or tool_entry.get("toolCall", {}).get("function", {}).get("name")
        or body.get("message", {}).get("toolCalls", [{}])[0].get("function", {}).get("name")
    )

    tool_call_id = (
        tool_entry.get("toolCall", {}).get("id")
        or body.get("message", {}).get("toolCalls", [{}])[0].get("id")
        or "call_unknown"
    )

    # Extract parameters
    raw_args = (
        tool_entry.get("toolCall", {}).get("function", {}).get("arguments")
        or {}
    )
    if isinstance(raw_args, str):
        try:
            raw_args = json.loads(raw_args)
        except Exception:
            raw_args = {}

    print(f"Tool called: {name}")
    print(f"Tool call ID: {tool_call_id}")
    print(f"Parameters: {json.dumps(raw_args)}")

    # Route to correct handler
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return send_result(tool_call_id, {"error": f"Unknown tool: {name}"})

    try:
        result = handler(raw_args, tool_call_id)
        return send_result(tool_call_id, result)
    except Exception as e:
        print(f"ERROR: {str(e)}")
        return send_result(tool_call_id, {"error": True, "message": str(e)})


# Run locally
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
