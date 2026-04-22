import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
const execAsync = promisify(exec);

async function assembleVideo() {
  console.log('Stitching 8 scenes + voice → 1080x1920 MP4...');
  
  // Scene clips (4s each)
  for (let i = 1; i <= 8; i++) {
    await execAsync(`ffmpeg -y -loop 1 -i workspace/images/scene-${i}.jpg -t 4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -r 30 workspace/video/scene-${i}.mp4`, { maxBuffer: 1024 * 1024 });
  }
  
  // Write concat list
  const concatList = fs.writeFileSync('workspace/concat.txt', 'file workspace/video/scene-1.mp4\nfile workspace/video/scene-2.mp4\nfile workspace/video/scene-3.mp4\nfile workspace/video/scene-4.mp4\nfile workspace/video/scene-5.mp4\nfile workspace/video/scene-6.mp4\nfile workspace/video/scene-7.mp4\nfile workspace/video/scene-8.mp4\n');
  
  // Final concat + audio
  await execAsync(`ffmpeg -y -f concat -safe 0 -i workspace/concat.txt -i workspace/audio/voice.mp3 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -shortest -vf "scale=1080:1920" workspace/video/final-short.mp4`, { maxBuffer: 1024 * 1024 });
  
  console.log('✅ Video ready: workspace/video/final-short.mp4');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assembleVideo().catch(console.error);
}
export { assembleVideo };
