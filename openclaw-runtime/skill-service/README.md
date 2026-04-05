# Local Skill Service

This folder contains a local skill service for the `openclaw-runtime` chain.

Default mode is real browser execution via Playwright.

## What it provides

- `GET /health`
- `GET /skills`
- `POST /skills/invoke`

It currently supports one skill:

- `browser-automation`

The service can execute browser actions for:

- Baidu search and webpage summarization flows
- Jimeng video generation flows

## Install dependencies

From `OPCcomp/openclaw-runtime`:

```bash
source /opt/miniconda3/etc/profile.d/conda.sh && conda activate Airouting
npm install
npx playwright install chromium
```

## Start

From `OPCcomp/openclaw-runtime`:

```bash
source /opt/miniconda3/etc/profile.d/conda.sh && conda activate Airouting
npm run skill-service
```

## Verify

```bash
node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.json()).then(console.log)"
node -e "fetch('http://127.0.0.1:8080/skills').then(r=>r.json()).then(console.log)"
```

Example invoke payload:

```bash
node -e "fetch('http://127.0.0.1:8080/skills/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skill:'browser-automation',parameters:{start_url:'https://www.baidu.com',actions:['wait:dom-ready','type:selector=input[name=\\'wd\\'], value=OpenClaw','click:selector=input[type=submit]','wait:dom-ready','extract:list=.result h3 a'],options:{provider:'baidu',top_k:5}}})}).then(r=>r.json()).then(console.log)"
```

## Notes

- Real browser behavior still depends on target site DOM and anti-bot rules.
- You can temporarily switch to mock mode with `SKILL_SERVICE_MOCK_MODE=true`.
- Your agents will treat it as the `OPENCLAW_SKILL_SERVICE_URL` target.
