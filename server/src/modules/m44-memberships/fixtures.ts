import { Fixtures, type Input } from "../../store/fixtures.js";
import "../m40-courses/fixtures.js";
import "../m43-communities/fixtures.js";
import { Membership, MembershipPlan } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    membershipPlan(o?: Input<MembershipPlan>): MembershipPlan;
    membership(o?: Input<Membership>): Membership;
  }
}

Fixtures.prototype.membershipPlan = function (this: Fixtures, o: Input<MembershipPlan> = {}): MembershipPlan {
  const n = this.seq();
  return this.make("membership_plans", "mpl", MembershipPlan, {
    name: `Plan ${n}`,
    description: null,
    entitlements: [],
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.membership = function (this: Fixtures, o: Input<Membership> = {}): Membership {
  return this.make("memberships", "mbr", Membership, {
    planId: o.planId ?? this.membershipPlan().id,
    contactId: o.contactId ?? this.contact().id,
    status: "active",
    grantedAt: this.now(),
    expiresAt: null,
    revokedAt: null,
    revokeReason: null,
    grantedBy: "us_1",
    ...o,
  });
};
