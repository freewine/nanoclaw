import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const VALID_VOICES = [
  'Kore',
  'Charon',
  'Fenrir',
  'Puck',
  'Zephyr',
  'Leda',
  'Orus',
  'Pegasus',
];

const DEFAULT_VOICE = 'Kore';

/**
 * Generate speech audio from text using Gemini 2.5 Flash TTS.
 * Returns the path to a temporary opus file. Caller must clean up.
 */
export async function generateSpeech(
  text: string,
  voice?: string,
): Promise<string> {
  const { GEMINI_API_KEY } = readEnvFile(['GEMINI_API_KEY']);
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured in .env');
  }

  const resolvedVoice =
    voice && VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  if (voice && !VALID_VOICES.includes(voice)) {
    logger.warn(
      { voice, fallback: DEFAULT_VOICE },
      'Invalid TTS voice, using default',
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        response_modalities: ['AUDIO'],
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: resolvedVoice },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini TTS API error (${response.status}): ${errText}`);
  }

  const result = (await response.json()) as {
    candidates?: {
      content?: { parts?: { inlineData?: { data?: string } }[] };
    }[];
  };
  const inlineData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;

  if (!inlineData?.data) {
    throw new Error('No audio data in Gemini TTS response');
  }

  // Decode base64 PCM audio (16-bit, 24kHz, mono)
  const pcmBuffer = Buffer.from(inlineData.data, 'base64');
  const tmpPcm = path.join(os.tmpdir(), `tts-pcm-${Date.now()}.raw`);
  const tmpOpus = path.join(os.tmpdir(), `tts-${Date.now()}.opus`);

  try {
    fs.writeFileSync(tmpPcm, pcmBuffer);

    execSync(
      `ffmpeg -f s16le -ar 24000 -ac 1 -i "${tmpPcm}" -c:a libopus -b:a 64k "${tmpOpus}" -y 2>/dev/null`,
    );

    return tmpOpus;
  } finally {
    // Always clean up the intermediate PCM file
    try {
      fs.unlinkSync(tmpPcm);
    } catch {
      // ignore
    }
  }
}
