/**
 * VoiceShifter for Windows
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures mic via ffmpeg (dshow) → ElevenLabs Voice Changer → plays to VB-Cable
 * Telegram/Discord/any app uses "CABLE Output" as its microphone input.
 *
 * Setup:
 *   1. Install VB-Cable  → https://vb-audio.com/Cable/
 *   2. Drop ffmpeg.exe   → https://www.gyan.dev/ffmpeg/builds/  (ffmpeg-release-essentials.zip)
 *      Place ffmpeg.exe in the SAME folder as this file.
 *   3. Fill in .env      → ELEVENLABS_API_KEY and VOICE_ID
 *   4. npm install && npm start
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const fetch    = require('node-fetch');
const FormData = require('form-data');
const chalk    = require('chalk');
const { spawn, spawnSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY       = process.env.ELEVENLABS_API_KEY;
const VOICE_ID      = process.env.VOICE_ID;
const CHUNK_SEC     = Number(process.env.CHUNK_SECONDS) || 3;
const MODEL         = 'eleven_multilingual_sts_v2';
const SAMPLE_RATE   = 16000;
const CHANNELS      = 1;
const OUTPUT_DEVICE = process.env.OUTPUT_DEVICE || 'CABLE Input';
const INPUT_DEVICE  = process.env.INPUT_DEVICE  || '';   // empty = auto-detect

// ffmpeg: check same folder first, then PATH
const FFMPEG = (() => {
  const local = path.join(__dirname, 'ffmpeg.exe');
  return fs.existsSync(local) ? local : 'ffmpeg';
})();

// ─── Validate ─────────────────────────────────────────────────────────────────
if (!API_KEY || API_KEY === 'YOUR_KEY_HERE') {
  console.error(chalk.red('\n  ✗ Set ELEVENLABS_API_KEY in .env\n'));
  process.exit(1);
}
if (!VOICE_ID || VOICE_ID === 'YOUR_VOICE_ID_HERE') {
  console.error(chalk.red('\n  ✗ Set VOICE_ID in .env\n'));
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let isShifting  = true;
let isMuted     = false;
let isRunning   = true;
let chunkBuffer = [];
let chunkTimer  = null;
let processing  = false;
let stats       = { converted: 0, errors: 0, totalMs: 0 };

// ─── Detect default mic name via ffmpeg dshow device list ─────────────────────
function detectMicName() {
  if (INPUT_DEVICE) return INPUT_DEVICE; // user already set it

  try {
    // ffmpeg -list_devices true -f dshow -i dummy  → lists devices to stderr
    const result = spawnSync(FFMPEG, [
      '-list_devices', 'true',
      '-f', 'dshow',
      '-i', 'dummy',
    ], { encoding: 'utf8', windowsHide: true });

    const output = result.stderr || '';
    // Parse lines like:  "Microphone (Realtek Audio)" (audio)
    const audioSection = output.split('DirectShow audio devices')[1] || output;
    const matches = [...audioSection.matchAll(/"([^"]+)"\s+\(audio\)/g)];

    if (matches.length > 0) {
      // Skip CABLE Output — that's the virtual cable's recording device, not a real mic
      const real = matches.find(m => !m[1].toLowerCase().includes('cable output'));
      return real ? real[1] : matches[0][1];
    }
  } catch (_) {}

  return null;
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(micName) {
  console.clear();
  console.log(chalk.greenBright(`
  ██╗   ██╗ ██████╗ ██╗ ██████╗███████╗███████╗██╗  ██╗██╗███████╗████████╗███████╗██████╗
  ██║   ██║██╔═══██╗██║██╔════╝██╔════╝██╔════╝██║  ██║██║██╔════╝╚══██╔══╝██╔════╝██╔══██╗
  ██║   ██║██║   ██║██║██║     █████╗  ███████╗███████║██║█████╗     ██║   █████╗  ██████╔╝
  ╚██╗ ██╔╝██║   ██║██║██║     ██╔══╝  ╚════██║██╔══██║██║██╔══╝     ██║   ██╔══╝  ██╔══██╗
   ╚████╔╝ ╚██████╔╝██║╚██████╗███████╗███████║██║  ██║██║██║        ██║   ███████╗██║  ██║
    ╚═══╝   ╚═════╝ ╚═╝ ╚═════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝   ╚══════╝╚═╝  ╚═╝
  `));
  console.log(chalk.gray('  Real-time voice changer — ElevenLabs + VB-Cable + ffmpeg\n'));

  const mic = (micName || 'not detected').slice(0, 30);
  console.log(chalk.white('  ┌──────────────────────────────────────────────┐'));
  console.log(chalk.white('  │') + chalk.yellow('  Voice ID  : ') + chalk.cyan((VOICE_ID.slice(0,8)+'...').padEnd(32)) + chalk.white('│'));
  console.log(chalk.white('  │') + chalk.yellow('  Mic input : ') + chalk.cyan(mic.padEnd(32))                         + chalk.white('│'));
  console.log(chalk.white('  │') + chalk.yellow('  Output to : ') + chalk.cyan(OUTPUT_DEVICE.padEnd(32))               + chalk.white('│'));
  console.log(chalk.white('  │') + chalk.yellow('  Chunk size: ') + chalk.cyan(`${CHUNK_SEC}s`.padEnd(32))             + chalk.white('│'));
  console.log(chalk.white('  │') + chalk.yellow('  ffmpeg    : ') + chalk.cyan(path.basename(FFMPEG).padEnd(32))       + chalk.white('│'));
  console.log(chalk.white('  └──────────────────────────────────────────────┘\n'));
  console.log(chalk.gray('  Keys: [s] toggle shift   [m] mute   [i] stats   [q] quit\n'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────\n'));
}

function printStatus() {
  const shift = isShifting ? chalk.greenBright('● SHIFTING ON ') : chalk.gray('○ SHIFTING OFF');
  const mute  = isMuted    ? chalk.red('🔇 MUTED  ')           : chalk.green('🎙 LIVE   ');
  const lat   = stats.converted > 0
    ? chalk.yellow(`Avg: ${Math.round(stats.totalMs / stats.converted)}ms`)
    : chalk.gray('waiting...');
  process.stdout.write(`\r  ${shift}  ${mute}  ${chalk.gray(`ok:${stats.converted} err:${stats.errors}`)}  ${lat}   `);
}

// ─── Build WAV header around raw PCM ─────────────────────────────────────────
function buildWavBuffer(pcmChunks) {
  const pcm    = Buffer.concat(pcmChunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                          // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ─── ElevenLabs API call ──────────────────────────────────────────────────────
async function convertChunk(wavBuffer) {
  if (processing) return null;
  processing = true;
  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('audio', wavBuffer, {
      filename:    'chunk.wav',
      contentType: 'audio/wav',
      knownLength: wavBuffer.length,
    });
    form.append('model_id', MODEL);
    form.append('remove_background_noise', 'false');

    const res = await fetch(
      `https://api.elevenlabs.io/v1/speech-to-speech/${VOICE_ID}/stream`,
      { method: 'POST', headers: { 'xi-api-key': API_KEY, ...form.getHeaders() }, body: form }
    );

    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0,120)}`);

    const buf = Buffer.from(await res.arrayBuffer());
    stats.converted++;
    stats.totalMs += Date.now() - t0;
    return buf;

  } catch (err) {
    stats.errors++;
    process.stdout.write('\n');
    console.error(chalk.red(`  ✗ ${err.message}`));
    return null;
  } finally {
    processing = false;
  }
}

// ─── Play audio file to VB-Cable Input via ffmpeg dshow ───────────────────────
function playToVBCable(audioBuffer, ext) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `vs_${Date.now()}.${ext}`);
    fs.writeFileSync(tmp, audioBuffer);

    // ffmpeg writes to a DirectShow audio output device
    const proc = spawn(FFMPEG, [
      '-loglevel', 'quiet',
      '-i', tmp,
      '-f', 'dshow',
      '-i', `audio=${OUTPUT_DEVICE}`,   // NOTE: this is OUTPUT for playback
    ], { windowsHide: true, stdio: 'ignore' });

    // ffmpeg dshow output: use -f dshow as output muxer
    // Correct form for playback output to dshow device:
    const proc2 = spawn(FFMPEG, [
      '-loglevel', 'quiet',
      '-i', tmp,
      '-f', 'dshow',
      `audio=${OUTPUT_DEVICE}`,
    ], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });

    proc.kill(); // kill first attempt, use proc2

    proc2.on('close', () => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      resolve();
    });

    proc2.stderr && proc2.stderr.on('data', (d) => {
      const m = d.toString();
      if (m.includes('No such') || m.includes('Invalid')) {
        process.stdout.write('\n');
        console.error(chalk.red(`  ✗ Playback: ${m.trim()}`));
        console.error(chalk.yellow(`  → Check OUTPUT_DEVICE in .env matches your VB-Cable name exactly`));
      }
    });
  });
}

// ─── Actually correct ffmpeg dshow playback ───────────────────────────────────
// ffmpeg doesn't support dshow as an output muxer directly.
// Instead we use the Windows default: -f waveout or play via powershell/wmplayer.
// Best cross-compat approach on Windows: use ffmpeg to convert to PCM then
// write to the dshow device using a second ffmpeg process piped together.
function playToDevice(audioBuffer, ext) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `vs_${Date.now()}.${ext}`);
    fs.writeFileSync(tmp, audioBuffer);

    // Decode audio → raw PCM pipe → write to waveout device by name
    // ffmpeg -i input.mp3 -f s16le -ar 44100 -ac 2 - | ffmpeg -f s16le -ar 44100 -ac 2 -i - -f waveout "CABLE Input"
    const decoder = spawn(FFMPEG, [
      '-loglevel', 'quiet',
      '-i', tmp,
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

    const player = spawn(FFMPEG, [
      '-loglevel', 'quiet',
      '-f', 's16le',
      '-ar', '44100',
      '-ac', '2',
      '-i', '-',
      '-f', 'waveout',
      OUTPUT_DEVICE,
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

    decoder.stdout.pipe(player.stdin);

    player.on('close', () => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      resolve();
    });

    player.stderr && player.stderr.on('data', (d) => {
      const m = d.toString();
      if (m.includes('No such device') || (m.includes('Error') && !m.includes('conversion'))) {
        process.stdout.write('\n');
        console.error(chalk.red(`  ✗ Playback error: ${m.trim()}`));
      }
    });

    decoder.on('error', () => resolve());
    player.on('error', () => resolve());
  });
}

// ─── Process a chunk ──────────────────────────────────────────────────────────
async function processChunk(pcmChunks) {
  if (!pcmChunks.length) return;
  const wav = buildWavBuffer(pcmChunks);

  if (!isShifting) {
    await playToDevice(wav, 'wav');
  } else {
    const mp3 = await convertChunk(wav);
    if (mp3) await playToDevice(mp3, 'mp3');
  }
  printStatus();
}

// ─── Start ffmpeg mic capture ─────────────────────────────────────────────────
function startCapture(micName) {
  const args = [
    '-loglevel', 'quiet',
    '-f', 'dshow',
    '-i', `audio=${micName}`,
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-f', 's16le',   // raw PCM to stdout
    '-',
  ];

  const proc = spawn(FFMPEG, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (d) => {
    const m = d.toString();
    if (m.includes('Cannot find') || m.includes('No such')) {
      process.stdout.write('\n');
      console.error(chalk.red(`  ✗ Mic not found: "${micName}"`));
      console.error(chalk.yellow('  → Run this to list your mic names:'));
      console.error(chalk.cyan(`      ${FFMPEG} -list_devices true -f dshow -i dummy`));
      console.error(chalk.yellow('  → Then set INPUT_DEVICE="Your Mic Name" in .env\n'));
    }
  });

  proc.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(chalk.red('\n  ✗ ffmpeg.exe not found!'));
      console.error(chalk.yellow('  → Download from https://www.gyan.dev/ffmpeg/builds/'));
      console.error(chalk.yellow('  → Get ffmpeg-release-essentials.zip, extract ffmpeg.exe'));
      console.error(chalk.yellow('  → Place ffmpeg.exe in the same folder as main.js\n'));
      process.exit(1);
    }
  });

  return proc;
}

// ─── Keyboard ────────────────────────────────────────────────────────────────
function setupKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_str, key) => {
    if (!key) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      console.log(chalk.yellow('\n\n  Stopped.\n'));
      isRunning = false;
      clearInterval(chunkTimer);
      process.exit(0);
    }
    if (key.name === 's') { isShifting = !isShifting; printStatus(); }
    if (key.name === 'm') { isMuted    = !isMuted;    printStatus(); }
    if (key.name === 'i') {
      process.stdout.write('\n');
      console.log(chalk.cyan([
        '',
        '  ┌─── Stats ──────────────────────────────────┐',
        `  │  Converted : ${String(stats.converted).padEnd(30)}│`,
        `  │  Errors    : ${String(stats.errors).padEnd(30)}│`,
        `  │  Avg delay : ${String(stats.converted > 0 ? Math.round(stats.totalMs/stats.converted)+'ms' : 'N/A').padEnd(30)}│`,
        `  │  Shifting  : ${String(isShifting?'ON':'OFF').padEnd(30)}│`,
        `  │  Muted     : ${String(isMuted?'YES':'NO').padEnd(30)}│`,
        '  └────────────────────────────────────────────┘',
        '',
      ].join('\n')));
    }
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log(chalk.gray('\n  Detecting microphone...'));
const micName = detectMicName();

if (!micName) {
  console.error(chalk.red('  ✗ Could not detect a microphone automatically.'));
  console.error(chalk.yellow(`  → Run: ${FFMPEG} -list_devices true -f dshow -i dummy`));
  console.error(chalk.yellow('  → Copy your mic name and set INPUT_DEVICE="..." in .env\n'));
  process.exit(1);
}

printBanner(micName);

const ffmpegProc = startCapture(micName);

console.log(chalk.greenBright('  ✓ Mic captured: ') + chalk.cyan(micName));
console.log(chalk.gray(`  In Telegram → Settings → Privacy → Calls → Microphone → "CABLE Output (VB-Audio Virtual Cable)"\n`));

ffmpegProc.stdout.on('data', (chunk) => {
  if (!isMuted && isRunning) chunkBuffer.push(chunk);
});

chunkTimer = setInterval(async () => {
  if (!chunkBuffer.length) return;
  const batch = [...chunkBuffer];
  chunkBuffer = [];
  await processChunk(batch);
}, CHUNK_SEC * 1000);

setupKeyboard();
printStatus();

process.on('SIGINT', () => {
  isRunning = false;
  clearInterval(chunkTimer);
  ffmpegProc.kill();
  console.log(chalk.yellow('\n\n  Stopped.\n'));
  process.exit(0);
});
