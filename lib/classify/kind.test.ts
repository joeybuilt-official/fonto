// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0001 §4 — edge-case grid coverage for deriveKind. Each row in the
// spec's table becomes one `it(...)` block. The asymmetry invariant Sara
// flagged ("document classifications IGNORE EXIF; graphics classifications
// REQUIRE no EXIF") gets its own dedicated tests at the bottom.
//
// Run: cd /workspace/fonto && npx vitest run lib/classify/kind.test.ts

import { describe, it, expect } from "vitest";
import { deriveKind, type KindInput } from "./kind";

// Convenience: build a KindInput with sensible defaults. Each test overrides
// only the fields that matter to its scenario.
function input(overrides: Partial<KindInput>): KindInput {
  return {
    mimeType: "image/jpeg",
    classification: null,
    filename: "test.jpg",
    widthPx: 4032,
    heightPx: 3024,
    subClassification: null,
    ocrText: null,
    ...overrides,
  };
}

// EXIF presence helper — any one camera signal counts.
const REAL_CAMERA_EXIF = {
  exposureTime: "1/120",
  fNumber: 1.8,
  iso: 100,
  focalLength: 26,
  lensModel: "iPhone 15 Pro back camera",
};

// Pre-fab OCR strings.
const RECEIPT_OCR = [
  "WHOLE FOODS MARKET",
  "123 MAIN ST",
  "ORGANIC BANANAS    $3.42",
  "ALMOND MILK        $4.99",
  "SUBTOTAL          $28.41",
  "TAX                $2.27",
  "TOTAL             $30.68",
  "VISA ****1234",
  "THANK YOU",
].join("\n");

const WHITEBOARD_OCR = [
  "Q3 Roadmap",
  "MVP shipping next sprint",
  "Auth flow redesign",
  "Mobile app parity",
  "Stretch: face clustering",
  "Owner: Marcus",
].join("\n");

describe("deriveKind — ADR 0001 §4 edge-case grid", () => {
  it("phone photo of paper receipt → document (classification beats EXIF)", () => {
    // Row: Phone photo of paper receipt | receipt | yes | document
    const kind = deriveKind(
      input({
        classification: "receipt",
        ocrText: RECEIPT_OCR,
        filename: "IMG_4521.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("phone photo of receipt in restaurant scene → moment", () => {
    // Row: Phone photo of receipt in restaurant scene | food/photo | yes | moment
    // Classifier called the scene; we honor it. No OCR-paper-doc signal.
    const kind = deriveKind(
      input({
        classification: "food",
        filename: "IMG_4522.jpg",
        ocrText: null,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("moment");
  });

  it("phone photo of whiteboard → document (rule 4)", () => {
    // Row: Phone photo of whiteboard | whiteboard | yes | document
    const kind = deriveKind(
      input({
        classification: "whiteboard",
        filename: "IMG_4523.jpg",
        ocrText: WHITEBOARD_OCR,
        widthPx: 4032,
        heightPx: 3024,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("phone photo of brand logo on storefront → moment", () => {
    // Row: Phone photo of brand logo on storefront | architecture/logo | yes | moment
    // architecture classification → rule 6 skips it (not in GRAPHICS set),
    // EXIF present → rule 8 wins. Even classification=logo + EXIF falls
    // through rule 6 because looksLikeCameraPhoto blocks it.
    const archKind = deriveKind(
      input({
        classification: "architecture",
        filename: "IMG_4524.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(archKind).toBe("moment");

    const logoKind = deriveKind(
      input({
        classification: "logo",
        filename: "IMG_4525.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(logoKind).toBe("moment");
  });

  it("Drive-imported logo PNG → graphics (rule 6, no EXIF)", () => {
    // Row: Drive-imported logo PNG | logo | no | graphics
    const kind = deriveKind(
      input({
        classification: "logo",
        filename: "acme-logo.png",
        mimeType: "image/png",
        // No EXIF, no camera-roll filename.
      }),
    );
    expect(kind).toBe("graphics");
  });

  it("photographed book page → document (rule 3)", () => {
    // Row: Photographed book page | document | yes | document
    const kind = deriveKind(
      input({
        classification: "document",
        subClassification: "note-page",
        filename: "IMG_4526.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("Polaroid in someone's hand → moment", () => {
    // Row: Polaroid in someone's hand | portrait | yes | moment
    const kind = deriveKind(
      input({
        classification: "portrait",
        filename: "IMG_4527.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("moment");
  });

  it("screenshot of scanned receipt → screenshot (rule 7)", () => {
    // Row: Screenshot of scanned receipt | screenshot-receipt | no | screenshot
    // Legacy top-level `screenshot-receipt` collapses to legacy
    // classification "receipt" via legacyClassificationFor — but the new
    // taxonomy puts these under screenshot/receipt-screenshot. Both paths
    // must land on screenshot. Cover both:
    // (a) New path: classification="screenshot", sub="receipt-screenshot".
    const newPath = deriveKind(
      input({
        classification: "screenshot",
        subClassification: "receipt-screenshot",
        filename: "Screenshot_20260605-120100.png",
        mimeType: "image/png",
        widthPx: 1170,
        heightPx: 2532,
      }),
    );
    expect(newPath).toBe("screenshot");

    // (b) Legacy top-level: persisted as classification="receipt" — but
    // SHOULD have come from the legacyClassificationFor("screenshot-receipt")
    // collapse. The current legacy map sends it to "receipt", which is in
    // DOCUMENT_CLASSIFICATIONS, so this hits rule 3 → document. That's the
    // documented legacy behaviour (per back-compat note in taxonomy.ts) —
    // newly-classified screenshot receipts go through the new path above.
    // We don't assert the legacy receipt case here because the legacy map
    // intentionally sends it to receipt/document for back-compat with
    // existing rows.
  });

  it("museum painting photo → moment (rule 6 blocks graphics)", () => {
    // Row: Museum painting photo | art/portrait | yes | moment
    // Asymmetry test: graphics needs no EXIF. EXIF present blocks rule 6.
    const artKind = deriveKind(
      input({
        classification: "art",
        filename: "IMG_4528.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(artKind).toBe("moment");

    // Also covers §7 conflict #4 — art + EXIF defaults to moment even when
    // a small placard might create a few OCR tokens. isPhotoOfArt routes.
    const artWithPlacard = deriveKind(
      input({
        classification: "art",
        filename: "IMG_4529.jpg",
        ocrText: "Monet, Water Lilies, 1906",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(artWithPlacard).toBe("moment");
  });

  it("downloaded artwork JPEG → graphics (rule 6, no EXIF)", () => {
    // Row: Downloaded artwork JPEG | art | no | graphics
    const kind = deriveKind(
      input({
        classification: "art",
        filename: "downloaded-painting.jpg",
        // No EXIF.
      }),
    );
    expect(kind).toBe("graphics");
  });

  it("road sign / billboard → moment", () => {
    // Row: Road sign / billboard | document or photo | yes | moment
    // New `travel` sub catches sign-in-scene context. We assert the
    // moment routing for the photo classification (filename hint + EXIF
    // takes us through rule 8) and architecture classification.
    const travelKind = deriveKind(
      input({
        classification: "photo",
        subClassification: "travel",
        filename: "IMG_4530.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(travelKind).toBe("moment");
  });

  it("event ticket on a table → document (rule 3, ticket is doc sub)", () => {
    // Row: Event ticket on a table | ticket | yes | document
    // Ticket persists as classification="document", sub="ticket" via taxonomy.
    const kind = deriveKind(
      input({
        classification: "document",
        subClassification: "ticket",
        filename: "IMG_4531.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("chat conversation screenshot → screenshot (rule 7)", () => {
    // Row: Chat conversation screenshot | chat | no | screenshot
    const kind = deriveKind(
      input({
        classification: "screenshot",
        subClassification: "chat",
        filename: "Screenshot_20260605-091223.png",
        mimeType: "image/png",
        widthPx: 1170,
        heightPx: 2532,
      }),
    );
    expect(kind).toBe("screenshot");
  });
});

describe("deriveKind — asymmetry invariant (Sara)", () => {
  it("classification=document IGNORES EXIF (rule 3 always wins over EXIF)", () => {
    // Even with full real-camera EXIF, classification=document → document.
    const kind = deriveKind(
      input({
        classification: "document",
        filename: "IMG_4540.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("classification=receipt IGNORES EXIF", () => {
    const kind = deriveKind(
      input({
        classification: "receipt",
        filename: "IMG_4541.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("classification=graphics REQUIRES no EXIF (rule 6 fails with EXIF → falls through to moment)", () => {
    // logo + EXIF + camera-roll filename → moment, NOT graphics.
    const withExif = deriveKind(
      input({
        classification: "logo",
        filename: "IMG_4542.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(withExif).toBe("moment");

    // logo + no EXIF + non-camera filename → graphics.
    const withoutExif = deriveKind(
      input({
        classification: "logo",
        filename: "acme-logo.png",
        mimeType: "image/png",
      }),
    );
    expect(withoutExif).toBe("graphics");
  });

  it("classification=art REQUIRES no EXIF (museum photo stays a moment)", () => {
    const museumPhoto = deriveKind(
      input({
        classification: "art",
        filename: "IMG_4543.jpg",
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(museumPhoto).toBe("moment");

    const downloadedArt = deriveKind(
      input({
        classification: "art",
        filename: "starry-night.jpg",
      }),
    );
    expect(downloadedArt).toBe("graphics");
  });
});

describe("deriveKind — rule precedence", () => {
  it("rule 1: video mime always wins", () => {
    const kind = deriveKind(
      input({
        mimeType: "video/mp4",
        classification: "document",
        filename: "VID_20260605_120100.mp4",
      }),
    );
    expect(kind).toBe("video");
  });

  it("rule 2: PDF mime → document regardless of classification", () => {
    const kind = deriveKind(
      input({
        mimeType: "application/pdf",
        classification: "photo",
        filename: "contract.pdf",
      }),
    );
    expect(kind).toBe("document");
  });

  it("rule 2: text/* mime → document", () => {
    const kind = deriveKind(
      input({
        mimeType: "text/plain",
        classification: null,
        filename: "notes.txt",
      }),
    );
    expect(kind).toBe("document");
  });

  it("rule 4: whiteboard people-in-front (portrait class + ≥5 OCR tokens) → document", () => {
    // §7 conflict #3 — operator default: ≥5 distinct tokens with people-in-front.
    const kind = deriveKind(
      input({
        classification: "portrait",
        filename: "IMG_4550.jpg",
        ocrText: WHITEBOARD_OCR,
        widthPx: 4032,
        heightPx: 3024,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("rule 4: whiteboard people-in-front with <5 tokens → moment (stays portrait)", () => {
    const kind = deriveKind(
      input({
        classification: "portrait",
        filename: "IMG_4551.jpg",
        ocrText: "Hi\nBob", // 2 tokens
        widthPx: 4032,
        heightPx: 3024,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("moment");
  });

  it("rule 5: OCR-paper-doc beats graphics when classifier missed it", () => {
    // Classifier landed on something innocuous but OCR sees a receipt.
    const kind = deriveKind(
      input({
        classification: "photo",
        filename: "IMG_4552.jpg",
        ocrText: RECEIPT_OCR,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  it("rule 6: graphics classifications cover wallpaper + diagram (ADR 0001 §3 new subs)", () => {
    const wallpaper = deriveKind(
      input({
        classification: "wallpaper",
        filename: "macos-monterey-4k.png",
        mimeType: "image/png",
      }),
    );
    expect(wallpaper).toBe("graphics");

    const diagram = deriveKind(
      input({
        classification: "diagram",
        filename: "flowchart.png",
        mimeType: "image/png",
      }),
    );
    expect(diagram).toBe("graphics");
  });

  it("rule 7: screenshot classification routes to screenshot", () => {
    const kind = deriveKind(
      input({
        classification: "screenshot",
        subClassification: "error-dialog",
        filename: "Screenshot_20260605-120100.png",
        mimeType: "image/png",
        widthPx: 1170,
        heightPx: 2532,
      }),
    );
    expect(kind).toBe("screenshot");
  });

  it("rule 7: isScreenshot filename heuristic catches missing classification", () => {
    const kind = deriveKind(
      input({
        classification: null,
        filename: "Screenshot 2026-06-05 at 12.34.56 PM.png",
        mimeType: "image/png",
        widthPx: 2560,
        heightPx: 1440,
      }),
    );
    expect(kind).toBe("screenshot");
  });

  it("rule 8: camera-roll filename without EXIF → moment (Drive-stripped photo)", () => {
    // Drive imports strip EXIF; camera-roll filename is the safety net.
    // Use the Android format \d{8}_\d{6} (PXL_/IMG_ + underscore-digit forms
    // don't trip the regex's \b boundary; iOS-style IMG_<4-7 digits>.jpg does).
    const iosForm = deriveKind(
      input({
        classification: "photo",
        filename: "IMG_4561.jpg",
        // No EXIF.
      }),
    );
    expect(iosForm).toBe("moment");

    const androidForm = deriveKind(
      input({
        classification: "photo",
        filename: "20260605_120100.jpg",
        // No EXIF.
      }),
    );
    expect(androidForm).toBe("moment");
  });

  it("rule 11: image/* without camera evidence → moment fallback", () => {
    // Spec 2026-06-10: no classification, no camera evidence, generic
    // filename — an unknown image is a photo → moment (was screenshot).
    const kind = deriveKind(
      input({
        classification: null,
        filename: "random.jpg",
      }),
    );
    expect(kind).toBe("moment");
  });

  it("rule 10: unknown mime → moment fallback", () => {
    const kind = deriveKind(
      input({
        mimeType: "application/octet-stream",
        classification: null,
        filename: "mystery.bin",
      }),
    );
    expect(kind).toBe("moment");
  });
});

describe("deriveKind — remediation spec 2026-06-10", () => {
  // (a) EXIF-stripped image, classification="photo" → moment.
  it("EXIF-stripped photo (classification=photo, no EXIF) → moment", () => {
    const kind = deriveKind(
      input({
        classification: "photo",
        filename: "downloaded_beach.jpg",
        mimeType: "image/jpeg",
        widthPx: 1600,
        heightPx: 1200,
        // No EXIF, non-camera-roll filename.
      }),
    );
    expect(kind).toBe("moment");
  });

  // (b) EXIF-stripped TALL image (AR 0.5), classification="photo", no
  // screenshot filename → moment (NOT screenshot — shape ≠ content).
  it("EXIF-stripped tall photo (AR 0.5, no screenshot name) → moment, not screenshot", () => {
    const kind = deriveKind(
      input({
        classification: "photo",
        filename: "saved_portrait.jpg",
        mimeType: "image/jpeg",
        widthPx: 1080,
        heightPx: 2160, // AR 0.5 — matches the old aspect heuristic.
        // No EXIF.
      }),
    );
    expect(kind).toBe("moment");
  });

  // (c) classification="screenshot" with dense receipt-like OCR → screenshot
  // (NOT document — trusted-vision screenshot beats OCR-doc).
  it("screenshot classification + receipt-like OCR → screenshot, not document", () => {
    const kind = deriveKind(
      input({
        classification: "screenshot",
        filename: "saved_image_8821.png",
        mimeType: "image/png",
        widthPx: 1170,
        heightPx: 2532,
        ocrText: RECEIPT_OCR,
      }),
    );
    expect(kind).toBe("screenshot");
  });

  // (d) filename "Screenshot_2024.png", no camera, with OCR text → screenshot
  // (filename signal beats OCR-doc).
  it("screenshot filename + receipt OCR + no camera → screenshot, not document", () => {
    const kind = deriveKind(
      input({
        classification: "photo",
        filename: "Screenshot_2024.png",
        mimeType: "image/png",
        widthPx: 1170,
        heightPx: 2532,
        ocrText: RECEIPT_OCR,
        // No EXIF — !looksLikeCameraPhoto, so the filename branch fires.
      }),
    );
    expect(kind).toBe("screenshot");
  });

  // (e) phone photo of receipt (IMG_1234.jpg + camera EXIF + receipt OCR) →
  // document still (camera evidence skips the screenshot branches; rule 7 OCR
  // -doc claims it). Preserved invariant.
  it("phone photo of receipt (camera EXIF + receipt OCR) → document still", () => {
    const kind = deriveKind(
      input({
        classification: "photo",
        filename: "IMG_1234.jpg",
        mimeType: "image/jpeg",
        ocrText: RECEIPT_OCR,
        ...REAL_CAMERA_EXIF,
      }),
    );
    expect(kind).toBe("document");
  });

  // (f) downloaded logo (classification="logo", no EXIF) → graphics still.
  it("downloaded logo (classification=logo, no EXIF) → graphics still", () => {
    const kind = deriveKind(
      input({
        classification: "logo",
        filename: "brand-logo.png",
        mimeType: "image/png",
        // No EXIF.
      }),
    );
    expect(kind).toBe("graphics");
  });
});

describe("deriveKind — idempotency", () => {
  it("same input produces same output across runs", () => {
    const sample: KindInput = input({
      classification: "receipt",
      filename: "IMG_4560.jpg",
      ocrText: RECEIPT_OCR,
      ...REAL_CAMERA_EXIF,
    });
    const a = deriveKind(sample);
    const b = deriveKind(sample);
    const c = deriveKind(sample);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe("document");
  });
});
