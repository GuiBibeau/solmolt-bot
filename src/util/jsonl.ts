import fs from "node:fs/promises";
import path from "node:path";

export async function appendJsonl(
  filePath: string,
  entry: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}
