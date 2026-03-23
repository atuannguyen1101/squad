import { getPackageVersion } from '../core/version.js';

export async function versionCommand(): Promise<void> {
  console.log(getPackageVersion());
}
