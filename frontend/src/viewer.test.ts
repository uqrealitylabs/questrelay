import { expect, it, vi } from "vitest";
import type { Feed } from "./api";
import { Viewer } from "./viewer";

it("resubscribes to a selected headset after it disconnects and returns", () => {
  const viewer = Reflect.construct(Viewer, [
    {},
    {},
    {},
    vi.fn(),
    vi.fn(),
  ]) as Viewer;
  const internal = viewer as unknown as {
    selected: Set<string>;
    subscriptions: Map<
      string,
      {
        stream: MediaStream;
        consumers: [];
        producers: string[];
      }
    >;
    updateFeeds: (feeds: Feed[]) => void;
  };
  const watch = vi.spyOn(viewer, "watch").mockResolvedValue(undefined);
  internal.selected.add("quest-a");
  internal.subscriptions.set("quest-a", {
    stream: {} as MediaStream,
    consumers: [],
    producers: ["video-1"],
  });

  internal.updateFeeds([]);
  expect(internal.selected.has("quest-a")).toBe(true);
  expect(internal.subscriptions.has("quest-a")).toBe(false);

  watch.mockClear();
  internal.updateFeeds([
    { headsetId: "quest-a", video: "video-2", audio: null },
  ]);
  expect(watch).toHaveBeenCalledWith("quest-a");
});
