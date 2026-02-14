import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const IS_VERCEL = process.env.VERCEL === '1' || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
export const IS_WINDOWS = os.platform() === 'win32';
export const BIN_NAME = IS_WINDOWS ? 'flyctl.exe' : 'flyctl';

// Resolve to backend root
export const BACKEND_ROOT = path.resolve(__dirname, '..');

export const BASE_WORK_DIR = IS_VERCEL ? os.tmpdir() : BACKEND_ROOT;
export const VERCEL_HOME = path.join(os.tmpdir(), 'fly_home');
export const TEMP_DIR = path.join(BASE_WORK_DIR, 'fly_deployer_workspaces');
export const FLY_INSTALL_DIR = path.join(VERCEL_HOME, '.fly');
export const FLY_BIN = path.join(FLY_INSTALL_DIR, 'bin', BIN_NAME);
