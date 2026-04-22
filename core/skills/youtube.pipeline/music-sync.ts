import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function addMusicAndSFX() {
  console.log('Adding dramatic music + SFX...');
  
  // Download cinematic background (suspenseful)
  await execAsync('curl -s -o workspace/audio/music.mp3 "https://www.soundjay.com/misc/sounds/bell-ringing-5.mp3" || echo "Music placeholder"');
  
  // Heartbeat SFX for tension scenes
  await execAsync('ffmpeg -f lavfi -i "sine=frequency=60:duration=2" -ar 22050 workspace/audio/heartbeat.mp3');
  
  // Mix: music under voice (70/30), SFX overlay
  await execAsync(`
    ffmpeg -y \\
      -i workspace/audio/music.mp3 \\
      -i workspace/audio/voice.mp3 \\
      -i workspace/audio/heartbeat.mp3 \\
      -filter_complex "[1:a]volume=1.0[a1]; [0:a]volume=0.3[a0]; [a0][a1]amix=inputs=2:duration=longest[a2]; [a2][2:a]amix=inputs=2:duration=longest" \\
      workspace/audio/final_audio.mp3
  `);
  
  console.log('Final audio: workspace/audio/final_audio.mp3');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  addMusicAndSFX().catch(console.error);
}
export { addMusicAndSFX };
