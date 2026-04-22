/**
 * Renders the Tiled map (office2.json) to a static PNG background image.
 * Uses node-canvas to composite all tile layers.
 */
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';

const TILE_DIR = 'src/renderer/public/pixel/tilesets';
const MAP_FILE = 'src/renderer/public/pixel/maps/office2.json';
const OUTPUT = 'src/renderer/public/pixel/office-bg.png';

// Tileset name → filename mapping
const TILESET_FILES = {
  'room_builder': 'Room_Builder_48x48.png',
  'modern_office': 'Modern_Office_48x48.png',
  'Classroom & Library': '5_Classroom_and_library_48x48.png',
  'Basement': '14_Basement_48x48.png',
  'Generic Interiors': '1_Generic_48x48.png',
  'Interios Room Builder': 'Room_Builder_Office_48x48.png',
  '6_Music_and_sport_48x48': '6_Music_and_sport_48x48.png',
  '3_Bathroom_48x48': '3_Bathroom_48x48.png',
  '4_Bedroom_48x48': '4_Bedroom_48x48.png',
  '2_LivingRoom_48x48': '2_LivingRoom_48x48.png',
  '7_Art_48x48': '7_Art_48x48.png',
  '8_Gym_48x48': '8_Gym_48x48.png',
  '9_Fishing_48x48': '9_Fishing_48x48.png',
  '11_Halloween_48x48': '11_Halloween_48x48.png',
  '13_Conference_Hall_48x48': '13_Conference_Hall_48x48.png',
  '16_Grocery_store_48x48': '16_Grocery_store_48x48.png',
};

async function main() {
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
  const { width: mapW, height: mapH, tilewidth: tw, tileheight: th } = map;
  const canvasW = mapW * tw;
  const canvasH = mapH * th;

  console.log(`Map: ${mapW}x${mapH} tiles, ${canvasW}x${canvasH}px`);

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // Fill with dark background
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Load all tileset images
  const tilesets = [];
  for (const ts of map.tilesets) {
    const name = ts.name || ts.source?.replace('.tsx', '') || '';
    const filename = TILESET_FILES[name];
    if (!filename) {
      console.warn(`Unknown tileset: ${name}, skipping`);
      tilesets.push({ ...ts, image: null, columns: 0 });
      continue;
    }
    const imgPath = path.join(TILE_DIR, filename);
    if (!fs.existsSync(imgPath)) {
      console.warn(`Missing tileset file: ${imgPath}`);
      tilesets.push({ ...ts, image: null, columns: 0 });
      continue;
    }
    const img = await loadImage(imgPath);
    const columns = Math.floor(img.width / tw);
    tilesets.push({ ...ts, image: img, columns });
    console.log(`Loaded: ${name} (${img.width}x${img.height}, ${columns} cols, firstgid=${ts.firstgid})`);
  }

  // Sort tilesets by firstgid descending for lookup
  const sortedTilesets = [...tilesets].sort((a, b) => b.firstgid - a.firstgid);

  function findTileset(gid) {
    const rawGid = gid & 0x1FFFFFFF; // strip flip flags
    for (const ts of sortedTilesets) {
      if (rawGid >= ts.firstgid) return ts;
    }
    return null;
  }

  // Render each tile layer
  for (const layer of map.layers) {
    if (layer.type !== 'tilelayer' || !layer.data || !layer.visible) continue;
    console.log(`Rendering layer: ${layer.name}`);

    for (let i = 0; i < layer.data.length; i++) {
      const rawGid = layer.data[i];
      if (rawGid === 0) continue;

      const gid = rawGid & 0x1FFFFFFF;
      const ts = findTileset(gid);
      if (!ts || !ts.image) continue;

      const localId = gid - ts.firstgid;
      const sx = (localId % ts.columns) * tw;
      const sy = Math.floor(localId / ts.columns) * th;
      const dx = (i % mapW) * tw;
      const dy = Math.floor(i / mapW) * th;

      // Handle flipping
      const flipH = !!(rawGid & 0x80000000);
      const flipV = !!(rawGid & 0x40000000);
      const flipD = !!(rawGid & 0x20000000);

      ctx.save();
      ctx.translate(dx + tw / 2, dy + th / 2);
      if (flipH) ctx.scale(-1, 1);
      if (flipV) ctx.scale(1, -1);
      if (flipD) {
        ctx.rotate(Math.PI / 2);
        ctx.scale(1, -1);
      }
      ctx.drawImage(ts.image, sx, sy, tw, th, -tw / 2, -th / 2, tw, th);
      ctx.restore();
    }
  }

  // Save to PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(OUTPUT, buffer);
  console.log(`\nSaved: ${OUTPUT} (${(buffer.length / 1024).toFixed(0)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
