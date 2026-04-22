import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYS_FILE = path.join(__dirname, '..', 'data', 'keys.json');

interface Keys {
  claude?: string;
  ollama?: string;
}

class KeysManager {
  private keys: Keys = {};

  constructor() {
    this.load();
  }

  private load() {
    if (!fs.existsSync(KEYS_FILE)) {
      this.save();
      return;
    }
    const data = fs.readFileSync(KEYS_FILE, 'utf-8');
    this.keys = JSON.parse(data) as Keys;
  }

  private save() {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(this.keys, null, 2), 'utf-8');
  }

  get(provider: keyof Keys): string | undefined {
    return this.keys[provider];
  }

  set(provider: keyof Keys, key: string) {
    this.keys[provider] = key;
    this.save();
  }

  delete(provider: keyof Keys) {
    delete this.keys[provider];
    this.save();
  }
}

export default new KeysManager();