import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Brain, DEFAULT_SETTINGS, type VaultSettings } from "../src/brain.js";
import { Vault } from "../src/vault.js";

export async function makeBrain(files: Record<string, string>, settings: Partial<VaultSettings> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));
  for (const [p, c] of Object.entries(files)) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c);
  }
  const vault = new Vault(dir);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const brain = new Brain(vault, () => s);
  await brain.load();
  return { brain, vault, dir, read: (p: string) => fs.readFileSync(path.join(dir, p), "utf8"), exists: (p: string) => fs.existsSync(path.join(dir, p)) };
}
