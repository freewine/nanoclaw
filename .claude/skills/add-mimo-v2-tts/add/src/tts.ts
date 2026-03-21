import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

const DEFAULT_VOICE = 'mimo_default';

/**
 * Generate speech audio from text using Xiaomi MiMo v2 TTS.
 * Uses the OpenAI-compatible chat completions API with audio output.
 * Returns the path to a temporary opus file. Caller must clean up.
 */
export async function generateSpeech(
  text: string,
  voice?: string,
): Promise<string> {
  const { MIMO_API_KEY } = readEnvFile(['MIMO_API_KEY']);
  if (!MIMO_API_KEY) {
    throw new Error('MIMO_API_KEY not configured in .env');
  }

  const VALID_VOICES = ['mimo_default', 'default_zh', 'default_en'];
  const resolvedVoice =
    voice && VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE;

  const url = 'https://api.xiaomimimo.com/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MIMO_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mimo-v2-tts',
      messages: [
        { role: 'user', content: text },
        { role: 'assistant', content: text },
      ],
      audio: { format: 'wav', voice: resolvedVoice },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MiMo TTS API error (${response.status}): ${errText}`);
  }

  const result = (await response.json()) as {
    choices?: {
      message?: { audio?: { data?: string } };
    }[];
  };
  const audioData = result.choices?.[0]?.message?.audio?.data;

  if (!audioData) {
    throw new Error('No audio data in MiMo TTS response');
  }

  const wavBuffer = Buffer.from(audioData, 'base64');
  const tmpWav = path.join(os.tmpdir(), `tts-wav-${Date.now()}.wav`);
  const tmpOpus = path.join(os.tmpdir(), `tts-${Date.now()}.opus`);

  try {
    fs.writeFileSync(tmpWav, wavBuffer);

    execSync(
      `ffmpeg -i "${tmpWav}" -c:a libopus -b:a 64k "${tmpOpus}" -y 2>/dev/null`,
    );

    return tmpOpus;
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      // ignore
    }
  }
}
