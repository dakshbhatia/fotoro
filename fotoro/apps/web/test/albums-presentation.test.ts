import test from "node:test";
import assert from "node:assert/strict";
import {albumDateTag, albumMemberLabel} from "../src/albums/presentation";
import {shareOriginals} from "../src/library/system-share";

test("album contributors use reviewed contact names or roster labels without exposing IDs", () => {
  const members = ["owner-private-id", "member-private-id", "third-private-id"];
  const names = new Map([[members[1], "Alex"]]);
  assert.equal(albumMemberLabel(members[0], members[0], names, members), "You");
  assert.equal(albumMemberLabel(members[1], members[0], names, members), "Alex");
  assert.equal(albumMemberLabel(members[2], members[0], names, members), "Member 3");
  assert.equal(albumMemberLabel("unknown-id", members[0], names, members), "Member");
});

test("album date chips distinguish import dates from observed capture dates", () => {
  const sourceDate = "2026-10-07T12:00:00.000Z";
  const imported = albumDateTag({sourceDate, dateSource: "import"}, "en-US")!;
  assert.match(imported.text, /^Imported /); assert.equal(imported.label, "Imported date");
  for (const dateSource of ["photos", "exif"] as const) {
    const captured = albumDateTag({sourceDate, dateSource}, "en-US")!;
    assert.equal(captured.text, imported.text.slice("Imported ".length)); assert.equal(captured.label, "Capture date");
  }
  assert.equal(albumDateTag({sourceDate: "invalid", dateSource: "import"}), undefined);
});

test("prepared originals invoke downloads synchronously in the fresh gesture and reject withdrawn access", async () => {
  const file = new File(["original"], "photo.jpg", {type: "image/jpeg"}); let invoked = false;
  const attempt = shareOriginals([file], () => true, {canShare: () => false, download: received => {assert.equal(received, file); invoked = true;}});
  assert.equal(invoked, true); assert.equal(await attempt, "downloaded");
  await assert.rejects(shareOriginals([file], () => false, {canShare: () => false, download: () => assert.fail("Withdrawn access cannot download")}), /SOURCE_UNAVAILABLE/);
});
