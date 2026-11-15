import { describe, expect, it } from "vitest";
import { formatBytes, imageType } from "./image";

describe("imageType", () => {
  it("recognizes image extensions case-insensitively", () => {
    expect(imageType("logo.png")).toBe("image/png");
    expect(imageType("assets/Photo.JPG")).toBe("image/jpeg");
    expect(imageType("src-tauri/icons/app-icon.svg")).toBe("image/svg+xml");
  });

  it("ignores other files and dots in directory names", () => {
    expect(imageType("README.md")).toBeNull();
    expect(imageType("png")).toBeNull();
    expect(imageType("v1.png/readme")).toBeNull();
    expect(imageType("archive.png.zip")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
