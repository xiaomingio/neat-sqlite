/*
Purpose: Protect an open database and its journal files from export destinations, including filesystem aliases.
*/
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
export class DatabaseDestination {
  static async validate(sourcePath: string, targetPath: string): Promise<void> {
    const source = await realpath(sourcePath);
    const destination = await realpath(targetPath).catch(async () => join(await realpath(dirname(resolve(targetPath))), basename(targetPath)));
    if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(destination)) throw new Error('Choose a destination outside the open database and its journal files.');
    const [sourceFile, targetFile] = await Promise.all([stat(source), stat(destination).catch(() => undefined)]);
    if (targetFile && sourceFile.dev === targetFile.dev && sourceFile.ino === targetFile.ino) throw new Error('The destination refers to the open database. Choose a different file.');
  }
}
