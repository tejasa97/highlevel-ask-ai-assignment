import { Fixtures, type Input } from "../../store/fixtures.js";
import { MediaAsset } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    mediaAsset(o?: Input<MediaAsset>): MediaAsset;
  }
}

Fixtures.prototype.mediaAsset = function (this: Fixtures, o: Input<MediaAsset> = {}): MediaAsset {
  const n = this.seq();
  return this.make("media_assets", "md", MediaAsset, {
    name: `Asset ${n}`,
    mimeType: "image/png",
    sizeBytes: 1024,
    folder: "",
    altText: null,
    url: `https://cdn.example/asset-${n}`,
    version: 1,
    accessLinks: [],
    uploadedBy: "us_1",
    createdAt: this.now(),
    updatedAt: this.now(),
    ...o,
  });
};
