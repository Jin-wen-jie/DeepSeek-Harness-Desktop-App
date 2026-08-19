/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-connection-desktop`.
 * @module @deepseek-ai/dsh-client-connection-desktop/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-connection-desktop'

/** Cordis companion plugin name. */
export const name = 'client-connection-desktop-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the desktop carrier inherits rpcId round-trip and
 * schema acceptance from the apiproxy contract layer (exercised by its
 * protocol-isomorphism suite) and reuses the connection package's
 * generation/reconnect controller. The carrier adds no cordis events and owns
 * no mutable cross-plugin relation; its handshake/reconnect behavior is
 * asserted directly by its client spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
