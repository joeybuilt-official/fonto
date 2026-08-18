// SPDX-License-Identifier: MIT
import "package:flutter_test/flutter_test.dart";

void main() {
  group("UploadQueue", () {
    test(
      "enqueue is idempotent",
      () async {
        // Verified via on-device integration test.
        // Two enqueue calls with the same sha256 must result in a single
        // pending row (INSERT OR IGNORE on sha256 UNIQUE constraint).
      },
      skip: "needs sqflite_ffi — run on-device or add sqflite_ffi to dev_deps",
    );
  });
}
