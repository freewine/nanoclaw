import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('gemini-tts skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: gemini-tts');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('GEMINI_API_KEY');
  });

  it('has all files declared in adds', () => {
    const ttsFile = path.join(skillDir, 'add', 'src', 'tts.ts');
    expect(fs.existsSync(ttsFile)).toBe(true);

    const content = fs.readFileSync(ttsFile, 'utf-8');
    expect(content).toContain('generateSpeech');
    expect(content).toContain('readEnvFile');
    expect(content).toContain('GEMINI_API_KEY');
    expect(content).toContain('ffmpeg');
    expect(content).toContain('libopus');
  });

  it('has all files declared in modifies', () => {
    const files = [
      'modify/src/types.ts',
      'modify/src/ipc.ts',
      'modify/src/ipc-auth.test.ts',
      'modify/src/router.ts',
      'modify/src/index.ts',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts',
    ];

    for (const file of files) {
      expect(fs.existsSync(path.join(skillDir, file))).toBe(true);
    }
  });

  it('has intent files for modified files', () => {
    const intentFiles = [
      'modify/src/types.ts.intent.md',
      'modify/src/ipc.ts.intent.md',
      'modify/src/ipc-auth.test.ts.intent.md',
      'modify/src/router.ts.intent.md',
      'modify/src/index.ts.intent.md',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md',
    ];

    for (const file of intentFiles) {
      expect(fs.existsSync(path.join(skillDir, file))).toBe(true);
    }
  });

  it('modified types.ts adds sendAudio to Channel interface', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'types.ts'),
      'utf-8',
    );

    expect(content).toContain('sendAudio?');
    expect(content).toContain('audioPath: string');

    // Core preserved
    expect(content).toContain('interface Channel');
    expect(content).toContain('sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('interface RegisteredGroup');
    expect(content).toContain('interface NewMessage');
  });

  it('modified ipc.ts adds tts_message handler', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc.ts'),
      'utf-8',
    );

    // TTS integration
    expect(content).toContain("import { generateSpeech } from './tts.js'");
    expect(content).toContain('tts_message');
    expect(content).toContain('generateSpeech(data.text, data.voice)');
    expect(content).toContain('deps.sendAudio(data.chatJid, audioPath)');
    expect(content).toContain('sendAudio');

    // Core preserved
    expect(content).toContain("data.type === 'message'");
    expect(content).toContain('processTaskIpc');
    expect(content).toContain('startIpcWatcher');
  });

  it('modified ipc-auth.test.ts adds sendAudio mock', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'ipc-auth.test.ts'),
      'utf-8',
    );

    expect(content).toContain('sendAudio');

    // Core preserved
    expect(content).toContain("describe('schedule_task authorization'");
    expect(content).toContain("describe('IPC message authorization'");
    expect(content).toContain('processTaskIpc');
  });

  it('modified router.ts adds routeOutboundAudio', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'router.ts'),
      'utf-8',
    );

    expect(content).toContain('routeOutboundAudio');
    expect(content).toContain('sendAudio');
    expect(content).toContain('No audio-capable channel');

    // Core preserved
    expect(content).toContain('routeOutbound');
    expect(content).toContain('findChannel');
    expect(content).toContain('formatMessages');
    expect(content).toContain('escapeXml');
  });

  it('modified index.ts wires sendAudio into IPC deps', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'index.ts'),
      'utf-8',
    );

    expect(content).toContain('routeOutboundAudio');
    expect(content).toContain('sendAudio');

    // Core preserved
    expect(content).toContain('startIpcWatcher');
    expect(content).toContain('startSchedulerLoop');
    expect(content).toContain('startMessageLoop');
  });

  it('modified ipc-mcp-stdio.ts adds send_tts_message tool', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'container', 'agent-runner', 'src', 'ipc-mcp-stdio.ts'),
      'utf-8',
    );

    // TTS tool
    expect(content).toContain('send_tts_message');
    expect(content).toContain("type: 'tts_message'");
    expect(content).toContain('voice');
    expect(content).toContain('Kore');

    // Core preserved
    expect(content).toContain('send_message');
    expect(content).toContain('schedule_task');
    expect(content).toContain('register_group');
    expect(content).toContain('writeIpcFile');
  });

  it('add/src/tts.ts validates voice names', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'add', 'src', 'tts.ts'),
      'utf-8',
    );

    expect(content).toContain('Kore');
    expect(content).toContain('Charon');
    expect(content).toContain('Fenrir');
    expect(content).toContain('Puck');
    expect(content).toContain('Zephyr');
    expect(content).toContain('Leda');
    expect(content).toContain('Orus');
    expect(content).toContain('Pegasus');
    expect(content).toContain('VALID_VOICES');
    expect(content).toContain('DEFAULT_VOICE');
  });
});
