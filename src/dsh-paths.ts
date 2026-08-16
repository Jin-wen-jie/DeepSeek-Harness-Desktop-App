/**
 * DeepSeek Harness user-data paths used by the desktop shell menus.
 *
 * The bundled `dsh` CLI owns the real path policy through
 * `@deepseek-ai/dsh-home-paths`; this module mirrors that policy for the two
 * paths the shell opens directly (skills directories and the booted profile's
 * patch file) without importing a transitive dependency. Precedence is:
 * non-blank `DSH_HOME`/`DSH_AGENTS_HOME`, otherwise `~/.dsh`/`~/.agents`.
 * @module dsh-paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the default DeepSeek Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Environment variable that overrides the default agents home. */
const DSH_AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/** Directory name for the default DeepSeek Harness home under the OS home. */
const DEFAULT_DSH_HOME_DIR = '.dsh'

/** Directory name for the default agents home under the OS home. */
const DEFAULT_AGENTS_HOME_DIR = '.agents'

/** The profile the desktop shell boots (`dsh web`). */
export const DESKTOP_PROFILE = 'web'

/** The user patch layer inside a profile directory. */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The user patch layer at the harness home, applied to every profile. */
const HOME_PATCH_FILENAME = 'cordis.patch.yml'

/**
 * Expand a leading `~`, `~/`, or `~\` against the operating-system home.
 * @param path - configured path that may begin with a home prefix.
 * @returns the expanded path.
 */
function expandHomePrefix(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve a configured home override, falling back to the OS home directory.
 * @param env - environment mapping read for the override variable.
 * @param variable - environment variable name to read.
 * @param defaultDir - directory name joined to the OS home when unset.
 * @returns the normalized absolute home path.
 */
function resolveHome(env: NodeJS.ProcessEnv, variable: string, defaultDir: string): string {
  const configured = env[variable]
  const value = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), defaultDir)
  return resolve(expandHomePrefix(value))
}

/**
 * Resolve the DeepSeek Harness home used by the bundled CLI.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveHome(env, DSH_HOME_ENV, DEFAULT_DSH_HOME_DIR)
}

/**
 * Resolve the agents home scanned for user-level skills.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the normalized absolute agents home path.
 */
export function resolveAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveHome(env, DSH_AGENTS_HOME_ENV, DEFAULT_AGENTS_HOME_DIR)
}

/**
 * Resolve a dsh profile directory under the harness home.
 * @param profile - profile name; defaults to {@link DESKTOP_PROFILE}.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(profile: string = DESKTOP_PROFILE, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'profiles', profile)
}

/**
 * Resolve a profile's user patch layer file.
 * @param profile - profile name; defaults to {@link DESKTOP_PROFILE}.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute path of `cordis.patch.yml`.
 */
export function resolveProfilePatchFile(profile: string = DESKTOP_PROFILE, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveProfileDir(profile, env), PROFILE_PATCH_FILENAME)
}

/**
 * Resolve the home-level patch layer file applied to every profile.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute path of `<dshHome>/cordis.patch.yml`.
 */
export function resolveHomePatchFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), HOME_PATCH_FILENAME)
}

/**
 * Resolve the user-level DeepSeek Harness skills directory.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute `<dshHome>/skills` path.
 */
export function resolveUserSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'skills')
}

/**
 * Resolve the user-level agents skills directory.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the absolute `<agentsHome>/skills` path.
 */
export function resolveAgentsSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentsHome(env), 'skills')
}
