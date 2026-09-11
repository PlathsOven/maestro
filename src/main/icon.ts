import { app } from 'electron';
import path from 'path';

/**
 * Path to Maestro's 1024x1024 app icon. `build/icon.png` isn't part of
 * `build.files`, so it never lands in the packaged asar — packaged builds
 * instead read the copy `build.extraResources` places next to the app.
 */
export function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'build', 'icon.png');
}
