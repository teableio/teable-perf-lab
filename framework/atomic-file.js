import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export const writeFileAtomically = async (
  path,
  contents,
  { renameFile = rename } = {},
) => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents);
    await renameFile(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};
