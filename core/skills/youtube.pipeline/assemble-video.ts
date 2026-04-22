import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function assembleVideo() {
  console.log('Stitching 8 scenes + voice → 1080x1920 MP4...');
  
  // Create 4s clips from placeholder images
  for (let i = 1; i <= 8; i++) {
    await execAsync(`
      ffmpeg -y -loop 1 -i workspace/images/scene-${i}.jpg \\
        -t 4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1" \\
        -r 30 workspace/video/scene-${i}.mp4
    `);
  }
  
  // Concat video + audio
  await execAsync(`
    ffmpeg -y -f concat -safe 0 -i <(for i in {1..8}; do echo "file 'workspace/video/scene-\$i.mp4'"; done) \\
      -i workspace/audio/voice.mp3 \\
      -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \\
      -c:a aac -shortest \\
      -vf "scale=1080:1920" \\
      workspace/video/final-short.mp4
  `);
  
  console.log('✅ Video ready: workspace/video/final-short.mp4');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assembleVideo().catch(console.error);
}
export { assembleVideo };
