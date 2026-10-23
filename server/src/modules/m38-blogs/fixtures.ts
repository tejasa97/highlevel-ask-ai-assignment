import { Fixtures, type Input } from "../../store/fixtures.js";
import { BlogPost } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    blogPost(o?: Input<BlogPost>): BlogPost;
  }
}

Fixtures.prototype.blogPost = function (this: Fixtures, o: Input<BlogPost> = {}): BlogPost {
  const n = this.seq();
  return this.make("blog_posts", "blg", BlogPost, {
    title: `Post ${n}`,
    slug: `post-${n}`,
    body: "Draft body",
    authorId: "us_1",
    categories: [],
    mediaIds: [],
    seo: { title: null, description: null },
    status: "draft",
    publishAt: null,
    publishedAt: null,
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
