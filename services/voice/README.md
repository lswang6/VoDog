# VoDog voice worker

The worker leases AI runs from Control, bridges WebRTC audio and uses xAI or Doubao. It has no database or user/device credentials. Provider adapters preserve third-party names and endpoints.

Run `npm ci`, `npm test`, then configure the following before `node server.mjs`:

| Variable | Requirement |
| --- | --- |
| `VOICE_CONTROL_ORIGIN` | Actual Control origin; default `http://127.0.0.1:16880`. HTTP is accepted only on loopback; remote origins require HTTPS. Redirects are rejected. |
| `VOICE_INSTANCE_ID` | Operator-generated stable UUID. Each start generates a separate boot UUID. |
| `AI_INTERNAL_TOKEN_FILE` | Absolute path to a private regular file (0600) containing the same at-least-32-character `AI_INTERNAL_TOKEN` configured on Control. |
| `VOICE_PROVIDER` | Default `xai`; must be configured locally. Runs may select another configured provider. |
| `VOICE_NODE_ID` | Optional `relay-primary` or `relay-secondary`, matching your node configuration. |
| `VOICE_MEDIA_TRANSPORT` | `udp` (default) or `tls`. |
| `AI_MAX_CALL_SECONDS` | 60–3600, default 600; provider-specific limits may override. |
| `VOICE_HEAP_RESTART_MB` | Optional worker restart threshold; default 120. |
| `XAI_API_KEY` | Required for xAI. |
| `XAI_AGENT_ID` / `XAI_REALTIME_MODEL` | Supply your own agent ID or public realtime model. Hosted agent personas belong to your provider account; none are included. |
| `XAI_REALTIME_PORT` | Optional 1–65535 endpoint port override; TLS hostname verification remains enabled. |
| `XAI_VOICE`, `XAI_GREETING` | Optional model-mode voice and greeting instruction; hosted agents use their own opener. |
| `XAI_TRANSCRIPTION_MODEL`, `XAI_TRANSCRIPTION_LANGUAGE` | Optional transcription settings. |
| `VOICE_VAD_THRESHOLD`, `VOICE_VAD_PREFIX_MS`, `VOICE_VAD_SILENCE_MS` | Optional endpoint detection controls; validated by the xAI adapter. |
| `DOUBAO_API_KEY` | Required to announce Doubao. |
| `DOUBAO_VOICE`, `DOUBAO_GREETING` | Optional voice and literal opening sentence. The default identifies VoDog as an AI assistant. |
| `DOUBAO_INSTRUCTIONS_FILE` | Optional absolute or service-relative persona file; default `prompts/doubao-persona.zh.md`, nonempty and at most 20,000 characters. |
| `DOUBAO_OUTPUT_FORMAT` | `f32le` (default) or `s16le`. |
| `DOUBAO_MAX_CALL_SECONDS` | 60–3600, default 180. |
| `DOUBAO_SILENCE_HANGUP_SECONDS` | 0–120, default 15; zero disables. |
| `DOUBAO_STRICT_AUDIT`, `DOUBAO_EXIT_INTENT`, `DOUBAO_END_CALL_TOOL` | Boolean strings; defaults true, true, false. |
| `DOUBAO_BARGE_IN` | `cancel` (default) or `off`. |
| `DOUBAO_SPEED`, `DOUBAO_LOUDNESS` | Optional integers -50–100. |
| `DOUBAO_MODEL` | Adapter-supported model version; see provider validation. |
| `DOUBAO_REALTIME_URL` | Optional test endpoint; requires WSS except on loopback. |

`npm test` uses synthetic audio and mocked providers; optional native media integration is `npm run test:media`. Provider smoke/probe scripts make real provider requests only when explicitly run with credentials. `VOICE_PROBE_OUTPUT_DIR` defaults to `./probe-output`; `VOICE_PROBE_PCM_PATH`, `VOICE_PROBE_WAV_PATH`, and `VOICE_PROBE_OGG_PATH` select synthetic fixtures. Do not commit probe output or audio. Native WebRTC packaging and real cellular acceptance must be verified separately on your deployment.
