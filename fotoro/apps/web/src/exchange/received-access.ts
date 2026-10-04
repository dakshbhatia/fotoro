import type {GrantV1} from "@fotoro/contracts";
import {api} from "./api";
import {assertVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";

export function currentReceivedGrant(expected: GrantV1, inbox: readonly GrantV1[], accountId: string, now = Date.now()) {
  const grant = inbox.find(value => value.grantId === expected.grantId);
  return grant && grant.momentId === expected.momentId && grant.ownerAccountId === expected.ownerAccountId &&
    grant.recipientAccountId === expected.recipientAccountId && grant.role === expected.role &&
    [grant.ownerAccountId, grant.recipientAccountId].includes(accountId) && expected.version > 0 &&
    grant.version >= expected.version && !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > now)
    ? grant : null;
}

// Returning to received photos checks access only. Owned copies and Save requests stay independent.
export class ReceivedAccessRefresh {
  private pending?: {session: UnlockedVault; grant: GrantV1; controller: AbortController; promise: Promise<{version: number; grants: GrantV1[]}>};
  cancel() {this.pending?.controller.abort(); this.pending = undefined;}
  async read(grant: GrantV1, session: UnlockedVault, current: () => boolean) {
    assertVault(session);
    if (!current()) throw new DOMException("Received photos closed", "AbortError");
    let attempt = this.pending;
    if (!attempt || attempt.session !== session || attempt.grant !== grant) {
      this.cancel();
      const controller = new AbortController();
      attempt = {session, grant, controller, promise: api("/v1/grants", undefined, "GrantInboxV1", "GET", controller.signal)};
      this.pending = attempt;
    }
    try {
      const inbox = await attempt.promise;
      attempt.controller.signal.throwIfAborted(); assertVault(session);
      if (!current()) throw new DOMException("Received photos closed", "AbortError");
      return currentReceivedGrant(grant, inbox.grants, session.accountId);
    } finally {if (this.pending === attempt) this.pending = undefined;}
  }
}
