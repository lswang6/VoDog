/**
 * S24 决策 3: the xAI realtime adapter moved to `providers/xai.mjs` behind the provider registry.
 * This module stays as the compatibility surface its existing importers and unit tests use, plus
 * the one thing that was never xAI: the Gemini recording transcription used by the report jobs.
 */
export { XaiVoiceAgent, xaiRealtimeUrl, vadSettings, xaiConfig, xaiConfigured } from './providers/xai.mjs';

/** Reuses wacli's provider contract without pretending a call is a WhatsApp message. */
export async function transcribeOgg(bytes, { apiKey, model = 'gemini-3.5-transcribe', fetcher = fetch, timeoutMs = 120_000 } = {}) {
  if (!apiKey) throw new Error('Transcription is not configured');
  if (bytes.subarray(0, 4).toString() !== 'OggS') throw new Error('Recording must be an Ogg container');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Split recording into smaller transcription segments');
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/ogg', data: bytes.toString('base64') } }] }], generationConfig: { audioTranscriptionConfig: { wordTimestamp: true, diarization: true } } }),
  });
  if (!response.ok) throw new Error(`Transcription provider HTTP ${response.status}`);
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!text) throw new Error('Transcription provider returned no text');
  return { text, model };
}
