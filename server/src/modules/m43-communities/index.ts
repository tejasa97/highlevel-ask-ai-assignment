import { namedResolver, tableResolver } from "../../registry/lookup.js";
import "./fixtures.js";
import { z } from "zod";
import { ActionError, defineAction, mustGet } from "../../registry/define.js";
import { activeUser, person, requireState } from "../../registry/helpers.js";
import type { ModuleExports } from "../../registry/registry.js";
import type { Store } from "../../store/db.js";
import { Community, CommunityMember, CommunityPost } from "./schema.js";

export { Community, CommunityMember, CommunityPost } from "./schema.js";

// A community is a discussion space. Members join and leave without deleting their rows.
// Posts are top-level; replies can't be pinned or replied to. Removing a post requires a report.

const CommunityId = z.string().describe("community id (com_…)");
const ContactId = z.string().describe("contact id (ct_…)");
const PostId = z.string().describe("post id (cmp_…)");
const Name = z.string().trim().min(1);
const Body = z.string().trim().min(1);

const communityOf = (store: Store, id: string) => mustGet<Community>(store, "communities", id, "community");
const postOf = (store: Store, id: string) => mustGet<CommunityPost>(store, "community_posts", id, "post");

function live(store: Store, id: string, doing: string): Community {
  const c = communityOf(store, id);
  requireState(`Community "${c.name}"`, c.status, ["active"], doing);
  return c;
}

function nameTaken(store: Store, name: string): Community | undefined {
  const n = name.trim().toLowerCase();
  return store.find<Community>("communities", (c) => c.name.toLowerCase() === n)[0];
}

function currentMember(store: Store, communityId: string, contactId: string): CommunityMember | undefined {
  return store.find<CommunityMember>("community_members", (m) => m.communityId === communityId && m.contactId === contactId && m.leftAt == null)[0];
}

function authorId(store: Store, contactId: string | undefined, actorId: string | undefined, communityId: string): string {
  if (contactId) {
    const who = person(store, { contactId }, "post in a community");
    if (!currentMember(store, communityId, who.id)) throw new ActionError("CONFLICT", `${who.name} isn't a current member; join the community first`);
    return who.id;
  }
  return activeUser(store, actorId ?? "us_1", "post as staff").id;
}

const createCommunity = defineAction({
  id: "M43.A01",
  description: "Create an active community with a name and optional description and guidelines. Channels start empty; add them with Create discussion channel. Unlike Join community, this does not add a member.",
  risk: "write",
  input: z.strictObject({
    name: Name,
    description: z.string().trim().min(1).nullable().optional(),
    guidelines: z.string().trim().min(1).nullable().optional(),
  }),
  output: Community,
  entities: { produces: "community" },
  example: () => ({ name: "Builders", description: "A place to compare notes" }),
  handler: (a, { store, clock }) => {
    const name = a.name.trim();
    const dup = nameTaken(store, name);
    if (dup) throw new ActionError("DUPLICATE", `A community called "${dup.name}" already exists (${dup.id})`, { existingId: dup.id });
    const now = clock.now().toISOString();
    return store.insert("communities", "com", {
      name,
      description: a.description ?? null,
      guidelines: a.guidelines ?? null,
      channels: [],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  },
});

const getCommunity = defineAction({
  id: "M43.A02",
  description: "Get one community by id or by exact name: its id, guidelines, channels and status. Use this to find a community's id from its name. Unlike Create community, this only reads a community that already exists.",
  risk: "read",
  input: z.strictObject({ communityId: CommunityId.optional(), name: Name.optional() }),
  output: Community,
  entities: { produces: "community", consumes: ["community"], lookup: "community" },
  example: (f) => ({ communityId: f.community().id }),
  handler: ({ communityId, name }, { store }) => {
    if (!communityId === !name) throw new ActionError("INVALID", "Give exactly one of communityId or name");
    if (communityId) return communityOf(store, communityId);
    const found = nameTaken(store, name!);
    if (!found) throw new ActionError("NOT_FOUND", `No community called "${name}"`);
    return found;
  },
});

const updateGuidelines = defineAction({
  id: "M43.A03",
  description: "Replace the guidelines text of an active community. Unlike Create discussion channel, this changes the rules members see, not the list of channels. The same text is refused.",
  risk: "write",
  input: z.strictObject({ communityId: CommunityId, guidelines: z.string().trim().min(1) }),
  output: Community,
  entities: { consumes: ["community"] },
  example: (f) => ({ communityId: f.community().id, guidelines: "Be kind and stay on topic." }),
  handler: (a, { store, clock }) => {
    const c = live(store, a.communityId, "change its guidelines");
    const guidelines = a.guidelines.trim();
    if (c.guidelines === guidelines) throw new ActionError("CONFLICT", "The community already has that value");
    return store.update<Community>("communities", c.id, { guidelines, updatedAt: clock.now().toISOString() });
  },
});

const createChannel = defineAction({
  id: "M43.A04",
  description: "Add a discussion channel to an active community. Unlike Update community guidelines, this adds a place to post. A channel with the same name is refused.",
  risk: "write",
  input: z.strictObject({ communityId: CommunityId, name: Name }),
  output: Community,
  entities: { consumes: ["community"] },
  example: (f) => ({ communityId: f.community().id, name: "Announcements" }),
  handler: (a, { store, clock }) => {
    const c = live(store, a.communityId, "gain a channel");
    const name = a.name.trim();
    if (c.channels.some((ch) => ch.name.toLowerCase() === name.toLowerCase())) {
      throw new ActionError("DUPLICATE", `This community already has a channel called "${name}"`);
    }
    const channel = { id: store.nextId("_nested", "ch"), name };
    return store.update<Community>("communities", c.id, { channels: [...c.channels, channel], updatedAt: clock.now().toISOString() });
  },
});

const join = defineAction({
  id: "M43.A05",
  description: "Join an active contact to a community as a member, or clear leftAt if they had left. Unlike M44.A07 Grant membership, this adds them to one community and does not enroll them in courses.",
  risk: "write",
  input: z.strictObject({ communityId: CommunityId, contactId: ContactId }),
  output: CommunityMember,
  siblings: ["M44.A07", "M44.A09"],
  entities: { consumes: ["community", "contact"] },
  example: (f) => ({ communityId: f.community().id, contactId: f.contact().id }),
  handler: (a, { store, clock }) => {
    const c = live(store, a.communityId, "take new members");
    const who = person(store, { contactId: a.contactId }, "join a community");
    if (currentMember(store, c.id, who.id)) throw new ActionError("CONFLICT", `${who.name} is already a member of ${c.name}`);
    const now = clock.now().toISOString();
    const prior = store.find<CommunityMember>("community_members", (m) => m.communityId === c.id && m.contactId === who.id).at(-1);
    if (prior) return store.update<CommunityMember>("community_members", prior.id, { leftAt: null, joinedAt: now });
    return store.insert("community_members", "cmm", { communityId: c.id, contactId: who.id, role: "member" as const, joinedAt: now, leftAt: null });
  },
});

const leave = defineAction({
  id: "M43.A06",
  description: "Mark a current member as having left. The row stays so their posts keep an author. Unlike Join community, this sets leftAt instead of clearing it.",
  risk: "write",
  input: z.strictObject({ communityId: CommunityId, contactId: ContactId }),
  output: CommunityMember,
  entities: { consumes: ["community"] },
  example: (f) => {
    const m = f.communityMember();
    return { communityId: m.communityId, contactId: m.contactId };
  },
  handler: (a, { store, clock }) => {
    communityOf(store, a.communityId);
    const who = person(store, { contactId: a.contactId }, "leave a community");
    const member = currentMember(store, a.communityId, who.id);
    if (!member) throw new ActionError("CONFLICT", `${who.name} isn't a current member of this community`);
    return store.update<CommunityMember>("community_members", member.id, { leftAt: clock.now().toISOString() });
  },
});

const createPost = defineAction({
  id: "M43.A07",
  argumentLookups: { channelId: { entity: "community_channel", scope: { communityId: "communityId" } } },
  destination: { id: "community", label: "CRM community" },
  description: "Start a top-level post in a channel. Pass contactId for a member post, or omit it to post as the acting staff user. Unlike Reply to community post, this is not nested under another post and it can be pinned.",
  risk: "write",
  input: z.strictObject({
    communityId: CommunityId,
    channelId: z.string().describe("channel id on the community"),
    body: Body,
    contactId: ContactId.optional(),
  }),
  output: CommunityPost,
  entities: { produces: "community_post", consumes: ["community"] },
  example: (f) => {
    const c = f.community();
    const channel = c.channels[0];
    if (!channel) throw new Error("community fixture has no channel");
    return { communityId: c.id, channelId: channel.id, body: "Welcome to the space" };
  },
  handler: (a, { store, clock, actorId }) => {
    const c = live(store, a.communityId, "take posts");
    if (!c.channels.some((ch) => ch.id === a.channelId)) throw new ActionError("CONFLICT", "That channel isn't in this community");
    const author = authorId(store, a.contactId, actorId, c.id);
    return store.insert("community_posts", "cmp", {
      communityId: c.id,
      channelId: a.channelId,
      authorId: author,
      parentId: null,
      body: a.body.trim(),
      pinned: false,
      reports: [],
      status: "visible" as const,
      createdAt: clock.now().toISOString(),
      removedAt: null,
      removedBy: null,
    });
  },
});

const reply = defineAction({
  id: "M43.A08",
  description: "Reply to a visible top-level post. Replies can't be pinned or replied to. Pass contactId for a member, or omit it to reply as staff. Unlike Create community post, this nests under an existing post.",
  risk: "write",
  input: z.strictObject({ postId: PostId, body: Body, contactId: ContactId.optional() }),
  output: CommunityPost,
  entities: { produces: "community_post", consumes: ["community_post"] },
  example: (f) => ({ postId: f.communityPost().id, body: "Thanks for posting" }),
  handler: (a, { store, clock, actorId }) => {
    const parent = postOf(store, a.postId);
    if (parent.parentId) throw new ActionError("CONFLICT", "Replies can't be replied to; reply to the original post");
    requireState("Post", parent.status, ["visible"], "be replied to");
    const c = live(store, parent.communityId, "take posts");
    const author = authorId(store, a.contactId, actorId, c.id);
    return store.insert("community_posts", "cmp", {
      communityId: c.id,
      channelId: parent.channelId,
      authorId: author,
      parentId: parent.id,
      body: a.body.trim(),
      pinned: false,
      reports: [],
      status: "visible" as const,
      createdAt: clock.now().toISOString(),
      removedAt: null,
      removedBy: null,
    });
  },
});

const pin = defineAction({
  id: "M43.A09",
  description: "Pin a visible top-level post so it stays highlighted. Replies can't be pinned. Unlike Remove reported post, the post stays visible. Pinning it again is refused.",
  risk: "write",
  input: z.strictObject({ postId: PostId }),
  output: CommunityPost,
  entities: { consumes: ["community_post"] },
  example: (f) => ({ postId: f.communityPost().id }),
  handler: ({ postId }, { store }) => {
    const post = postOf(store, postId);
    if (post.parentId) throw new ActionError("CONFLICT", "Replies can't be pinned");
    requireState("Post", post.status, ["visible"], "be pinned");
    live(store, post.communityId, "pin posts");
    if (post.pinned) throw new ActionError("CONFLICT", "The post is already pinned");
    return store.update<CommunityPost>("community_posts", post.id, { pinned: true });
  },
});

const removePost = defineAction({
  id: "M43.A10",
  description: "Remove a visible post that someone has already reported. The row stays with removedAt set. Unlike Pin community post, this hides the post. A post with no reports is refused.",
  risk: "destructive",
  input: z.strictObject({ postId: PostId }),
  output: CommunityPost,
  entities: { consumes: ["community_post"] },
  example: (f) => ({ postId: f.communityPost({ reports: [{ by: "us_1", reason: "spam", at: f.now() }] }).id }),
  handler: ({ postId }, { store, clock, actorId }) => {
    const post = postOf(store, postId);
    requireState("Post", post.status, ["visible"], "be removed");
    if (post.reports.length === 0) throw new ActionError("CONFLICT", "This post hasn't been reported");
    const now = clock.now().toISOString();
    return store.update<CommunityPost>("community_posts", post.id, { status: "removed", pinned: false, removedAt: now, removedBy: actorId ?? "us_1" });
  },
});

export default {
  resolvers: {
    community: tableResolver("communities"),
    community_channel: namedResolver({
      records: (store) => store.all<Community>("communities").flatMap((c) => c.channels.map((channel) => ({ ...channel, communityId: c.id, community: c.name }))),
      name: (c) => c.name, detail: (c) => c.community,
      qualifiers: { communityId: (c) => c.communityId, community: (c) => c.community }, parentQualifiers: ["communityId", "community"],
    }),
  },
  actions: [createCommunity, getCommunity, updateGuidelines, createChannel, join, leave, createPost, reply, pin, removePost],
} satisfies ModuleExports;
