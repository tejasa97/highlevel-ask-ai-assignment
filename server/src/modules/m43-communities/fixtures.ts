import { Fixtures, type Input } from "../../store/fixtures.js";
import { Community, CommunityMember, CommunityPost } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    community(o?: Input<Community>): Community;
    communityMember(o?: Input<CommunityMember>): CommunityMember;
    communityPost(o?: Input<CommunityPost>): CommunityPost;
  }
}

Fixtures.prototype.community = function (this: Fixtures, o: Input<Community> = {}): Community {
  const n = this.seq();
  const channels = o.channels ?? [{ id: this.store.nextId("_nested", "ch"), name: "General" }];
  return this.make("communities", "com", Community, {
    name: `Community ${n}`,
    description: null,
    guidelines: null,
    channels,
    status: "active",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};

Fixtures.prototype.communityMember = function (this: Fixtures, o: Input<CommunityMember> = {}): CommunityMember {
  return this.make("community_members", "cmm", CommunityMember, {
    communityId: o.communityId ?? this.community().id,
    contactId: o.contactId ?? this.contact().id,
    role: "member",
    joinedAt: this.now(),
    leftAt: null,
    ...o,
  });
};

Fixtures.prototype.communityPost = function (this: Fixtures, o: Input<CommunityPost> = {}): CommunityPost {
  const n = this.seq();
  const communityId = o.communityId ?? this.community().id;
  const community = this.store.get<Community>("communities", communityId);
  const channelId = o.channelId ?? community?.channels[0]?.id;
  if (!channelId) throw new Error(`community post fixture: ${communityId} has no channel`);
  return this.make("community_posts", "cmp", CommunityPost, {
    communityId,
    channelId,
    authorId: o.authorId ?? this.contact().id,
    parentId: null,
    body: `Post ${n}`,
    pinned: false,
    reports: [],
    status: "visible",
    createdAt: this.now(),
    removedAt: null,
    removedBy: null,
    ...o,
  });
};
