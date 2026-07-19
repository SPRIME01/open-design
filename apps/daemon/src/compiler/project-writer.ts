import * as fs from "node:fs";
import * as path from "node:path";

interface BackupEntry {
  absolutePath: string;
  originalContent: string | null; // null if it didn't exist
}

export class ProjectWriter {
  private backups: BackupEntry[] = [];

  constructor(private outputRoot: string) {}

  stageAndWrite(files: { path: string; content: string }[]) {
    this.backups = [];
    try {
      for (const file of files) {
        const absPath = path.resolve(this.outputRoot, file.path);
        
        // Backup
        if (fs.existsSync(absPath)) {
          this.backups.push({
            absolutePath: absPath,
            originalContent: fs.readFileSync(absPath, "utf8"),
          });
        } else {
          this.backups.push({
            absolutePath: absPath,
            originalContent: null,
          });
        }

        // Write
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, file.content, "utf8");
      }
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  rollback() {
    for (const backup of this.backups) {
      if (backup.originalContent === null) {
        if (fs.existsSync(backup.absolutePath)) {
          fs.unlinkSync(backup.absolutePath);
        }
      } else {
        fs.writeFileSync(backup.absolutePath, backup.originalContent, "utf8");
      }
    }
    this.backups = [];
  }
}
