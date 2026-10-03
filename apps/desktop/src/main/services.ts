import { VaultServices, type VaultServicesDeps } from "@passvault/services";
import { nodePlatform } from "./nodePlatform.js";

export interface ServicesDeps extends Omit<VaultServicesDeps, "platform"> {
  readonly appDataDir: string;
}

/**
 * The application, wired to this machine.
 *
 * Everything it does now lives in `@passvault/services`; all that is left here
 * is the choice of adapters. The class remains because the Electron main
 * process and the end-to-end tests both construct a device by naming a
 * directory, and that is a desktop idea — Android has no directory to name.
 */
export class DesktopServices extends VaultServices {
  public constructor(deps: ServicesDeps) {
    super({ ...deps, platform: nodePlatform(deps.appDataDir) });
  }
}

export { explainFailure } from "@passvault/services";
