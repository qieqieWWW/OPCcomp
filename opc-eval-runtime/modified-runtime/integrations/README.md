# Feishu Gateway (Minimal MVP)

This integration enables a first-pass flow:

1. Receive Feishu message events.
2. Extract text instruction.
3. Run OpenClaw runtime task dispatch.
4. Send summary reply back to Feishu user.

## Start

1. Activate environment and set required credentials:

   source /opt/miniconda3/etc/profile.d/conda.sh
   conda activate Airouting
   export FEISHU_APP_ID=your_app_id
   export FEISHU_APP_SECRET=your_app_secret
   export OPENCLAW_SKILL_SERVICE_URL=http://127.0.0.1:8080

2. Start local skill service (if needed by selected experts):

   npm run skill-service

3. Start Feishu gateway:

   npm run feishu-gateway

## Endpoint

- Health: GET /health
- Event callback: POST /feishu/events

## Feishu Console Setup

In your Feishu app backend:

- Enable bot ability.
- Configure Event Subscription callback URL to your gateway endpoint.
- Subscribe to event type: im.message.receive_v1.
- Publish app version after enabling permissions and bot settings.

## Current behavior

- Supports text message instructions.
- Ignores encrypted callbacks in minimal mode.
- Dynamically selects experts by instruction keywords.
- Replies with executive summary text.

## Notes

- For production, add callback signature verification and event de-duplication.
- For production, add encrypted payload decrypt support if encryption is enabled in Feishu console.
