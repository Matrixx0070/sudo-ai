/**
 * @file grok-media-extras.ts
 * @description `sudo-ai grok media <upscale|caption>` — FREE video upscale +
 * caption on the $30 subscription seat (cookie lane, statsig-free), siblings of
 * `grok video`. `upscale` returns a direct HD url (and downloads it with --out);
 * `caption` starts a caption job on a video the seat OWNS.
 *
 * NOTE: registered into the `grok` command group via one registerGrokMediaExtras()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 */
import type { Command } from 'commander';

type UpscaleTarget = import('../../llm/grok-media-extras.js').GrokUpscaleTarget;

function printError(prefix: string, err: unknown): void {
  const cls = (err as { errorClass?: string })?.errorClass;
  console.error(
    `${prefix} failed${cls ? ` [${cls}]` : ''}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Run `sudo-ai grok media upscale <videoId>`. Returns a process exit code. */
export async function runGrokMediaUpscale(
  videoId: string,
  opts: { res?: string; out?: string },
): Promise<number> {
  const { upscaleGrokVideo } = await import('../../llm/grok-media-extras.js');
  const target: UpscaleTarget =
    opts.res === '1080p' ? 'UPSCALE_TARGET_RESOLUTION_1080P' : 'UPSCALE_TARGET_RESOLUTION_HD';
  try {
    const r = await upscaleGrokVideo(videoId, {
      targetResolution: target,
      ...(opts.out ? { outputPath: opts.out } : {}),
    });
    console.log(`HD url: ${r.hdMediaUrl}`);
    if (r.file) console.log(`wrote ${r.bytes ?? 0} bytes -> ${r.file}`);
    return 0;
  } catch (err) {
    printError('grok media upscale', err);
    return 2;
  }
}

/** Run `sudo-ai grok media caption <videoId>`. */
export async function runGrokMediaCaption(
  videoId: string,
  opts: { preset?: string; style?: string },
): Promise<number> {
  const { captionGrokVideo } = await import('../../llm/grok-media-extras.js');
  try {
    const r = await captionGrokVideo(videoId, {
      ...(opts.preset ? { preset: opts.preset } : {}),
      ...(opts.style ? { style: opts.style } : {}),
    });
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return 0;
  } catch (err) {
    printError('grok media caption', err);
    return 2;
  }
}

/** Register `grok media` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokMediaExtras(grokCmd: Command): void {
  const media = grokCmd
    .command('media')
    .description('FREE video extras on your subscription seat (cookie lane): upscale (direct HD url) + caption (owned videos). Needs SUDO_GROK_WEBSESSION=1.');
  media
    .command('upscale <videoId>')
    .description('Upscale a video; prints the direct HD url (downloads it with --out)')
    .option('--res <hd|1080p>', 'Target resolution (default hd)')
    .option('--out <path>', 'Also download the upscaled mp4 to this path')
    .action(async (id: string, opts: { res?: string; out?: string }) =>
      process.exit(await runGrokMediaUpscale(id, opts)),
    );
  media
    .command('caption <videoId>')
    .description('Start caption generation for a video your seat owns (job result)')
    .option('--preset <name>', 'Caption preset')
    .option('--style <name>', 'Caption style')
    .action(async (id: string, opts: { preset?: string; style?: string }) =>
      process.exit(await runGrokMediaCaption(id, opts)),
    );
}
