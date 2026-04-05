# OPCcomp AIS API Test Project

## Files
- `call_ais_service.py`: AIS V2/V1 chat completion test client.
	- V2: OpenAI-compatible style (`base_url={host}/apis/ais-v2`).
	- V1: Raw HTTP probing (`/apis/ais/chat/completions`).

## Quick Start

### 1) V2 (as requested)
```bash
python OPCcomp/test_project/call_ais_service.py --version v2 --host http://10.7.88.150:8080 --model test --text "你好，测试V2接口。"
```

### 2) V1 check
```bash
python OPCcomp/test_project/call_ais_service.py --version v1 --host http://10.7.88.150:8080 --model test --text "你好，测试V1接口。"
```

### 3) If authorization is enabled
```bash
python OPCcomp/test_project/call_ais_service.py --version v2 --host http://10.7.88.150:8080 --model test --api-key "<your-api-key>"
```

### 4) No-auth service
- If the service does not enable auth, do not pass `--api-key`.
- The script will call V2 without `Authorization` header.

## Notes
- V2 endpoint path: `/apis/ais-v2/chat/completions`
- V1 endpoint path (for probing): `/apis/ais/chat/completions`
- Requires Python package: `openai` (for V2 OpenAI-compatible call path).
