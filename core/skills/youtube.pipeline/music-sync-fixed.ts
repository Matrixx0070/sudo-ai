import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function addMusicAndSFX() {
  console.log('Synth music + SFX...');
  
  // Synth music (suspense drone)
  await execAsync('ffmpeg -f lavfi -i "sine=frequency=110:duration=35" -ar 22050 -af "volume=0.2" workspace/audio/music.mp3');
  
  // Heartbeat SFX
  await execAsync('ffmpeg -f lavfi -i "sine=frequency=80:duration=25" -ar 22050 -af "volume=0.1" workspace/audio/heartbeat.mp3');
  
  // Simple mix: music + voice
  await execAsync('ffmpeg -y -i workspace/audio/music.mp3 -i workspace/audio/voice.mp3 -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest" workspace/audio/final_audio.mp3');
  
  console.log('Final audio ready');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  addMusicAndSFX().catch(console.error);
}
export { addMusicAndSFX };
