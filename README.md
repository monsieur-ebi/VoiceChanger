# VoiceShifter for Windows
### Mic → ElevenLabs voice change → VB-Cable → Telegram / Discord / any app

---

## How it works

```
Your mic → ffmpeg captures → ElevenLabs API converts → ffmpeg plays to VB-Cable → Telegram hears shifted voice
```

---

## Setup (do these in order)

### 1. Install VB-Cable
- Download from https://vb-audio.com/Cable/
- Right-click `VBCABLE_Setup_x64.exe` → **Run as administrator**
- Restart your PC after install

### 2. Get ffmpeg.exe
- Go to https://www.gyan.dev/ffmpeg/builds/
- Download `ffmpeg-release-essentials.zip`
- Open the zip → go into the `bin` folder
- Copy **`ffmpeg.exe`** into the same folder as `main.js`

That's it — no PATH setup needed, it just sits next to main.js.

### 3. Fill in .env
Open `.env` and set:
```
ELEVENLABS_API_KEY=xi-...your key...
VOICE_ID=...your trained voice ID...
```

**Finding your Voice ID:**
- Go to https://elevenlabs.io/app/voice-lab
- Click your trained voice → look at the URL or the "Voice ID" field in the panel
- It looks like: `pNInz6obpgDQGcFmaJgB`

### 4. Install Node dependencies
```cmd
npm install
```

### 5. Run it
```cmd
npm start
```

It will auto-detect your microphone on first run.

### 6. Set Telegram to use VB-Cable
- Telegram → Settings → Privacy and Security → Voice Calls
- **Microphone** → select `CABLE Output (VB-Audio Virtual Cable)`
- Now Telegram hears your shifted voice

For Discord: User Settings → Voice & Video → Input Device → `CABLE Output`

---

## Controls while running

| Key | Action |
|-----|--------|
| `S` | Toggle voice shifting on/off |
| `M` | Mute / unmute mic |
| `I` | Show stats (conversions, errors, avg latency) |
| `Q` | Quit |

---

## If it can't find your mic

Run this command to list all audio devices on your PC:
```cmd
ffmpeg.exe -list_devices true -f dshow -i dummy
```

Look for lines like `"Microphone (Realtek Audio)" (audio)` — copy that name
and set it in `.env`:
```
INPUT_DEVICE=Microphone (Realtek Audio)
```

---

## Latency

Each chunk = ~1–3 seconds of delay depending on your internet speed.
Set `CHUNK_SECONDS=2` in `.env` for less delay (uses more API credits).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ffmpeg.exe not found` | Put ffmpeg.exe in the same folder as main.js |
| Mic not detected | Run the `-list_devices` command above, set INPUT_DEVICE in .env |
| No audio in Telegram | Make sure Telegram mic is set to "CABLE Output", not "CABLE Input" |
| API errors | Check ELEVENLABS_API_KEY and VOICE_ID in .env |
| Silence / no output | Check OUTPUT_DEVICE in .env matches the name in Windows Sound settings |
