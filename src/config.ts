// Where ios-sim keeps its config and state, and what the config says.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Config and state: ~/.config/ios-sim-kit when installed, the repo's dev/ when run from ./bin/ios-sim. */
export const HOME = process.env.IOS_SIM_HOME ?? join(homedir(), ".config", "ios-sim-kit");

export interface Config {
  /** The AXe binary: axe-patched (rotate, correct landscape taps); see README.md. */
  axe: string;
  /** When set, only devices named `PREFIX-…` may be used (others belong to other projects). */
  prefix: string;
  /** The probe relay's port on 127.0.0.1. */
  probePort: number;
}

export const DEFAULT_PROBE_PORT = 4320;

export function config(): Config {
  const file = join(HOME, "config.json");
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  return {
    axe: join(homedir(), "bin", "axe-patched"),
    prefix: "",
    probePort: DEFAULT_PROBE_PORT,
    ...fromFile,
  };
}
