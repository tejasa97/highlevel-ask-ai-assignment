import { Fixtures, type Input } from "../../store/fixtures.js";
import "../m40-courses/fixtures.js";
import "../m41-lessons/fixtures.js";
import { Enrollment } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    enrollment(o?: Input<Enrollment>): Enrollment;
  }
}

Fixtures.prototype.enrollment = function (this: Fixtures, o: Input<Enrollment> = {}): Enrollment {
  return this.make("enrollments", "enr", Enrollment, {
    courseId: o.courseId ?? this.course({ status: "published" }).id,
    contactId: o.contactId ?? this.contact().id,
    status: "active",
    enrolledAt: this.now(),
    expiresAt: null,
    completions: [],
    certificate: null,
    membershipId: null,
    suspendedAt: null,
    revokedAt: null,
    revokeReason: null,
    ...o,
  });
};
