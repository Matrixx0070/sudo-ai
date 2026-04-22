import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
const execAsync = promisify(exec);

async function assembleVideo() {
  console.log('Creating 8 scene clips...');
  
  // Generate 4s clips with proper framerate
  for (let i = 1; i <= 8; i++) {
    await execAsync(`ffmpeg -y -loop 1 -i workspace/images/scene-${i}.jpg -t 4 -r 30 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" workspace/video/scene-${i}.mp4`, { maxBuffer: 10 * 1024 * 1024 });
    console.log(`Scene ${i} done`);
  }
  
  // Write proper concat list
  const concatContent = Array.from({length: 8}, (_, i) => `file 'workspace/video/scene-${i+1}.mp4'`);
  fs.writeFileSync('workspace/concat.txt', concatContent.join('\\n'));
  
  console.log('Concatenating with audio...');
  await execAsync(`ffmpeg -y -f concat -safe 0 -i workspace/concat.txt -i workspace/audio/voice.mp3 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest workspace/video/final-short.mp4`, { maxBuffer: 10 * 1024 * 1024 });
  
  console.log('✅ FINAL VIDEO: workspace/video/final-short.mp4');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assembleVideo().catch(console.error);
}
export { assembleVideo };
