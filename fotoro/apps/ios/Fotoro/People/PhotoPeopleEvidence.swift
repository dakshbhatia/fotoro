import GRDB

extension SearchIndex {
  /// A current completed local scan, including zero faces, is distinct from never analyzed.
  func detectedFaceCount(photoID: String, revision: String) throws -> Int? {
    try preparePeopleTables()
    return try database.read { db in
      guard try String.fetchOne(db, sql: "SELECT value FROM peopleState WHERE key='enabled'") == "1",
        try Int.fetchOne(db, sql: """
          SELECT count(*) FROM peopleScans p JOIN searchRecords r ON r.id=p.photo
          WHERE p.photo=? AND p.revision=? AND p.processor=?
            AND p.revision=json_extract(r.value,'$.revision')
          """, arguments: [photoID, revision, PhotoFaceVector.processor]) == 1 else { return nil }
      return try Int.fetchOne(db, sql: """
        SELECT count(*) FROM peopleFaces WHERE photo=? AND revision=?
          AND json_extract(value,'$.rejected')=0
        """, arguments: [photoID, revision]) ?? 0
    }
  }
}

extension LocalSearchStore {
  func detectedFaceCount(for photo: RecentPhoto) -> Int? {
    guard canEditPeoplePhoto(photo.id, revision: photo.sourceRevision) else { return nil }
    return try? peopleIndex?.detectedFaceCount(photoID: photo.id, revision: photo.sourceRevision)
  }
}
